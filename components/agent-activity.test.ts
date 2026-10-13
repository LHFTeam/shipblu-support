// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActivity } from './agent-activity';

/**
 * The countdown dialog's buttons, in a DOM. The case this exists for: a press
 * on "Sign out now" reached the window's `pointerdown` listener before the
 * button's `click`, was read as the agent coming back, and dismissed the
 * countdown and kept the session — the one button that could not do what it
 * said. Each case here is one side of the line the fix draws: input inside the
 * dialog is an answer to it, input anywhere else is activity.
 *
 * `.ts` with `createElement`, happy-dom through the pragma above, React's own
 * `act` and `createRoot` — the shape `use-action-form.test.ts` set.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const accepted = () => ({ status: 200, ok: true, json: async () => ({ accepting: true }) });
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => accepted());
const replace = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
beforeEach(() => {
  fetchMock.mockClear();
  replace.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  // The sign-out leaves through `window.location.replace`, which happy-dom
  // would try to carry out; a stub records where it was going instead.
  vi.stubGlobal('location', { ...window.location, replace });
  // Fake timers fake `Date.now` too, which is every clock the component reads.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const POLICY = {
  accepting: true,
  awayAfterMins: null,
  signoutAfterMins: 1,
  warningLeadMs: 20_000,
};

/** The calls `fetch` was given, by endpoint. */
const calls = (path: string) => fetchMock.mock.calls.filter(([input]) => input === path);

/**
 * Mounts a session the server holds to be 45 seconds idle on a one-minute
 * window, and advances to the first tick, where `idleTick` says to warn —
 * 50 seconds in, past the 40-second lead and short of the sign-out.
 */
function mountWithCountdown() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(AgentActivity, { ...POLICY, sessionIdleForMs: 45_000 })));
  expect(container.querySelector('[role=alertdialog]')).toBeNull();

  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  const dialog = () => container.querySelector('[role=alertdialog]');
  expect(dialog()).not.toBeNull();

  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
  return { container, dialog, button };
}

/** A press as the browser delivers it: `pointerdown` on the way to `click`. */
async function press(target: Element, key?: string) {
  await act(async () => {
    if (key) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    } else {
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    }
    if (target instanceof HTMLElement) target.click();
  });
}

describe('AgentActivity countdown', () => {
  it('lets "Sign out now" sign out: the press is not counted as activity', async () => {
    const { button } = mountWithCountdown();
    await press(button('Sign out now'));

    expect(calls('/api/auth/logout')).toHaveLength(1);
    expect(calls('/api/presence/activity')).toHaveLength(0);
    expect(replace).toHaveBeenCalledWith('/login?signedOut=inactivity');
  });

  it('lets Enter on a focused "Sign out now" sign out: the key is not counted either', async () => {
    const { button } = mountWithCountdown();
    await press(button('Sign out now'), 'Enter');

    expect(calls('/api/auth/logout')).toHaveLength(1);
    expect(calls('/api/presence/activity')).toHaveLength(0);
  });

  it('"Stay signed in" sends a beat at once and closes the dialog', async () => {
    const { dialog, button } = mountWithCountdown();
    await press(button('Stay signed in'));

    expect(dialog()).toBeNull();
    expect(calls('/api/auth/logout')).toHaveLength(0);
    const beats = calls('/api/presence/activity');
    expect(beats).toHaveLength(1);
    // An input beat, not the idle report: only this kind moves the session clock.
    expect(beats[0]![1]?.body).toBe('{}');
    expect(replace).not.toHaveBeenCalled();
  });

  it('a press anywhere outside the dialog still dismisses it', async () => {
    const { dialog } = mountWithCountdown();
    await press(document.body);

    expect(dialog()).toBeNull();
    expect(calls('/api/presence/activity')).toHaveLength(1);
    expect(calls('/api/auth/logout')).toHaveLength(0);
  });

  it('a press on the dialog itself, off its buttons, still counts as being back', async () => {
    const { container, dialog } = mountWithCountdown();
    await press(container.querySelector('#idle-warning-desc')!);

    expect(dialog()).toBeNull();
    expect(calls('/api/presence/activity')).toHaveLength(1);
    expect(calls('/api/auth/logout')).toHaveLength(0);
  });

  it('the window regaining focus while the countdown is up is not an answer to it', async () => {
    // A mousedown on the dialog raises the window's focus first when another
    // application had the window; dismissing on it would pull the dialog out
    // from under that click.
    const { dialog } = mountWithCountdown();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(dialog()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the window regaining focus counts as activity when nothing is asked', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(createElement(AgentActivity, { ...POLICY, sessionIdleForMs: 0 })));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(calls('/api/presence/activity')).toHaveLength(1);
  });

  it('a key inside the dialog neither dismisses it nor beats', async () => {
    const { dialog, button } = mountWithCountdown();
    await act(async () => {
      button('Stay signed in').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });

    expect(dialog()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
