// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useFieldAction, type LinkAction } from './use-field-action';

/**
 * What a sidebar control sees when its action redirects. `updateTicket` does
 * when an edit takes the ticket out of the agent's own sight, and Next then
 * rejects the call with its redirect while the router navigates. The hook must
 * take that as the navigation it is — not leave the control pending, and not
 * let the rejection escape the control's handler — while an action that
 * genuinely fails still throws.
 *
 * The real `next/navigation` but for the router, so the redirect is Next's own
 * error and `unstable_rethrow` judges it as it would in the browser.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => router,
}));
const { redirect } = await import('next/navigation');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function mount(action: LinkAction) {
  const seen = {} as {
    run: (fields: Record<string, string>) => Promise<unknown>;
    pending: boolean;
  };
  function Control() {
    const field = useFieldAction(action);
    seen.run = field.run;
    seen.pending = field.pending;
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(createElement(Control)));
  return seen;
}

describe('useFieldAction', () => {
  it('answers a redirect as nothing refused, and is not left pending', async () => {
    const seen = mount(async () => redirect('/inbox'));

    let result: unknown;
    await act(async () => {
      result = await seen.run({ field: 'group', value: 'elsewhere' });
    });

    expect(result).toEqual({ error: null });
    expect(seen.pending).toBe(false);
  });

  it('still throws what is not a redirect', async () => {
    const seen = mount(async () => {
      throw new Error('connection reset');
    });

    await act(async () => {
      await expect(seen.run({ field: 'group', value: 'elsewhere' })).rejects.toThrow(
        'connection reset',
      );
    });
  });
});
