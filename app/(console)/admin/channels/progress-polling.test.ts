// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingView } from '@/lib/whatsapp/onboarding-view';

/**
 * The Channels page's poller, in a DOM: it asks the progress endpoint and
 * refreshes the page only for an answer that means the page is out of date.
 * Each case is a way it went wrong or could: a signed-out poll redirected to
 * /login and swallowed, so the tab polled the login page for ever; two pollers
 * on one page each refreshing for the same change; and an answer a render
 * overtook, refreshing the page back towards what it already showed (§6.91).
 * Then the one part of a progress card that moves without a render: the
 * backoff's countdown.
 *
 * Rendered through `OnboardingPolling`, the hook's own component — two of them
 * stand for the page's poller and a "Copy again" burst, which run the same
 * hook. The module's actions are server code, so they are stubbed out.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router, unstable_rethrow: () => {} }));
vi.mock('./actions', () => ({
  connectBusinessAppNumber: vi.fn(),
  forgetStoredCredential: vi.fn(),
  requestCoexistenceSync: vi.fn(),
  retryCoexistenceOnboarding: vi.fn(),
}));

const { OnboardingPolling, OnboardingProgress } = await import('./coexistence-forms');

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

/** A shape of `Response` the hook reads: enough to stand for each kind of answer. */
function answer(shape: { type?: ResponseType; status: number; body?: unknown }): Response {
  return {
    type: shape.type ?? 'basic',
    status: shape.status,
    ok: shape.status >= 200 && shape.status < 300,
    json: () =>
      shape.body === undefined
        ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
        : Promise.resolve(shape.body),
  } as Response;
}
const versionIs = (version: string) => answer({ status: 200, body: { version } });
// What a browser hands back for a redirect it was told not to follow.
const redirected = () => answer({ type: 'opaqueredirect', status: 0 });

// The refreshes already asked for live in the module across cases, as they
// do across a page's pollers, and the hook measures their age on
// `performance.now()`. So one fake clock for the whole file — a new one would
// start again at zero, behind every claim — and an hour between cases, which
// leaves no claim standing.
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});
afterAll(() => {
  vi.useRealTimers();
});

let roots: Root[] = [];
beforeEach(() => {
  vi.advanceTimersByTime(3_600_000);
  router.refresh.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  vi.unstubAllGlobals();
});

function mount(props: { intervalMs: number | null; version: string }) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(OnboardingPolling, props)));
  return {
    rerender: (next: { intervalMs: number | null; version: string }) =>
      act(() => root.render(createElement(OnboardingPolling, next))),
  };
}

/**
 * Lets `ms` of polling go by, half a second per `act`: React commits what each
 * step set off — a transition ending, as a refresh's does in a browser well
 * before the next tick — instead of holding all of it until the end.
 */
async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 500) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(500, left));
    });
  }
}

describe('useProgressPolling', () => {
  it('asks uncached and without following a redirect', async () => {
    fetchMock.mockResolvedValue(versionIs('v1'));
    mount({ intervalMs: 3_000, version: 'v1' });

    await wait(3_000);

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/onboarding-progress', {
      cache: 'no-store',
      redirect: 'manual',
    });
  });

  it('does not refresh while the version is the one the page was rendered with', async () => {
    fetchMock.mockResolvedValue(versionIs('v1'));
    mount({ intervalMs: 3_000, version: 'v1' });

    await wait(30_000);

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('refreshes once for a version that moved, and stops once the page has it', async () => {
    fetchMock.mockResolvedValue(versionIs('v2'));
    const page = mount({ intervalMs: 3_000, version: 'v1' });

    await wait(3_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // The page has not re-rendered with v2 yet: the ticks before it does are
    // told v2 again, and do not ask for a second refresh.
    await wait(6_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    page.rerender({ intervalMs: 3_000, version: 'v2' });
    await wait(30_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('asks again for a refresh that never landed, once the claim on it has lapsed', async () => {
    fetchMock.mockResolvedValue(versionIs('v2'));
    mount({ intervalMs: 3_000, version: 'v1' });

    await wait(3_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // The page never re-rendered with v2: the refresh was lost on the way.
    await wait(12_000);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  // proxy.ts redirects a request with no session cookie to /login before the
  // route can answer 401. Followed, that was a 200 of HTML the hook threw on
  // and swallowed, so the tab never left and polled /login for ever.
  it('refreshes once when the poll is redirected, so the page itself goes to /login', async () => {
    fetchMock.mockResolvedValue(redirected());
    mount({ intervalMs: 3_000, version: 'v1' });

    await wait(3_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes for a 401 or a 403, as for a redirect', async () => {
    fetchMock.mockResolvedValue(answer({ status: 401 }));
    mount({ intervalMs: 3_000, version: 'v1' });
    await wait(3_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    act(() => roots.forEach((root) => root.unmount()));
    roots = [];
    vi.advanceTimersByTime(60_000);
    fetchMock.mockResolvedValue(answer({ status: 403 }));
    mount({ intervalMs: 3_000, version: 'v1' });
    await wait(3_000);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  // A page that keeps rendering while its poll keeps being turned away must
  // not become a refresh on every tick: that is the render-on-a-timer this
  // poller replaced.
  it('refreshes a persistent refusal no faster than the claim on it lapses', async () => {
    fetchMock.mockResolvedValue(redirected());
    mount({ intervalMs: 3_000, version: 'v1' });

    await wait(30_000);

    // Ten asks, at 3 s, 6 s … 30 s; refreshes at 3, 15 and 27 s.
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(router.refresh).toHaveBeenCalledTimes(3);
  });

  it('does not refresh for an answer it cannot read, or a server error', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ status: 500 }))
      .mockResolvedValueOnce(answer({ status: 200 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(versionIs('v1'));
    mount({ intervalMs: 3_000, version: 'v1' });

    await wait(12_000);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('refreshes once between two pollers that see the same change', async () => {
    fetchMock.mockResolvedValue(versionIs('v2'));
    // The page's poller and a "Copy again" burst beside it, a second apart.
    const page = mount({ intervalMs: 3_000, version: 'v1' });
    await wait(1_000);
    const burst = mount({ intervalMs: 3_000, version: 'v1' });

    // The page's poller refreshes at 3 s; the burst is told v2 at 4 s, 7 s and
    // 10 s, while that render is still on its way, and leaves it be.
    await wait(9_500);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    // The render lands, carrying v2 to both.
    page.rerender({ intervalMs: 3_000, version: 'v2' });
    burst.rerender({ intervalMs: 3_000, version: 'v2' });
    await wait(15_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('still refreshes each of two different changes', async () => {
    fetchMock.mockResolvedValue(versionIs('v2'));
    const page = mount({ intervalMs: 3_000, version: 'v1' });

    await wait(3_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    page.rerender({ intervalMs: 3_000, version: 'v2' });
    fetchMock.mockResolvedValue(versionIs('v3'));
    await wait(3_000);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  // A poll that left before a render — an action's revalidation, or the other
  // poller's refresh — answers with what the rows said before it. Compared
  // with the version that render brought, that read as a change, and the page
  // rendered again for "v3 -> v2" while it already showed v3.
  it('drops an answer a render overtook while it was out', async () => {
    let answerWith: (response: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerWith = resolve;
          }),
      )
      .mockResolvedValue(versionIs('v3'));
    const page = mount({ intervalMs: 3_000, version: 'v1' });

    await wait(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    page.rerender({ intervalMs: 3_000, version: 'v3' });
    await act(async () => answerWith(versionIs('v2')));
    expect(router.refresh).not.toHaveBeenCalled();

    // The next tick asks against v3, and v3 is what the server says.
    await wait(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('drops an answer a render overtook while its body was read', async () => {
    let bodyWith: (body: unknown) => void = () => {};
    fetchMock
      .mockResolvedValueOnce({
        type: 'basic',
        status: 200,
        ok: true,
        json: () =>
          new Promise((resolve) => {
            bodyWith = resolve;
          }),
      } as Response)
      .mockResolvedValue(versionIs('v3'));
    const page = mount({ intervalMs: 3_000, version: 'v1' });

    await wait(3_000);
    page.rerender({ intervalMs: 3_000, version: 'v3' });
    await act(async () => bodyWith({ version: 'v2' }));
    await wait(3_000);

    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('stops asking when the interval is null', async () => {
    fetchMock.mockResolvedValue(versionIs('v2'));
    mount({ intervalMs: null, version: 'v1' });

    await wait(30_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

/**
 * The backoff's countdown, which the card draws for itself: `progressVersion`
 * leaves it out, so no render arrives to move it. It counts from the server's
 * clock, carried forward by the browser's — this file's fake browser clock is
 * days away from the server's `now` below, as a laptop's can be minutes away.
 */
describe('OnboardingProgress', () => {
  const SERVER_NOW = Date.parse('2026-10-08T10:00:00.000Z');
  const serverAt = (ms: number) => new Date(SERVER_NOW + ms);

  const attempt = (overrides: Partial<OnboardingView> = {}): OnboardingView => ({
    id: 'o-1',
    status: 'exchanged',
    origin: 'embedded_signup',
    steps: [],
    attempts: 1,
    nextAttemptAt: serverAt(30_000).toISOString(),
    lastTransientError: 'Graph timed out',
    error: null,
    channelId: null,
    phoneNumberId: '109876543210',
    wabaId: '102030405060',
    startedAt: serverAt(-60_000).toISOString(),
    finishedAt: null,
    startedByLabel: null,
    ...overrides,
  });

  function card(onboarding: OnboardingView, now: Date, tokenEnvVar: string | null = null) {
    return createElement(OnboardingProgress, {
      onboarding,
      coexistence: null,
      channelName: null,
      accountName: null,
      credential: null,
      tokenEnvVar,
      canConnect: true,
      connect: { readiness: { ready: false, missing: [] }, groups: [], suggestedGroupId: null },
      now,
    });
  }

  function show(onboarding: OnboardingView, now: Date, tokenEnvVar: string | null = null) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(card(onboarding, now, tokenEnvVar)));
    return {
      text: () => container.textContent ?? '',
      countdown: () => /retrying (in \d+ (s|min)|now)/.exec(container.textContent ?? '')?.[0],
      rerender: (next: OnboardingView, nextNow: Date) =>
        act(() => root.render(card(next, nextNow, tokenEnvVar))),
    };
  }

  it('counts a pending retry down once a second, from the server’s clock', async () => {
    expect(Math.abs(Date.now() - SERVER_NOW)).toBeGreaterThan(24 * 60 * 60 * 1000);
    const shown = show(attempt(), serverAt(0));
    expect(shown.countdown()).toBe('retrying in 30 s');

    await wait(1_000);
    expect(shown.countdown()).toBe('retrying in 29 s');
    await wait(10_000);
    expect(shown.countdown()).toBe('retrying in 19 s');
    await wait(19_000);
    expect(shown.countdown()).toBe('retrying now');

    // Due: nothing left to count, so nothing ticks until the next render.
    await wait(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts again from the clock each render brings', async () => {
    const shown = show(attempt(), serverAt(0));
    await wait(5_000);
    expect(shown.countdown()).toBe('retrying in 25 s');

    // The retry failed again and was put off: the render brings the server's
    // clock and the new instant, and the count starts from those.
    shown.rerender(
      attempt({ attempts: 2, nextAttemptAt: serverAt(100_000).toISOString() }),
      serverAt(60_000),
    );
    expect(shown.countdown()).toBe('retrying in 40 s');
    await wait(3_000);
    expect(shown.countdown()).toBe('retrying in 37 s');
  });

  it('runs no clock when nothing is counting down', () => {
    show(attempt({ lastTransientError: null, nextAttemptAt: null }), serverAt(0));

    expect(vi.getTimerCount()).toBe(0);
  });

  // An adopted number has no stored credential by design, and sends with the
  // variable its account names — until the account stops naming one.
  it('names the variable an adopted number sends with, and only while there is one', () => {
    const connected = attempt({
      origin: 'adopted',
      status: 'connected',
      lastTransientError: null,
      nextAttemptAt: null,
      finishedAt: serverAt(0).toISOString(),
    });

    const named = show(connected, serverAt(0), 'WHATSAPP_TOKEN_SALES');
    expect(named.text()).toContain('sends with WHATSAPP_TOKEN_SALES');
    expect(named.text()).toContain('Nothing else to do.');

    const none = show(connected, serverAt(0), null);
    expect(none.text()).toContain('credential not stored');
    expect(none.text()).not.toContain('Nothing else to do.');
    expect(none.text()).toContain('No credential is stored for this business account now');
  });
});
