import { afterEach, beforeEach } from 'vitest';
import { resetEnvCache } from '@/lib/env';

/**
 * The environment a unit test runs in, and the one way it changes it.
 *
 * `env()` validates the whole schema once and caches the answer, and it will
 * not parse without `DATABASE_URL` and `APP_SECRET`. So a test that reaches it
 * sets those two, resets the cache, and has to put everything back afterwards —
 * including whatever a test changed along the way, which is where the copies
 * this replaced differed. Some restored the whole environment; some deleted the
 * keys they remembered to list; one cleaned up on the last line of its own
 * test, after an assertion that could throw first and leave the value set for
 * every test after it. Here everything is put back after each test, whatever
 * the test did. (Only within a file: each test file runs in its own process, so
 * nothing ever crossed from one file to the next.)
 *
 * The environment is built from nothing but what the test names, not copied
 * from the shell running the suite. Nothing today depends on a variable it did
 * not set — the suite passes with `INSTAGRAM_ACCESS_TOKEN`, `KB_PUBLIC_HOST` and
 * `LOG_ALL_INCOMING_WEBHOOKS` exported — but a copied environment is how a test
 * would come to, unnoticed until it failed on the one machine that had one.
 *
 * Not a global `setupFiles`, and four test files manage their own, each for a
 * reason: `lib/env.test.ts` tests what happens when these variables are missing;
 * `lib/email/providers/index.test.ts` and the email webhook's
 * `route.drivers.test.ts` re-import their modules per test, so must reset the
 * cache of the instance they imported, not this one; and
 * `worker/handlers/send-agent-invite.test.ts` sets its variables before its
 * imports, which a `beforeEach` is too late for.
 */

type Values = Record<string, string | undefined>;

// How many `withTestEnv` scopes are active for the running test. A count, not a
// flag, because a nested call's hooks run inside the outer one's.
let activeScopes = 0;

/**
 * Every test in the enclosing scope — the file, or the `describe` it is called
 * in — starts from the two required variables plus `values`, and whatever it
 * changes is gone before the next test. Call it once per scope: a second call
 * nested inside the first starts from nothing again, not from the outer values.
 */
export function withTestEnv(values: Values = {}): void {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    activeScopes++;
    saved = process.env;
    process.env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    setTestEnv({
      DATABASE_URL: 'postgresql://localhost:5432/test',
      APP_SECRET: '0'.repeat(64),
      ...values,
    });
  });

  afterEach(() => {
    process.env = saved;
    resetEnvCache();
    activeScopes--;
  });
}

/**
 * Changes the current test's environment, and resets `env()`'s cache so the
 * next read sees it. `undefined` removes a variable, which is how a test asks
 * what happens when one is not configured.
 *
 * Refuses outside a `withTestEnv` scope. There the writes would land on the real
 * `process.env` with nothing to put them back, and every later test in the file
 * would inherit them without a word.
 */
export function setTestEnv(values: Values): void {
  if (activeScopes === 0) {
    throw new Error('setTestEnv() outside withTestEnv(): nothing would restore these values');
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetEnvCache();
}
