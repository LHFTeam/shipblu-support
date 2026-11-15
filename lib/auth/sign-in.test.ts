import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from './identity';

const calls: string[] = [];
let principal: Principal = { kind: 'invalid' };
let attemptAllowed = true;
let dispatchAllowed = true;

vi.mock('@/lib/http/request-meta', () => ({
  requestMeta: async () => ({ ip: '198.51.100.7', userAgent: 'test' }),
}));
vi.mock('@/lib/auth/throttle', () => ({
  allowLoginAttempt: () => attemptAllowed,
  allowEmailDispatch: () => dispatchAllowed,
  clearLoginAttempts: () => void calls.push('clearLoginAttempts'),
}));
vi.mock('@/lib/auth/identity', () => ({
  authenticate: async () => {
    calls.push('authenticate');
    return principal;
  },
}));
vi.mock('@/lib/auth/session', () => ({
  createSession: async (id: string) => void calls.push(`createSession ${id}`),
}));
vi.mock('@/lib/auth/customer-session', () => ({
  createCustomerSession: async (id: string) => void calls.push(`createCustomerSession ${id}`),
}));
vi.mock('@/lib/portal/accounts', () => ({
  recordSignIn: async (id: string) => void calls.push(`recordSignIn ${id}`),
  requestPasswordReset: async (email: string, locale: string) =>
    void calls.push(`requestPasswordReset ${email} ${locale}`),
}));
vi.mock('@/db/client', () => ({
  db: {
    update: () => ({ set: () => ({ where: async () => void calls.push('lastSeenAt') }) }),
  },
}));

const { signInWithPassword } = await import('./sign-in');

beforeEach(() => {
  calls.length = 0;
  principal = { kind: 'invalid' };
  attemptAllowed = true;
  dispatchAllowed = true;
});

describe('signInWithPassword', () => {
  it('refuses a throttled address before the password is checked', async () => {
    attemptAllowed = false;
    principal = { kind: 'agent', agentId: 'a1' };

    expect(await signInWithPassword('amira@example.test', 'pw', 'ar')).toBe('throttled');
    expect(calls).toEqual([]);
  });

  it('keeps the attempts counted after a wrong password, and starts no session', async () => {
    expect(await signInWithPassword('amira@example.test', 'pw', 'ar')).toBe('invalid');
    expect(calls).toEqual(['authenticate']);
  });

  it('re-sends the confirmation link in the form’s language, and starts no session', async () => {
    principal = { kind: 'unverified', identityId: 'i1', email: 'amira@example.test' };

    expect(await signInWithPassword('amira@example.test', 'pw', 'en')).toBe('unverified');
    expect(calls).toEqual(['authenticate', 'requestPasswordReset amira@example.test en']);
  });

  it('does not re-send the link past the email throttle', async () => {
    principal = { kind: 'unverified', identityId: 'i1', email: 'amira@example.test' };
    dispatchAllowed = false;

    expect(await signInWithPassword('amira@example.test', 'pw', 'ar')).toBe('unverified');
    expect(calls).toEqual(['authenticate']);
  });

  it('signs a customer in and records it', async () => {
    principal = { kind: 'customer', identityId: 'i1' };

    expect(await signInWithPassword('amira@example.test', 'pw', 'ar')).toBe('customer');
    expect(calls).toEqual([
      'authenticate',
      'clearLoginAttempts',
      'createCustomerSession i1',
      'recordSignIn i1',
    ]);
  });

  it('signs an agent in and marks them seen', async () => {
    principal = { kind: 'agent', agentId: 'a1' };

    expect(await signInWithPassword('omar@shipblu.test', 'pw', 'ar')).toBe('agent');
    expect(calls).toEqual(['authenticate', 'clearLoginAttempts', 'createSession a1', 'lastSeenAt']);
  });

  // The help centre's own host serves no console, and the session cookie is
  // host-only: a session started there opened an inbox whose every click
  // answered 404. The password was right, so the attempts are cleared all the
  // same.
  it('starts no agent session where no console is served', async () => {
    principal = { kind: 'agent', agentId: 'a1' };

    expect(
      await signInWithPassword('omar@shipblu.test', 'pw', 'ar', { consoleServedHere: false }),
    ).toBe('agent_elsewhere');
    expect(calls).toEqual(['authenticate', 'clearLoginAttempts']);
  });

  it('still signs a customer in there, whose portal is the help centre', async () => {
    principal = { kind: 'customer', identityId: 'i1' };

    expect(
      await signInWithPassword('amira@example.test', 'pw', 'ar', { consoleServedHere: false }),
    ).toBe('customer');
    expect(calls).toContain('createCustomerSession i1');
  });
});
