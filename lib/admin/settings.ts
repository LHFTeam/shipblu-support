import { asc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  businessHours,
  cannedResponses,
  conversations,
  groupMembers,
  groups,
  holidays,
  locations,
  shipmentPhrases,
  skills,
  slaPolicies,
  ticketFields,
  ticketStatuses,
} from '@/db/schema';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';

/**
 * What each admin settings page lists: every row, active or not, in the order
 * the page shows them.
 *
 * Here rather than in the pages for the reason `./overview` is: a page is where
 * a query is first run in production, and the database tier can reach this
 * module (`settings.db.test.ts`). They stay apart from the runtime reads of the
 * same tables — the composer's canned-response picker, say — because those
 * answer a different question: what an agent may use now, not everything an
 * admin can edit.
 *
 * Authorisation is the page's, which calls `requirePermission` before any of
 * these.
 */

export function listCannedResponses() {
  return db
    .select()
    .from(cannedResponses)
    .orderBy(asc(cannedResponses.folder), asc(cannedResponses.title));
}

export function listTicketFields() {
  return db
    .select()
    .from(ticketFields)
    .orderBy(asc(ticketFields.position), asc(ticketFields.label));
}

export function listLocations() {
  return db
    .select({
      id: locations.id,
      name: locations.name,
      code: locations.code,
      email: locations.email,
      isActive: locations.isActive,
    })
    .from(locations)
    .orderBy(asc(locations.code));
}

export function listTicketStatuses() {
  return db
    .select()
    .from(ticketStatuses)
    .orderBy(asc(ticketStatuses.position), asc(ticketStatuses.name));
}

/** The Arabic wording an admin saved, by phrase key. Unsaved phrases have no row. */
export function listSavedPhrases() {
  return db.select({ key: shipmentPhrases.key, ar: shipmentPhrases.ar }).from(shipmentPhrases);
}

/** The agents a picker offers: active ones, by name. Groups, skills and SLA escalations each offer it. */
export function listActiveAgents() {
  return db
    .select({ id: agents.id, name: agents.name, email: agents.email })
    .from(agents)
    .where(eq(agents.isActive, true))
    .orderBy(asc(agents.name));
}

/**
 * Every group, with how many agents it has and how many tickets sit with it.
 *
 * The member count's correlation is `${groups.id}`, the shape the comment on
 * `tickets` below warns renders unqualified. It is right only because
 * `group_members` has no `id` column of its own for the bare name to find;
 * `settings.db.test.ts` pins both counts so a column added there fails a test
 * rather than the page.
 */
export function listGroupsForAdmin() {
  return db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      businessHoursId: groups.businessHoursId,
      assignmentStrategy: groups.assignmentStrategy,
      matchSkills: groups.matchSkills,
      skillTimeoutMins: groups.skillTimeoutMins,
      defaultMaxOpenTickets: groups.defaultMaxOpenTickets,
      assignWithinHoursOnly: groups.assignWithinHoursOnly,
      reclaimAfterMins: groups.reclaimAfterMins,
      escalateToAgentId: groups.escalateToAgentId,
      escalateAfterMins: groups.escalateAfterMins,
      members: sql<number>`(select count(*)::int from ${groupMembers} gm where gm.group_id = ${groups.id})`,
      // Read-only channels excluded: this number is "how much work sits with
      // this group", and a transcript nobody may answer is not work. It would
      // only ever be wrong once someone set a default group on the bot
      // channel, which is exactly the day nobody would think to check here.
      /*
       * How much work sits with this group. A transcript nobody may answer is
       * not work, so read-only channels are out.
       *
       * Two things about the shape of this. The correlation is written
       * `${groups}.id`, not `${groups.id}`: inside a select-clause subquery
       * drizzle renders a column reference *unqualified*, so `${groups.id}`
       * became a bare "id", which Postgres resolved against the innermost
       * table — the subquery compared conversations.group_id to
       * conversations.id and every group reported zero tickets. And the
       * channel test uses drizzle's operator rather than `<> all(...)`,
       * because a JS array interpolated into a `sql` template arrives as one
       * scalar parameter that Postgres rejects as malformed array input.
       */
      tickets: sql<number>`(
        select count(*)::int from ${conversations}
        where ${conversations.groupId} = ${groups}.id
          and ${notInArray(conversations.channel, readOnlyChannels())}
      )`,
    })
    .from(groups)
    .orderBy(asc(groups.name));
}

/** Business-hours schedules for the group editor's picker, by name. */
export function listScheduleOptions() {
  return db
    .select({
      id: businessHours.id,
      name: businessHours.name,
      isDefault: businessHours.isDefault,
    })
    .from(businessHours)
    .orderBy(asc(businessHours.name));
}

export function listSchedules() {
  return db.select().from(businessHours).orderBy(asc(businessHours.name));
}

export function listHolidays() {
  return db.select().from(holidays).orderBy(asc(holidays.date));
}

/** The groups that work a schedule of their own, for the hours page's "used by". */
export function listGroupsWithOwnHours() {
  return db
    .select({ name: groups.name, businessHoursId: groups.businessHoursId })
    .from(groups)
    .where(isNotNull(groups.businessHoursId))
    .orderBy(asc(groups.name));
}

export function listSkills() {
  return db.select().from(skills).orderBy(asc(skills.position), asc(skills.name));
}

/** The groups that route by skill, which the skills page names as its users. */
export function listSkillRoutingGroups() {
  return db
    .select({ name: groups.name })
    .from(groups)
    .where(eq(groups.matchSkills, true))
    .orderBy(asc(groups.name));
}

/** Who holds each of these skills. An empty list asks nothing. */
export async function listSkillHolders(skillIds: string[]) {
  if (skillIds.length === 0) return [];
  return db
    .select({ skillId: agentSkills.skillId, agentId: agentSkills.agentId })
    .from(agentSkills)
    .where(inArray(agentSkills.skillId, skillIds));
}

export function listSlaPolicies() {
  return db.select().from(slaPolicies).orderBy(asc(slaPolicies.position), asc(slaPolicies.name));
}

/** Schedule names for the SLA editor, in the order the table holds them. */
export function listScheduleNames() {
  return db.select({ id: businessHours.id, name: businessHours.name }).from(businessHours);
}
