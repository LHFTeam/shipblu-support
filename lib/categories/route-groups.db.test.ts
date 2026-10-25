import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, groupMembers, groups } from '@/db/schema';
import { HEARTBEAT_TTL_MS } from '@/lib/assignment/eligibility';
import { withCleanDatabase } from '@/lib/testing/db';
import { routeGroupSummaries } from './route-groups';

/**
 * The route-group picker's summary against real Postgres: the query's joins,
 * and that "accepting now" is assignment's own test of who is there.
 */

withCleanDatabase();

const NOW = new Date('2026-10-25T10:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 30_000);
const STALE = new Date(NOW.getTime() - HEARTBEAT_TTL_MS - 1_000);

async function agent(name: string, values: Partial<typeof agents.$inferInsert>) {
  const [row] = await db
    .insert(agents)
    .values({
      name,
      email: `${name.toLowerCase()}@shipblu.test`,
      presence: 'online',
      lastSeenAt: FRESH,
      isAcceptingTickets: true,
      ...values,
    })
    .returning({ id: agents.id });
  return row!.id;
}

describe('routeGroupSummaries', () => {
  it('counts a present, accepting agent, and nobody away, stale, switched off or deactivated', async () => {
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care', assignmentStrategy: 'round_robin' })
      .returning({ id: groups.id });

    const members = [
      await agent('Here', {}),
      await agent('Offline', { presence: 'offline' }),
      await agent('Away', { presence: 'away' }),
      await agent('Stale', { lastSeenAt: STALE }),
      await agent('Never', { lastSeenAt: null }),
      await agent('Paused', { isAcceptingTickets: false, acceptingOffReason: 'self' }),
      await agent('Gone', { isActive: false }),
    ];
    await db
      .insert(groupMembers)
      .values(members.map((agentId) => ({ groupId: merchantCare!.id, agentId })));
    // A present, accepting agent in no group counts for nobody.
    await agent('Elsewhere', {});

    const summaries = await routeGroupSummaries(NOW);

    expect(summaries.find((summary) => summary.id === merchantCare!.id)).toEqual({
      id: merchantCare!.id,
      name: 'Merchant Care',
      strategy: 'round_robin',
      assignWithinHoursOnly: true,
      // Six: the deactivated agent is still in `group_members`, and still not
      // somebody a ticket can go to.
      members: 6,
      acceptingNow: 1,
    });
  });

  it('returns every group by name, an empty one and one of only deactivated members included', async () => {
    const [deserted] = await db
      .insert(groups)
      .values({ name: 'Deserted', assignWithinHoursOnly: false })
      .returning({ id: groups.id });
    await db
      .insert(groupMembers)
      .values({ groupId: deserted!.id, agentId: await agent('Left', { isActive: false }) });

    const summaries = await routeGroupSummaries(NOW);

    expect(summaries.map((summary) => summary.name)).toEqual(['Deserted', 'Support']);
    expect(summaries[0]).toMatchObject({
      strategy: 'manual',
      assignWithinHoursOnly: false,
      members: 0,
      acceptingNow: 0,
    });
    expect(summaries[1]).toMatchObject({ members: 0, acceptingNow: 0 });
  });

  it('counts an agent in two groups in each of them', async () => {
    const created = await db
      .insert(groups)
      .values([{ name: 'Customer Care' }, { name: 'Inbound Sales Team' }])
      .returning({ id: groups.id });
    const both = await agent('Both', {});
    await db.insert(groupMembers).values(created.map(({ id }) => ({ groupId: id, agentId: both })));

    const summaries = await routeGroupSummaries(NOW);

    for (const { id } of created) {
      expect(summaries.find((summary) => summary.id === id)).toMatchObject({
        members: 1,
        acceptingNow: 1,
      });
    }
  });
});
