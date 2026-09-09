import { afterEach, describe, expect, it, vi } from 'vitest';

const getSessionAgent = vi.fn(async () => ({ id: 'agent-1' }));
const currentSessionHash = vi.fn(async () => 'session-hash');
const sessionIsLive = vi.fn(async () => true);
vi.mock('@/lib/auth/session', () => ({ getSessionAgent, currentSessionHash, sessionIsLive }));

const goOnline = vi.fn(async () => {});
const goOffline = vi.fn(async () => {});
const beat = vi.fn(async () => {});
vi.mock('@/lib/assignment/presence', () => ({ goOnline, goOffline, beat }));

const { GET } = await import('./route');

function abortedRequest(): Request {
  const controller = new AbortController();
  controller.abort();
  return new Request('http://localhost/api/presence', { signal: controller.signal });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/**
 * This stream's beat is what keeps an agent in the assignment rota, so the
 * failure being guarded is not a leaked timer in the abstract: it is a console
 * that was closed before the stream started going on reporting its owner as
 * available, every 25 seconds, for as long as the process lives. The abort
 * handler used to be attached after the work, and a listener added to a signal
 * that has already fired never runs.
 */
describe('GET /api/presence', () => {
  it('opens no beat and asserts no presence when the request is already aborted', async () => {
    vi.useFakeTimers();

    await GET(abortedRequest());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(goOnline).not.toHaveBeenCalled();
    expect(beat).not.toHaveBeenCalled();
  });

  it('does not sign off a presence it never asserted', async () => {
    vi.useFakeTimers();

    await GET(abortedRequest());
    await vi.advanceTimersByTimeAsync(60_000);

    // `goOffline` here would take the agent's *other* console out of the rota,
    // which is why this path closes the controller directly rather than
    // reusing the abort cleanup.
    expect(goOffline).not.toHaveBeenCalled();
  });
});
