import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, groupMembers, groups, invites, jobs, passwordResets } from '@/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { hashToken } from '@/lib/auth/tokens';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * Accepting an invite, against Postgres, because what it may do depends on
 * rows written by somebody else: the groups the invite names, deleted or not,
 * and an agent who came to hold the invite's address after it was sent — the
 * agent editor can now move one there, and accepting must never overwrite them.
 */

const sessions = vi.hoisted(() => [] as string[]);
// Only the session's creation is replaced: a reset ends sessions through the
// real `destroyAllSessionsForAgent`, and must never reach `createSession`.
vi.mock('@/lib/auth/session', async (original) => ({
  ...(await original<typeof import('@/lib/auth/session')>()),
  createSession: async (agentId: string) => sessions.push(agentId),
}));
const throttle = vi.hoisted(() => ({ allows: true, asked: [] as string[] }));
vi.mock('@/lib/auth/throttle', () => ({
  allowEmailDispatch: (email: string) => {
    throttle.asked.push(email);
    return throttle.allows;
  },
}));
vi.mock('@/lib/http/request-meta', () => ({
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));
// Next's redirect throws to end the action; the test only needs to know it ran.
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const { acceptInvite, bootstrapAdmin, requestReset, resetPassword } = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };
const PASSWORD = 'Correct-Horse-9-battery';

let savedFrom: string | undefined;
beforeEach(() => {
  sessions.length = 0;
  throttle.allows = true;
  throttle.asked.length = 0;
  savedFrom = process.env.EMAIL_FROM_ADDRESS;
  process.env.EMAIL_FROM_ADDRESS = 'support@shipblu.test';
  resetEnvCache();
});
afterEach(() => {
  if (savedFrom === undefined) delete process.env.EMAIL_FROM_ADDRESS;
  else process.env.EMAIL_FROM_ADDRESS = savedFrom;
  resetEnvCache();
  vi.restoreAllMocks();
});

async function invite(token: string, values: Partial<typeof invites.$inferInsert> = {}) {
  await db.insert(invites).values({
    tokenHash: hashToken(token),
    email: 'new@shipblu.test',
    name: 'New Agent',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    ...values,
  });
}

function accept(token: string) {
  const data = new FormData();
  data.set('token', token);
  data.set('password', PASSWORD);
  return acceptInvite(INITIAL, data);
}

describe('acceptInvite', () => {
  it('creates the agent in the groups the invite names, skipping one deleted since', async () => {
    const [sales, gone] = await db
      .insert(groups)
      .values([{ name: 'Sales' }, { name: 'Gone' }])
      .returning({ id: groups.id });
    await db.delete(groups).where(eq(groups.id, gone!.id));
    await invite('one', { groupIds: [sales!.id, gone!.id] });

    await expect(accept('one')).rejects.toThrow('NEXT_REDIRECT /inbox');

    const [created] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.email, 'new@shipblu.test'));
    expect(sessions).toEqual([created!.id]);
    expect(
      await db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.agentId, created!.id)),
    ).toEqual([{ groupId: sales!.id }]);
  });

  it('never overwrites an active agent who came to hold the address, and keeps the invite', async () => {
    await invite('two');
    // Moved onto the address by the agent editor after the invite was sent.
    const [holder] = await db
      .insert(agents)
      .values({ name: 'Omar', email: 'new@shipblu.test', passwordHash: 'theirs' })
      .returning({ id: agents.id });

    expect(await accept('two')).toEqual({
      error: 'Somebody already signs in with this address. Ask for a new invite.',
    });

    const [after] = await db
      .select({ name: agents.name, passwordHash: agents.passwordHash })
      .from(agents)
      .where(eq(agents.id, holder!.id));
    expect(after).toEqual({ name: 'Omar', passwordHash: 'theirs' });
    expect(sessions).toEqual([]);
    const [pending] = await db
      .select({ acceptedAt: invites.acceptedAt })
      .from(invites)
      .where(eq(invites.tokenHash, hashToken('two')));
    expect(pending!.acceptedAt).toBeNull();
  });

  it('refuses a name longer than the agent editor would save back', async () => {
    // The editor sends the name with every save and refuses one over the cap,
    // so an agent created with a longer one could not have their groups or
    // role changed until somebody rewrote it.
    await invite('four');
    const data = new FormData();
    data.set('token', 'four');
    data.set('password', PASSWORD);
    data.set('name', 'x'.repeat(121));

    expect(await acceptInvite(INITIAL, data)).toEqual({
      error: 'A name cannot be longer than 120 characters',
    });
    expect(
      await db.select({ id: agents.id }).from(agents).where(eq(agents.email, 'new@shipblu.test')),
    ).toEqual([]);
  });

  it('reactivates a deactivated agent at the address, keeping their history', async () => {
    await invite('three', { role: 'supervisor' });
    const [former] = await db
      .insert(agents)
      .values({ name: 'Former', email: 'new@shipblu.test', isActive: false })
      .returning({ id: agents.id });

    await expect(accept('three')).rejects.toThrow('NEXT_REDIRECT /inbox');

    const [after] = await db
      .select({ isActive: agents.isActive, role: agents.role })
      .from(agents)
      .where(eq(agents.id, former!.id));
    expect(after).toEqual({ isActive: true, role: 'supervisor' });
    expect(sessions).toEqual([former!.id]);
  });
});

describe('bootstrapAdmin', () => {
  // `needsBootstrap` remembers an agent once it has seen one, for the life of
  // the module; nothing above asks it, and each test starts from no agents.
  it('refuses a first admin whose address the send path refuses, storing no agent', async () => {
    const data = new FormData();
    data.set('name', 'First Admin');
    data.set('email', 'ops..team@shipblu.test');
    data.set('password', PASSWORD);

    // The address the survey test and low-rating alerts go to, through a job
    // that refuses this spelling (§6.117).
    expect(await bootstrapAdmin(INITIAL, data)).toEqual({ error: 'Enter a valid email address' });
    expect(await db.$count(agents)).toBe(0);
    expect(sessions).toEqual([]);
  });
});

/**
 * The forgotten-password form. What it must never do is answer differently for
 * an address that signs in here: that difference is the staff list.
 */
describe('requestReset', () => {
  function ask(email: string) {
    const data = new FormData();
    data.set('email', email);
    return requestReset(INITIAL, data);
  }

  async function mona() {
    const [row] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test', passwordHash: 'old-hash' })
      .returning({ id: agents.id });
    return row!.id;
  }

  const resetJobs = () => db.$count(jobs, eq(jobs.type, 'send_agent_password_reset'));

  it('refuses a spelling no link could reach, before spending the allowance', async () => {
    expect(await ask('')).toEqual({ error: 'Enter your email address' });
    expect(await ask('mona..farouk@gmail.com')).toEqual({ error: 'Enter a valid email address' });
    expect(throttle.asked).toEqual([]);
  });

  it('ends on the same page for an agent, a stranger and a throttled request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await mona();

    // Written as typed by somebody with caps lock on: the address is normalised.
    await expect(ask(' Mona@ShipBlu.test ')).rejects.toThrow('NEXT_REDIRECT /forgot?sent=1');
    expect(await resetJobs()).toBe(1);

    await expect(ask('stranger@example.com')).rejects.toThrow('NEXT_REDIRECT /forgot?sent=1');
    expect(await resetJobs()).toBe(1);

    throttle.allows = false;
    await expect(ask('mona@shipblu.test')).rejects.toThrow('NEXT_REDIRECT /forgot?sent=1');
    expect(await resetJobs()).toBe(1);
    expect(await db.$count(passwordResets)).toBe(0);
  });
});

describe('resetPassword', () => {
  function redeem(token: string, password = PASSWORD) {
    const data = new FormData();
    data.set('token', token);
    data.set('password', password);
    return resetPassword(INITIAL, data);
  }

  async function linkFor(token: string) {
    const [row] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test', passwordHash: 'old-hash' })
      .returning({ id: agents.id });
    await db.insert(passwordResets).values({
      tokenHash: hashToken(token),
      agentId: row!.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return row!.id;
  }

  it('changes the password and sends the agent to sign in, signing nobody in', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const id = await linkFor('live');

    await expect(redeem('live')).rejects.toThrow('NEXT_REDIRECT /login?reset=1');

    const [after] = await db
      .select({ passwordHash: agents.passwordHash })
      .from(agents)
      .where(eq(agents.id, id));
    expect(await verifyPassword(after!.passwordHash!, PASSWORD)).toBe(true);
    // A link in an inbox is not a session.
    expect(sessions).toEqual([]);
  });

  it('says why a weak password was refused, and keeps the link', async () => {
    await linkFor('live');

    expect(await redeem('live', 'short')).toEqual({
      error: 'Password must be at least 12 characters',
    });
    expect(await redeem('live', 'short')).toEqual({
      error: 'Password must be at least 12 characters',
    });
  });

  it('refuses a link that is used, unknown or missing with one sentence', async () => {
    const refused = { error: 'This link has expired or has already been used. Ask for a new one.' };

    expect(await redeem('guess')).toEqual(refused);
    expect(await redeem('')).toEqual(refused);
  });
});
