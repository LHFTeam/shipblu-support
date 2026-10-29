import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, groupMembers, groups } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { applyAgentGroups, applyGroupMembers, joinGroups } from './group-members';

/**
 * The three writers of `group_members`. What each must not do is the point:
 * undo a change the other editor made while this one was open, fail an invite
 * over a group deleted since it was sent, or half-apply a stale form.
 */

withCleanDatabase();

async function group(name: string): Promise<string> {
  const [row] = await db.insert(groups).values({ name }).returning({ id: groups.id });
  return row!.id;
}

async function agent(name: string, isActive = true): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase()}@shipblu.test`, isActive })
    .returning({ id: agents.id });
  return row!.id;
}

async function groupsOf(agentId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.agentId, agentId));
  return rows.map((row) => row.groupId).sort();
}

async function membersOf(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: groupMembers.agentId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((row) => row.agentId).sort();
}

describe('applyAgentGroups', () => {
  it('adds the boxes ticked and removes the boxes unticked', async () => {
    const [sales, care, returns] = [
      await group('Sales'),
      await group('Care'),
      await group('Returns'),
    ];
    const omar = await agent('Omar');
    await db.insert(groupMembers).values([
      { groupId: sales, agentId: omar },
      { groupId: care, agentId: omar },
    ]);

    // Drawn with Sales and Care ticked; Sales unticked, Returns ticked.
    const saved = await db.transaction((tx) =>
      applyAgentGroups(tx, omar, { held: [sales, care], chosen: [care, returns] }),
    );

    expect(saved).toBe(true);
    expect(await groupsOf(omar)).toEqual([care, returns].sort());
  });

  it('leaves a membership added elsewhere while the form was open, its box untouched', async () => {
    // The box was drawn unticked and sent unticked: nobody here asked for a
    // change, so the row the group editor added since stays.
    const sales = await group('Sales');
    const omar = await agent('Omar');
    await db.insert(groupMembers).values({ groupId: sales, agentId: omar });

    await db.transaction((tx) => applyAgentGroups(tx, omar, { held: [], chosen: [] }));

    expect(await groupsOf(omar)).toEqual([sales]);
  });

  it('does not put back a membership removed elsewhere while the form was open', async () => {
    // Drawn ticked and sent ticked: no change asked for here either, so the
    // removal the group editor made since is not undone.
    const sales = await group('Sales');
    const omar = await agent('Omar');

    await db.transaction((tx) => applyAgentGroups(tx, omar, { held: [sales], chosen: [sales] }));

    expect(await groupsOf(omar)).toEqual([]);
  });

  it('refuses a stale form whole when a newly ticked group has been deleted', async () => {
    const [sales, gone] = [await group('Sales'), await group('Gone')];
    const omar = await agent('Omar');
    await db.insert(groupMembers).values({ groupId: sales, agentId: omar });
    await db.delete(groups).where(eq(groups.id, gone));

    const saved = await db.transaction((tx) =>
      applyAgentGroups(tx, omar, { held: [sales], chosen: [gone] }),
    );

    // Nothing removed either: the unticked Sales is part of the same stale form.
    expect(saved).toBe(false);
    expect(await groupsOf(omar)).toEqual([sales]);
  });

  it('saves the same choice twice without complaint', async () => {
    const sales = await group('Sales');
    const omar = await agent('Omar');
    const choice = { held: [], chosen: [sales] };

    await db.transaction((tx) => applyAgentGroups(tx, omar, choice));
    await db.transaction((tx) => applyAgentGroups(tx, omar, choice));

    expect(await groupsOf(omar)).toEqual([sales]);
  });
});

describe('applyGroupMembers', () => {
  it('keeps a member the editor drew no box for', async () => {
    // Deactivation keeps the row so reactivating restores the roster; the
    // group editor draws no box for a deactivated non-member, and a save from
    // a form that never showed one must leave whatever exists.
    const sales = await group('Sales');
    const [omar, former] = [await agent('Omar'), await agent('Former', false)];
    await db.insert(groupMembers).values({ groupId: sales, agentId: former });

    await db.transaction((tx) => applyGroupMembers(tx, sales, { held: [], chosen: [omar] }));

    expect(await membersOf(sales)).toEqual([omar, former].sort());
  });

  it('takes off a member whose box was unticked', async () => {
    const sales = await group('Sales');
    const [omar, zeina] = [await agent('Omar'), await agent('Zeina')];
    await db.insert(groupMembers).values([
      { groupId: sales, agentId: omar },
      { groupId: sales, agentId: zeina },
    ]);

    await db.transaction((tx) =>
      applyGroupMembers(tx, sales, { held: [omar, zeina], chosen: [zeina] }),
    );

    expect(await membersOf(sales)).toEqual([zeina]);
  });

  it('leaves a member the agents page added while the editor was open', async () => {
    const sales = await group('Sales');
    const [omar, zeina] = [await agent('Omar'), await agent('Zeina')];
    // Drawn with only Omar ticked; Zeina was added from her own editor since.
    await db.insert(groupMembers).values([
      { groupId: sales, agentId: omar },
      { groupId: sales, agentId: zeina },
    ]);

    await db.transaction((tx) => applyGroupMembers(tx, sales, { held: [omar], chosen: [omar] }));

    expect(await membersOf(sales)).toEqual([omar, zeina].sort());
  });
});

describe('joinGroups', () => {
  it('skips a group deleted since the invite was sent, and anything not a uuid', async () => {
    const [sales, gone] = [await group('Sales'), await group('Gone')];
    const omar = await agent('Omar');
    await db.delete(groups).where(eq(groups.id, gone));

    await db.transaction((tx) => joinGroups(tx, omar, [sales, gone, 'not-a-uuid', 42]));

    expect(await groupsOf(omar)).toEqual([sales]);
  });

  it('leaves a re-invited agent in the groups they already had', async () => {
    const [sales, care] = [await group('Sales'), await group('Care')];
    const omar = await agent('Omar');
    await db.insert(groupMembers).values({ groupId: sales, agentId: omar });

    await db.transaction((tx) => joinGroups(tx, omar, [sales.toUpperCase(), care]));

    expect(await groupsOf(omar)).toEqual([sales, care].sort());
  });
});
