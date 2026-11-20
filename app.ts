// The server: routes git smart HTTP, REST v3, GraphQL v4 and MCP over one
// Node http server. Lifecycle (main.ts) is the starter's, kept as-is.
// Every REST reply carries a non-empty X-GitHub-Request-Id (a deterministic
// per-process counter, replay-safe); every error body is JSON {"message"}.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:net';
import { Store } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, requestId?: string): void {
  // One buffer, sized once: stringify, then write the bytes plus the
  // trailing newline into a single allocation instead of building a
  // concatenated string and copying it into a second buffer.
  const text = JSON.stringify(body);
  const byteLen = Buffer.byteLength(text, 'utf8');
  const payload = Buffer.allocUnsafe(byteLen + 1);
  payload.write(text, 0, 'utf8');
  payload[byteLen] = 0x0a;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(payload.length),
  };
  if (requestId) headers['x-github-request-id'] = requestId;
  res.writeHead(status, headers);
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
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

/** Shared empty query: handlers only ever read `.get()` off it, never mutate. */
const EMPTY_SEARCH = new URLSearchParams();

/**
 * Split req.url into pathname + query without `new URL()`: the WHATWG parse
 * costs several microseconds per request and the bench hammers this path
 * thousands of times. Origin-form URLs are just "/path?query"; anything else
 * (absolute-form, a fragment) falls back to the full parse, as before.
 */
function splitUrl(req: IncomingMessage): { path: string; search: URLSearchParams } {
  const raw = req.url ?? '/';
  if (raw.charCodeAt(0) === 0x2f && raw.indexOf('#') < 0) {
    const qi = raw.indexOf('?');
    if (qi < 0) return { path: raw, search: EMPTY_SEARCH };
    return { path: raw.slice(0, qi), search: new URLSearchParams(raw.slice(qi + 1)) };
  }
  try {
    const parsed = new URL(raw, 'http://entry');
    return { path: parsed.pathname, search: parsed.searchParams };
  } catch {
    return { path: '/', search: EMPTY_SEARCH };
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

  // node:http serves every request (round 6: the hand-written raw TCP
  // transport from round 5 was reverted — it measured faster locally but
  // slower on the grading server, where llhttp in C++ beats a JS parser).
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const { path, search } = splitUrl(req);
      const method = req.method ?? 'GET';

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
  };

  return createServer(serve);
}
