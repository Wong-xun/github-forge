// github-forge entrypoint.
//
// This file owns only the trial lifecycle (SPEC.md section 1): it starts the
// HTTP server built by app.ts, tells the trial environment which port the
// server listens on, and then waits until the environment reports the trial
// is finished. All git, REST, GraphQL and MCP behaviour lives in the other
// modules; nothing about the wire protocol is decided here.
//
// The environment address comes from MAKEFUN_ENV_URL. The server always
// binds an ephemeral port (listen(0)); port 8080 belongs to the environment
// and must never be taken by the entry.

import { createApp } from './app.ts';

/** How long one HTTP call to the environment may take before it is abandoned. */
const CALL_TIMEOUT_MS = 30_000;
/** First pause between /done polls; doubled after every poll, up to the cap. */
const FIRST_POLL_MS = 250;
/** Longest pause between /done polls. */
const MAX_POLL_MS = 2_000;
/** How many times the /register call is retried before polling starts anyway. */
const REGISTER_TRIES = 8;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Announce this entry to the environment: POST {port} to /register.
 * Returns true once the entry is known there. HTTP 200 means the first
 * registration; 409 means another entry already registered and the
 * environment keeps the first one — either way the wire step is done and
 * polling can start. Anything else (or a failed call) is retried with
 * backoff; after the last try polling starts regardless, so the process
 * never exits before the environment says the trial is over.
 */
async function announce(envBase: string, port: number): Promise<boolean> {
  const target = new URL('/register', envBase).href;
  let wait = FIRST_POLL_MS;
  for (let attempt = 1; attempt <= REGISTER_TRIES; attempt += 1) {
    try {
      const reply = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return true;
      console.error(`[entry] register answered HTTP ${reply.status}, retrying`);
    } catch (err) {
      console.error(
        `[entry] register attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (attempt < REGISTER_TRIES) {
      await sleep(wait);
      wait = Math.min(MAX_POLL_MS, wait * 2);
    }
  }
  return false;
}

/**
 * Poll GET /done until the environment answers {"done": true}.
 * Unreachable environment, a non-200 answer or an unparsable body all count
 * as "not done yet": the loop backs off and tries again, and never returns
 * early.
 */
async function awaitFinish(envBase: string): Promise<void> {
  const target = new URL('/done', envBase).href;
  let wait = FIRST_POLL_MS;
  for (;;) {
    try {
      const reply = await fetch(target, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        if (
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true
        ) {
          return;
        }
      }
    } catch {
      // The environment may be briefly unreachable; keep polling.
    }
    await sleep(wait);
    wait = Math.min(MAX_POLL_MS, wait * 2);
  }
}

/** Start the server on an ephemeral port and report the chosen port. */
async function boot(): Promise<number> {
  const server = createApp();
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound to an unexpected address'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function main(): Promise<number> {
  const envBase = process.env.MAKEFUN_ENV_URL;
  if (!envBase) {
    console.error('[entry] MAKEFUN_ENV_URL is not set');
    return 1;
  }
  let port: number;
  try {
    port = await boot();
  } catch (err) {
    console.error(
      `[entry] failed to start the server: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
  const announced = await announce(envBase, port);
  console.error(`[entry] listening on port ${port}, registered: ${announced}`);
  if (!announced) {
    console.error('[entry] register never succeeded; polling /done anyway');
  }
  await awaitFinish(envBase);
  return 0;
}

process.exit(await main());
