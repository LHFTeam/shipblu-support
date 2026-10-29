import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, groupMembers, groups, invites } from '@/db/schema';
import { hashToken } from '@/lib/auth/tokens';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * Accepting an invite, against Postgres, because what it may do depends on
 * rows written by somebody else: the groups the invite names, deleted or not,
 * and an agent who came to hold the invite's address after it was sent — the
 * agent editor can now move one there, and accepting must never overwrite them.
 */

const sessions = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/auth/session', () => ({
  createSession: async (agentId: string) => sessions.push(agentId),
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

const { acceptInvite } = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };
const PASSWORD = 'Correct-Horse-9-battery';

beforeEach(() => {
  sessions.length = 0;
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
