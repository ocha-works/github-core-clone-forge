// The HTTP server: routing and the plumbing every surface shares — bearer
// authentication against $MAKEFUN_SHOP_TOKEN, a request id and a JSON answer
// on every API response, body reading with a bound, and a JSON 404 for
// anything unrouted. The surfaces themselves live in src/: git smart HTTP,
// REST v3, GraphQL v4 and MCP, all over one shared Store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { GitHttp } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body the forge will read (a push pack is the only big one). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

function jsonAnswer(store: Store, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Answer {
  const text = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  return {
    status,
    contentType: JSON_TYPE,
    body: Buffer.from(text, 'utf8'),
    headers: { 'x-github-request-id': `forge-${++store.requestSeq}`, ...headers },
  };
}

function send(res: ServerResponse, answer: Answer): void {
  const headers: Record<string, string> = { 'content-type': answer.contentType, ...answer.headers };
  if (answer.status !== 204) headers['content-length'] = String(answer.body.length);
  res.writeHead(answer.status, headers);
  res.end(answer.status === 204 ? undefined : answer.body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The bearer check: the token in our environment is the token the env presents. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the forge's server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const gitHttp = new GitHttp(store);

  const route = async (req: IncomingMessage): Promise<Answer> => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://entry');
    const path = url.pathname;

    // The env's boot probe: no token, always the same answer.
    if (method === 'GET' && path === '/healthz') {
      return jsonAnswer(store, 200, { ok: true });
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authorized(req)) return jsonAnswer(store, 401, { message: 'Bad credentials' });
      const segments = path.slice('/api/v3'.length).split('/').filter((part) => part !== '').map(decodeSegment);
      let body: Record<string, unknown> | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            const parsed: unknown = JSON.parse(raw.toString('utf8'));
            body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
          } catch {
            return jsonAnswer(store, 400, { message: 'Problems parsing JSON' });
          }
        }
      }
      const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
      const result = handleRest(store, baseUrl, method, segments, url.searchParams, body);
      if (result.status === 204) return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0), headers: { 'x-github-request-id': `forge-${++store.requestSeq}` } };
      return jsonAnswer(store, result.status, result.body, result.headers);
    }

    if (path === '/api/graphql') {
      if (method !== 'POST') return jsonAnswer(store, 404, { message: 'Not Found' });
      if (!authorized(req)) return jsonAnswer(store, 401, { message: 'Bad credentials' });
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return jsonAnswer(store, 400, { errors: [{ message: 'the request body is not JSON' }] });
      }
      const result = executeGraphQL(store, parsed);
      return jsonAnswer(store, result.status, result.payload);
    }

    if (path === '/mcp') {
      if (method === 'DELETE') return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0) };
      if (method !== 'POST') return jsonAnswer(store, 405, { message: 'Method Not Allowed' });
      if (!authorized(req)) return jsonAnswer(store, 401, { message: 'Bad credentials' });
      const raw = await readBody(req);
      const result = handleMcp(store, raw.toString('utf8'));
      if (result.status === 202) return { status: 202, contentType: JSON_TYPE, body: Buffer.alloc(0) };
      return jsonAnswer(store, result.status, result.body);
    }

    const gitMatch = GIT_PATH.exec(path);
    if (gitMatch !== null) {
      if (!authorized(req)) return jsonAnswer(store, 401, { message: 'Bad credentials' });
      const owner = decodeSegment(gitMatch[1] as string);
      const repoName = decodeSegment(gitMatch[2] as string);
      const repo = store.repoFor(owner, repoName);
      if (repo === null) return jsonAnswer(store, 404, { message: 'Not Found' });
      const tail = gitMatch[3] as string;
      const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (tail === 'info/refs' && method === 'GET') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          return jsonAnswer(store, 400, { message: 'unknown service' });
        }
        const answer = gitHttp.infoRefs(repo, service, protocolV2);
        return { status: answer.status, contentType: answer.contentType, body: answer.body };
      }
      if (tail === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        const answer = gitHttp.uploadPack(repo, body, protocolV2);
        return { status: answer.status, contentType: answer.contentType, body: answer.body };
      }
      if (tail === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        const answer = gitHttp.receivePack(repo, body);
        return { status: answer.status, contentType: answer.contentType, body: answer.body };
      }
      return jsonAnswer(store, 404, { message: 'Not Found' });
    }

    return jsonAnswer(store, 404, { message: 'Not Found' });
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req).then(
      (answer) => send(res, answer),
      () => {
        try {
          send(res, jsonAnswer(store, 500, { message: 'Internal Server Error' }));
        } catch {
          // The peer is gone; nothing left to answer on.
        }
      },
    );
  });
}
