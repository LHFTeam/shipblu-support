import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, groupMembers, groups } from '@/db/schema';
import type { Permission } from '@/lib/auth/permissions';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * A group and its members as `saveGroup` stores them, against Postgres because
 * the roster is written in the transaction that writes the group: a new group
 * has no id until it is inserted, and an edit of one deleted meanwhile must be
 * told so rather than handed a foreign-key crash on the members' insert.
 */

vi.mock('@/lib/auth/guard', async () => {
  const { can } =
    await vi.importActual<typeof import('@/lib/auth/permissions')>('@/lib/auth/permissions');
  return {
    requirePermission: async (permission: Permission) => {
      const agent = {
        id: '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44',
        name: 'Mona Admin',
        role: 'admin' as const,
        permissions: {},
      };
      if (!can(agent, permission)) throw new Error(`NEXT_REDIRECT forbidden: ${permission}`);
      return agent;
    },
  };
});
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidated.push(path) }));

const { saveGroup } = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };

beforeEach(() => {
  revalidated.length = 0;
});

async function agent(name: string, isActive = true): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase()}@shipblu.test`, isActive })
    .returning({ id: agents.id });
  return row!.id;
}

function groupForm(fields: Record<string, string>, members: { held: string[]; chosen: string[] }) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (const id of members.held) data.append('memberIdsHeld', id);
  for (const id of members.chosen) data.append('memberIds', id);
  return data;
}

async function membersOf(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: groupMembers.agentId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((row) => row.agentId).sort();
}

describe('saveGroup', () => {
  it('creates a group with the members ticked in the same form', async () => {
    // Omar is drawn unticked and left alone, so only Zeina joins.
    const [, zeina] = [await agent('Omar'), await agent('Zeina')];

    const state = await saveGroup(
      INITIAL,
      groupForm({ name: 'Merchant Care' }, { held: [], chosen: [zeina] }),
    );

    expect(state.error).toBeNull();
    const [created] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.name, 'Merchant Care'));
    expect(await membersOf(created!.id)).toEqual([zeina]);
    // The agents page names each agent's groups, and the categories page
    // counts who in a route group could take a ticket.
    expect(revalidated).toEqual(
      expect.arrayContaining(['/admin/groups', '/admin/agents', '/admin/categories']),
    );
  });

  it('writes only the boxes somebody clicked', async () => {
    const [support] = await db.select({ id: groups.id }).from(groups);
    const [omar, zeina, former, kept] = [
      await agent('Omar'),
      await agent('Zeina'),
      await agent('Former', false),
      await agent('Kept'),
    ];
    await db.insert(groupMembers).values([
      { groupId: support!.id, agentId: omar },
      { groupId: support!.id, agentId: former },
      // Added from Kept's own editor after this one was drawn.
      { groupId: support!.id, agentId: kept },
    ]);

    // Drawn with Omar and the deactivated Former ticked; Omar unticked and
    // Zeina ticked. Kept's box was drawn unticked and left alone.
    const state = await saveGroup(
      INITIAL,
      groupForm(
        { id: support!.id, name: 'Support' },
        { held: [omar, former], chosen: [former, zeina] },
      ),
    );

    expect(state.error).toBeNull();
    expect(await membersOf(support!.id)).toEqual([former, kept, zeina].sort());
  });

  it('says the group is gone when it was deleted while the editor was open', async () => {
    const omar = await agent('Omar');
    const [gone] = await db.insert(groups).values({ name: 'Gone' }).returning({ id: groups.id });
    await db.delete(groups).where(eq(groups.id, gone!.id));

    const state = await saveGroup(
      INITIAL,
      groupForm({ id: gone!.id, name: 'Gone' }, { held: [], chosen: [omar] }),
    );

    expect(state.error).toMatch(/no longer exists/);
    expect(await db.select().from(groupMembers)).toEqual([]);
  });

  it('refuses a member who does not exist, before writing the group', async () => {
    const state = await saveGroup(
      INITIAL,
      groupForm(
        { name: 'Merchant Care' },
        { held: [], chosen: ['5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d'] },
      ),
    );

    expect(state.error).toMatch(/agents no longer exists/);
    expect(await db.select().from(groups).where(eq(groups.name, 'Merchant Care'))).toEqual([]);
  });
});
