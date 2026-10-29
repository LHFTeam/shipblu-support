import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, groupMembers, groups, invites } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import {
  EMAIL_TAKEN,
  GROUP_GONE,
  lockAddress,
  saveAgentProfile,
  type AgentProfileInput,
} from './agent-profile';

/**
 * The agent editor's save. Every refusal here is one the console cannot make
 * for itself, because each depends on rows the form never saw: who else holds
 * an address, an invite waiting on it, and how many account admins are left.
 */

withCleanDatabase();

const NOW = new Date('2026-10-29T10:00:00Z');

type Role = (typeof agents.$inferInsert)['role'];

async function agent(
  name: string,
  values: { role?: Role; isActive?: boolean } = {},
): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase()}@shipblu.test`, ...values })
    .returning({ id: agents.id });
  return row!.id;
}

async function row(id: string) {
  const [found] = await db
    .select({ name: agents.name, email: agents.email, role: agents.role })
    .from(agents)
    .where(eq(agents.id, id));
  return found!;
}

const NO_GROUPS = { held: [], chosen: [] };

function input(values: Partial<AgentProfileInput>): AgentProfileInput {
  return { name: 'Omar', email: 'omar@shipblu.test', role: null, groups: NO_GROUPS, ...values };
}

describe('saveAgentProfile', () => {
  it('saves the name, address, role and groups together', async () => {
    const admin = await agent('Admin', { role: 'admin' });
    const omar = await agent('Omar');
    const [sales] = await db.insert(groups).values({ name: 'Sales' }).returning({ id: groups.id });

    const refusal = await saveAgentProfile(
      admin,
      omar,
      input({
        name: '  Omar Adel ',
        email: ' Omar.Adel@ShipBlu.test',
        role: 'supervisor',
        groups: { held: [], chosen: [sales!.id] },
      }),
      NOW,
    );

    expect(refusal).toBeNull();
    expect(await row(omar)).toEqual({
      name: 'Omar Adel',
      email: 'omar.adel@shipblu.test',
      role: 'supervisor',
    });
    const members = await db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.agentId, omar));
    expect(members).toEqual([{ groupId: sales!.id }]);
  });

  it('refuses to change your own role, and saves the rest of your own row', async () => {
    const admin = await agent('Admin', { role: 'admin' });

    expect(
      await saveAgentProfile(
        admin,
        admin,
        input({ name: 'Admin', email: 'admin@shipblu.test', role: 'agent' }),
        NOW,
      ),
    ).toBe('You cannot change your own role');
    expect((await row(admin)).role).toBe('admin');

    // The editor disables the select on your own row, so it posts no role.
    expect(
      await saveAgentProfile(
        admin,
        admin,
        input({ name: 'Head of support', email: 'admin@shipblu.test', role: null }),
        NOW,
      ),
    ).toBeNull();
    expect(await row(admin)).toEqual({
      name: 'Head of support',
      email: 'admin@shipblu.test',
      role: 'admin',
    });
  });

  it('keeps the last active account admin in the role', async () => {
    const admin = await agent('Admin', { role: 'admin' });
    const owner = await agent('Owner', { role: 'account_admin' });
    // A deactivated owner is no owner anybody can sign in as.
    await agent('Former', { role: 'account_admin', isActive: false });

    expect(
      await saveAgentProfile(
        admin,
        owner,
        input({ name: 'Owner', email: 'owner@shipblu.test', role: 'admin' }),
        NOW,
      ),
    ).toMatch(/only active account admin/);
    expect((await row(owner)).role).toBe('account_admin');
  });

  it('lets an account admin go once another active one exists', async () => {
    const admin = await agent('Admin', { role: 'admin' });
    const owner = await agent('Owner', { role: 'account_admin' });
    await agent('Second', { role: 'account_admin' });

    expect(
      await saveAgentProfile(
        admin,
        owner,
        input({ name: 'Owner', email: 'owner@shipblu.test', role: 'admin' }),
        NOW,
      ),
    ).toBeNull();
    expect((await row(owner)).role).toBe('admin');
  });

  it('demotes a deactivated account admin, who holds nothing anybody can use', async () => {
    const admin = await agent('Admin', { role: 'admin' });
    const former = await agent('Former', { role: 'account_admin', isActive: false });

    expect(
      await saveAgentProfile(
        admin,
        former,
        input({ name: 'Former', email: 'former@shipblu.test', role: 'agent' }),
        NOW,
      ),
    ).toBeNull();
  });

  it('can make somebody an account admin, as the invite can', async () => {
    const admin = await agent('Admin', { role: 'admin' });
    const omar = await agent('Omar');

    expect(await saveAgentProfile(admin, omar, input({ role: 'account_admin' }), NOW)).toBeNull();
    expect((await row(omar)).role).toBe('account_admin');
  });

  it('refuses an address another agent signs in with', async () => {
    const admin = await agent('Admin', { role: 'admin' });
    const omar = await agent('Omar');
    await agent('Zeina');

    expect(await saveAgentProfile(admin, omar, input({ email: 'ZEINA@shipblu.test' }), NOW)).toBe(
      EMAIL_TAKEN,
    );
    expect((await row(omar)).email).toBe('omar@shipblu.test');
  });

  it('refuses an address with an invite waiting, and takes one whose invite has lapsed', async () => {
    // Accepting an invite finds the agent by address and overwrites its
    // password, so a live link for the new address would open this account.
    const admin = await agent('Admin', { role: 'admin' });
    const omar = await agent('Omar');
    await db.insert(invites).values([
      {
        tokenHash: 'live',
        email: 'pending@shipblu.test',
        name: 'Pending',
        expiresAt: new Date('2026-11-01T00:00:00Z'),
      },
      {
        tokenHash: 'lapsed',
        email: 'lapsed@shipblu.test',
        name: 'Lapsed',
        expiresAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]);

    expect(
      await saveAgentProfile(admin, omar, input({ email: 'pending@shipblu.test' }), NOW),
    ).toMatch(/invite waiting/);
    expect(
      await saveAgentProfile(admin, omar, input({ email: 'lapsed@shipblu.test' }), NOW),
    ).toBeNull();
  });

  it('waits for an invite being created for the new address, then refuses it', async () => {
    // `createInvite` checks for an agent holding the address and this checks
    // for an invite; neither sees the other's uncommitted row, so without the
    // shared lock both would pass and the invite would open this account.
    const admin = await agent('Admin', { role: 'admin' });
    const omar = await agent('Omar');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let written!: () => void;
    const inviteWritten = new Promise<void>((resolve) => (written = resolve));

    const inviting = db.transaction(async (tx) => {
      await lockAddress(tx, 'new@shipblu.test');
      await tx.insert(invites).values({
        tokenHash: 'racing',
        email: 'new@shipblu.test',
        name: 'New',
        expiresAt: new Date('2026-11-01T00:00:00Z'),
      });
      written();
      await held;
    });
    await inviteWritten;

    const saving = saveAgentProfile(admin, omar, input({ email: 'new@shipblu.test' }), NOW);
    await untilWaitingOnALock(db);
    release();
    await inviting;

    expect(await saving).toMatch(/invite waiting/);
    expect((await row(omar)).email).toBe('omar@shipblu.test');
  });

  it('refuses a stale form whose group has gone, writing nothing', async () => {
    const admin = await agent('Admin', { role: 'admin' });
    const omar = await agent('Omar');
    const [gone] = await db.insert(groups).values({ name: 'Gone' }).returning({ id: groups.id });
    await db.delete(groups).where(eq(groups.id, gone!.id));

    expect(
      await saveAgentProfile(
        admin,
        omar,
        input({ name: 'Renamed', groups: { held: [], chosen: [gone!.id] } }),
        NOW,
      ),
    ).toBe(GROUP_GONE);
    expect((await row(omar)).name).toBe('Omar');
  });

  it.each([
    ['an empty name', input({ name: '   ' }), 'Enter their name'],
    ['a name too long to render', input({ name: 'x'.repeat(121) }), /cannot be longer/],
    ['something that is not an address', input({ email: 'omar@' }), 'Enter a valid email address'],
    ['a role that does not exist', input({ role: 'owner' }), 'Unknown role'],
  ])('refuses %s before reading anything', async (_name, values, error) => {
    const admin = await agent('Admin', { role: 'admin' });
    const omar = await agent('Omar');

    const refusal = await saveAgentProfile(admin, omar, values, NOW);
    if (typeof error === 'string') expect(refusal).toBe(error);
    else expect(refusal).toMatch(error);
    expect(await row(omar)).toEqual({ name: 'Omar', email: 'omar@shipblu.test', role: 'agent' });
  });

  it('says so when the agent does not exist', async () => {
    const admin = await agent('Admin', { role: 'admin' });

    expect(
      await saveAgentProfile(admin, '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', input({}), NOW),
    ).toBe('Unknown agent');
  });
});
