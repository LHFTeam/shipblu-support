import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contactIdentities,
  contacts,
  contactTokens,
  jobs,
  passwordResets,
  sessions,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { saveAgentProfile } from '@/lib/admin/agent-profile';
import { withCleanDatabase } from '@/lib/testing/db';
import { requestAccountReset } from './account-reset';
import { verifyPassword } from './password';
import {
  completeAgentPasswordReset,
  deleteExpiredPasswordResets,
  discardUnsentReset,
  findLiveAgentReset,
  issueAgentPasswordReset,
  requestAgentPasswordReset,
  revokePasswordResets,
} from './password-reset';
import { hashToken } from './tokens';

/**
 * An agent's forgotten password, against Postgres, because every rule in it is
 * about rows somebody else can change between two of its steps: the agent
 * deactivated after the mail went, a link redeemed twice at once, a link in a
 * mailbox the agent no longer has.
 */

withCleanDatabase();

const NOW = new Date('2026-11-26T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const PASSWORD = 'Correct-Horse-9-battery';

let savedFrom: string | undefined;
beforeEach(() => {
  savedFrom = process.env.EMAIL_FROM_ADDRESS;
  process.env.EMAIL_FROM_ADDRESS = 'support@shipblu.test';
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (savedFrom === undefined) delete process.env.EMAIL_FROM_ADDRESS;
  else process.env.EMAIL_FROM_ADDRESS = savedFrom;
  resetEnvCache();
  vi.restoreAllMocks();
});

async function agent(values: Partial<typeof agents.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona', email: 'mona@shipblu.test', passwordHash: 'old-hash', ...values })
    .returning({ id: agents.id });
  return row!.id;
}

async function link(
  agentId: string,
  token: string,
  values: Partial<typeof passwordResets.$inferInsert> = {},
) {
  await db.insert(passwordResets).values({
    tokenHash: hashToken(token),
    agentId,
    expiresAt: new Date(NOW.getTime() + HOUR),
    ...values,
  });
}

function queued(type: 'send_agent_password_reset' | 'send_notification_email') {
  return db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.type, type));
}

async function hashOf(agentId: string) {
  const [row] = await db
    .select({ passwordHash: agents.passwordHash })
    .from(agents)
    .where(eq(agents.id, agentId));
  return row!.passwordHash;
}

describe('requestAgentPasswordReset', () => {
  it('queues the agent by id, and writes no link', async () => {
    const id = await agent();

    expect(await requestAgentPasswordReset('mona@shipblu.test')).toBe(true);

    // The payload is the whole reason the worker mints: nothing in it opens
    // the account.
    expect(await queued('send_agent_password_reset')).toEqual([{ payload: { agentId: id } }]);
    expect(await db.$count(passwordResets)).toBe(0);
  });

  it.each([
    ['nobody', async () => undefined],
    ['a deactivated agent', async () => void (await agent({ isActive: false }))],
    [
      'an invited agent who never set a password',
      async () => void (await agent({ passwordHash: null })),
    ],
  ])('is not an agent for %s, and writes nothing', async (_name, arrange) => {
    await arrange();

    expect(await requestAgentPasswordReset('mona@shipblu.test')).toBe(false);
    expect(await db.$count(jobs)).toBe(0);
    expect(await db.$count(passwordResets)).toBe(0);
  });

  it('queues nothing for a stored address the provider refuses, and does not print it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await agent({ email: 'mona..farouk@gmail.com' });

    // Still the agent's address: `true`, so no customer's link goes instead.
    expect(await requestAgentPasswordReset('mona..farouk@gmail.com')).toBe(true);

    expect(await db.$count(jobs)).toBe(0);
    const printed = warn.mock.calls.flat().join(' ');
    expect(printed).toContain(`agent=${id}`);
    expect(printed).not.toContain('gmail.com');
  });

  it('queues nothing while no sender is configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.EMAIL_FROM_ADDRESS;
    resetEnvCache();
    await agent();

    expect(await requestAgentPasswordReset('mona@shipblu.test')).toBe(true);
    expect(await db.$count(jobs)).toBe(0);
  });
});

describe('requestAccountReset', () => {
  async function customer(email: string) {
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Mona' })
      .returning({ id: contacts.id });
    await db.insert(contactIdentities).values({
      contactId: contact!.id,
      channel: 'email',
      identifier: email,
      isVerified: true,
      passwordHash: 'portal-hash',
    });
  }

  it("sends an agent the console's link only, though the address is a customer's too", async () => {
    await agent();
    await customer('mona@shipblu.test');

    await requestAccountReset('mona@shipblu.test', 'ar');

    expect(await queued('send_agent_password_reset')).toHaveLength(1);
    expect(await queued('send_notification_email')).toHaveLength(0);
    expect(await db.$count(contactTokens)).toBe(0);
  });

  it("sends a deactivated agent's address the portal's link, as sign-in would check that password", async () => {
    await agent({ isActive: false });
    await customer('mona@shipblu.test');

    await requestAccountReset('mona@shipblu.test', 'ar');

    expect(await queued('send_agent_password_reset')).toHaveLength(0);
    expect(await db.$count(contactTokens)).toBe(1);
  });

  it('writes nothing for an address that is nobody', async () => {
    await requestAccountReset('stranger@example.com', 'ar');

    expect(await db.$count(jobs)).toBe(0);
    expect(await db.$count(contactTokens)).toBe(0);
    expect(await db.$count(contacts)).toBe(0);
  });
});

describe('issueAgentPasswordReset', () => {
  it('mints a link good for an hour and stores only its hash', async () => {
    const id = await agent();

    const issued = await issueAgentPasswordReset(id, NOW);

    expect(issued).toMatchObject({
      to: 'mona@shipblu.test',
      name: 'Mona',
      expiresAt: new Date(NOW.getTime() + HOUR),
    });
    const rows = await db.select().from(passwordResets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(issued!.token));
    expect(rows[0]!.tokenHash).not.toBe(issued!.token);
  });

  it('leaves an earlier link working, and stops at five outstanding', async () => {
    const id = await agent();

    const first = await issueAgentPasswordReset(id, NOW);
    for (let i = 0; i < 4; i += 1) expect(await issueAgentPasswordReset(id, NOW)).not.toBeNull();

    expect(await issueAgentPasswordReset(id, NOW)).toBeNull();
    expect(await db.$count(passwordResets)).toBe(5);
    expect(await findLiveAgentReset(first!.token, NOW)).toMatchObject({ agentId: id });

    // The cap is on what is outstanding: an hour on, there is room again.
    expect(await issueAgentPasswordReset(id, new Date(NOW.getTime() + HOUR))).not.toBeNull();
  });

  it('mints nothing for an agent who can no longer sign in, or who is gone', async () => {
    const id = await agent({ isActive: false });

    expect(await issueAgentPasswordReset(id, NOW)).toBeNull();
    expect(await issueAgentPasswordReset('5b0c8f4e-7a1d-4c6b-9e2f-3a4b5c6d7e8f', NOW)).toBeNull();
    expect(await db.$count(passwordResets)).toBe(0);
  });

  it('mints nothing that would give a first password to an invited agent', async () => {
    const id = await agent({ passwordHash: null });

    expect(await issueAgentPasswordReset(id, NOW)).toBeNull();
    expect(await db.$count(passwordResets)).toBe(0);
  });

  it('mints nothing for a stored address the provider refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await agent({ email: 'mona..farouk@gmail.com' });

    expect(await issueAgentPasswordReset(id, NOW)).toBeNull();
    expect(await db.$count(passwordResets)).toBe(0);
  });
});

describe('findLiveAgentReset', () => {
  it('opens the link its token names, and nothing for any other', async () => {
    const id = await agent();
    await link(id, 'live');
    await link(id, 'used', { usedAt: NOW });
    // Expiring at the instant asked about is expired.
    await link(id, 'expired', { expiresAt: NOW });

    expect(await findLiveAgentReset('live', NOW)).toEqual({
      agentId: id,
      email: 'mona@shipblu.test',
    });
    expect(await findLiveAgentReset('guess', NOW)).toBeNull();
    expect(await findLiveAgentReset('used', NOW)).toBeNull();
    expect(await findLiveAgentReset('expired', NOW)).toBeNull();
    // The stored hash is not the credential.
    expect(await findLiveAgentReset(hashToken('live'), NOW)).toBeNull();
  });

  it('opens nothing once the agent is deactivated', async () => {
    const id = await agent();
    await link(id, 'live');
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, id));

    expect(await findLiveAgentReset('live', NOW)).toBeNull();
  });
});

describe('completeAgentPasswordReset', () => {
  async function session(agentId: string, token: string) {
    await db.insert(sessions).values({
      tokenHash: hashToken(token),
      agentId,
      expiresAt: new Date(NOW.getTime() + 24 * HOUR),
    });
  }

  it('refuses a weak password and leaves the link to try again with', async () => {
    const id = await agent();
    await link(id, 'live');

    expect(await completeAgentPasswordReset('live', 'short', NOW)).toMatchObject({
      ok: false,
      reason: 'weak_password',
    });

    expect(await findLiveAgentReset('live', NOW)).not.toBeNull();
    expect(await hashOf(id)).toBe('old-hash');
  });

  it('changes the password, ends every session of theirs, and cancels their other links', async () => {
    const id = await agent();
    const other = await agent({ name: 'Omar', email: 'omar@shipblu.test' });
    await link(id, 'live');
    await link(id, 'sibling');
    await link(other, 'theirs');
    await session(id, 'laptop');
    await session(id, 'phone');
    await session(other, 'omar');

    expect(await completeAgentPasswordReset('live', PASSWORD, NOW)).toEqual({ ok: true });

    expect(await verifyPassword((await hashOf(id))!, PASSWORD)).toBe(true);
    expect(await db.select({ agentId: sessions.agentId }).from(sessions)).toEqual([
      { agentId: other },
    ]);

    const left = await db
      .select({ tokenHash: passwordResets.tokenHash, usedAt: passwordResets.usedAt })
      .from(passwordResets)
      .orderBy(passwordResets.agentId);
    expect(left).toHaveLength(2);
    expect(left).toContainEqual({ tokenHash: hashToken('live'), usedAt: NOW });
    expect(left).toContainEqual({ tokenHash: hashToken('theirs'), usedAt: null });
    expect(await hashOf(other)).toBe('old-hash');

    // The agent is told, in an email that carries no link.
    const mail = await queued('send_notification_email');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.payload).toMatchObject({
      to: 'mona@shipblu.test',
      subject: 'Your ShipBlu Support password was changed',
    });
    expect(JSON.stringify(mail[0]!.payload)).not.toContain('http');
  });

  it('works once', async () => {
    const id = await agent();
    await link(id, 'live');

    expect(await completeAgentPasswordReset('live', PASSWORD, NOW)).toEqual({ ok: true });
    const first = await hashOf(id);

    expect(await completeAgentPasswordReset('live', 'Another-Horse-9-battery', NOW)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect(await hashOf(id)).toBe(first);
  });

  it('lets one of two submissions of the same link win', async () => {
    const id = await agent();
    await link(id, 'live');

    const results = await Promise.all([
      completeAgentPasswordReset('live', PASSWORD, NOW),
      completeAgentPasswordReset('live', 'Another-Horse-9-battery', NOW),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await queued('send_notification_email')).toHaveLength(1);
  });

  it.each([
    ['unknown', 'guess'],
    ['expired', 'expired'],
  ])('refuses an %s link', async (_name, token) => {
    const id = await agent();
    await link(id, 'expired', { expiresAt: NOW });

    expect(await completeAgentPasswordReset(token, PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect(await hashOf(id)).toBe('old-hash');
  });

  it('refuses the link of an agent deactivated since it was sent', async () => {
    const id = await agent();
    await link(id, 'live');
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, id));

    expect(await completeAgentPasswordReset('live', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect(await hashOf(id)).toBe('old-hash');
  });

  it('never sets a first password: an invited agent holding a link redeems nothing', async () => {
    // No path mints one for them; a row written some other way must still not
    // activate an account nobody activated.
    const id = await agent({ passwordHash: null });
    await link(id, 'live');

    expect(await findLiveAgentReset('live', NOW)).toBeNull();
    expect(await completeAgentPasswordReset('live', PASSWORD, NOW)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect(await hashOf(id)).toBeNull();
  });

  it('queues no notice to an address its job would refuse, and still changes the password', async () => {
    const id = await agent({ email: 'mona..farouk@gmail.com' });
    await link(id, 'live');

    expect(await completeAgentPasswordReset('live', PASSWORD, NOW)).toEqual({ ok: true });
    expect(await verifyPassword((await hashOf(id))!, PASSWORD)).toBe(true);
    expect(await db.$count(jobs)).toBe(0);
  });

  it('still changes the password when the notice cannot be sent', async () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    resetEnvCache();
    const id = await agent();
    await link(id, 'live');

    expect(await completeAgentPasswordReset('live', PASSWORD, NOW)).toEqual({ ok: true });
    expect(await db.$count(jobs)).toBe(0);
  });
});

describe('what cancels a link', () => {
  it('revokes every link of the agent named, and nobody else', async () => {
    const id = await agent();
    const other = await agent({ name: 'Omar', email: 'omar@shipblu.test' });
    await link(id, 'one');
    await link(id, 'two', { usedAt: NOW });
    await link(other, 'theirs');

    await revokePasswordResets(db, id);

    expect(await db.select({ agentId: passwordResets.agentId }).from(passwordResets)).toEqual([
      { agentId: other },
    ]);
  });

  it('withdraws an unsent link, and never one that was used', async () => {
    const id = await agent();
    await link(id, 'unsent');
    await link(id, 'used', { usedAt: NOW });

    await discardUnsentReset('unsent');
    await discardUnsentReset('used');

    expect(await db.select({ tokenHash: passwordResets.tokenHash }).from(passwordResets)).toEqual([
      { tokenHash: hashToken('used') },
    ]);
  });

  it('a change of address cancels the links sent to the old one', async () => {
    const admin = await agent({
      name: 'Admin',
      email: 'admin@shipblu.test',
      role: 'account_admin',
    });
    const id = await agent({ role: 'agent' });
    await link(id, 'old-inbox');

    const refusal = await saveAgentProfile(admin, id, {
      name: 'Mona',
      email: 'mona.farouk@shipblu.test',
      role: 'agent',
      groups: { held: [], chosen: [] },
    });

    expect(refusal).toBeNull();
    expect(await db.$count(passwordResets, eq(passwordResets.agentId, id))).toBe(0);
  });

  it('cleanup deletes the expired, spent or not, and keeps what still works', async () => {
    const id = await agent();
    const past = new Date(Date.now() - HOUR);
    const future = new Date(Date.now() + HOUR);
    await link(id, 'expired', { expiresAt: past });
    await link(id, 'spent-and-expired', { expiresAt: past, usedAt: past });
    await link(id, 'live', { expiresAt: future });

    expect(await deleteExpiredPasswordResets()).toBe(2);
    expect(await db.select({ tokenHash: passwordResets.tokenHash }).from(passwordResets)).toEqual([
      { tokenHash: hashToken('live') },
    ]);
  });
});
