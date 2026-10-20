import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contactIdentities, contacts, extensionSessions } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  deleteExpiredExtensionSessions,
  destroyExtensionSession,
  extensionAgentFor,
  signInExtension,
} from './extension-session';
import { hashPassword } from './password';
import { destroyAllSessionsForAgent } from './session';

/**
 * The extension's bearer session against the real tables. The token is a week
 * long and lives in a browser profile, so what it opens — and what closes it —
 * is pinned here rather than assumed from the console's cookie session.
 */

withCleanDatabase();

const META = { ip: '203.0.113.9', userAgent: 'vitest' };
const PASSWORD = 'correct horse battery staple';

async function agent(email: string) {
  const [row] = await db
    .insert(agents)
    .values({ email, name: email, passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: agents.id });
  return row!.id;
}

function request(token: string | null) {
  return new Request('https://support.test/api/extension/session', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function signIn(email: string) {
  const outcome = await signInExtension(email, PASSWORD, META);
  if (outcome.kind !== 'signed_in') throw new Error(`expected a session, got ${outcome.kind}`);
  return outcome;
}

describe('signInExtension', () => {
  it('signs an agent in and the token opens that agent', async () => {
    const id = await agent('ext-agent@shipblu.test');
    const { token, expiresAt } = await signIn('ext-agent@shipblu.test');

    expect(await extensionAgentFor(request(token))).toMatchObject({ id, sessionIdleForMs: 0 });
    // A week, give or take the test's own runtime.
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
  });

  it('refuses a wrong password', async () => {
    await agent('ext-wrong@shipblu.test');
    expect(await signInExtension('ext-wrong@shipblu.test', 'nope', META)).toEqual({
      kind: 'invalid',
    });
  });

  it('answers a customer’s correct password as invalid, and writes no session', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Customer', primaryEmail: 'ext-customer@shipblu.test' })
      .returning({ id: contacts.id });
    await db.insert(contactIdentities).values({
      contactId: contact!.id,
      channel: 'email',
      identifier: 'ext-customer@shipblu.test',
      passwordHash: await hashPassword(PASSWORD),
      isVerified: true,
    });

    expect(await signInExtension('ext-customer@shipblu.test', PASSWORD, META)).toEqual({
      kind: 'invalid',
    });
    expect(await db.select().from(extensionSessions)).toHaveLength(0);
  });
});

describe('extensionAgentFor', () => {
  it('opens nothing without a token, or with one nobody holds', async () => {
    expect(await extensionAgentFor(request(null))).toBeNull();
    expect(await extensionAgentFor(request('guess'))).toBeNull();
  });

  it('opens nothing once the session has expired, and the sweep removes it', async () => {
    await agent('ext-expired@shipblu.test');
    const { token } = await signIn('ext-expired@shipblu.test');
    await db.update(extensionSessions).set({ expiresAt: new Date(Date.now() - 1000) });

    expect(await extensionAgentFor(request(token))).toBeNull();
    expect(await deleteExpiredExtensionSessions()).toBe(1);
  });

  it('opens nothing for an agent deactivated after signing in', async () => {
    const id = await agent('ext-deactivated@shipblu.test');
    const { token } = await signIn('ext-deactivated@shipblu.test');
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, id));

    expect(await extensionAgentFor(request(token))).toBeNull();
  });
});

describe('signing out', () => {
  it('ends the one session the token names', async () => {
    await agent('ext-out@shipblu.test');
    const first = await signIn('ext-out@shipblu.test');
    const second = await signIn('ext-out@shipblu.test');

    expect(await destroyExtensionSession(request(first.token))).toBe(true);
    expect(await extensionAgentFor(request(first.token))).toBeNull();
    expect(await extensionAgentFor(request(second.token))).not.toBeNull();
  });

  it('offboarding ends every extension session the agent holds', async () => {
    const id = await agent('ext-offboard@shipblu.test');
    const { token } = await signIn('ext-offboard@shipblu.test');

    await destroyAllSessionsForAgent(id);

    expect(await extensionAgentFor(request(token))).toBeNull();
  });
});
