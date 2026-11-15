import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';

/**
 * Where the help centre's sign-in sends an agent, by the host it was posted to.
 *
 * On 2026-11-15 an admin signed in at support.shipblu.com/ar/account/login,
 * once `KB_PUBLIC_HOST` named that host. The action redirected to `/inbox`, and
 * a server action's redirect is rendered in the same request without passing
 * the proxy, so the inbox drew on the help centre's host. Every group view, and
 * every other click in it, then went through the proxy, was rewritten under
 * /help and answered 404. The password check itself is `signInWithPassword`'s,
 * tested beside it; this holds the action to asking it the right question and
 * to sending the agent where the console is.
 */

const state = vi.hoisted(() => ({
  host: 'support.shipblu.com' as string | null,
  outcome: 'agent_elsewhere' as string,
  asked: [] as unknown[],
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'host' ? state.host : null) }),
}));
// Next's redirect throws to end the action; the test reads where it went.
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));
vi.mock('@/lib/auth/sign-in', () => ({
  signInWithPassword: async (...args: unknown[]) => {
    state.asked.push(args[3]);
    return state.outcome;
  },
}));

const { portalSignIn } = await import('./actions');

withTestEnv({
  KB_PUBLIC_HOST: 'support.shipblu.com',
  APP_URL: 'https://shipblu-support.onrender.com',
});

beforeEach(() => {
  state.host = 'support.shipblu.com';
  state.outcome = 'agent_elsewhere';
  state.asked.length = 0;
});

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set('locale', 'ar');
  data.set('email', 'omar@shipblu.com');
  data.set('password', 'Correct-Horse-9-battery');
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe('portalSignIn, for an agent', () => {
  it('on the help centre’s host, asks for no session and sends them to the console’s sign-in', async () => {
    await expect(portalSignIn({ error: null }, form())).rejects.toThrow(
      'NEXT_REDIRECT https://shipblu-support.onrender.com/login?next=%2Finbox&from=help-centre',
    );
    expect(state.asked).toEqual([{ consoleServedHere: false }]);
  });

  it('carries the page they were going to, on the console’s host', async () => {
    await expect(portalSignIn({ error: null }, form({ next: '/inbox/1042' }))).rejects.toThrow(
      'NEXT_REDIRECT https://shipblu-support.onrender.com/login?next=%2Finbox%2F1042&from=help-centre',
    );
  });

  it('on the console’s host, signs them in and opens the inbox there, as before', async () => {
    state.host = 'shipblu-support.onrender.com';
    state.outcome = 'agent';

    await expect(portalSignIn({ error: null }, form())).rejects.toThrow('NEXT_REDIRECT /inbox');
    expect(state.asked).toEqual([{ consoleServedHere: true }]);
  });

  // Sent to APP_URL when it is the help centre's host, the agent would land on
  // the same 404 again; a sentence on the form is the better failure.
  it('says something went wrong when APP_URL names no console', async () => {
    setTestEnv({ APP_URL: 'https://support.shipblu.com' });

    await expect(portalSignIn({ error: null }, form())).resolves.toEqual({
      error: 'errorGeneric',
    });
  });
});
