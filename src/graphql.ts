// The GraphQL v4 surface: a small lexer, parser and executor covering the
// documents gh and github-mcp-server actually send — viewer and repository
// reads, __type introspection, issue/pull-request connections with cursor
// pagination, node(id:) over opaque global ids, operation batching, and the
// five mutations. Unknown fields answer a 200 with an `errors` array naming
// the field, the way GitHub answers them.

import type { CommentRecord, FileChange, IssueRecord, PullRecord, RepoRecord, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'eof'; readonly value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const esc = source[index + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 4;
          } else value += esc;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (index >= source.length) throw new Error('unterminated string');
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = index;
      while (end < source.length && /[0-9.eE+-]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'number', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = index;
      while (end < source.length && /[_0-9A-Za-z]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type Value =
  | { readonly kind: 'var'; readonly name: string }
  | { readonly kind: 'scalar'; readonly value: unknown }
  | { readonly kind: 'list'; readonly items: readonly Value[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, Value> };

interface FieldNode {
  readonly name: string;
  readonly alias?: string;
  readonly args: ReadonlyMap<string, Value>;
  readonly selection: readonly SelectionNode[];
}

type SelectionNode =
  | { readonly kind: 'field'; readonly field: FieldNode }
  | { readonly kind: 'inline'; readonly typeCondition: string; readonly selection: readonly SelectionNode[] }
  | { readonly kind: 'spread'; readonly name: string };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name?: string;
  readonly selection: readonly SelectionNode[];
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, { typeCondition: string; selection: readonly SelectionNode[] }>;
}

class Parser {
  private position = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private next(): Token {
    return this.tokens[this.position++] as Token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: readonly SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: keyword, name, selection: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'eof') throw new Error('unterminated directive arguments');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): readonly SelectionNode[] {
    this.expectPunct('{');
    const selection: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.atPunct('...')) {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selection.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selection.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      selection.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selection;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, Value>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    this.next();
    if (token.kind === 'string') return { kind: 'scalar', value: token.value };
    if (token.kind === 'number') return { kind: 'scalar', value: token.value.includes('.') ? Number.parseFloat(token.value) : Number.parseInt(token.value, 10) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'scalar', value: true };
      if (token.value === 'false') return { kind: 'scalar', value: false };
      if (token.value === 'null') return { kind: 'scalar', value: null };
      return { kind: 'scalar', value: token.value }; // an enum, carried as its name
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(value: Value, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'scalar':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, field] of value.fields) out[name] = resolveValue(field, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema data for introspection
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'commits', 'comments', 'createdAt', 'updatedAt', 'closedAt',
  ],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------------------------

function encodeId(...parts: readonly (string | number)[]): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

function decodeId(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split(':');
  } catch {
    return [];
  }
}

const repoGlobalId = (repo: RepoRecord): string => encodeId('Repository', repo.id);
const issueGlobalId = (repo: RepoRecord, issue: IssueRecord): string => encodeId('Issue', repo.id, issue.number);
const pullGlobalId = (repo: RepoRecord, pull: PullRecord): string => encodeId('PullRequest', repo.id, pull.number);
const commentGlobalId = (comment: CommentRecord): string => encodeId('IssueComment', comment.dbId);

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { readonly type: string; readonly bag: Readonly<Record<string, unknown>> }
  | string
  | number
  | boolean
  | null;

interface ExecCtx {
  readonly store: Store;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: DocumentNode['fragments'];
  readonly errors: { message: string }[];
}

class FieldError extends Error {}

function obj(type: string, bag: Record<string, unknown>): GqlValue {
  return { type, bag };
}

function isObj(value: GqlValue): value is { type: string; bag: Readonly<Record<string, unknown>> } {
  return typeof value === 'object' && value !== null;
}

function argOf(field: FieldNode, ctx: ExecCtx, name: string): unknown {
  const value = field.args.get(name);
  return value === undefined ? undefined : resolveValue(value, ctx.variables);
}

function repoByGlobalId(store: Store, id: unknown): RepoRecord | null {
  if (typeof id !== 'string') return null;
  const [kind, dbId] = decodeId(id);
  if (kind !== 'Repository') return null;
  const wanted = Number.parseInt(dbId ?? '', 10);
  for (const repo of store.repos.values()) if (repo.id === wanted) return repo;
  return null;
}

function issueByGlobalId(store: Store, id: unknown): { repo: RepoRecord; issue: IssueRecord } | null {
  if (typeof id !== 'string') return null;
  const [kind, dbId, numberText] = decodeId(id);
  if (kind !== 'Issue') return null;
  const wanted = Number.parseInt(dbId ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== wanted) continue;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

function pullByGlobalId(store: Store, id: unknown): { repo: RepoRecord; pull: PullRecord } | null {
  if (typeof id !== 'string') return null;
  const [kind, dbId, numberText] = decodeId(id);
  if (kind !== 'PullRequest') return null;
  const wanted = Number.parseInt(dbId ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== wanted) continue;
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

const userObject = (): GqlValue => obj('User', {});

function issueObject(repo: RepoRecord, issue: IssueRecord): GqlValue {
  return obj('Issue', { repo, issue });
}

function pullObject(repo: RepoRecord, pull: PullRecord): GqlValue {
  return obj('PullRequest', { repo, pull });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function issueConnection(ctx: ExecCtx, repo: RepoRecord, field: FieldNode): GqlValue {
  const states = argOf(field, ctx, 'states');
  const orderBy = argOf(field, ctx, 'orderBy') as { field?: string; direction?: string } | undefined;
  const first = argOf(field, ctx, 'first');
  const after = argOf(field, ctx, 'after');
  let list = [...repo.issues.values()];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const descending = orderBy?.direction === 'DESC';
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const number = Number.parseInt(decoded.replace('cursor:', ''), 10);
      const index = list.findIndex((issue) => issue.number === number);
      if (index >= 0) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(start, start + limit);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? cursorOf((page[page.length - 1] as IssueRecord).number) : null;
  return obj('IssueConnection', {
    repo,
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: obj('PageInfo', { hasNextPage, hasPreviousPage: start > 0, startCursor: page.length > 0 ? cursorOf(page[0]?.number ?? 0) : null, endCursor }),
    totalCount: list.length,
  });
}

function resolveField(value: { type: string; bag: Readonly<Record<string, unknown>> }, field: FieldNode, ctx: ExecCtx): unknown {
  const { store } = ctx;
  const name = field.name;
  if (name === '__typename') return value.type;
  if (name in value.bag && (value.type.endsWith('Payload') || value.type.endsWith('Edge') || value.type.endsWith('Connection') || value.type === 'PageInfo')) {
    return value.bag[name];
  }

  switch (value.type) {
    case 'Query': {
      if (name === 'viewer') return userObject();
      if (name === 'repository') {
        const owner = argOf(field, ctx, 'owner');
        const repoName = argOf(field, ctx, 'name');
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        const repo = store.repoFor(owner, repoName);
        return repo === null ? null : obj('Repository', { repo });
      }
      if (name === 'node') {
        const id = argOf(field, ctx, 'id');
        if (typeof id !== 'string') return null;
        const [kind] = decodeId(id);
        if (kind === 'Repository') {
          const repo = repoByGlobalId(store, id);
          return repo === null ? null : obj('Repository', { repo });
        }
        if (kind === 'Issue') {
          const found = issueByGlobalId(store, id);
          return found === null ? null : issueObject(found.repo, found.issue);
        }
        if (kind === 'PullRequest') {
          const found = pullByGlobalId(store, id);
          return found === null ? null : pullObject(found.repo, found.pull);
        }
        return null;
      }
      if (name === '__type') {
        const typeName = argOf(field, ctx, 'name');
        if (typeof typeName !== 'string') return null;
        if (TYPE_FIELDS[typeName] !== undefined) return obj('__Type', { name: typeName, kind: 'OBJECT' });
        if (TYPE_ENUMS[typeName] !== undefined) return obj('__Type', { name: typeName, kind: 'ENUM' });
        return null;
      }
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (argOf(field, ctx, 'input') ?? {}) as { repositoryId?: unknown; title?: unknown; body?: unknown };
        const repo = repoByGlobalId(store, input.repositoryId);
        if (repo === null) throw new FieldError('createIssue: the repository id does not name a repository');
        const issue = store.createIssue(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          labels: [],
        });
        return obj('CreateIssuePayload', { issue: issueObject(repo, issue) });
      }
      if (name === 'closeIssue') {
        const input = (argOf(field, ctx, 'input') ?? {}) as { issueId?: unknown };
        const found = issueByGlobalId(store, input.issueId);
        if (found === null) throw new FieldError('closeIssue: the issue id does not name an issue');
        found.issue.state = 'closed';
        found.issue.closedAt = store.nowSec();
        found.issue.updatedAt = store.nowSec();
        return obj('CloseIssuePayload', { issue: issueObject(found.repo, found.issue) });
      }
      if (name === 'createPullRequest') {
        const input = (argOf(field, ctx, 'input') ?? {}) as { repositoryId?: unknown; baseRefName?: unknown; headRefName?: unknown; title?: unknown; body?: unknown };
        const repo = repoByGlobalId(store, input.repositoryId);
        if (repo === null) throw new FieldError('createPullRequest: the repository id does not name a repository');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
        if (store.branchTip(repo, head) === null) throw new FieldError(`createPullRequest: the head branch ${head} does not exist`);
        if (store.branchTip(repo, base) === null) throw new FieldError(`createPullRequest: the base branch ${base} does not exist`);
        const pull = store.createPull(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head,
          base,
        });
        return obj('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull) });
      }
      if (name === 'mergePullRequest') {
        const input = (argOf(field, ctx, 'input') ?? {}) as { pullRequestId?: unknown; mergeMethod?: unknown };
        const found = pullByGlobalId(store, input.pullRequestId);
        if (found === null) throw new FieldError('mergePullRequest: the pull request id does not name a pull request');
        const sha = store.mergePull(found.repo, found.pull, input.mergeMethod === 'MERGE' ? 'merge' : 'squash');
        if (sha === null) throw new FieldError('mergePullRequest: the pull request is not mergeable');
        return obj('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull) });
      }
      if (name === 'addComment') {
        const input = (argOf(field, ctx, 'input') ?? {}) as { subjectId?: unknown; body?: unknown };
        const found = issueByGlobalId(store, input.subjectId);
        if (found === null) throw new FieldError('addComment: the subject id does not name an issue');
        const comment = store.addComment(found.issue, typeof input.body === 'string' ? input.body : '');
        return obj('AddCommentPayload', {
          commentEdge: obj('IssueCommentEdge', { node: obj('IssueComment', { comment }) }),
        });
      }
      break;
    }
    case 'User': {
      if (name === 'login') return store.viewerLogin ?? 'forge';
      if (name === 'id') return encodeId('User', 1);
      if (name === 'name') return store.viewerLogin ?? 'forge';
      break;
    }
    case '__Type': {
      const typeName = value.bag.name as string;
      if (name === 'name') return typeName;
      if (name === 'kind') return value.bag.kind;
      if (name === 'fields') return (TYPE_FIELDS[typeName] ?? []).map((fieldName) => obj('__Field', { name: fieldName }));
      if (name === 'enumValues') return (TYPE_ENUMS[typeName] ?? []).map((enumName) => obj('__EnumValue', { name: enumName }));
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return value.bag.name;
      break;
    }
    case 'Repository': {
      const repo = value.bag.repo as RepoRecord;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.viewerLogin ?? 'forge'}/${repo.name}`;
        case 'owner': return userObject();
        case 'defaultBranchRef': {
          const tip = store.branchTip(repo, repo.defaultBranch);
          return tip === null ? null : obj('Ref', { name: repo.defaultBranch });
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'createdAt': return store.iso(repo.createdAt);
        case 'updatedAt': return store.iso(repo.updatedAt);
        case 'issue': {
          const number = argOf(field, ctx, 'number');
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          return issue === undefined ? null : issueObject(repo, issue);
        }
        case 'issues': return issueConnection(ctx, repo, field);
        case 'pullRequests': {
          const first = argOf(field, ctx, 'first');
          const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          const page = typeof first === 'number' ? pulls.slice(0, first) : pulls;
          return obj('PullRequestConnection', {
            repo,
            nodes: page.map((pull) => pullObject(repo, pull)),
            totalCount: pulls.length,
          });
        }
        case 'pullRequest': {
          const number = argOf(field, ctx, 'number');
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          return pull === undefined ? null : pullObject(repo, pull);
        }
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return value.bag.name;
      break;
    }
    case 'Issue': {
      const repo = value.bag.repo as RepoRecord;
      const issue = value.bag.issue as IssueRecord;
      switch (name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return userObject();
        case 'repository': return obj('Repository', { repo });
        case 'createdAt': return store.iso(issue.createdAt);
        case 'updatedAt': return store.iso(issue.updatedAt);
        case 'closedAt': return issue.closedAt === null ? null : store.iso(issue.closedAt);
      }
      break;
    }
    case 'PullRequest': {
      const repo = value.bag.repo as RepoRecord;
      const pull = value.bag.pull as PullRecord;
      switch (name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return pull.state !== 'open' ? 'UNKNOWN' : store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'author': return userObject();
        case 'createdAt': return store.iso(pull.createdAt);
        case 'updatedAt': return store.iso(pull.updatedAt);
        case 'files': {
          const first = argOf(field, ctx, 'first');
          const files = store.pullFiles(repo, pull);
          const page = typeof first === 'number' ? files.slice(0, first) : files;
          return obj('PullRequestChangedFileConnection', {
            nodes: page.map((file) => obj('PullRequestChangedFile', { file })),
            totalCount: files.length,
          });
        }
      }
      break;
    }
    case 'PullRequestChangedFile': {
      const file = value.bag.file as FileChange;
      switch (name) {
        case 'path': return file.filename;
        case 'additions': return file.additions;
        case 'deletions': return file.deletions;
        case 'changeType': return file.status.toUpperCase();
      }
      break;
    }
    case 'IssueComment': {
      const comment = value.bag.comment as CommentRecord;
      switch (name) {
        case 'id': return commentGlobalId(comment);
        case 'body': return comment.body;
        case 'author': return userObject();
        case 'createdAt': return store.iso(comment.createdAt);
        case 'updatedAt': return store.iso(comment.updatedAt);
      }
      break;
    }
  }
  throw new FieldError(`Field '${name}' doesn't exist on type '${value.type}'`);
}

function completeValue(value: unknown, selection: readonly SelectionNode[], ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx));
  if (!isObj(value as GqlValue)) return value;
  const object = value as { type: string; bag: Readonly<Record<string, unknown>> };
  if (selection.length === 0) return null;
  const out: Record<string, unknown> = {};
  const applySelection = (nodes: readonly SelectionNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'inline') {
        if (node.typeCondition === object.type) applySelection(node.selection);
        continue;
      }
      if (node.kind === 'spread') {
        const fragment = ctx.fragments.get(node.name);
        if (fragment !== undefined && fragment.typeCondition === object.type) applySelection(fragment.selection);
        continue;
      }
      const field = node.field;
      const key = field.alias ?? field.name;
      try {
        const resolved = resolveField(object, field, ctx);
        out[key] = completeValue(resolved, field.selection, ctx);
      } catch (err) {
        if (err instanceof FieldError) {
          ctx.errors.push({ message: err.message });
          out[key] = null;
        } else {
          throw err;
        }
      }
    }
  };
  applySelection(selection);
  return out;
}

function executeOperation(store: Store, document: DocumentNode, operation: OperationNode, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const ctx: ExecCtx = { store, variables, fragments: document.fragments, errors: [] };
  const root = obj(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
  const data = completeValue(root, operation.selection, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** Execute one GraphQL HTTP body (a single operation or a batch array). */
export function executeGraphQL(store: Store, body: unknown): { status: number; payload: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'the request body is not a GraphQL operation' }] };
    }
    const query = (entry as { query?: unknown }).query;
    const variables = ((entry as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
    const operationName = (entry as { operationName?: unknown }).operationName;
    if (typeof query !== 'string') return { errors: [{ message: 'the operation carries no query string' }] };
    let document: DocumentNode;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: `Syntax Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    const operation = typeof operationName === 'string'
      ? document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]
      : document.operations[0];
    if (operation === undefined) return { errors: [{ message: 'the document carries no operation' }] };
    return executeOperation(store, document, operation, variables);
  };
  if (Array.isArray(body)) return { status: 200, payload: body.map(runOne) };
  return { status: 200, payload: runOne(body) };
}
