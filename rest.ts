// REST v3 API under /api/v3.
// Wire rules verified against checks-rest.ts and rest-client.ts in the kit:
// every reply application/json + non-empty X-GitHub-Request-Id, errors are
// {"message": string}, unknown routes 404 JSON, malformed JSON bodies 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildCommit,
  buildTreeFromFiles,
  getObject,
  lineDiff,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  storeObject,
  trialEpochSec,
  trialNowIso,
  treeToFiles,
  type FileEntry,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestCtx {
  store: Store;
  token: string;
  requestId: () => string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, ctx: RestCtx, extra: Record<string, string> = {}): void {
  // One buffer, sized once: stringify, then write the bytes plus the
  // trailing newline into a single allocation instead of building a
  // concatenated string and copying it into a second buffer.
  const text = JSON.stringify(body);
  const byteLen = Buffer.byteLength(text, 'utf8');
  const payload = Buffer.allocUnsafe(byteLen + 1);
  payload.write(text, 0, 'utf8');
  payload[byteLen] = 0x0a;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': ctx.requestId(),
    ...extra,
  });
  res.end(payload);
}

function sendNoContent(res: ServerResponse, ctx: RestCtx): void {
  res.writeHead(204, { 'x-github-request-id': ctx.requestId() });
  res.end();
}

function err(res: ServerResponse, status: number, message: string, ctx: RestCtx): void {
  sendJson(res, status, { message }, ctx);
}

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

type JsonObj = Record<string, unknown>;

async function readJsonBody(req: IncomingMessage, res: ServerResponse, ctx: RestCtx): Promise<JsonObj | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as JsonObj;
  } catch {
    err(res, 400, 'Malformed JSON body', ctx);
    return null;
  }
}

function authed(req: IncomingMessage, ctx: RestCtx): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice('Bearer '.length).trim();
  if (!token) return false;
  if (ctx.token) return token === ctx.token;
  return true;
}

function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s);
}

/**
 * Decode one path segment, skipping decodeURIComponent when the segment has
 * no '%' at all (the common case: plain ASCII names). A malformed escape
 * still goes through decodeURIComponent and throws exactly as before.
 */
function decodeSeg(s: string): string {
  return s.indexOf('%') < 0 ? s : decodeURIComponent(s);
}

/** Resolve a branch name or commit sha to a commit sha. */
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (isHex40(ref)) {
    const obj = repo.objects.get(ref.toLowerCase());
    if (obj && obj.type === 'commit') return ref.toLowerCase();
    return undefined;
  }
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`);
}

function repoJson(repo: Repo): JsonObj {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER_ID },
    fork: false,
  };
}

export function issueJson(repo: Repo, issue: { number: number; id: number; title: string; body: string; state: string; labels: string[] }): JsonObj {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN },
  };
}

/**
 * The same single-issue JSON as issueJson, built as a string: the write/read
 * hot paths answer one issue per request, and building the object graph just
 * to stringify it costs more than interpolating the already-escaped string
 * fields. Key order and escaping match issueJson exactly (title/body/labels
 * go through JSON.stringify; state is the 'open'|'closed' enum).
 */
export function issueJsonString(issue: { number: number; id: number; title: string; body: string; state: string; labels: string[] }): string {
  let labelsJson = '';
  for (let i = 0; i < issue.labels.length; i += 1) {
    if (i > 0) labelsJson += ',';
    labelsJson += `{"name":${JSON.stringify(issue.labels[i])}}`;
  }
  return `{"id":${issue.id},"number":${issue.number},"title":${JSON.stringify(issue.title)},"body":${JSON.stringify(issue.body)},"state":"${issue.state}","labels":[${labelsJson}],"user":{"login":"${VIEWER_LOGIN}"}}`;
}

/** sendJson for an already-serialized JSON string (same framing: + '\\n'). */
function sendJsonString(res: ServerResponse, status: number, text: string, ctx: RestCtx): void {
  const byteLen = Buffer.byteLength(text, 'utf8');
  const payload = Buffer.allocUnsafe(byteLen + 1);
  payload.write(text, 0, 'utf8');
  payload[byteLen] = 0x0a;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': ctx.requestId(),
  });
  res.end(payload);
}

export function prJson(pr: PullRequest): JsonObj {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    merged: pr.merged,
    merged_at: pr.merged ? pr.mergedAt : null,
    merge_commit_sha: pr.merged ? pr.mergeCommitSha : null,
    user: { login: VIEWER_LOGIN },
  };
}

function parsePerson(line: string): { name: string; email: string } {
  const m = line.match(/^(.*?) <(.*?)> \d+ [+-]\d{4}$/);
  if (m) return { name: m[1], email: m[2] };
  return { name: line, email: '' };
}

function paginate<T>(items: T[], search: URLSearchParams, req: IncomingMessage, pathname: string): { page: T[]; link: string | undefined } {
  const perPageRaw = parseInt(search.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(search.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | undefined;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const params = new URLSearchParams(search);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    const url = `http://${host}${pathname}?${params.toString()}`;
    link = `<${url}>; rel="next"`;
    const lastPage = Math.ceil(items.length / perPage);
    const lastParams = new URLSearchParams(search);
    lastParams.set('page', String(lastPage));
    lastParams.set('per_page', String(perPage));
    link += `, <http://${host}${pathname}?${lastParams.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function sendPage<T>(res: ServerResponse, items: T[], search: URLSearchParams, req: IncomingMessage, pathname: string, ctx: RestCtx): void {
  const { page, link } = paginate(items, search, req, pathname);
  const extra: Record<string, string> = {};
  if (link) extra.link = link;
  sendJson(res, 200, page, ctx, extra);
}

/** Create a commit on a branch (or the unborn default) from a file map. */
function commitFiles(
  repo: Repo,
  branch: string,
  files: Map<string, FileEntry>,
  message: string,
): { commitSha: string; treeSha: string } {
  const treeSha = buildTreeFromFiles(repo, files);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip ? [tip] : [];
  const commitSha = storeObject(repo, 'commit', buildCommit(treeSha, parents, message, trialEpochSec()));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, treeSha };
}

/** Shared record creation used by REST and MCP. */
export function createIssueRecord(
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
): { number: number; id: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; seq: number } {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue = {
    number,
    id: repo.dbId * 1000000 + number,
    title,
    body,
    state: 'open' as const,
    labels,
    seq: repo.issueSeq,
  };
  repo.issueSeq += 1;
  repo.issues.set(number, issue);
  return issue;
}

export function createPrRecord(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return null;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pr: PullRequest = {
    number,
    id: repo.dbId * 1000000 + number,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    seq: repo.issueSeq,
  };
  repo.issueSeq += 1;
  repo.prs.set(number, pr);
  return pr;
}

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestCtx,
  method: string,
  pathname: string,
  search: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith('/api/v3')) return false;

  // Public roots (no auth): the starter serves these without a token.
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, ctx, {
      'x-oauth-scopes': 'repo, read:org',
    });
    return true;
  }
  if (method === 'GET' && pathname === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' }, ctx);
    return true;
  }

  // Everything else under /api/v3 requires the bearer token.
  if (!authed(req, ctx)) {
    err(res, 401, 'Requires authentication', ctx);
    return true;
  }

  const store = ctx.store;
  // pathname always starts with '/api/v3': split once and drop the leading
  // '' + 'api' + 'v3' by slicing, instead of running a filter callback over
  // every segment. A single trailing slash leaves one trailing '' segment;
  // drop it so '/api/v3/user/repos/' routes like '/api/v3/user/repos'.
  const parts = pathname.split('/');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  const rest = parts.slice(3); // after '', 'api', 'v3'

  // GET /user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' }, ctx);
    return true;
  }

  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN).map((r) => repoJson(r));
      sendPage(res, repos, search, req, pathname, ctx);
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res, ctx);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) {
        err(res, 422, 'name is required', ctx);
        return true;
      }
      const existing = store.getRepo(VIEWER_LOGIN, name);
      if (existing) {
        err(res, 422, 'Repository already exists', ctx);
        return true;
      }
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      sendJson(res, 201, repoJson(repo), ctx);
      return true;
    }
  }

  // /repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeSeg(rest[1]);
    const repoName = decodeSeg(rest[2]);
    if (owner !== VIEWER_LOGIN) {
      err(res, 404, 'Not Found', ctx);
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    const tail = rest.slice(3);

    // Repo object itself.
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        sendJson(res, 200, repoJson(repo), ctx);
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        const body = await readJsonBody(req, res, ctx);
        if (body === null) return true;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(repo), ctx);
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        store.deleteRepo(owner, repoName);
        sendNoContent(res, ctx);
        return true;
      }
      err(res, 404, 'Not Found', ctx);
      return true;
    }

    if (!repo) {
      err(res, 404, 'Not Found', ctx);
      return true;
    }

    // Branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const out = [...repo.refs.keys()]
          .filter((n) => n.startsWith('refs/heads/'))
          .sort()
          .map((n) => ({ name: n.slice('refs/heads/'.length), commit: { sha: repo.refs.get(n) } }));
        sendJson(res, 200, out, ctx);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = decodeSeg(tail[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha } }, ctx);
        return true;
      }
      err(res, 404, 'Not Found', ctx);
      return true;
    }

    // Commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = search.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (!tip) {
        err(res, 404, 'Not Found', ctx);
        return true;
      }
      const out = listCommits(repo, tip).map((sha) => {
        const obj = getObject(repo, sha);
        const c = obj ? parseCommit(obj.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
        const message = c.message.replace(/\n$/, '');
        return {
          sha,
          commit: {
            message,
            author: parsePerson(c.author),
            committer: parsePerson(c.committer),
            tree: { sha: c.tree },
          },
        };
      });
      sendJson(res, 200, out, ctx);
      return true;
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const body = await readJsonBody(req, res, ctx);
        if (body === null) return true;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isHex40(sha)) {
          err(res, 422, 'Invalid ref or sha', ctx);
          return true;
        }
        if (repo.refs.has(ref)) {
          err(res, 422, 'Reference already exists', ctx);
          return true;
        }
        repo.refs.set(ref, sha.toLowerCase());
        sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() } }, ctx);
        return true;
      }
      if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
        const branch = decodeSeg(tail[3]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } }, ctx);
        return true;
      }
      err(res, 404, 'Not Found', ctx);
      return true;
    }

    // Contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map((s) => decodeSeg(s)).join('/');
      if (method === 'GET') {
        const ref = search.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (!tip) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        const commit = getObject(repo, tip);
        if (!commit || commit.type !== 'commit') {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        const files = treeToFiles(repo, parseCommit(commit.data).tree);
        if (path === '') {
          // Root directory listing.
          const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
          for (const [p, entry] of files) {
            const top = p.split('/')[0];
            if (!seen.has(top)) {
              if (p === top) seen.set(top, { type: 'file', name: top, path: top, sha: entry.oid });
              else {
                // Directory: find its tree oid via the tree walk.
                seen.set(top, { type: 'dir', name: top, path: top, sha: '' });
              }
            }
          }
          const out = [...seen.values()];
          // Fill directory shas.
          const rootTree = getObject(repo, parseCommit(commit.data).tree);
          if (rootTree) {
            for (const e of parseTree(rootTree.data)) {
              const hit = out.find((o) => o.name === e.name);
              if (hit && e.mode === '40000') hit.sha = e.oid;
            }
          }
          out.sort((a, b) => (a.name < b.name ? -1 : 1));
          sendJson(res, 200, out, ctx);
          return true;
        }
        const file = files.get(path);
        if (file) {
          const blob = getObject(repo, file.oid);
          const bytes = blob ? blob.data : Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path.split('/').pop(),
            path,
            content: bytes.toString('base64'),
            sha: file.oid,
          }, ctx);
          return true;
        }
        // Directory?
        const prefix = `${path}/`;
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [p, entry] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (restPath === first) {
            children.set(first, { type: 'file', name: first, path: `${path}/${first}`, sha: entry.oid });
          } else if (!children.has(first)) {
            children.set(first, { type: 'dir', name: first, path: `${path}/${first}`, sha: '' });
          }
        }
        if (children.size > 0) {
          // Fill directory shas by walking the tree to this directory.
          const dirTree = findTreeOid(repo, parseCommit(commit.data).tree, path);
          if (dirTree) {
            const treeObj = getObject(repo, dirTree);
            if (treeObj) {
              for (const e of parseTree(treeObj.data)) {
                const hit = children.get(e.name);
                if (hit && e.mode === '40000') hit.sha = e.oid;
              }
            }
          }
          const out = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
          sendJson(res, 200, out, ctx);
          return true;
        }
        err(res, 404, 'Not Found', ctx);
        return true;
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req, res, ctx);
        if (body === null) return true;
        const message = typeof body.message === 'string' ? body.message : '';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
        const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined;
        if (!contentB64) {
          err(res, 422, 'content is required', ctx);
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        } catch {
          err(res, 422, 'content is not valid base64', ctx);
          return true;
        }
        const blobSha = storeObject(repo, 'blob', content);
        // Resolve the branch tip (create the branch from the default tip if needed).
        let tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip && branch !== repo.defaultBranch) {
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        let files = new Map<string, FileEntry>();
        if (tip) {
          const commit = getObject(repo, tip);
          if (commit && commit.type === 'commit') files = treeToFiles(repo, parseCommit(commit.data).tree);
        }
        const existing = files.get(path);
        if (existing) {
          if (givenSha && givenSha !== existing.oid) {
            err(res, 409, 'sha does not match the current file', ctx);
            return true;
          }
          files.set(path, { oid: blobSha, mode: '100644' });
          const { commitSha } = commitFiles(repo, branch, files, message);
          sendJson(res, 200, {
            content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: commitSha, message },
          }, ctx);
          return true;
        }
        if (givenSha) {
          err(res, 409, 'sha does not match the current file', ctx);
          return true;
        }
        files.set(path, { oid: blobSha, mode: '100644' });
        const { commitSha } = commitFiles(repo, branch, files, message);
        sendJson(res, 201, {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        }, ctx);
        return true;
      }
      if (method === 'DELETE') {
        const body = await readJsonBody(req, res, ctx);
        if (body === null) return true;
        const message = typeof body.message === 'string' ? body.message : '';
        const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : undefined;
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        const commit = getObject(repo, tip);
        if (!commit || commit.type !== 'commit') {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        const files = treeToFiles(repo, parseCommit(commit.data).tree);
        const existing = files.get(path);
        if (!existing) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        if (givenSha && givenSha !== existing.oid) {
          err(res, 409, 'sha does not match the current file', ctx);
          return true;
        }
        files.delete(path);
        const { commitSha } = commitFiles(repo, branch, files, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } }, ctx);
        return true;
      }
      err(res, 404, 'Not Found', ctx);
      return true;
    }

    // Labels
    if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
      const body = await readJsonBody(req, res, ctx);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (!name) {
        err(res, 422, 'name is required', ctx);
        return true;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color }, ctx);
      return true;
    }

    // Issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJsonBody(req, res, ctx);
          if (body === null) return true;
          const title = typeof body.title === 'string' ? body.title : '';
          const issueBody = typeof body.body === 'string' ? body.body : '';
          const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) {
              err(res, 422, `label does not exist: ${l}`, ctx);
              return true;
            }
          }
          const issue = createIssueRecord(repo, title, issueBody, labels);
          sendJsonString(res, 201, issueJsonString(issue), ctx);
          return true;
        }
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          const sort = search.get('sort') ?? 'created';
          const direction = search.get('direction') ?? 'asc';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
          }
          sendPage(res, list.map((i) => issueJson(repo, i)), search, req, pathname, ctx);
          return true;
        }
      }
      if (tail.length === 2) {
        const n = parseInt(tail[1], 10);
        const issue = repo.issues.get(n);
        if (method === 'GET') {
          if (!issue) {
            err(res, 404, 'Not Found', ctx);
            return true;
          }
          sendJsonString(res, 200, issueJsonString(issue), ctx);
          return true;
        }
        if (method === 'PATCH') {
          if (!issue) {
            err(res, 404, 'Not Found', ctx);
            return true;
          }
          const body = await readJsonBody(req, res, ctx);
          if (body === null) return true;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue), ctx);
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const n = parseInt(tail[1], 10);
        const issue = repo.issues.get(n);
        if (!issue) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, res, ctx);
          if (body === null) return true;
          const commentBody = typeof body.body === 'string' ? body.body : '';
          const id = repo.nextCommentId;
          repo.nextCommentId += 1;
          repo.comments.set(id, { id, body: commentBody, issueNumber: n });
          sendJson(res, 201, { id, body: commentBody }, ctx);
          return true;
        }
        if (method === 'GET') {
          const out = [...repo.comments.values()]
            .filter((c) => c.issueNumber === n)
            .sort((a, b) => a.id - b.id)
            .map((c) => ({ id: c.id, body: c.body }));
          sendJson(res, 200, out, ctx);
          return true;
        }
      }
      err(res, 404, 'Not Found', ctx);
      return true;
    }

    // Pull requests
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = await readJsonBody(req, res, ctx);
          if (body === null) return true;
          const title = typeof body.title === 'string' ? body.title : '';
          const prBody = typeof body.body === 'string' ? body.body : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const pr = createPrRecord(repo, title, prBody, head, base);
          if (!pr) {
            err(res, 422, 'head or base branch not found', ctx);
            return true;
          }
          sendJson(res, 201, prJson(pr), ctx);
          return true;
        }
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          let list = [...repo.prs.values()];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => a.seq - b.seq);
          sendPage(res, list.map((p) => prJson(p)), search, req, pathname, ctx);
          return true;
        }
      }
      if (tail.length === 2) {
        const n = parseInt(tail[1], 10);
        const pr = repo.prs.get(n);
        if (method === 'GET') {
          if (!pr) {
            err(res, 404, 'Not Found', ctx);
            return true;
          }
          sendJson(res, 200, prJson(pr), ctx);
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const n = parseInt(tail[1], 10);
        const pr = repo.prs.get(n);
        if (!pr) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        const files = prFiles(repo, pr);
        sendJson(res, 200, files, ctx);
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const n = parseInt(tail[1], 10);
        const pr = repo.prs.get(n);
        if (!pr) {
          err(res, 404, 'Not Found', ctx);
          return true;
        }
        const body = await readJsonBody(req, res, ctx);
        if (body === null) return true;
        if (pr.merged || pr.state === 'closed') {
          err(res, 405, 'Pull request is already merged or closed', ctx);
          return true;
        }
        const result = squashMerge(repo, pr);
        if (!result) {
          err(res, 405, 'Merge conflict', ctx);
          return true;
        }
        sendJson(res, 200, { merged: true, sha: result.sha, message: result.message }, ctx);
        return true;
      }
      err(res, 404, 'Not Found', ctx);
      return true;
    }
  }

  // Unknown route under /api/v3.
  err(res, 404, 'Not Found', ctx);
  return true;
}

// ---------------------------------------------------------------------------
// PR helpers
// ---------------------------------------------------------------------------

function findTreeOid(repo: Repo, rootTreeOid: string, dirPath: string): string | undefined {
  const parts = dirPath.split('/').filter((p) => p.length > 0);
  let current = rootTreeOid;
  for (const part of parts) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return undefined;
    current = entry.oid;
  }
  return current;
}

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export function prFiles(repo: Repo, pr: PullRequest): PrFile[] {
  const baseCommit = mergeBase(repo, pr.baseSha, pr.headSha) ?? pr.baseSha;
  const baseObj = getObject(repo, baseCommit);
  const headObj = getObject(repo, pr.headSha);
  const baseFiles = baseObj && baseObj.type === 'commit' ? treeToFiles(repo, parseCommit(baseObj.data).tree) : new Map<string, FileEntry>();
  const headFiles = headObj && headObj.type === 'commit' ? treeToFiles(repo, parseCommit(headObj.data).tree) : new Map<string, FileEntry>();
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: PrFile[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = baseFiles.get(path);
    const newEntry = headFiles.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    const oldText = oldEntry ? (getObject(repo, oldEntry.oid)?.data.toString('utf8') ?? '') : '';
    const newText = newEntry ? (getObject(repo, newEntry.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    let status = 'modified';
    if (!oldEntry) status = 'added';
    else if (!newEntry) status = 'removed';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** Three-way squash merge. Returns null on conflict. */
export function squashMerge(repo: Repo, pr: PullRequest): { sha: string; message: string } | null {
  const baseCommit = mergeBase(repo, pr.baseSha, pr.headSha);
  if (!baseCommit) return null;
  const baseTipSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTipSha) return null;
  const readFiles = (sha: string): Map<string, FileEntry> => {
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') return new Map();
    return treeToFiles(repo, parseCommit(obj.data).tree);
  };
  const baseFiles = readFiles(baseCommit);
  const headFiles = readFiles(pr.headSha);
  const tipFiles = readFiles(baseTipSha);
  // Conflict: a path changed on both sides with different resulting bytes.
  const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of allPaths) {
    const b = baseFiles.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    const t = tipFiles.get(path)?.oid;
    const headChanged = h !== b;
    const tipChanged = t !== b;
    if (headChanged && tipChanged && h !== t) return null;
  }
  // Merged tree: base tip's files, with head's changes applied.
  const merged = new Map<string, FileEntry>(tipFiles);
  for (const path of allPaths) {
    const b = baseFiles.get(path)?.oid;
    const h = headFiles.get(path);
    const headChanged = (h?.oid ?? undefined) !== b;
    if (headChanged) {
      if (h) merged.set(path, h);
      else merged.delete(path);
    }
  }
  const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
  const { commitSha } = commitFiles(repo, pr.baseRef, merged, message);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = trialNowIso();
  pr.mergeCommitSha = commitSha;
  return { sha: commitSha, message };
}

/** Is the PR currently mergeable (no three-way conflict)? */
export function prMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.merged) return 'UNKNOWN';
  const baseCommit = mergeBase(repo, pr.baseSha, pr.headSha);
  if (!baseCommit) return 'UNKNOWN';
  const baseTipSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTipSha) return 'UNKNOWN';
  const readFiles = (sha: string): Map<string, FileEntry> => {
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') return new Map();
    return treeToFiles(repo, parseCommit(obj.data).tree);
  };
  const baseFiles = readFiles(baseCommit);
  const headFiles = readFiles(pr.headSha);
  const tipFiles = readFiles(baseTipSha);
  const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of allPaths) {
    const b = baseFiles.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    const t = tipFiles.get(path)?.oid;
    if (h !== b && t !== b && h !== t) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
