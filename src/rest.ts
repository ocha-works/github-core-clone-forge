// The REST v3 surface: the API root, meta, user, repositories, branches,
// commits, contents, labels, issues, comments and pull requests. Serializers
// are shared in spirit with the GraphQL and MCP surfaces but shaped the way
// api.github.com shapes them (lowercase states, head/base objects, numeric
// ids beside the per-repository numbers).

import { parseCommit, parseTree } from './git.ts';
import type { CommentRecord, IssueRecord, PullRecord, RepoRecord, Store } from './store.ts';

export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const notFound = (): RestResponse => ({ status: 404, body: { message: 'Not Found' } });
const invalid = (message: string): RestResponse => ({ status: 422, body: { message } });

interface Ctx {
  readonly store: Store;
  readonly baseUrl: string;
}

function ownerOf(ctx: Ctx): string {
  return ctx.store.viewerLogin ?? 'forge';
}

function userJson(ctx: Ctx): Record<string, unknown> {
  const login = ownerOf(ctx);
  return { login, id: 1, type: 'User', name: login };
}

function repoJson(ctx: Ctx, repo: RepoRecord): Record<string, unknown> {
  const owner = ownerOf(ctx);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.private,
    owner: { login: owner, id: 1, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    created_at: ctx.store.iso(repo.createdAt),
    updated_at: ctx.store.iso(repo.updatedAt),
    pushed_at: ctx.store.iso(repo.updatedAt),
  };
}

function labelJson(repo: RepoRecord, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', default: false, description: null };
}

function issueJson(ctx: Ctx, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(ctx),
    comments: issue.comments.length,
    created_at: ctx.store.iso(issue.createdAt),
    updated_at: ctx.store.iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : ctx.store.iso(issue.closedAt),
  };
}

function commentJson(ctx: Ctx, comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.dbId,
    body: comment.body,
    user: userJson(ctx),
    created_at: ctx.store.iso(comment.createdAt),
    updated_at: ctx.store.iso(comment.updatedAt),
  };
}

function pullJson(ctx: Ctx, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headSha = ctx.store.pullHeadSha(repo, pull) ?? pull.mergeCommitSha ?? '0000000000000000000000000000000000000000';
  const baseSha = ctx.store.pullBaseSha(repo, pull) ?? '0000000000000000000000000000000000000000';
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${ownerOf(ctx)}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${ownerOf(ctx)}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : ctx.store.iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(ctx),
    draft: false,
    created_at: ctx.store.iso(pull.createdAt),
    updated_at: ctx.store.iso(pull.updatedAt),
  };
}

/** "Name <email> 1735689600 +0000" -> the REST author shape. */
function authorJson(store: Store, line: string): Record<string, unknown> {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: store.iso(0) };
  return { name: match[1], email: match[2], date: store.iso(Number.parseInt(match[3] as string, 10)) };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): T[] {
  const { page, perPage } = pageParams(query);
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(
  store: Store,
  baseUrl: string,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
): RestResponse {
  const ctx: Ctx = { store, baseUrl };
  const [head, ...tail] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0-forge', hooks: [], git: [] } };
  }
  if (head === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson(ctx) };
  }
  if (head === 'user' && tail[0] === 'repos' && segments.length === 2) {
    if (method === 'POST') return createRepo(ctx, body);
    if (method === 'GET') return listUserRepos(ctx, query);
    return notFound();
  }
  if (head === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.repoFor(owner, name);
    if (repo === null) return notFound();
    return handleRepo(ctx, repo, method, segments.slice(3), query, body);
  }
  return notFound();
}

function createRepo(ctx: Ctx, body: Record<string, unknown> | undefined): RestResponse {
  const name = typeof body?.name === 'string' ? body.name : '';
  if (name === '') return invalid('Validation Failed: name is required');
  const existing = ctx.store.repos.get(name);
  if (existing !== undefined) {
    return { status: 422, body: { message: 'name already exists on this account', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } };
  }
  const repo = ctx.store.createRepo(name, {
    description: typeof body?.description === 'string' ? body.description : '',
    private: typeof body?.private === 'boolean' ? body.private : false,
  });
  if (repo === null) return invalid('name already exists on this account');
  return { status: 201, body: repoJson(ctx, repo) };
}

function listUserRepos(ctx: Ctx, query: URLSearchParams): RestResponse {
  const all = [...ctx.store.repos.values()].sort((a, b) => a.id - b.id);
  const { page, perPage } = pageParams(query);
  const items = paginate(all, query);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const url = (p: number): string => `${ctx.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { status: 200, body: items.map((repo) => repoJson(ctx, repo)), headers };
}

// ---------------------------------------------------------------------------------------------
// one repository
// ---------------------------------------------------------------------------------------------

function handleRepo(
  ctx: Ctx,
  repo: RepoRecord,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
): RestResponse {
  const store = ctx.store;
  const [head, ...tail] = segments;

  if (segments.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(ctx, repo) };
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      repo.updatedAt = store.nowSec();
      return { status: 200, body: repoJson(ctx, repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return notFound();
  }

  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: store.branchTip(repo, name) }, protected: false }));
      return { status: 200, body: branches };
    }
    if (tail.length >= 1 && method === 'GET') {
      const name = tail.join('/');
      const tip = store.branchTip(repo, name);
      if (tip === null) return notFound();
      return { status: 200, body: { name, commit: { sha: tip }, protected: false } };
    }
    return notFound();
  }

  if (head === 'commits' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    const refish = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveCommit(repo, refish);
    if (tip === null) return { status: 200, body: [] };
    const seen = new Set<string>();
    const ordered: string[] = [];
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      ordered.push(oid);
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'commit') {
        const parents = parseCommit(object.data).parents;
        for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index] as string);
      }
    }
    const items = paginate(ordered, query).map((oid) => {
      const commit = parseCommit((store.getObject(oid) as { data: Buffer }).data);
      return {
        sha: oid,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: authorJson(store, commit.author),
          committer: authorJson(store, commit.committer),
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return { status: 200, body: items };
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (tail.length === 1 && method === 'POST') {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/')) return invalid('Validation Failed: ref is invalid');
      const object = store.getObject(sha);
      if (object === undefined) return invalid('Validation Failed: sha is invalid');
      if (ref.startsWith('refs/heads/') && object.type !== 'commit') return invalid('Validation Failed: sha is not a commit');
      if (repo.refs.has(ref)) return invalid('Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: object.type } } };
    }
    if (tail.length >= 2 && method === 'GET') {
      const joined = tail.join('/');
      const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound();
      const object = store.getObject(oid);
      return { status: 200, body: { ref, object: { sha: oid, type: object?.type ?? 'commit' } } };
    }
    return notFound();
  }

  if (head === 'contents') return handleContents(ctx, repo, method, tail.join('/'), query, body);

  if (head === 'labels') {
    if (segments.length === 1 && method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      const color = typeof body?.color === 'string' ? body.color : 'ededed';
      if (name === '') return invalid('Validation Failed: name is required');
      const label = store.createLabel(repo, name, color);
      if (label === null) return invalid('Validation Failed: name already exists');
      return { status: 201, body: { id: label.id, name: label.name, color: label.color, default: false, description: null } };
    }
    if (segments.length === 1 && method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color, default: false, description: null })) };
    }
    return notFound();
  }

  if (head === 'issues') return handleIssues(ctx, repo, method, tail, query, body);
  if (head === 'pulls') return handlePulls(ctx, repo, method, tail, query, body);
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(
  ctx: Ctx,
  repo: RepoRecord,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
): RestResponse {
  const store = ctx.store;

  if (method === 'GET') {
    const refish = query.get('ref') ?? repo.defaultBranch;
    const commit = store.resolveCommit(repo, refish);
    if (commit === null) return notFound();
    const tree = store.commitTree(commit);
    if (path === '') {
      return { status: 200, body: dirListing(store, tree, '') };
    }
    const entry = store.pathEntry(tree, path);
    if (entry === null) return notFound();
    if (entry.kind === 'dir') return { status: 200, body: dirListing(store, entry.oid, path) };
    const blob = store.getObject(entry.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: entry.oid,
        size: data.length,
        name: path.split('/').pop(),
        path,
      },
    };
  }

  if (method === 'PUT') {
    const message = typeof body?.message === 'string' ? body.message : 'Update file';
    const contentText = typeof body?.content === 'string' ? body.content : '';
    const content = Buffer.from(contentText.replace(/[\r\n\t ]+/g, ''), 'base64');
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const expectedSha = typeof body?.sha === 'string' ? body.sha : undefined;
    const tipBefore = store.branchTip(repo, branch) ?? (branch !== repo.defaultBranch ? store.branchTip(repo, repo.defaultBranch) : null);
    const treeBefore = tipBefore === null ? null : store.commitTree(tipBefore);
    const existed = treeBefore !== null && store.pathEntry(treeBefore, path)?.kind === 'file';
    const result = store.putFile(repo, branch, path, content, message, expectedSha);
    if ('conflict' in result) return { status: 409, body: { message: `${path} does not match ${expectedSha}` } };
    if ('missing' in result) return notFound();
    return {
      status: existed ? 200 : 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: result.blob, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commit, message },
      },
    };
  }

  if (method === 'DELETE') {
    const message = typeof body?.message === 'string' ? body.message : 'Delete file';
    const sha = typeof body?.sha === 'string' ? body.sha : '';
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = store.branchTip(repo, branch);
    const tree = tip === null ? null : store.commitTree(tip);
    const entry = tree === null ? null : store.pathEntry(tree, path);
    if (entry === null || entry.kind !== 'file') return notFound();
    if (entry.oid !== sha) return { status: 409, body: { message: `${path} does not match ${sha}` } };
    const result = store.deleteFile(repo, branch, path, message);
    if (result === null) return notFound();
    return { status: 200, body: { content: null, commit: { sha: result.commit, message } } };
  }

  return notFound();
}

function dirListing(store: Store, treeOid: string | null, prefix: string): Record<string, unknown>[] {
  if (treeOid === null) return [];
  const tree = store.getObject(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  const entries: Record<string, unknown>[] = [];
  for (const entry of parseTree(tree.data)) {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : store.getObject(entry.oid);
    entries.push({
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: isDir ? 0 : (blob?.data.length ?? 0),
    });
  }
  return entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
}

// ---------------------------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------------------------

function handleIssues(
  ctx: Ctx,
  repo: RepoRecord,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
): RestResponse {
  const store = ctx.store;

  if (segments.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') return invalid('Validation Failed: title is required');
      const labels = Array.isArray(body?.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return invalid(`Validation Failed: label "${label}" does not exist`);
      }
      const issue = store.createIssue(repo, { title, body: typeof body?.body === 'string' ? body.body : '', labels });
      return { status: 201, body: issueJson(ctx, repo, issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return { status: 200, body: paginate(issues, query).map((issue) => issueJson(ctx, repo, issue)) };
    }
    return notFound();
  }

  const number = Number.parseInt(segments[0] as string, 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) return notFound();

  if (segments.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(ctx, repo, issue) };
    if (method === 'PATCH') {
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      if (Array.isArray(body?.labels)) {
        const labels = body.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) if (!repo.labels.has(label)) return invalid(`Validation Failed: label "${label}" does not exist`);
        issue.labels = labels;
      }
      if (body?.state === 'closed' || body?.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? store.nowSec() : null;
      }
      issue.updatedAt = store.nowSec();
      return { status: 200, body: issueJson(ctx, repo, issue) };
    }
    return notFound();
  }

  if (segments.length === 2 && segments[1] === 'comments') {
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      const comment = store.addComment(issue, text);
      return { status: 201, body: commentJson(ctx, comment) };
    }
    if (method === 'GET') {
      return { status: 200, body: paginate(issue.comments, query).map((comment) => commentJson(ctx, comment)) };
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function handlePulls(
  ctx: Ctx,
  repo: RepoRecord,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | undefined,
): RestResponse {
  const store = ctx.store;

  if (segments.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      const headRaw = typeof body?.head === 'string' ? body.head : '';
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '') return invalid('Validation Failed: title is required');
      const headTip = store.branchTip(repo, head);
      if (headTip === null) return invalid(`Validation Failed: head branch "${head}" does not exist`);
      if (store.branchTip(repo, base) === null) return invalid(`Validation Failed: base branch "${base}" does not exist`);
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return invalid(`A pull request already exists for ${head} into ${base}`);
      const pull = store.createPull(repo, { title, body: typeof body?.body === 'string' ? body.body : '', head, base });
      return { status: 201, body: pullJson(ctx, repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      return { status: 200, body: paginate(pulls, query).map((pull) => pullJson(ctx, repo, pull)) };
    }
    return notFound();
  }

  const number = Number.parseInt(segments[0] as string, 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return notFound();

  if (segments.length === 1 && method === 'GET') {
    return { status: 200, body: pullJson(ctx, repo, pull) };
  }
  if (segments.length === 2 && segments[1] === 'files' && method === 'GET') {
    const files = store.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: '',
    }));
    return { status: 200, body: paginate(files, query) };
  }
  if (segments.length === 2 && segments[1] === 'merge' && method === 'PUT') {
    if (pull.merged || pull.state !== 'open') {
      return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    }
    const methodWanted = typeof body?.merge_method === 'string' ? body.merge_method : 'squash';
    const sha = store.mergePull(repo, pull, methodWanted === 'merge' ? 'merge' : 'squash');
    if (sha === null) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}
