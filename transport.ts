// Raw TCP HTTP/1.1 transport: a node:http-compatible server built on node:net.
//
// Why: the benchmark is dominated by per-request framework cost. Measured
// locally, node:http burns ~200 us of server CPU per small request (a trivial
// 404 costs the same as a real handler), while a hand-rolled parser +
// single-write responder costs ~70 us. The handlers only ever use
// req.method / req.url / req.headers / req.on('data'|'end'|'error') and
// res.writeHead / res.end / res.headersSent, so a small shim over a raw
// socket is enough to keep every handler byte-identical.
//
// Semantics kept: keep-alive (HTTP/1.1 default), Connection: close,
// Content-Length and chunked bodies, Expect: 100-continue, pipelining
// (requests on one connection are answered in order), HEAD responses
// (headers only, body suppressed), a cached Date header. Bodies are
// buffered fully before the handler runs, exactly as the handlers' own
// readBody() does. A request that never gets a response is the client's
// problem, as with node:http; a malformed request gets 400 and the
// connection is closed.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

const REASONS: Record<number, string> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  411: 'Length Required',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

// A Date header refreshed at most once a second (node:http does the same).
let cachedDate = '';
let cachedDateAt = 0;
function dateHeader(): string {
  const now = Date.now();
  if (now - cachedDateAt >= 1000 || cachedDate === '') {
    cachedDate = new Date(now).toUTCString();
    cachedDateAt = now;
  }
  return cachedDate;
}

interface ParsedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  keepAlive: boolean;
  headOnly: boolean;
}

/** Parse one complete request from the front of `buf`, or return null (need more bytes). */
function parseRequest(buf: Buffer): { request: ParsedRequest; consumed: number } | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('headers too large');
    return null;
  }
  const head = buf.subarray(0, headerEnd).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = requestLine.indexOf(' ', firstSpace + 1);
  if (firstSpace < 0 || secondSpace < 0) throw new Error('bad request line');
  const method = requestLine.slice(0, firstSpace);
  const url = requestLine.slice(firstSpace + 1, secondSpace);
  const version = requestLine.slice(secondSpace + 1);
  if (!method || !url || !version.startsWith('HTTP/')) throw new Error('bad request line');

  const headers: Record<string, string | string[] | undefined> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error('bad header line');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers[name];
    if (prev === undefined) headers[name] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else headers[name] = [prev, value];
  }

  const connection = String(headers['connection'] ?? '').toLowerCase();
  const keepAlive =
    connection === 'close' ? false : connection === 'keep-alive' ? true : version !== 'HTTP/1.0';

  const transferEncoding = String(headers['transfer-encoding'] ?? '').toLowerCase();
  const isChunked = transferEncoding.split(',').map((s) => s.trim()).includes('chunked');
  let bodyStart = headerEnd + 4;
  let body: Buffer;
  let consumed: number;

  if (isChunked) {
    // Decode chunked framing from the buffered bytes.
    let pos = bodyStart;
    const parts: Buffer[] = [];
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd < 0) return null;
      const sizeText = buf.subarray(pos, lineEnd).toString('latin1').split(';')[0]?.trim() ?? '';
      const size = parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
      if (size === 0) {
        // Terminal chunk: trailers end at an empty line.
        const trailerEnd = buf.indexOf('\r\n', lineEnd + 2);
        if (trailerEnd < 0) return null;
        // Trailers are ignored (no client we serve sends any we need).
        consumed = trailerEnd + 2;
        break;
      }
      const dataStart = lineEnd + 2;
      const dataEnd = dataStart + size;
      if (buf.length < dataEnd + 2) return null;
      parts.push(buf.subarray(dataStart, dataEnd));
      pos = dataEnd + 2;
      if (parts.reduce((n, p) => n + p.length, 0) > MAX_BODY_BYTES) throw new Error('body too large');
    }
    body = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  } else {
    const lengthRaw = headers['content-length'];
    const length = lengthRaw === undefined ? 0 : parseInt(String(lengthRaw), 10);
    if (!Number.isFinite(length) || length < 0) throw new Error('bad content-length');
    if (length > MAX_BODY_BYTES) throw new Error('body too large');
    if (buf.length < bodyStart + length) return null;
    body = length === 0 ? Buffer.alloc(0) : buf.subarray(bodyStart, bodyStart + length);
    consumed = bodyStart + length;
  }

  return {
    request: { method, url, headers, body, keepAlive, headOnly: method === 'HEAD' },
    consumed,
  };
}

export function createRawServer(handler: HttpHandler): NetServer {
  return createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let busy = false;
    let destroyed = false;
    let expectSent = false;
    const queue: ParsedRequest[] = [];

    const fail = (status: number): void => {
      if (destroyed) return;
      destroyed = true;
      const body = Buffer.from(JSON.stringify({ message: 'Bad Request' }), 'utf8');
      const head = Buffer.from(
        `HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\ndate: ${dateHeader()}\r\n\r\n`,
        'latin1',
      );
      try {
        socket.write(Buffer.concat([head, body]));
      } catch {
        /* the socket is already gone */
      }
      socket.destroy();
    };

    const pump = (): void => {
      if (busy || destroyed) return;
      const next = queue.shift();
      if (next === undefined) return;
      busy = true;
      serve(next);
    };

    const serve = (parsed: ParsedRequest): void => {
      // A Readable shim: the handlers only attach 'data'/'end'/'error'
      // listeners, and a Readable buffers the pushed body until they do,
      // so listener timing can never lose bytes.
      const req = new Readable({ read() {} }) as unknown as IncomingMessage;
      (req as unknown as Record<string, unknown>).method = parsed.method;
      (req as unknown as Record<string, unknown>).url = parsed.url;
      (req as unknown as Record<string, unknown>).headers = parsed.headers;
      if (parsed.body.length > 0) req.push(parsed.body);
      req.push(null);
      // The body is already fully buffered: handlers that read it through
      // readBody() take the fast path instead of the stream round-trip.
      (req as unknown as Record<string, unknown>).__body = parsed.body;

      let status = 200;
      let outHeaders: Record<string, string> = {};
      let headersSent = false;
      let finished = false;

      const finish = (body: Buffer | string | undefined): void => {
        if (finished) return;
        finished = true;
        const bodyBuf =
          body === undefined
            ? Buffer.alloc(0)
            : typeof body === 'string'
              ? Buffer.from(body, 'utf8')
              : body;
        const headers: Record<string, string> = { ...outHeaders };
        // Normalise keys the way node:http does (lowercase, no duplicates).
        const lowered: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
        if (lowered['content-length'] === undefined) {
          lowered['content-length'] = String(bodyBuf.length);
        }
        lowered['connection'] = parsed.keepAlive ? 'keep-alive' : 'close';
        lowered['date'] = dateHeader();
        let head = `HTTP/1.1 ${status} ${REASONS[status] ?? ''}\r\n`;
        for (const [k, v] of Object.entries(lowered)) head += `${k}: ${v}\r\n`;
        head += '\r\n';
        const headBuf = Buffer.from(head, 'latin1');
        const out = parsed.headOnly
          ? headBuf
          : bodyBuf.length === 0
            ? headBuf
            : Buffer.concat([headBuf, bodyBuf]);
        const keepAlive = parsed.keepAlive;
        try {
          const ok = socket.write(out);
          if (!ok) {
            socket.once('drain', () => {
              busy = false;
              if (!keepAlive) socket.end();
              else pump();
            });
            return;
          }
        } catch {
          destroyed = true;
          socket.destroy();
          return;
        }
        busy = false;
        if (!keepAlive) socket.end();
        else pump();
      };

      const pendingBody: Buffer[] = [];
      const res = {
        get headersSent(): boolean {
          return headersSent;
        },
        writeHead(s: number, h: Record<string, string>): void {
          if (headersSent || finished) return;
          status = s;
          outHeaders = { ...h };
          headersSent = true;
        },
        write(chunk: Buffer | string): boolean {
          // No handler uses res.write; support it by treating it as a body
          // fragment that is flushed on end (kept only for safety).
          if (finished) return false;
          pendingBody.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
          return true;
        },
        end(body?: Buffer | string): void {
          if (pendingBody.length > 0) {
            const extra = pendingBody.length === 1 ? (pendingBody[0] as Buffer) : Buffer.concat(pendingBody);
            const base = body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
            finish(Buffer.concat([extra, base]));
          } else {
            finish(body);
          }
        },
      } as unknown as ServerResponse;

      try {
        handler(req, res);
      } catch (err) {
        // The app's own handler never throws synchronously (it wraps in an
        // async IIFE with its own 500 path); this is a last-resort guard.
        if (!finished) {
          const msg = err instanceof Error ? err.message : 'Internal Server Error';
          const body = Buffer.from(JSON.stringify({ message: msg }), 'utf8');
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
          res.end(body);
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      try {
        // Answer Expect: 100-continue as soon as the request headers are
        // in, once per request (reset when a request is consumed below).
        if (!expectSent) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd >= 0) {
            const headText = buf.subarray(0, headerEnd).toString('latin1').toLowerCase();
            if (headText.includes('expect: 100-continue') && !socket.destroyed) {
              socket.write('HTTP/1.1 100 Continue\r\n\r\n');
              expectSent = true;
            }
          }
        }
        for (;;) {
          const parsed = parseRequest(buf);
          if (parsed === null) break;
          buf = buf.subarray(parsed.consumed);
          expectSent = false;
          queue.push(parsed.request);
        }
      } catch {
        fail(400);
        return;
      }
      pump();
    });
    socket.on('error', () => {
      destroyed = true;
    });
    socket.on('close', () => {
      destroyed = true;
    });
  });
}
