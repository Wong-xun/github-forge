// Shared store: repositories, git objects, issues, pull requests.
// One in-memory store, shared by git, REST, GraphQL and MCP surfaces.
// No wall clock, no randomness: ids are deterministic counters; entry-built
// commit timestamps come from MAKEFUN_TRIAL_NOW (or a fixed epoch).

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const SCENARIO_EPOCH_SEC = 1735689600;

/** Seconds for entry-built commits / merged_at. From MAKEFUN_TRIAL_NOW, else fixed. */
export function trialEpochSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 1e9) return Math.floor(asNum);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return SCENARIO_EPOCH_SEC;
}

export function trialNowIso(): string {
  return new Date(trialEpochSec() * 1000).toISOString();
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function objectId(type: ObjectType, data: Buffer): string {
  // Hash the header and the payload in place: the old code copied the whole
  // object into a fresh buffer just to hash it.
  return createHash('sha1').update(`${type} ${data.length}\0`, 'ascii').update(data).digest('hex');
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  issueNumber: number;
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  seq: number;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  nextNumber: number;
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, IssueComment>;
  nextCommentId: number;
  issueSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  repoSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      dbId: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      prs: new Map(),
      nextNumber: 1,
      labels: new Map(),
      comments: new Map(),
      nextCommentId: 1,
      issueSeq: 0,
    };
    this.nextRepoId += 1;
    this.repoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Git object helpers
// ---------------------------------------------------------------------------

export function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const out: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

export function buildCommit(tree: string, parents: string[], message: string, epochSec: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message}\n`;
  return Buffer.from(text, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries (raw order preserved). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (caller sorts git-style first). */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort: directories compare as if suffixed with '/'. */
export function gitEntrySort(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export interface FileEntry {
  oid: string;
  mode: string;
}

/**
 * Build trees from a flat path -> {oid, mode} map, storing every tree object.
 * Returns the root tree oid.
 */
export function buildTreeFromFiles(repo: Repo, files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) {
      entries.push({ mode: entry.mode, name, oid: entry.oid });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    entries.sort(gitEntrySort);
    return storeObject(repo, 'tree', serializeTree(entries));
  };
  return build(root);
}

/** Flatten a tree object into path -> {oid, mode}. Missing tree => empty map. */
export function treeToFiles(repo: Repo, treeOid: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** All objects reachable from the given tips (commits, trees, blobs, tags). */
export function reachable(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Commits reachable from tips, depth-limited: depth 1 = the tips only. */
export function reachableCommits(repo: Repo, tips: string[], maxDepth: number): Set<string> {
  const seen = new Set<string>();
  let frontier = [...tips];
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      next.push(...parseCommit(obj.data).parents);
    }
    frontier = next;
  }
  return seen;
}

/** Is `anc` an ancestor of (or equal to) `desc`? */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** First common ancestor of a and b (BFS from b over a's ancestor set). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    stackA.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  // Index pointer, not shift(): shift() re-indexes the whole queue on every
  // pop, which turns a long history walk quadratic.
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Commits reachable from a tip, newest-first (parent walk order). */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

/** Line diff counts between two blobs (LCS on lines). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  // LCS via DP; test files are small.
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}
