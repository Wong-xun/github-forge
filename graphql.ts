// GraphQL v4 executor: a small parser for the documents gh and
// github-mcp-server send, plus resolvers over the shared store.
// Wire rules verified against checks-graphql.ts / graphql-client.ts:
// - HTTP 200 with {data} on success; GraphQL errors are HTTP 200 with an
//   errors array (except unauthenticated -> 401, handled by the router).
// - JSON-array bodies are batched, results in order.
// - Unknown repository -> data.repository = null, no errors.
// - Global ids are opaque base64, never the plain numeric id.

import { VIEWER_ID, VIEWER_LOGIN, type PullRequest, type Repo, type Store } from './store.ts';
import { prFiles, prMergeable, squashMerge } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer / parser (subset of GraphQL: enough for the suite's documents)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let num = '';
      if (input[j] === '-') {
        num += '-';
        j += 1;
      }
      while (j < input.length && /[0-9]/.test(input[j])) {
        num += input[j];
        j += 1;
      }
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        num += '.';
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) {
          num += input[j];
          j += 1;
        }
      }
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(num) } : { kind: 'int', value: parseInt(num, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      let name = '';
      while (j < input.length && isNameChar(input[j])) {
        name += input[j];
        j += 1;
      }
      tokens.push({ kind: 'name', value: name });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection?: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition?: string; selection: SelectionNode[] };

export interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}`);
  }

  private peekPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected a name');
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const n = this.peek();
    if (n && n.kind === 'name') name = this.next().value;
    const variables: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peekPunct('(')) {
      this.next();
      while (!this.peekPunct(')')) {
        this.expectPunct('$');
        const vname = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peekPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: vname, defaultValue });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseType(): void {
    if (this.peekPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peekPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.peekPunct('}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t && t.kind === 'spread') {
      this.next();
      let typeCondition: string | undefined;
      const n = this.peek();
      if (n && n.kind === 'name' && n.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selection = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selection };
    }
    let alias: string | undefined;
    let name = this.expectName();
    if (this.peekPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peekPunct('(')) {
      this.next();
      while (!this.peekPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        const value = this.parseValue();
        args.push({ name: argName, value });
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | undefined;
    if (this.peekPunct('{')) selection = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.peekPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.peekPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function resolveValue(node: ValueNode, variables: Record<string, JsonValue>): JsonValue {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: { [key: string]: JsonValue } = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, JsonValue>): JsonValue {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined as unknown as JsonValue;
  return resolveValue(arg.value, variables);
}

// ---------------------------------------------------------------------------
// Global ids (opaque base64, never the plain numeric id)
// ---------------------------------------------------------------------------

function gid(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', [repo.dbId]);
}

function issueGid(repo: Repo, number: number): string {
  return gid('Issue', [repo.dbId, number]);
}

function prGid(repo: Repo, number: number): string {
  return gid('PullRequest', [repo.dbId, number]);
}

function commentGid(repo: Repo, commentId: number): string {
  return gid('IssueComment', [repo.dbId, commentId]);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Introspection data
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
    'description',
  ],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  FileConnection: ['nodes'],
  File: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Ref: ['name'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface GraphQLCtx {
  store: Store;
}

type AnyObj = { [key: string]: unknown };

interface ExecState {
  errors: { message: string }[];
}

interface TypedValue {
  __typename: string;
  value: AnyObj;
}

const VIEWER: TypedValue = {
  __typename: 'User',
  value: { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' },
};

function repoTyped(repo: Repo): TypedValue {
  return { __typename: 'Repository', value: { __repo: repo } };
}

function issueTyped(repo: Repo, number: number): TypedValue {
  return { __typename: 'Issue', value: { __repo: repo, __number: number } };
}

function prTyped(repo: Repo, number: number): TypedValue {
  return { __typename: 'PullRequest', value: { __repo: repo, __number: number } };
}

export function executeGraphQL(ctx: GraphQLCtx, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((op) => executeOne(ctx, op));
  }
  return executeOne(ctx, body);
}

function executeOne(ctx: GraphQLCtx, body: unknown): unknown {
  const state: ExecState = { errors: [] };
  try {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { data: null, errors: [{ message: 'request body must be an object' }] };
    }
    const b = body as AnyObj;
    const query = typeof b.query === 'string' ? b.query : '';
    const variables = (b.variables ?? {}) as Record<string, JsonValue>;
    if (!query) return { data: null, errors: [{ message: 'query is required' }] };
    const ops = new Parser(lex(query)).parseDocument();
    const opName = typeof b.operationName === 'string' ? b.operationName : undefined;
    let op = ops[0];
    if (opName) {
      const found = ops.find((o) => o.name === opName);
      if (found) op = found;
    }
    if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
    const vars: Record<string, JsonValue> = { ...variables };
    for (const v of op.variables) {
      if (!(v.name in vars) && v.defaultValue) vars[v.name] = resolveValue(v.defaultValue, vars);
    }
    const data = executeSelection(ctx, state, op.selection, null, vars, op.kind);
    const out: AnyObj = { data };
    if (state.errors.length) out.errors = state.errors;
    return out;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

function executeSelection(
  ctx: GraphQLCtx,
  state: ExecState,
  selection: SelectionNode[],
  parent: TypedValue | null,
  variables: Record<string, JsonValue>,
  opKind: 'query' | 'mutation',
): AnyObj {
  const out: AnyObj = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (!parent) continue;
      if (sel.typeCondition && sel.typeCondition !== parent.__typename) continue;
      const inner = executeSelection(ctx, state, sel.selection, parent, variables, opKind);
      Object.assign(out, inner);
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    try {
      out[key] = resolveField(ctx, state, field, parent, variables, opKind);
    } catch (err) {
      state.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function knownFields(typename: string): string[] {
  if (typename === 'Query') {
    return ['viewer', 'repository', 'node', '__type'];
  }
  if (typename === 'Mutation') {
    return ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
  }
  if (typename === 'CreateIssuePayload' || typename === 'CloseIssuePayload') return ['issue'];
  if (typename === 'CreatePullRequestPayload' || typename === 'MergePullRequestPayload') return ['pullRequest'];
  if (typename === 'AddCommentPayload') return ['commentEdge'];
  if (typename === 'CommentEdge') return ['node'];
  if (typename === 'IssueComment') return ['id', 'body'];
  if (typename === '__Type') return ['fields', 'enumValues', 'name'];
  if (typename === 'Field' || typename === 'EnumValue') return ['name'];
  return TYPE_FIELDS[typename] ?? [];
}

function resolveField(
  ctx: GraphQLCtx,
  state: ExecState,
  field: FieldNode,
  parent: TypedValue | null,
  variables: Record<string, JsonValue>,
  opKind: 'query' | 'mutation',
): unknown {
  const typename = parent ? parent.__typename : opKind === 'mutation' ? 'Mutation' : 'Query';
  if (!knownFields(typename).includes(field.name)) {
    throw new Error(`Cannot query field "${field.name}" on type "${typename}".`);
  }
  const sub = (value: unknown, sel?: SelectionNode[]): unknown => {
    if (!sel || value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => (isTyped(v) ? executeSelection(ctx, state, sel, v, variables, opKind) : v));
    if (isTyped(value)) return executeSelection(ctx, state, sel, value, variables, opKind);
    return value;
  };
  const sel = field.selection;

  // Root fields.
  if (!parent) {
    if (opKind === 'query') {
      if (field.name === 'viewer') return sub(VIEWER, sel);
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', variables) as string;
        const name = argValue(field, 'name', variables) as string;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = ctx.store.getRepo(owner, name);
        if (!repo) return null;
        return sub(repoTyped(repo), sel);
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', variables) as string;
        const parsed = parseGid(id);
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const dbId = parseInt(parsed.parts[0], 10);
          for (const repo of ctx.store.repos.values()) {
            if (repo.dbId === dbId) return sub(repoTyped(repo), sel);
          }
          return null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', variables) as string;
        return sub({ __typename: '__Type', value: { __typeName: name } }, sel);
      }
    } else {
      return resolveMutation(ctx, state, field, variables);
    }
  }

  // __Type meta-fields.
  if (parent.__typename === '__Type') {
    const typeName = parent.value.__typeName as string;
    if (field.name === 'fields') {
      return sub((TYPE_FIELDS[typeName] ?? []).map((n) => ({ __typename: 'Field', value: { name: n } })), sel);
    }
    if (field.name === 'enumValues') {
      return sub((TYPE_ENUM_VALUES[typeName] ?? []).map((n) => ({ __typename: 'EnumValue', value: { name: n } })), sel);
    }
    if (field.name === 'name') return typeName;
    return null;
  }

  // Field pseudo-type (introspection field entries).
  if (parent.__typename === 'Field' || parent.__typename === 'EnumValue') {
    if (field.name === 'name') return parent.value.name;
    return null;
  }

  // Mutation payload wrappers.
  if (parent.__typename === 'CreateIssuePayload' || parent.__typename === 'CloseIssuePayload') {
    if (field.name === 'issue') return sub(parent.value.__issue as TypedValue, sel);
    return null;
  }
  if (parent.__typename === 'CreatePullRequestPayload' || parent.__typename === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return sub(parent.value.__pr as TypedValue, sel);
    return null;
  }
  if (parent.__typename === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return sub(parent.value.__commentEdge as TypedValue, sel);
    return null;
  }
  if (parent.__typename === 'CommentEdge') {
    if (field.name === 'node') return sub(parent.value.__node as TypedValue, sel);
    return null;
  }
  if (parent.__typename === 'IssueComment') {
    if (field.name === 'id') return parent.value.id;
    if (field.name === 'body') return parent.value.body;
    return null;
  }

  // User.
  if (parent.__typename === 'User') {
    const v = parent.value as AnyObj;
    if (field.name === 'login') return v.login;
    if (field.name === 'id') return String(v.id);
    if (field.name === 'name') return v.name;
    if (field.name === 'email') return v.email;
    return null;
  }

  // Repository.
  if (parent.__typename === 'Repository') {
    const repo = parent.value.__repo as Repo;
    switch (field.name) {
      case 'id':
        return repoGid(repo);
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'description':
        return repo.description;
      case 'owner':
        return sub(VIEWER, sel);
      case 'defaultBranchRef':
        return sub({ __typename: 'Ref', value: { name: repo.defaultBranch } }, sel);
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const n = argValue(field, 'number', variables) as number;
        const issue = repo.issues.get(n);
        if (!issue) return null;
        return sub(issueTyped(repo, n), sel);
      }
      case 'issues': {
        const first = (argValue(field, 'first', variables) as number | undefined) ?? 100;
        const after = argValue(field, 'after', variables) as string | null | undefined;
        const states = argValue(field, 'states', variables) as string[] | undefined;
        const orderBy = argValue(field, 'orderBy', variables) as { field?: string; direction?: string } | undefined;
        let list = [...repo.issues.values()];
        if (states && states.length) {
          list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        if (orderBy && orderBy.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        } else {
          list.sort((a, b) => a.seq - b.seq);
        }
        let start = 0;
        if (after) {
          const n = numberFromCursor(after);
          if (n !== null) {
            const idx = list.findIndex((i) => i.number === n);
            if (idx >= 0) start = idx + 1;
          }
        }
        const page = list.slice(start, start + first);
        const hasNext = start + first < list.length;
        const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
        return sub(
          {
            __typename: 'IssueConnection',
            value: {
              __nodes: page.map((i) => issueTyped(repo, i.number)),
              __pageInfo: { hasNextPage: hasNext, endCursor },
            },
          },
          sel,
        );
      }
      case 'pullRequests': {
        const first = (argValue(field, 'first', variables) as number | undefined) ?? 100;
        const list = [...repo.prs.values()].sort((a, b) => a.seq - b.seq).slice(0, first);
        return sub(
          {
            __typename: 'PullRequestConnection',
            value: {
              __nodes: list.map((p) => prTyped(repo, p.number)),
              __pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          sel,
        );
      }
      case 'pullRequest': {
        const n = argValue(field, 'number', variables) as number;
        const pr = repo.prs.get(n);
        if (!pr) return null;
        return sub(prTyped(repo, n), sel);
      }
      default:
        return null;
    }
  }

  // Ref.
  if (parent.__typename === 'Ref') {
    if (field.name === 'name') return parent.value.name;
    return null;
  }

  // Connections.
  if (parent.__typename === 'IssueConnection' || parent.__typename === 'PullRequestConnection') {
    if (field.name === 'nodes') {
      const nodes = parent.value.__nodes as TypedValue[];
      if (!sel) return nodes.map((n) => n.value);
      return nodes.map((n) => executeSelection(ctx, state, sel, n, variables, opKind));
    }
    if (field.name === 'pageInfo') {
      const info = parent.value.__pageInfo as AnyObj;
      return sub({ __typename: 'PageInfo', value: info }, sel);
    }
    return null;
  }

  if (parent.__typename === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.value.hasNextPage;
    if (field.name === 'endCursor') return parent.value.endCursor;
    return null;
  }

  // Issue.
  if (parent.__typename === 'Issue') {
    const repo = parent.value.__repo as Repo;
    const issue = repo.issues.get(parent.value.__number as number);
    if (!issue) return null;
    switch (field.name) {
      case 'id':
        return issueGid(repo, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      default:
        return null;
    }
  }

  // PullRequest.
  if (parent.__typename === 'PullRequest') {
    const repo = parent.value.__repo as Repo;
    const pr = repo.prs.get(parent.value.__number as number);
    if (!pr) return null;
    switch (field.name) {
      case 'id':
        return prGid(repo, pr.number);
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'body':
        return pr.body;
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'mergeable':
        return prMergeable(repo, pr);
      case 'state':
        return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pr.merged;
      case 'files': {
        const first = (argValue(field, 'first', variables) as number | undefined) ?? 100;
        const files = prFiles(repo, pr).slice(0, first);
        return sub(
          {
            __typename: 'FileConnection',
            value: { __nodes: files.map((f) => ({ __typename: 'File', value: { path: f.filename } })) },
          },
          sel,
        );
      }
      default:
        return null;
    }
  }

  // FileConnection / File.
  if (parent.__typename === 'FileConnection') {
    if (field.name === 'nodes') {
      const nodes = parent.value.__nodes as TypedValue[];
      if (!sel) return nodes.map((n) => n.value);
      return nodes.map((n) => executeSelection(ctx, state, sel, n, variables, opKind));
    }
    return null;
  }
  if (parent.__typename === 'File') {
    if (field.name === 'path') return parent.value.path;
    return null;
  }

  return null;
}

function isTyped(v: unknown): v is TypedValue {
  return typeof v === 'object' && v !== null && '__typename' in v && 'value' in v;
}

function resolveMutation(ctx: GraphQLCtx, state: ExecState, field: FieldNode, variables: Record<string, JsonValue>): unknown {
  const input = argValue(field, 'input', variables) as AnyObj | undefined;
  if (!input || typeof input !== 'object') throw new Error(`mutation ${field.name} requires an input object`);
  const sel = field.selection;
  const sub = (value: unknown): unknown => {
    if (!sel || value === null || value === undefined) return value;
    if (isTyped(value)) return executeSelection(ctx, state, sel, value, variables, 'mutation');
    return value;
  };

  if (field.name === 'createIssue') {
    const repo = repoFromGid(ctx, input.repositoryId as string);
    if (!repo) throw new Error('repository not found');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue = {
      number,
      id: repo.dbId * 1000000 + number,
      title: (input.title as string) ?? '',
      body: (input.body as string) ?? '',
      state: 'open' as const,
      labels: [] as string[],
      seq: repo.issueSeq,
    };
    repo.issueSeq += 1;
    repo.issues.set(number, issue);
    return sub({ __typename: 'CreateIssuePayload', value: { __issue: issueTyped(repo, number) } });
  }

  if (field.name === 'closeIssue') {
    const found = issueFromGid(ctx, input.issueId as string);
    if (!found) throw new Error('issue not found');
    found.issue.state = 'closed';
    return sub({ __typename: 'CloseIssuePayload', value: { __issue: issueTyped(found.repo, found.issue.number) } });
  }

  if (field.name === 'createPullRequest') {
    const repo = repoFromGid(ctx, input.repositoryId as string);
    if (!repo) throw new Error('repository not found');
    const baseRef = (input.baseRefName as string) ?? repo.defaultBranch;
    const headRef = (input.headRefName as string) ?? '';
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) throw new Error('head or base branch not found');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pr: PullRequest = {
      number,
      id: repo.dbId * 1000000 + number,
      title: (input.title as string) ?? '',
      body: '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
      seq: repo.issueSeq,
    };
    repo.issueSeq += 1;
    repo.prs.set(number, pr);
    return sub({ __typename: 'CreatePullRequestPayload', value: { __pr: prTyped(repo, number) } });
  }

  if (field.name === 'mergePullRequest') {
    const found = prFromGid(ctx, input.pullRequestId as string);
    if (!found) throw new Error('pull request not found');
    if (found.pr.merged) throw new Error('pull request is already merged');
    const result = squashMerge(found.repo, found.pr);
    if (!result) throw new Error('merge conflict');
    return sub({ __typename: 'MergePullRequestPayload', value: { __pr: prTyped(found.repo, found.pr.number) } });
  }

  if (field.name === 'addComment') {
    const found = issueFromGid(ctx, input.subjectId as string);
    if (!found) throw new Error('subject not found');
    const id = found.repo.nextCommentId;
    found.repo.nextCommentId += 1;
    found.repo.comments.set(id, { id, body: (input.body as string) ?? '', issueNumber: found.issue.number });
    return sub({
      __typename: 'AddCommentPayload',
      value: {
        __commentEdge: {
          __typename: 'CommentEdge',
          value: { __node: { __typename: 'IssueComment', value: { id: commentGid(found.repo, id), body: input.body as string } } },
        },
      },
    });
  }

  throw new Error(`unknown mutation ${field.name}`);
}

function repoFromGid(ctx: GraphQLCtx, id: string): Repo | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const dbId = parseInt(parsed.parts[0], 10);
  for (const repo of ctx.store.repos.values()) {
    if (repo.dbId === dbId) return repo;
  }
  return null;
}

function issueFromGid(ctx: GraphQLCtx, id: string): { repo: Repo; issue: NonNullable<ReturnType<Repo['issues']['get']>> } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const dbId = parseInt(parsed.parts[0], 10);
  const number = parseInt(parsed.parts[1], 10);
  for (const repo of ctx.store.repos.values()) {
    if (repo.dbId === dbId) {
      const issue = repo.issues.get(number);
      if (issue) return { repo, issue };
    }
  }
  return null;
}

function prFromGid(ctx: GraphQLCtx, id: string): { repo: Repo; pr: PullRequest } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const dbId = parseInt(parsed.parts[0], 10);
  const number = parseInt(parsed.parts[1], 10);
  for (const repo of ctx.store.repos.values()) {
    if (repo.dbId === dbId) {
      const pr = repo.prs.get(number);
      if (pr) return { repo, pr };
    }
  }
  return null;
}
