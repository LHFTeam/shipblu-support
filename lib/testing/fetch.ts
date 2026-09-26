import { onTestFinished, vi } from 'vitest';

/**
 * `fetch`, answered by the test instead of the network, and put back afterwards.
 *
 * Every provider client here is a thin layer over `fetch`, and its tests are
 * about what it does with an answer: which failures it retries, what it logs,
 * whether a deadline passing mid-body reads as a timeout. Nine test files
 * replaced `fetch` for that, three different ways, and each owed the restore
 * separately — an `afterEach` with `vi.unstubAllGlobals()`, a saved
 * `ORIGINAL_FETCH` put back by hand, or a `try`/`finally` around one call. A
 * missed restore leaves the stub answering the next test in the file.
 *
 * `stubFetch` restores through `onTestFinished`, which runs whether the stub
 * was installed in the test or in a `beforeEach`, so no caller owes anything.
 * It restores every stubbed global, not just `fetch`; nothing that calls it
 * stubs another.
 */

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Answers every `fetch` in the current test with `handler`; returns the mock, to read its calls. */
export function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', mock);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return mock;
}

/**
 * Answers every call with Graph's error body: `status`, and Meta's `code` or
 * none. The Messenger/Instagram and WhatsApp clients both classify a failure
 * from exactly these two fields, so this is the whole input to that decision.
 */
export function respondWithGraphError(status: number, code: number | null, message = 'nope') {
  return stubFetch(
    () =>
      new Response(JSON.stringify({ error: { message, ...(code === null ? {} : { code }) } }), {
        status,
      }),
  );
}
