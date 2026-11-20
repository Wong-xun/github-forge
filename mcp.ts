// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
// Modern era (2026-07-28) via server/discover, with the legacy initialize
// handshake as a fallback. Wire rules verified against checks-mcp.ts and
// mcp-client.ts: plain JSON responses are accepted; auth (401) is decided
// before tool existence; unknown tools are -32602/-32601, never HTTP 500;
// parse errors are HTTP 400 with -32700; tools/list is byte-identical
// across calls; results carry both content text and structuredContent.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Store } from './store.ts';
import { createIssueRecord, createPrRecord, issueJson, prJson, squashMerge } from './rest.ts';

export interface McpCtx {
  store: Store;
  token: string;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository under the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  // Fast path: the raw transport already buffered the whole body.
  const pre = (req as unknown as { __body?: Buffer }).__body;
  if (pre !== undefined) return Promise.resolve(pre);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    // Small bodies arrive as one chunk; hand it back instead of copying it
    // through Buffer.concat.
    req.on('end', () => {
      if (chunks.length === 0) resolve(Buffer.alloc(0));
      else if (chunks.length === 1) resolve(chunks[0] as Buffer);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length });
  res.end(payload);
}

function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolOk(obj: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function toolErr(message: string): unknown {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Read an argument by its canonical name or any accepted synonym. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null) return args[n];
  }
  return undefined;
}

function argStr(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const v = arg(args, ...names);
  return typeof v === 'string' ? v : v === undefined ? undefined : String(v);
}

function argNum(args: Record<string, unknown>, ...names: string[]): number | undefined {
  const v = arg(args, ...names);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: McpCtx): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/mcp') return false;

  if (req.method === 'DELETE') {
    res.writeHead(200, { 'content-length': '0' });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } });
    return true;
  }

  // Auth is decided before anything else, including tool existence.
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : '';
  if (!token || (ctx.token && token !== ctx.token)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const raw = await readBody(req);
  const rawText = raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(rawText) as unknown;
  } catch {
    // Try to recover the id for the -32700 reply.
    let id: unknown = null;
    const m = rawText.match(/"id"\s*:\s*("[^"]*"|-?\d+)/);
    if (m) {
      const v = m[1];
      id = v.startsWith('"') ? v.slice(1, -1) : parseInt(v, 10);
    }
    sendJson(res, 400, rpcError(id, -32700, 'Parse error'));
    return true;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const msg = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get an empty 2xx answer.
  if (id === null || id === undefined) {
    if (method.startsWith('notifications/')) {
      res.writeHead(202, { 'content-length': '0' });
      res.end();
      return true;
    }
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: missing id'));
    return true;
  }

  if (method === 'server/discover') {
    sendJson(
      res,
      200,
      rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    );
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    sendJson(
      res,
      200,
      rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    );
    return true;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
      return true;
    }
    const result = await callTool(ctx, tool.name, args);
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}

async function callTool(ctx: McpCtx, name: string, args: Record<string, unknown>): Promise<unknown> {
  const store = ctx.store;
  const missing = (field: string): unknown => toolErr(`missing required argument: ${field}`);

  if (name === 'create_repo') {
    const repoName = argStr(args, 'name', 'repo_name', 'repository_name');
    if (!repoName) return missing('name');
    const description = argStr(args, 'description') ?? '';
    const isPrivate = args.private === true || args.is_private === true;
    const existing = store.getRepo(VIEWER_LOGIN, repoName);
    if (existing) {
      return toolOk({ ...repoShape(existing), full_name: `${VIEWER_LOGIN}/${repoName}` });
    }
    const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
    return toolOk({ ...repoShape(repo), full_name: `${VIEWER_LOGIN}/${repoName}` });
  }

  if (name === 'get_repo') {
    const owner = argStr(args, 'owner', 'owner_login', 'org', 'user', 'login');
    const repoName = argStr(args, 'repo', 'repository', 'repo_name');
    if (!owner) return missing('owner');
    if (!repoName) return missing('repo');
    if (owner !== VIEWER_LOGIN) return toolErr('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolErr('Not Found');
    return toolOk({ ...repoShape(repo), full_name: `${owner}/${repoName}` });
  }

  if (name === 'create_issue') {
    const owner = argStr(args, 'owner', 'owner_login', 'org', 'user', 'login');
    const repoName = argStr(args, 'repo', 'repository', 'repo_name');
    const title = argStr(args, 'title', 'issue_title', 'subject');
    if (!owner) return missing('owner');
    if (!repoName) return missing('repo');
    if (!title) return missing('title');
    const body = argStr(args, 'body', 'description', 'content', 'text') ?? '';
    if (owner !== VIEWER_LOGIN) return toolErr('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolErr('Not Found');
    const issue = createIssueRecord(repo, title, body, []);
    const out = issueJson(repo, issue) as Record<string, unknown>;
    out.owner = owner;
    out.repo = repoName;
    out.full_name = `${owner}/${repoName}`;
    return toolOk(out);
  }

  if (name === 'list_issues') {
    const owner = argStr(args, 'owner', 'owner_login', 'org', 'user', 'login');
    const repoName = argStr(args, 'repo', 'repository', 'repo_name');
    if (!owner) return missing('owner');
    if (!repoName) return missing('repo');
    const state = argStr(args, 'state') ?? 'open';
    if (owner !== VIEWER_LOGIN) return toolErr('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolErr('Not Found');
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    list.sort((a, b) => a.seq - b.seq);
    const items = list.map((i) => issueJson(repo, i));
    return { content: [{ type: 'text', text: JSON.stringify(items) }], structuredContent: { issues: items } };
  }

  if (name === 'create_pull_request') {
    const owner = argStr(args, 'owner', 'owner_login', 'org', 'user', 'login');
    const repoName = argStr(args, 'repo', 'repository', 'repo_name');
    const title = argStr(args, 'title', 'issue_title', 'subject');
    const head = argStr(args, 'head', 'head_ref', 'head_branch', 'source_branch', 'branch');
    const base = argStr(args, 'base', 'base_ref', 'base_branch', 'target_branch');
    if (!owner) return missing('owner');
    if (!repoName) return missing('repo');
    if (!title) return missing('title');
    if (!head) return missing('head');
    if (!base) return missing('base');
    const body = argStr(args, 'body', 'description', 'content', 'text') ?? '';
    if (owner !== VIEWER_LOGIN) return toolErr('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolErr('Not Found');
    const pr = createPrRecord(repo, title, body, head, base);
    if (!pr) return toolErr('head or base branch not found');
    const out = prJson(pr) as Record<string, unknown>;
    out.owner = owner;
    out.repo = repoName;
    out.full_name = `${owner}/${repoName}`;
    return toolOk(out);
  }

  if (name === 'merge_pull_request') {
    const owner = argStr(args, 'owner', 'owner_login', 'org', 'user', 'login');
    const repoName = argStr(args, 'repo', 'repository', 'repo_name');
    const number = argNum(args, 'pull_number', 'pr_number', 'number');
    if (!owner) return missing('owner');
    if (!repoName) return missing('repo');
    if (number === undefined) return missing('pull_number');
    if (owner !== VIEWER_LOGIN) return toolErr('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return toolErr('Not Found');
    const pr = repo.prs.get(number);
    if (!pr) return toolErr('Pull request not found');
    if (pr.merged) return toolErr('Pull request is already merged');
    const result = squashMerge(repo, pr);
    if (!result) return toolErr('Merge conflict');
    return toolOk({ merged: true, number: pr.number, sha: result.sha, message: result.message });
  }

  return toolErr(`Unknown tool: ${name}`);
}

function repoShape(repo: { dbId: number; name: string; owner: string; description: string; isPrivate: boolean; defaultBranch: string }): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}
