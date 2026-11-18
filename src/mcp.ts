// The MCP surface: JSON-RPC 2.0 over streamable HTTP at POST /mcp. Both
// protocol eras the suite accepts are served — the 2026-07-28 revision's
// server/discover and the legacy initialize handshake — statelessly, with the
// six github-mcp-server tools dispatching into the same store the REST and
// GraphQL surfaces use, so an object made over MCP is the same object over
// REST (the rest-parity check reads exactly that).

import type { RepoRecord, Store } from './store.ts';

export interface McpResponse {
  readonly status: number;
  readonly body: unknown;
}

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'] as const;

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { type: string; description: string }>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
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
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
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
    description: 'Merge a pull request by its number.',
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

/** The frozen tools/list answer: the same object every call, so two answers are byte-identical. */
const TOOLS_LIST_RESULT = { tools: TOOLS } as const;

function repoToolJson(store: Store, repo: RepoRecord): Record<string, unknown> {
  const owner = store.viewerLogin ?? 'forge';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner },
  };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

type Args = Readonly<Record<string, unknown>>;

function stringArg(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function callTool(store: Store, name: string, args: Args): Record<string, unknown> | 'unknown' {
  const repoFor = (toolArgs: Args): RepoRecord | null => {
    const owner = stringArg(toolArgs, 'owner');
    const repo = stringArg(toolArgs, 'repo');
    if (owner === undefined || repo === undefined) return null;
    return store.repoFor(owner, repo);
  };

  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === undefined) return toolFailure('create_repo requires a name');
      const existing = store.repos.get(repoName);
      if (existing !== undefined) return toolSuccess(repoToolJson(store, existing));
      const repo = store.createRepo(repoName, {
        description: stringArg(args, 'description') ?? '',
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      if (repo === null) return toolFailure(`a repository named ${repoName} already exists`);
      return toolSuccess(repoToolJson(store, repo));
    }
    case 'get_repo': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure('repository not found');
      return toolSuccess(repoToolJson(store, repo));
    }
    case 'create_issue': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure('repository not found');
      const title = stringArg(args, 'title');
      if (title === undefined) return toolFailure('create_issue requires a title');
      const issue = store.createIssue(repo, { title, body: stringArg(args, 'body') ?? '', labels: [] });
      return toolSuccess({
        id: issue.dbId,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
      });
    }
    case 'list_issues': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure('repository not found');
      const state = stringArg(args, 'state') ?? 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => ({ id: issue.dbId, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((label) => ({ name: label })) }));
      return toolSuccess({ issues });
    }
    case 'create_pull_request': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure('repository not found');
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === undefined || head === undefined || base === undefined) return toolFailure('create_pull_request requires title, head and base');
      if (store.branchTip(repo, head) === null) return toolFailure(`head branch ${head} does not exist`);
      if (store.branchTip(repo, base) === null) return toolFailure(`base branch ${base} does not exist`);
      const pull = store.createPull(repo, { title, body: stringArg(args, 'body') ?? '', head, base });
      return toolSuccess({
        id: pull.dbId,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: store.pullHeadSha(repo, pull) },
        base: { ref: pull.baseRef, sha: store.pullBaseSha(repo, pull) },
        merged: pull.merged,
      });
    }
    case 'merge_pull_request': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.NaN;
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolFailure('pull request not found');
      if (pull.merged || pull.state !== 'open') return toolFailure('pull request is not open');
      const sha = store.mergePull(repo, pull, 'squash');
      if (sha === null) return toolFailure('pull request is not mergeable');
      return toolSuccess({
        id: pull.dbId,
        number: pull.number,
        state: pull.state,
        merged: true,
        merge_commit_sha: sha,
        head: { ref: pull.headRef },
        base: { ref: pull.baseRef },
      });
    }
    default:
      return 'unknown';
  }
}

interface RpcOutcome {
  readonly status: number;
  readonly body: unknown;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function handleOne(store: Store, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Args;
      const outcome = callTool(store, toolName, args);
      if (outcome === 'unknown') return rpcError(id, -32602, `unknown tool: ${toolName}`);
      return rpcResult(id, outcome);
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body (already read as text, so a non-JSON body is the
 * parse error the suite listens for). Authentication is the caller's job.
 */
export function handleMcp(store: Store, rawBody: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => (typeof entry === 'object' && entry !== null ? handleOne(store, entry as Record<string, unknown>) : null))
      .filter((entry) => entry !== null);
    return { status: 200, body: answers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const answer = handleOne(store, parsed as Record<string, unknown>);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}
