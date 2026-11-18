// The git smart-HTTP surface: info/refs advertisements, protocol v2 ls-refs
// and fetch, a protocol v0 fetch fallback, and receive-pack with per-ref
// fast-forward enforcement. The dialect spoken here is the one the suite's
// own git client (kit env/src/git-client.ts) speaks, which is git's.

import { createHash } from 'node:crypto';
import {
  buildPack,
  collectReachable,
  commitDistances,
  decodePktLines,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  pktLine,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import type { RepoRecord, Store } from './store.ts';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const AGENT = 'makefun-forge/1.0';
/** Band-1 payload per sideband packet: 4 header bytes + 1 band byte + data ≤ 65520. */
const SIDEBAND_CHUNK = 65515;

function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + SIDEBAND_CHUNK)])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

export class GitHttp {
  private readonly packCache = new Map<string, Buffer>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private sortedRefs(repo: RepoRecord): Array<[string, string]> {
    return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private headOid(repo: RepoRecord): string {
    return this.store.branchTip(repo, repo.defaultBranch) ?? ZERO_OID;
  }

  /** The pack for an exact object set, built once and reused (the clone workload's fifty identical asks). */
  private packFor(oids: readonly string[]): Buffer {
    const key = createHash('sha1').update([...oids].sort().join(' ')).digest('hex');
    const cached = this.packCache.get(key);
    if (cached !== undefined) return cached;
    const objects: GitObject[] = [];
    for (const oid of oids) {
      const object = this.store.getObject(oid);
      if (object !== undefined) objects.push(object);
    }
    const pack = buildPack(objects);
    if (this.packCache.size > 64) this.packCache.clear();
    this.packCache.set(key, pack);
    return pack;
  }

  // -------------------------------------------------------------------------------------------
  // advertisements
  // -------------------------------------------------------------------------------------------

  infoRefs(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): GitResponse {
    const contentType = `application/x-${service}-advertisement`;
    if (service === 'git-upload-pack' && protocolV2) {
      const body = Buffer.concat([
        pktLine('version 2\n'),
        pktLine(`agent=${AGENT}\n`),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow\n'),
        pktLine('object-format=sha1\n'),
        PKT_FLUSH,
      ]);
      return { status: 200, contentType, body };
    }
    const caps = service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
    const refs = this.sortedRefs(repo);
    if (refs.length === 0) {
      lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      lines.push(pktLine(`${this.headOid(repo)} HEAD\0${caps}\n`));
      for (const [ref, oid] of refs) {
        lines.push(pktLine(`${oid} ${ref}\n`));
        const peeled = this.peeledOf(oid);
        if (peeled !== null) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
    lines.push(PKT_FLUSH);
    return { status: 200, contentType, body: Buffer.concat(lines) };
  }

  /** The commit an annotated tag peels to, or null for anything else. */
  private peeledOf(oid: string): string | null {
    const object = this.store.getObject(oid);
    if (object === undefined || object.type !== 'tag') return null;
    return peelToCommit(this.store.lookup, oid);
  }

  // -------------------------------------------------------------------------------------------
  // upload-pack (ls-refs and fetch)
  // -------------------------------------------------------------------------------------------

  uploadPack(repo: RepoRecord, body: Buffer, protocolV2: boolean): GitResponse {
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      return jsonError(400, 'malformed pkt-line stream');
    }
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    if (protocolV2) {
      const command = lines.find((line) => line.startsWith('command='));
      if (command === 'command=ls-refs\n' || command === 'command=ls-refs') return this.lsRefs(repo, lines);
      if (command === 'command=fetch\n' || command === 'command=fetch') return this.fetchV2(repo, lines);
      return jsonError(400, 'unknown protocol v2 command');
    }
    return this.fetchV0(repo, packets);
  }

  private lsRefs(repo: RepoRecord, lines: readonly string[]): GitResponse {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const out: string[] = [];
    if (matches('HEAD')) {
      const tip = this.store.branchTip(repo, repo.defaultBranch);
      const target = `refs/heads/${repo.defaultBranch}`;
      if (tip !== null) out.push(`${tip} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
      else if (unborn) out.push(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    }
    for (const [ref, oid] of this.sortedRefs(repo)) {
      if (!matches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (peel) {
        const peeled = this.peeledOf(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      out.push(`${line}\n`);
    }
    const body = Buffer.concat([...out.map((line) => pktLine(line)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }

  // -------------------------------------------------------------------------------------------
  // fetch set arithmetic
  // -------------------------------------------------------------------------------------------

  private planFetch(
    wants: readonly string[],
    haves: readonly string[],
    clientShallow: readonly string[],
    depth: number | null,
  ): { pack: Buffer; shallow: string[]; unshallow: string[] } {
    const lookup = this.store.lookup;
    const stop = new Set(clientShallow);
    const haveClosure = collectReachable(lookup, haves, stop);
    const haveCommits = new Set([...haveClosure].filter((oid) => lookup(oid)?.type === 'commit'));

    if (depth === null) {
      const wantClosure = collectReachable(lookup, wants);
      const send = [...wantClosure].filter((oid) => !haveClosure.has(oid));
      return { pack: this.packFor(send), shallow: [], unshallow: [] };
    }

    const distances = commitDistances(lookup, wants);
    const included = new Set<string>();
    for (const [commit, distance] of distances) if (distance < depth) included.add(commit);

    const send = new Set<string>();
    // The want objects themselves (a tag want carries its tag object along).
    for (const want of wants) {
      let current: string | null = want;
      for (let guard = 0; guard < 32 && current !== null; guard += 1) {
        const object = lookup(current);
        if (object === undefined) break;
        if (object.type === 'tag') {
          send.add(current);
          current = parseTag(object.data).object;
          continue;
        }
        break;
      }
    }
    // Included commits the client does not already hold, each with its full tree.
    const addTreeClosure = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (send.has(oid) || haveClosure.has(oid)) continue;
        const object = lookup(oid);
        if (object === undefined) continue;
        send.add(oid);
        if (object.type === 'tree') {
          for (const entry of parseTreeEntries(object.data)) stack.push(entry);
        }
      }
    };
    for (const commit of included) {
      if (haveCommits.has(commit)) continue;
      if (!send.has(commit)) send.add(commit);
      const object = lookup(commit);
      if (object !== undefined && object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
    }
    for (const oid of haveClosure) send.delete(oid);

    const shallow: string[] = [];
    for (const commit of included) {
      if (haveCommits.has(commit)) continue;
      const object = lookup(commit);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent) && !haveCommits.has(parent) && lookup(parent) !== undefined)) {
        shallow.push(commit);
      }
    }
    const unshallow: string[] = [];
    for (const boundary of clientShallow) {
      if (!included.has(boundary) || shallow.includes(boundary)) continue;
      const object = lookup(boundary);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => included.has(parent) || haveCommits.has(parent))) unshallow.push(boundary);
    }
    return { pack: this.packFor([...send]), shallow, unshallow };
  }

  private fetchV2(repo: RepoRecord, lines: readonly string[]): GitResponse {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    }
    const plan = this.planFetch(wants, haves, clientShallow, depth);
    const acks = haves.filter((have) => this.store.getObject(have) !== undefined);
    const parts: Buffer[] = [];
    // The acknowledgments section exists only when the client negotiated
    // with have lines; a have-less fetch (a fresh clone) goes straight to
    // the packfile section, which is what a real git client reads first.
    // Response sections are separated by delim packets (0001); only the
    // whole response ends with a flush — a real git client insists on the
    // delim after 'ready', and section-based readers accept either.
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      if (acks.length > 0) {
        for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(PKT_DELIM);
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(plan.pack));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  private fetchV0(repo: RepoRecord, packets: ReturnType<typeof decodePktLines>): GitResponse {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (line.startsWith('want ')) wants.push(line.slice(5, 45));
        else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      }
    }
    const plan = this.planFetch(wants, haves, clientShallow, depth);
    const parts: Buffer[] = [];
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    const acks = haves.filter((have) => this.store.getObject(have) !== undefined);
    parts.push(pktLine(acks.length > 0 ? `ACK ${acks[0]}\n` : 'NAK\n'));
    parts.push(...sidebandPackets(plan.pack));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  // -------------------------------------------------------------------------------------------
  // receive-pack
  // -------------------------------------------------------------------------------------------

  receivePack(repo: RepoRecord, body: Buffer): GitResponse {
    // Split the command stream (pkt-lines up to the first flush) from the pack that follows.
    let offset = 0;
    const commandLines: string[] = [];
    let packStart = -1;
    while (offset < body.length) {
      if (offset + 4 > body.length) break;
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = parseInt(header, 16);
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length < 4 || offset + length > body.length) break;
      commandLines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
      offset += length;
    }
    const pack = packStart >= 0 ? body.subarray(packStart) : Buffer.alloc(0);

    let sideband = false;
    interface Command { oldOid: string; newOid: string; ref: string }
    const commands: Command[] = [];
    for (const [index, rawLine] of commandLines.entries()) {
      let line = rawLine.replace(/\n$/, '');
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const caps = line.slice(nul + 1).split(' ');
          if (caps.includes('side-band-64k')) sideband = true;
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length !== 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }

    let unpackOk = true;
    let unpackDetail = 'ok';
    if (pack.length > 0) {
      try {
        const objects = readPack(pack, this.store.lookup);
        for (const [oid, object] of objects) {
          if (!this.store.objects.has(oid)) this.store.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const reportLines: string[] = [`unpack ${unpackDetail}\n`];
    for (const command of commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${command.ref} unpack failed\n`);
        continue;
      }
      const reason = this.applyUpdate(repo, command.oldOid, command.newOid, command.ref);
      reportLines.push(reason === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }
    const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
    const bodyOut = sideband
      ? Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), PKT_FLUSH])
      : report;
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
  }

  /** Apply one ref update; answers null on success or the `ng` reason. */
  private applyUpdate(repo: RepoRecord, oldOid: string, newOid: string, ref: string): string | null {
    if (!ref.startsWith('refs/') || ref.includes(' ')) return 'invalid ref';
    const current = repo.refs.get(ref) ?? ZERO_OID;
    if (oldOid !== current) {
      return oldOid === ZERO_OID && current !== ZERO_OID ? 'reference already exists' : 'stale info';
    }
    if (newOid === ZERO_OID) {
      if (current === ZERO_OID) return 'reference does not exist';
      repo.refs.delete(ref);
      return null;
    }
    const object = this.store.getObject(newOid);
    if (object === undefined) return 'invalid object';
    if (ref.startsWith('refs/heads/') && object.type !== 'commit') return 'invalid object';
    if (oldOid !== ZERO_OID) {
      const oldCommit = peelToCommit(this.store.lookup, current);
      const newCommit = peelToCommit(this.store.lookup, newOid);
      if (oldCommit === null || newCommit === null || !isAncestor(this.store.lookup, oldCommit, newCommit)) {
        return 'non-fast-forward';
      }
    }
    repo.refs.set(ref, newOid);
    return null;
  }
}

/** The child oids of a tree object's raw bytes (kept local so git-http needs no extra export). */
function parseTreeEntries(data: Buffer): string[] {
  const oids: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    oids.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return oids;
}
