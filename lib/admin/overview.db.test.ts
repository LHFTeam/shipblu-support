import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agentSkills, agents, channels, groups, skills, slaPolicies } from '@/db/schema';
import { SEEDED_RULES } from '@/lib/automations/defaults';
import { withCleanDatabase } from '@/lib/testing/db';
import { configurationCounts } from './overview';

/**
 * Twelve raw subqueries that, before this file, first ran in production. The
 * baseline test is the one that proves each of them executes and comes back as
 * a number. `count(*)` is a bigint, which postgres.js hands over as a string,
 * and the page's `=== 0` tests are strict: without the `::int`, an empty SLA
 * table would read as "no default policy" rather than "none".
 * The other two pin the filters, which are where the page's advice comes from.
 */

withCleanDatabase();

const TARGET = { firstResponseMins: 60, nextResponseMins: null, resolutionMins: 1440 };
const TARGETS = { low: TARGET, medium: TARGET, high: TARGET, urgent: TARGET };

async function agent(name: string, isActive: boolean): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name}@shipblu.test`, isActive })
    .returning({ id: agents.id });
  if (!row) throw new Error('agent not inserted');
  return row.id;
}

async function skill(name: string, isActive = true): Promise<string> {
  const [row] = await db.insert(skills).values({ name, isActive }).returning({ id: skills.id });
  if (!row) throw new Error('skill not inserted');
  return row.id;
}

describe('configurationCounts', () => {
  it('reads the seeded baseline as numbers, one per check', async () => {
    expect(await configurationCounts()).toEqual({
      agents: 0,
      policies: 0,
      defaultPolicy: 0,
      rules: SEEDED_RULES.length,
      schedules: 1,
      statuses: 4,
      canned: 0,
      // The customer bot's number, which the seed writes.
      channels: 1,
      locations: 0,
      routingGroups: 0,
      allGroups: 1,
      orphanSkills: 0,
    });
  });

  it('counts only what is switched on, and a default only when it is active', async () => {
    await agent('active', true);
    await agent('departed', false);

    await db.insert(slaPolicies).values([
      { name: 'default', targets: TARGETS, isDefault: true },
      { name: 'old default', targets: TARGETS, isDefault: true, isActive: false },
      { name: 'vip', targets: TARGETS },
    ]);

    await db
      .insert(channels)
      .values({ type: 'email', name: 'retired mailbox', config: {}, isActive: false });
    await db.insert(groups).values({ name: 'Returns', assignmentStrategy: 'round_robin' });

    expect(await configurationCounts()).toMatchObject({
      agents: 1,
      policies: 2,
      defaultPolicy: 1,
      channels: 1,
      routingGroups: 1,
      allGroups: 2,
    });
  });

  it('calls a skill orphaned when no active agent holds it, and ignores a switched-off one', async () => {
    const active = await agent('active', true);
    const departed = await agent('departed', false);

    const held = await skill('arabic');
    const heldByLeaver = await skill('returns');
    await skill('cod disputes');
    await skill('retired', false);

    await db.insert(agentSkills).values([
      { agentId: active, skillId: held },
      { agentId: departed, skillId: heldByLeaver },
    ]);

    expect((await configurationCounts())?.orphanSkills).toBe(2);
  });
});
