import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, groupMembers, groups } from '@/db/schema';
import { filterCandidates, type CandidateRow } from '@/lib/assignment/eligibility';

/**
 * What the Categories page's route-group picker says about each group: how it
 * hands tickets out, whether only inside its hours, and how many of its people
 * are there to take one right now.
 *
 * The picker needs this because the route group is chosen once and then acted
 * on by nobody watching. From Stage 5 a routed ticket lands in the group and
 * waits for whatever that group does next, so a `manual` group, or one whose
 * members are all away, is a queue that fills without anybody assigned — and
 * an admin should see that while choosing it, not from a breach report.
 */
export type RouteGroupSummary = {
  id: string;
  name: string;
  strategy: (typeof groups.$inferSelect)['assignmentStrategy'];
  assignWithinHoursOnly: boolean;
  /**
   * Active members only. Deactivating an agent leaves their `group_members`
   * rows in place, and assignment's roster skips them (`loadRoster`), so
   * counting them would describe a bigger team than the one tickets go to.
   */
  members: number;
  /** Of those, how many assignment would consider present and accepting at `now`. */
  acceptingNow: number;
};

/**
 * Every group, by name, with its summary — one query, whatever the number of
 * groups, rather than one per group: the page reads it beside two others, and
 * each query in flight holds one of the pool's eight places (§6.91,
 * `lib/concurrency.ts`).
 *
 * "Accepting now" is decided by `filterCandidates`, the function assignment
 * itself runs, so the picker and the next assignment cannot disagree about who
 * is there: signed in, a heartbeat inside `HEARTBEAT_TTL_MS`, and the
 * accepting switch on. Skills and capacity are left out by giving it none to
 * test — no required skill and no cap — because neither is a fact about the
 * group: skills are asked of a ticket, and a full inbox is somebody at work,
 * which "accepting" is not the question about. Leaving the cap out also spares
 * a count of every member's open tickets.
 */
export async function routeGroupSummaries(now: Date = new Date()): Promise<RouteGroupSummary[]> {
  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      strategy: groups.assignmentStrategy,
      assignWithinHoursOnly: groups.assignWithinHoursOnly,
      agentId: agents.id,
      presence: agents.presence,
      lastSeenAt: agents.lastSeenAt,
      isAcceptingTickets: agents.isAcceptingTickets,
    })
    .from(groups)
    .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    // The active test in the join rather than the WHERE, so a group whose
    // members are all deactivated still comes back, with nobody in it.
    .leftJoin(agents, and(eq(agents.id, groupMembers.agentId), eq(agents.isActive, true)))
    .orderBy(asc(groups.name), asc(groups.id));

  const summaries = new Map<string, { summary: RouteGroupSummary; roster: CandidateRow[] }>();
  for (const row of rows) {
    let entry = summaries.get(row.id);
    if (!entry) {
      entry = {
        summary: {
          id: row.id,
          name: row.name,
          strategy: row.strategy,
          assignWithinHoursOnly: row.assignWithinHoursOnly,
          members: 0,
          acceptingNow: 0,
        },
        roster: [],
      };
      summaries.set(row.id, entry);
    }
    if (row.agentId === null || row.presence === null || row.isAcceptingTickets === null) continue;
    entry.roster.push({
      agentId: row.agentId,
      name: '',
      presence: row.presence,
      lastSeenAt: row.lastSeenAt,
      isAcceptingTickets: row.isAcceptingTickets,
      maxOpenTickets: null,
      openTickets: 0,
      skillIds: [],
    });
  }

  return [...summaries.values()].map(({ summary, roster }) => ({
    ...summary,
    members: roster.length,
    acceptingNow: filterCandidates(roster, { requiredSkillIds: [], groupDefaultMaxOpen: null, now })
      .eligible.length,
  }));
}
