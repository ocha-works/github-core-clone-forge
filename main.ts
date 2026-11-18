// The entry's lifecycle, which the harness drives and this file owns:
// learn where the env lives, bind an ephemeral port, register that port,
// then poll the env's /done until the trial is over and exit 0.
//
//   MAKEFUN_ENV_URL  the env's origin (http://store:8080 inside a trial).
//                    Unset means there is nothing to register with, so the
//                    program exits 1 at once rather than serving to no one.
//   listen(0)        the kernel picks the port; 8080 is never bound because
//                    that is the env's own port on the shared loopback.
//   POST /register   {"port": N} — the env notes the caller's address plus
//                    this port as the entry's base URL and dials it from
//                    then on. The first register wins; a 409 is not an
//                    error for us, it just means we keep waiting our turn.
//   GET /done        {"done": false} while the suite runs, {"done": true}
//                    once its export is written. A poll, never a held
//                    request; failures retry with a short backoff.
//
// main.ts imports the server factory from app.ts and nothing else that is
// not a Node built-in: the trial installs nothing.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const LONGEST_RETRY_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failures: doubling from FIRST_RETRY_MS, capped. */
function backoff(attempt: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

/** One call to the env, its body read as JSON when it parses. */
async function callEnv(path: string, init: RequestInit = {}): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${ENV_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** POST the bound port until the env takes it (200) or tells us we lost the race (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { status } = await callEnv('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (status === 200 || status === 409) return;
      if (status === 400 || status === 405) {
        throw new Error(`register refused with HTTP ${status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // A network error means the env may still be starting; retry below.
    }
    await sleep(backoff(attempt));
  }
}

/** Poll /done until the env says the trial is over; never return before. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { status, json } = await callEnv('/done');
      if (status === 200 && typeof json === 'object' && json !== null && (json as { done?: unknown }).done === true) {
        return;
      }
    } catch {
      // A failed poll is retried; the env's answer, not our patience, ends the trial.
    }
    await sleep(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('[forge] the server bound no TCP port\n');
  process.exit(1);
}
await register(address.port);
process.stderr.write(`[forge] registered port ${address.port}; serving until the env ends the trial\n`);
await waitUntilDone();
process.stderr.write('[forge] the env reports done; closing\n');
await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(0);
