import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  automationRules,
  businessHours,
  cannedResponses,
  channels,
  groups,
  locations,
  skills,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';

/**
 * What the settings overview (`app/(console)/admin/page.tsx`) counts, as one
 * row of scalar subqueries in a single round trip.
 *
 * Here rather than in the page so the database tier can run it
 * (`overview.db.test.ts`): twelve raw fragments are twelve chances for a
 * statement only Postgres can reject, and inline in a page they were first
 * executed in production.
 */
export async function configurationCounts() {
  const [counts] = await db
    .select({
      agents: sql<number>`(select count(*)::int from ${agents} where is_active)`,
      policies: sql<number>`(select count(*)::int from ${slaPolicies} where is_active)`,
      defaultPolicy: sql<number>`(select count(*)::int from ${slaPolicies} where is_default and is_active)`,
      rules: sql<number>`(select count(*)::int from ${automationRules} where is_active)`,
      schedules: sql<number>`(select count(*)::int from ${businessHours})`,
      statuses: sql<number>`(select count(*)::int from ${ticketStatuses})`,
      canned: sql<number>`(select count(*)::int from ${cannedResponses})`,
      channels: sql<number>`(select count(*)::int from ${channels} where is_active)`,
      locations: sql<number>`(select count(*)::int from ${locations})`,
      routingGroups: sql<number>`(select count(*)::int from ${groups} where assignment_strategy <> 'manual')`,
      allGroups: sql<number>`(select count(*)::int from ${groups})`,
      // A skill that no active agent holds, on a group that routes by skill, is
      // a ticket that waits for the timeout and then goes to anybody — or waits
      // forever, if nobody set one. Counted here because it is invisible
      // everywhere else until a customer chases.
      orphanSkills: sql<number>`(
        select count(*)::int from ${skills} s
        where s.is_active
          and not exists (
            select 1 from ${agentSkills} a
            join ${agents} g on g.id = a.agent_id and g.is_active
            where a.skill_id = s.id
          )
      )`,
    })
    .from(sql`(select 1) as one`);

  return counts;
}
