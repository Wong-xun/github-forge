// The server: routes git smart HTTP, REST v3, GraphQL v4 and MCP over one
// Node http server. Lifecycle (main.ts) is the starter's, kept as-is.
// Every REST reply carries a non-empty X-GitHub-Request-Id (a deterministic
// per-process counter, replay-safe); every error body is JSON {"message"}.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, requestId?: string): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
  };
  if (requestId) headers['x-github-request-id'] = requestId;
  res.writeHead(status, headers);
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;
  const nextRequestId = (): string => {
    requestCounter += 1;
    return `req-${requestCounter}`;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const search = new URL(req.url ?? '/', 'http://entry').searchParams;

      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (path.includes('.git/')) {
          const handled = await handleGit(req, res, { store, token }, method, path, search);
          if (handled) return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, nextRequestId());
            return;
          }
          const h = req.headers.authorization ?? '';
          const t = h.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : '';
          if (!t || (token && t !== token)) {
            sendJson(res, 401, { message: 'Requires authentication' }, nextRequestId());
            return;
          }
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = raw.length ? (JSON.parse(raw.toString('utf8')) as unknown) : {};
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' }, nextRequestId());
            return;
          }
          const out = executeGraphQL({ store }, body);
          sendJson(res, 200, out, nextRequestId());
          return;
        }

        // MCP.
        if (path === '/mcp') {
          await handleMcp(req, res, { store, token });
          return;
        }

        // REST v3.
        if (path.startsWith('/api/v3')) {
          await handleRest(req, res, { store, token, requestId: nextRequestId }, method, path, search);
          return;
        }

        // Anything else: JSON 404.
        sendJson(res, 404, { message: 'Not Found' }, nextRequestId());
      } catch (err) {
        // Never crash on a request: answer 500 JSON and stay up.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, nextRequestId());
        } else {
          res.end();
        }
      }
    })();
  });
}
