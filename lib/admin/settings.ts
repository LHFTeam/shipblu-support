import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  automationRules,
  autoResponses,
  businessHours,
  cannedResponses,
  channels,
  conversations,
  groupMembers,
  groups,
  holidays,
  invites,
  locations,
  shipmentPhrases,
  skills,
  slaPolicies,
  ticketCategories,
  ticketFields,
  ticketForms,
  ticketRootCauses,
  ticketStatuses,
  whatsappAccounts,
  whatsappTemplates,
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

/** Group names for a picker, by name. Auto-responses, automations and forms each offer it. */
export function listGroupNames() {
  return db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name));
}

export function listAutoResponses() {
  return db.select().from(autoResponses).orderBy(asc(autoResponses.createdAt));
}

/** One holiday or none: the auto-responses page asks only whether any calendar has one. */
export function listAnyHoliday() {
  return db.select({ id: holidays.id }).from(holidays).limit(1);
}

/** Every rule, in the order it runs: by trigger, then position. */
export function listAutomationRules() {
  return db
    .select()
    .from(automationRules)
    .orderBy(asc(automationRules.trigger), asc(automationRules.position));
}

/** Canned-response titles for the automation builder's "send a reply" action. */
export function listCannedTitles() {
  return db
    .select({ id: cannedResponses.id, title: cannedResponses.title })
    .from(cannedResponses)
    .orderBy(asc(cannedResponses.title));
}

/** Forms in the order the help centre offers them. */
export function listTicketForms() {
  return db.select().from(ticketForms).orderBy(asc(ticketForms.position), asc(ticketForms.slug));
}

/** The fields the form builder can place. */
export function listFormFieldChoices() {
  // Retired fields included, marked. A form can already be placing one, and
  // leaving it out of the picker renders that row blank with no way to tell
  // which question it is — while every save re-posts it.
  return db
    .select({
      key: ticketFields.key,
      label: ticketFields.label,
      type: ticketFields.type,
      options: ticketFields.options,
      visibleToCustomer: ticketFields.visibleToCustomer,
      editableByCustomer: ticketFields.editableByCustomer,
      isActive: ticketFields.isActive,
    })
    .from(ticketFields)
    .orderBy(asc(ticketFields.position), asc(ticketFields.label));
}

/** Every agent, deactivated ones included, by name. */
export function listAgentsForAdmin() {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      email: agents.email,
      role: agents.role,
      isActive: agents.isActive,
      lastSeenAt: agents.lastSeenAt,
      presence: agents.presence,
      isAcceptingTickets: agents.isAcceptingTickets,
      maxOpenTickets: agents.maxOpenTickets,
    })
    .from(agents)
    .orderBy(asc(agents.name));
}

/** Invites not yet accepted and not expired at `now`, newest first. */
export function listOpenInvites(now: Date) {
  return db
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
      tokenCiphertext: invites.tokenCiphertext,
    })
    .from(invites)
    .where(and(isNull(invites.acceptedAt), gt(invites.expiresAt, now)))
    .orderBy(desc(invites.createdAt));
}

/** Every category, retired ones included, in the order the taxonomy lists them. */
export function listTicketCategories() {
  return db
    .select()
    .from(ticketCategories)
    .orderBy(asc(ticketCategories.position), asc(ticketCategories.key));
}

/** Every root cause, retired ones included, in the order the resolve dialogue lists them. */
export function listRootCauses() {
  return db
    .select()
    .from(ticketRootCauses)
    .orderBy(asc(ticketRootCauses.position), asc(ticketRootCauses.key));
}

/** Every channel, inactive ones included, by name, with the columns the channels page reads. */
export function listChannelsForAdmin() {
  return db
    .select({
      id: channels.id,
      type: channels.type,
      name: channels.name,
      config: channels.config,
      createdAt: channels.createdAt,
      defaultGroupId: channels.defaultGroupId,
      whatsappAccountId: channels.whatsappAccountId,
      isActive: channels.isActive,
    })
    .from(channels)
    .orderBy(asc(channels.name));
}

export function listWhatsAppAccounts() {
  return db.select().from(whatsappAccounts).orderBy(asc(whatsappAccounts.name));
}

/**
 * Per WhatsApp account, how many templates it has and how many are approved.
 *
 * Approved and total, because they answer different questions. Approved is
 * what an agent can actually pick; total is what the sync last read back
 * from Meta, and zero of it is the difference between "connected" and
 * "connected to something that is not this WABA".
 */
export function countTemplatesByAccount() {
  return db
    .select({
      accountId: whatsappTemplates.whatsappAccountId,
      approved: sql<number>`count(*) filter (where ${whatsappTemplates.status} = 'APPROVED')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(whatsappTemplates)
    .groupBy(whatsappTemplates.whatsappAccountId);
}

/** Active custom fields, by position: the ones a rule condition can name. */
export function listActiveTicketFields() {
  return db
    .select()
    .from(ticketFields)
    .where(eq(ticketFields.isActive, true))
    .orderBy(asc(ticketFields.position));
}

/** Form slugs and names for the condition builder's "submitted through form". */
export function listFormNames() {
  return db
    .select({ slug: ticketForms.slug, nameEn: ticketForms.nameEn, nameAr: ticketForms.nameAr })
    .from(ticketForms)
    .orderBy(asc(ticketForms.position));
}
