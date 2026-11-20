// Git smart HTTP: pkt-line codec, pack read/write, upload-pack v2/v0,
// receive-pack v0, advertisements, ls-refs.
// Wire details verified against program/env/src/git-client.ts in the kit.

import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  getObject,
  isAncestor,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  reachable,
  reachableCommits,
  storeObject,
  type ObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  // One allocation: length prefix + payload in a single buffer, instead of
  // building a header buffer and concatenating it onto the body.
  const out = Buffer.allocUnsafe(body.length + 4);
  out.write((body.length + 4).toString(16).padStart(4, '0'), 0, 'ascii');
  body.copy(out, 4);
  return out;
}

/** Chunk `data` into sideband band-`band` pkt-line packets (side-band-64k:
 * at most 65520 data bytes per packet, plus the 1 band byte and 4 length bytes). */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65520;
  for (let off = 0; ; off += CHUNK) {
    const slice = data.subarray(off, off + CHUNK);
    // Prefix the band byte without an extra Buffer.concat.
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = band;
    slice.copy(framed, 1);
    parts.push(pktLine(framed));
    if (off + CHUNK >= data.length) break;
  }
  return parts;
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export interface PktParseResult {
  packets: Pkt[];
  consumed: number;
}

/** Parse pkt-lines from the start of buf; stops at the first incomplete packet. */
export function parsePktLines(buf: Buffer): PktParseResult {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    // Read the 4-hex-digit length straight off the bytes: the old code cut
    // a substring per packet and ran a regex over it.
    let len = 0;
    let valid = true;
    for (let i = 0; i < 4; i += 1) {
      const c = buf[off + i] as number;
      let digit: number;
      if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
      else if (c >= 0x61 && c <= 0x66) digit = c - 0x61 + 10;
      else if (c >= 0x41 && c <= 0x46) digit = c - 0x41 + 10;
      else {
        valid = false;
        break;
      }
      len = len * 16 + digit;
    }
    if (!valid) break;
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

export function pktLinesToStrings(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfile write (plain objects, no deltas) and read (with delta resolution)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackObject {
  type: ObjectType;
  data: Buffer;
}

export function writePack(objects: PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  // Feed the trailer hash as the pack is built, so the pack is concatenated
  // once at the end instead of twice (once for the hash, once for the trailer).
  const digest = createHash('sha1');
  digest.update(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODE[obj.type];
    const size = obj.data.length;
    // varint header: first byte (type << 4) | (size & 0x0f), then 7-bit groups.
    const bytes: number[] = [];
    let remaining = size >> 4;
    let first = (typeCode << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      bytes.push(b);
    }
    const varint = Buffer.from(bytes);
    // Level 1: a pack only needs a valid zlib stream, and these payloads are
    // small; the fastest level wins back real time on every fetch.
    const deflated = zlib.deflateSync(obj.data, { level: 1 });
    parts.push(varint, deflated);
    digest.update(varint);
    digest.update(deflated);
  }
  parts.push(digest.digest());
  return Buffer.concat(parts);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgtSize || total !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: Map<string, PackObject>;
}

/** Parse a packfile (v2/v3). Resolves OFS_DELTA and REF_DELTA against earlier entries. */
export function readPack(buf: Buffer): ReadPackResult {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, { type: ObjectType; data: Buffer }>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    let b = buf[off];
    off += 1;
    const typeCode = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let byte = buf[off];
      off += 1;
      let negOff = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[off];
        off += 1;
        negOff = ((negOff + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - negOff;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = zlib.inflateSync(buf.subarray(off), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const data = inflated.buffer;
    const consumed = inflated.engine.bytesWritten;
    off += consumed;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      const base = baseOffset !== undefined ? byOffset.get(baseOffset) : baseOid !== undefined ? objects.get(baseOid) : undefined;
      if (!base) throw new Error('delta base not found');
      const resolved = applyDelta(base.data, data);
      const type = base.type;
      const oid = objectId(type, resolved);
      const entry = { type, data: resolved };
      objects.set(oid, entry);
      byOffset.set(entryStart, entry);
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const oid = objectId(type, data);
      const entry = { type, data };
      objects.set(oid, entry);
      byOffset.set(entryStart, entry);
    }
  }
  return { objects };
}

// ---------------------------------------------------------------------------
// Fetch object-set computation
// ---------------------------------------------------------------------------

/** Objects reachable from haves, not walking parents of shallow boundaries. */
function reachableFromHaves(repo: Repo, haves: string[], shallow: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!shallow.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

export interface FetchPlan {
  objects: PackObject[];
  shallow: string[];
  unshallow: string[];
}

export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowKnown: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowKnown);
  const haveObjects = reachableFromHaves(repo, haves, shallowSet);
  let includedCommits: Set<string>;
  let boundary: string[] = [];
  // Objects to send: every object reachable from the wants (including a tag
  // object that IS a want — it points at a commit, no commit points at it),
  // minus what the client already holds.
  const wantObjects = new Set<string>();
  if (depth !== null) {
    // Resolve tag wants to their target commits for the depth walk, and
    // remember the tag objects themselves (sent even in shallow mode).
    const commitWants: string[] = [];
    for (const w of wants) {
      const obj = repo.objects.get(w);
      if (obj?.type === 'tag') {
        wantObjects.add(w);
        commitWants.push(parseTag(obj.data).object);
      } else {
        commitWants.push(w);
      }
    }
    includedCommits = reachableCommits(repo, commitWants, depth);
    // Boundary = included commits whose parents are not included.
    const set = includedCommits;
    for (const oid of set) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => !set.has(p))) boundary.push(oid);
    }
    for (const oid of includedCommits) {
      wantObjects.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const tree = parseCommit(obj.data).tree;
      for (const t of reachable(repo, [tree])) wantObjects.add(t);
    }
  } else {
    const all = reachable(repo, wants);
    for (const oid of all) wantObjects.add(oid);
    includedCommits = new Set<string>();
    for (const oid of all) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') includedCommits.add(oid);
    }
  }
  const unshallow: string[] = [];
  for (const s of shallowKnown) {
    if (includedCommits.has(s)) {
      const obj = repo.objects.get(s);
      if (obj && obj.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        if (parents.some((p) => includedCommits.has(p))) unshallow.push(s);
      }
    }
  }
  const send = [...wantObjects].filter((oid) => !haveObjects.has(oid));
  send.sort();
  const objects: PackObject[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  boundary.sort();
  unshallow.sort();
  return { objects, shallow: boundary, unshallow };
}

// ---------------------------------------------------------------------------
// HTTP helpers (shared with the app router via a small interface)
// ---------------------------------------------------------------------------

export interface GitCtx {
  store: { getRepo(owner: string, name: string): Repo | undefined };
  token: string;
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8');
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

const UPLOAD_V0_CAPS =
  'side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main agent=github-forge/1.0';
const RECEIVE_V0_CAPS =
  'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=github-forge/1.0';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    out.push({ oid, name });
    const obj = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      out.push({ oid: parseTag(obj.data).object, name: `${name}^{}`, peeled: parseTag(obj.data).object });
    }
  }
  return out;
}

function refLinesWithPeel(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (name.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      peeled = parseTag(obj.data).object;
    }
    out.push({ oid, name, peeled });
  }
  return out;
}

function headTip(repo: Repo): string {
  return repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(pktLine(`${ZERO_OID} HEAD\n`));
  } else {
    const tip = headTip(repo);
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** The v2 capability advertisement never changes: build it once, not per request. */
const V2_ADVERTISEMENT = v2Advertisement();

// ---------------------------------------------------------------------------
// Git routes
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GitCtx,
  method: string,
  pathname: string,
  search: URLSearchParams,
): Promise<boolean> {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const action = m[3];
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) return false;
  const repo = ctx.store.getRepo(owner, repoName);

  if (action === 'info/refs') {
    const service = search.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendText(res, 400, 'unknown service');
      return true;
    }
    if (!repo) {
      sendText(res, 404, 'repository not found');
      return true;
    }
    const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    if (wantV2) {
      sendBuffer(res, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
    } else {
      sendBuffer(
        res,
        200,
        v0Advertisement(repo, service),
        service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement',
      );
    }
    return true;
  }

  if (action === 'git-upload-pack') {
    if (method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return true;
    }
    if (!repo) {
      sendText(res, 404, 'repository not found');
      return true;
    }
    const body = await readBody(req);
    const { packets } = parsePktLines(body);
    const lines = pktLinesToStrings(packets);
    const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim();
    if (command === 'ls-refs') {
      return handleLsRefs(res, repo, lines);
    }
    if (command === 'fetch') {
      return handleFetchV2(res, repo, lines);
    }
    // v0 fetch: want/have lines.
    if (lines.some((l) => l.startsWith('want '))) {
      return handleFetchV0(res, repo, lines);
    }
    sendText(res, 400, 'unknown git-upload-pack command');
    return true;
  }

  if (action === 'git-receive-pack') {
    if (method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return true;
    }
    if (!repo) {
      sendText(res, 404, 'repository not found');
      return true;
    }
    const body = await readBody(req);
    return handleReceivePack(res, repo, body);
  }
  return false;
}

function handleLsRefs(res: ServerResponse, repo: Repo, lines: string[]): boolean {
  const peel = lines.some((l) => l.trim() === 'peel');
  const symrefs = lines.some((l) => l.trim() === 'symrefs');
  const prefixes: string[] = [];
  for (const l of lines) {
    if (l.startsWith('ref-prefix ')) prefixes.push(l.slice('ref-prefix '.length).trim());
  }
  const tip = headTip(repo);
  const out: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (keep('HEAD') && tip !== ZERO_OID) {
    out.push(pktLine(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  }
  for (const r of refLinesWithPeel(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.peeled) line += ` peeled:${r.peeled}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
  return true;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < pack.length; off += MAX) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX));
    const framed = Buffer.allocUnsafe(chunk.length + 1);
    framed[0] = 1;
    chunk.copy(framed, 1);
    out.push(pktLine(framed));
  }
  if (pack.length === 0) {
    out.push(pktLine(Buffer.from([1])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch response cache
// ---------------------------------------------------------------------------
//
// A fetch response is a pure function of (repo, wants, haves, shallow,
// depth, protocol version): git objects are content-addressed and immutable
// once stored, and a want's reachable set is fixed by its own bytes, so
// objects pushed later can never change the answer for the same inputs.
// The cache is keyed per Repo object — a deleted-and-recreated repo is a
// new object, so it can never collide with the old one's entries — and
// bounded, so a large pack cannot grow memory without limit.
const FETCH_CACHE_MAX_ENTRIES = 32;
const FETCH_CACHE_MAX_BYTES = 1_000_000;
const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();

function fetchCacheKey(version: 0 | 2, args: FetchArgs): string {
  return `${version}|${args.depth ?? ''}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}`;
}

function fetchCacheGet(repo: Repo, key: string): Buffer | undefined {
  return fetchCache.get(repo)?.get(key);
}

function fetchCachePut(repo: Repo, key: string, body: Buffer): void {
  if (body.length > FETCH_CACHE_MAX_BYTES) return;
  let perRepo = fetchCache.get(repo);
  if (!perRepo) {
    perRepo = new Map<string, Buffer>();
    fetchCache.set(repo, perRepo);
  }
  if (perRepo.size >= FETCH_CACHE_MAX_ENTRIES) {
    const oldest = perRepo.keys().next().value;
    if (oldest !== undefined) perRepo.delete(oldest);
  }
  perRepo.set(key, body);
}

function handleFetchV2(res: ServerResponse, repo: Repo, lines: string[]): boolean {
  const args = parseFetchArgs(lines);
  const key = fetchCacheKey(2, args);
  const hit = fetchCacheGet(repo, key);
  if (hit) {
    sendBuffer(res, 200, hit, 'application/x-git-upload-pack-result');
    return true;
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(repo, key, body);
  sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
  return true;
}

function handleFetchV0(res: ServerResponse, repo: Repo, lines: string[]): boolean {
  const args = parseFetchArgs(lines);
  const key = fetchCacheKey(0, args);
  const hit = fetchCacheGet(repo, key);
  if (hit) {
    sendBuffer(res, 200, hit, 'application/x-git-upload-pack-result');
    return true;
  }
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) parts.push(pktLine('NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(repo, key, body);
  sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
  return true;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): boolean {
  const { packets, consumed } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.trim();
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef) {
    const packBytes = body.subarray(consumed);
    if (packBytes.length > 0) {
      try {
        const { objects } = readPack(packBytes);
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, data: obj.data });
        }
      } catch (err) {
        unpackOk = false;
        reportLines.push(`unpack ${err instanceof Error ? err.message.replace(/\n/g, ' ') : 'unpack error'}`);
      }
    }
  }
  if (unpackOk) reportLines.push('unpack ok');
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} not found`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current === undefined || current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (newObj.type === 'commit' && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }
  // Report: pkt-lined report-status INSIDE sideband band 1 (verified against
  // real git http-backend: one band-1 packet carrying the pkt-lined report +
  // its flush, then the outer flush). A raw line inside band 1 makes git's
  // report parser read 'unpa' as a pkt-line length and fail.
  const report = Buffer.concat([
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    PKT_FLUSH,
  ]);
  const parts: Buffer[] = [...sidebandPackets(1, report), PKT_FLUSH];
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  return true;
}

// Re-exported for the REST layer (contents / merge commit creation).
export { storeObject };
