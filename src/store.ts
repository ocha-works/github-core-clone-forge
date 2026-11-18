// The domain store: one in-memory state shared by the git, REST, GraphQL and
// MCP surfaces, so an object created through one is the same object through
// all the others. Ids are per-store counters and timestamps come from a
// logical clock (a fixed epoch plus a counter), never from the wall clock, so
// repeated runs over the same request sequence answer byte-identically.

import {
  buildCommit,
  buildTreeFromFlat,
  collectReachable,
  diffLineCounts,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
} from './git.ts';

export const BASE_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z
export const ZERO_OID = '0000000000000000000000000000000000000000';

export interface LabelRecord {
  readonly id: number;
  name: string;
  color: string;
}

export interface CommentRecord {
  readonly dbId: number;
  body: string;
  readonly createdAt: number;
  updatedAt: number;
}

export interface IssueRecord {
  readonly dbId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface PullRecord {
  readonly dbId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  readonly createdAt: number;
  updatedAt: number;
}

export interface RepoRecord {
  readonly id: number;
  name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: Map<number, IssueRecord>;
  readonly pulls: Map<number, PullRecord>;
  nextNumber: number;
  readonly createdAt: number;
  updatedAt: number;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, RepoRecord>();
  viewerLogin: string | null = null;
  private clock = 0;
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  requestSeq = 0;

  readonly lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  /** The next logical timestamp, in epoch seconds. */
  nowSec(): number {
    this.clock += 1;
    return BASE_EPOCH_SEC + this.clock;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** Adopt the token owner's login from the first owner-bearing path seen. */
  adoptViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  /** The login paths should be judged against: the adopted viewer, if any. */
  ownerFor(ownerSegment: string): string {
    return this.viewerLogin ?? ownerSegment;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** The identity contents-API and merge commits are authored under. */
  identity(sec: number): string {
    const login = this.viewerLogin ?? 'forge';
    return `${login} <${login}@example.invalid> ${sec} +0000`;
  }

  // -------------------------------------------------------------------------------------------
  // repositories and refs
  // -------------------------------------------------------------------------------------------

  createRepo(name: string, options: { description?: string; private?: boolean }): RepoRecord | null {
    if (this.repos.has(name)) return null;
    const now = this.nowSec();
    const repo: RepoRecord = {
      id: ++this.repoSeq,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** A repository by name, visible only under the viewer's login. */
  repoFor(owner: string, name: string): RepoRecord | null {
    this.adoptViewer(owner);
    if (this.viewerLogin !== null && owner !== this.viewerLogin) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(repo: RepoRecord): void {
    this.repos.delete(repo.name);
  }

  refTip(repo: RepoRecord, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  branchTip(repo: RepoRecord, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a branch name, a full ref, HEAD, or a raw object id to a commit id. */
  resolveCommit(repo: RepoRecord, refish: string): string | null {
    let oid: string | null = null;
    if (refish === 'HEAD') oid = this.branchTip(repo, repo.defaultBranch);
    else if (refish.startsWith('refs/')) oid = this.refTip(repo, refish);
    else if (/^[0-9a-f]{40}$/.test(refish)) oid = this.objects.has(refish) ? refish : null;
    else oid = this.branchTip(repo, refish) ?? this.refTip(repo, `refs/tags/${refish}`);
    if (oid === null) return null;
    return peelToCommit(this.lookup, oid);
  }

  commitTree(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  // -------------------------------------------------------------------------------------------
  // contents API commits
  // -------------------------------------------------------------------------------------------

  /** The flattened files of a commit (empty for an unborn branch). */
  filesAt(repo: RepoRecord, commitOid: string | null): Map<string, { mode: string; oid: string }> {
    if (commitOid === null) return new Map();
    const tree = this.commitTree(commitOid);
    if (tree === null) return new Map();
    return flattenTree(this.lookup, tree);
  }

  /** One path's entry in a tree: a file, a directory, or nothing. */
  pathEntry(treeOid: string | null, path: string): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
    if (treeOid === null) return null;
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const tree = this.objects.get(current);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) {
        return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** Commit a new tree on a branch and move the branch; answers the commit id. */
  commitTreeOnBranch(repo: RepoRecord, branch: string, treeOid: string, message: string): string {
    const parent = this.branchTip(repo, branch);
    const sec = this.nowSec();
    const identity = this.identity(sec);
    const commit = this.putObject(
      'commit',
      buildCommit({
        tree: treeOid,
        parents: parent === null ? [] : [parent],
        author: identity,
        committer: identity,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commit);
    repo.updatedAt = sec;
    return commit;
  }

  /**
   * Write `content` at `path` on `branch`, creating the branch from the
   * default branch when it does not exist yet. `expectedSha` is the blob id
   * the caller believes is current: a mismatch on an existing file is a
   * conflict, answered as `{ conflict: true }`.
   */
  putFile(
    repo: RepoRecord,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commit: string; blob: string } | { conflict: true } | { missing: true } {
    let tip = this.branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) {
      const base = this.branchTip(repo, repo.defaultBranch);
      if (base !== null) {
        repo.refs.set(`refs/heads/${branch}`, base);
        tip = base;
      }
    }
    const files = this.filesAt(repo, tip);
    const existing = files.get(path);
    if (expectedSha !== undefined) {
      if (existing === undefined) return { missing: true };
      if (existing.oid !== expectedSha) return { conflict: true };
    }
    const blob = this.putObject('blob', content);
    files.set(path, { mode: existing?.mode ?? '100644', oid: blob });
    const tree = buildTreeFromFlat(files, (type, data) => this.putObject(type, data));
    const commit = this.commitTreeOnBranch(repo, branch, tree, message);
    return { commit, blob };
  }

  /** Delete `path` on `branch`; the caller has already verified the blob sha. */
  deleteFile(repo: RepoRecord, branch: string, path: string, message: string): { commit: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const files = this.filesAt(repo, tip);
    if (!files.delete(path)) return null;
    const tree = buildTreeFromFlat(files, (type, data) => this.putObject(type, data));
    const commit = this.commitTreeOnBranch(repo, branch, tree, message);
    return { commit };
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: RepoRecord, name: string, color: string): LabelRecord | null {
    if (repo.labels.has(name)) return null;
    const label: LabelRecord = { id: ++this.labelSeq, name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: RepoRecord, input: { title: string; body: string; labels: string[] }): IssueRecord {
    const now = this.nowSec();
    const issue: IssueRecord = {
      dbId: ++this.issueSeq,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(issue: IssueRecord, body: string): CommentRecord {
    const now = this.nowSec();
    const comment: CommentRecord = { dbId: ++this.commentSeq, body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    issue.updatedAt = now;
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests and merges
  // -------------------------------------------------------------------------------------------

  createPull(repo: RepoRecord, input: { title: string; body: string; head: string; base: string }): PullRecord {
    const now = this.nowSec();
    const pull: PullRecord = {
      dbId: ++this.pullSeq,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The pull request's current head commit (the branch tip, which may have moved). */
  pullHeadSha(repo: RepoRecord, pull: PullRecord): string | null {
    return this.branchTip(repo, pull.headRef);
  }

  pullBaseSha(repo: RepoRecord, pull: PullRecord): string | null {
    return this.branchTip(repo, pull.baseRef);
  }

  /** The commit a pull request's changes are measured against. */
  pullMergeBase(repo: RepoRecord, pull: PullRecord): string | null {
    const head = this.pullHeadSha(repo, pull);
    const base = this.pullBaseSha(repo, pull);
    if (head === null || base === null) return null;
    return mergeBase(this.lookup, base, head);
  }

  /** The changed files between the merge base and the head, with line counts. */
  pullFiles(repo: RepoRecord, pull: PullRecord): FileChange[] {
    const head = this.pullHeadSha(repo, pull);
    if (head === null) return [];
    const base = this.pullMergeBase(repo, pull);
    const before = this.filesAt(repo, base);
    const after = this.filesAt(repo, head);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = before.get(path);
      const newEntry = after.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
      const oldText = oldEntry === undefined ? '' : (this.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '');
      const newText = newEntry === undefined ? '' : (this.objects.get(newEntry.oid)?.data.toString('utf8') ?? '');
      const counts = diffLineCounts(oldText, newText);
      changes.push({
        filename: path,
        status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return changes;
  }

  /**
   * A three-way merge of the head tree into the current base tree, against
   * the merge base's tree. Answers the merged tree id, or null on a conflict
   * (both sides changed the same path to different bytes).
   */
  mergedTree(repo: RepoRecord, pull: PullRecord): string | null {
    const head = this.pullHeadSha(repo, pull);
    const base = this.pullBaseSha(repo, pull);
    if (head === null || base === null) return null;
    const ancestor = mergeBase(this.lookup, base, head);
    if (ancestor === null) return null;
    if (ancestor === head) {
      const tree = this.commitTree(base);
      return tree;
    }
    const baseFiles = this.filesAt(repo, ancestor);
    const headFiles = this.filesAt(repo, head);
    const currentFiles = this.filesAt(repo, base);
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      const inCurrent = currentFiles.get(path);
      const same = (a?: { oid: string }, b?: { oid: string }): boolean => a?.oid === b?.oid;
      if (same(inHead, inCurrent)) {
        if (inCurrent !== undefined) merged.set(path, inCurrent);
      } else if (same(inBase, inHead)) {
        if (inCurrent !== undefined) merged.set(path, inCurrent);
      } else if (same(inBase, inCurrent)) {
        if (inHead !== undefined) merged.set(path, inHead);
      } else {
        return null;
      }
    }
    return buildTreeFromFlat(merged, (type, data) => this.putObject(type, data));
  }

  /** Whether the pull request would merge cleanly right now. */
  pullMergeable(repo: RepoRecord, pull: PullRecord): boolean {
    if (pull.state !== 'open') return false;
    return this.mergedTree(repo, pull) !== null;
  }

  /**
   * Merge the pull request into its base branch. `squash` lands one commit
   * holding the merged tree; `merge` lands a two-parent merge commit.
   * Answers the new base tip, or null when the merge conflicts.
   */
  mergePull(repo: RepoRecord, pull: PullRecord, method: 'squash' | 'merge'): string | null {
    const tree = this.mergedTree(repo, pull);
    if (tree === null) return null;
    const baseTip = this.pullBaseSha(repo, pull);
    const headTip = this.pullHeadSha(repo, pull);
    if (baseTip === null || headTip === null) return null;
    const sec = this.nowSec();
    const identity = this.identity(sec);
    const message = method === 'squash'
      ? `${pull.title}\n\n${pull.body}`.trimEnd() + '\n'
      : `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    const parents = method === 'squash' ? [baseTip] : [baseTip, headTip];
    const commit = this.putObject('commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = sec;
    pull.mergeCommitSha = commit;
    pull.updatedAt = sec;
    repo.updatedAt = sec;
    return commit;
  }
}
