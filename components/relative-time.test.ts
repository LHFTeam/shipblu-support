// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatRelative } from '@/lib/format';
import { RelativeTime } from './relative-time';

/**
 * A relative time drawn by a client component, rendered on the "server" at one
 * instant and hydrated in the "browser" across a minute boundary from it —
 * the case §6.96 left open, where React finds the text changed and rebuilds the
 * whole page. The first case is the control: the shape every call site had,
 * reading the clock while it renders, is caught by this harness, so the cases
 * after it saying nothing was caught mean something.
 *
 * `.ts` with `createElement`, as `components/use-action-form.test.ts` explains.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const SENT = new Date('2026-10-15T09:00:00Z');
const SERVER_AT = new Date('2026-10-15T09:02:59Z'); // "2m"
const BROWSER_AT = new Date('2026-10-15T09:03:01Z'); // "3m"

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

/** Server HTML at `SERVER_AT`, hydrated at `BROWSER_AT`; what React complained about. */
function renderAcrossTheBoundary(element: ReactNode) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SERVER_AT);
  const html = renderToString(element);

  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.replaceChildren(host);

  vi.setSystemTime(BROWSER_AT);
  const errors: unknown[] = [];
  act(() => {
    root = hydrateRoot(host, element, { onRecoverableError: (error) => errors.push(error) });
  });

  return { html, errors, text: () => host.textContent };
}

describe('RelativeTime', () => {
  it('is what stops the mismatch: the clock read while rendering is caught here', () => {
    function ReadsTheClock() {
      return formatRelative(SENT, new Date());
    }

    const { html, errors } = renderAcrossTheBoundary(createElement(ReadsTheClock));
    expect(html).toBe('2m');
    expect(errors).not.toHaveLength(0);
  });

  it('hydrates without a mismatch, then shows the time', () => {
    const { html, errors, text } = renderAcrossTheBoundary(
      createElement(RelativeTime, { at: SENT }),
    );
    expect(html).toBe('');
    expect(errors).toEqual([]);
    expect(text()).toBe('3m');
  });

  it('draws a worded phrase whole once hydrated, and none of it before', () => {
    const phrase = createElement(
      'p',
      null,
      // A render function, which createElement's rest arguments type as a ReactNode.
      // eslint-disable-next-line react/no-children-prop
      createElement(RelativeTime, { at: SENT, children: (ago: string) => `Opened ${ago} ago` }),
    );

    const { html, errors, text } = renderAcrossTheBoundary(phrase);
    expect(html).toBe('<p></p>');
    expect(errors).toEqual([]);
    expect(text()).toBe('Opened 3m ago');
  });

  it('accepts the instant as the string a server action or a fetch hands over', () => {
    const { errors, text } = renderAcrossTheBoundary(
      createElement(RelativeTime, { at: SENT.toISOString() }),
    );
    expect(errors).toEqual([]);
    expect(text()).toBe('3m');
  });
});
