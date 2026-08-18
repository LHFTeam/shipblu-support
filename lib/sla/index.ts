import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  businessHours,
  conversationEvents,
  conversations,
  contacts,
  holidays,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import type { HoursConfig } from '@/lib/hours';
import { conversationFacts } from '@/lib/rules/facts';
import {
  dueAt,
  dueDatesOnCreate,
  nextResponseDueAt,
  selectPolicy,
  type LoadedPolicy,
  type Priority,
} from './policy';

/**
 * Applying SLA policies to real tickets.
 *
 * The decisions live in `./policy`; this file is the plumbing — which rows to
 * read, which columns to write, and at which four moments in a ticket's life
 * the clocks move: it arrives, an agent answers, the customer comes back, and
 * the status stops or restarts the clock.
 *
 * Every entry point is best-effort by design. A support system whose inbound
 * mail stops working because an SLA policy is misconfigured has failed at the
 * only job that really matters, so failures here are logged and swallowed and
 * the ticket goes on existing without a due date.
 */

export type { LoadedPolicy } from './policy';

export async function loadPolicies(): Promise<LoadedPolicy[]> {
  const rows = await db
    .select({
      id: slaPolicies.id,
      name: slaPolicies.name,
      conditions: slaPolicies.conditions,
      targets: slaPolicies.targets,
      escalations: slaPolicies.escalations,
      position: slaPolicies.position,
      isDefault: slaPolicies.isDefault,
      businessHoursId: slaPolicies.businessHoursId,
      timezone: businessHours.timezone,
      schedule: businessHours.schedule,
    })
    .from(slaPolicies)
    .leftJoin(businessHours, eq(businessHours.id, slaPolicies.businessHoursId))
    .where(eq(slaPolicies.isActive, true))
    .orderBy(slaPolicies.position);

  if (rows.length === 0) return [];

  // Holidays for every schedule in one query rather than one per policy: half a
  // dozen policies commonly share a single calendar.
  const scheduleIds = [...new Set(rows.map((row) => row.businessHoursId).filter(Boolean))];
  const holidayRows = scheduleIds.length
    ? await db
        .select({
          businessHoursId: holidays.businessHoursId,
          date: holidays.date,
          name: holidays.name,
        })
        .from(holidays)
        .where(inArray(holidays.businessHoursId, scheduleIds as string[]))
    : [];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    conditions: row.conditions,
    targets: row.targets,
    escalations: row.escalations,
    position: row.position,
    isDefault: row.isDefault,
    hours:
      row.businessHoursId && row.schedule && row.timezone
        ? ({
            schedule: row.schedule,
            timezone: row.timezone,
            holidays: holidayRows
              .filter((holiday) => holiday.businessHoursId === row.businessHoursId)
              .map((holiday) => ({ date: holiday.date, name: holiday.name })),
          } satisfies HoursConfig)
        : null,
  }));
}

type ConversationRow = {
  conversation: typeof conversations.$inferSelect;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  stopsSlaClock: boolean;
  requesterEmail: string | null;
};

async function loadConversation(conversationId: string): Promise<ConversationRow | null> {
  const rows = await db
    .select({
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      stopsSlaClock: ticketStatuses.stopsSlaClock,
      requesterEmail: contacts.primaryEmail,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  return rows[0] ?? null;
}

async function policyFor(policyId: string | null): Promise<LoadedPolicy | null> {
  if (!policyId) return null;
  const policies = await loadPolicies();
  return policies.find((policy) => policy.id === policyId) ?? null;
}

/**
 * Picks a policy for a new ticket and writes its first clocks.
 *
 * Called after the ticket exists rather than inside the transaction that
 * creates it: an SLA is an annotation on a ticket, and there is no version of
 * this worth rolling back a customer's message for.
 */
export async function applySlaOnCreate(conversationId: string): Promise<void> {
  try {
    const row = await loadConversation(conversationId);
    if (!row) return;

    const policies = await loadPolicies();
    if (policies.length === 0) return;

    const policy = selectPolicy(policies, conversationFacts(row));
    if (!policy) return;

    const due = dueDatesOnCreate(
      policy,
      row.conversation.priority as Priority,
      row.conversation.createdAt,
    );

    await db
      .update(conversations)
      .set({ slaPolicyId: policy.id, ...due })
      .where(eq(conversations.id, conversationId));
  } catch (error) {
    console.error(`[sla] could not apply a policy to ${conversationId}`, error);
  }
}

/**
 * An agent replied: the response clocks stop.
 *
 * `firstRespondedAt` is recorded even when the ticket has no policy, because
 * reporting measures response time whether or not anyone committed to a target.
 */
export async function onAgentReply(conversationId: string, at: Date = new Date()): Promise<void> {
  try {
    const row = await loadConversation(conversationId);
    if (!row) return;

    await db
      .update(conversations)
      .set({
        firstRespondedAt: row.conversation.firstRespondedAt ?? at,
        // Answered, so nothing is owed until the customer writes again.
        nextResponseDueAt: null,
      })
      .where(eq(conversations.id, conversationId));
  } catch (error) {
    console.error(`[sla] could not record an agent reply on ${conversationId}`, error);
  }
}

/**
 * The customer wrote again: a reply is owed.
 *
 * Only once the ticket has been answered at least once — before that the
 * first-response clock is already running and starting a second countdown
 * beside it would just show the same obligation twice.
 */
export async function onCustomerReply(
  conversationId: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    const row = await loadConversation(conversationId);
    if (!row?.conversation.firstRespondedAt) return;

    const policy = await policyFor(row.conversation.slaPolicyId);
    if (!policy) return;

    await db
      .update(conversations)
      .set({
        nextResponseDueAt: nextResponseDueAt(policy, row.conversation.priority as Priority, at),
      })
      .where(eq(conversations.id, conversationId));
  } catch (error) {
    console.error(`[sla] could not record a customer reply on ${conversationId}`, error);
  }
}

/**
 * The single call every inbound path makes: a message from the customer either
 * starts a ticket's clocks or restarts the response one.
 */
export async function onInboundMessage(
  conversationId: string,
  createdConversation: boolean,
  at: Date = new Date(),
): Promise<void> {
  if (createdConversation) return applySlaOnCreate(conversationId);
  return onCustomerReply(conversationId, at);
}

/**
 * Stops or restarts the clock on a status change.
 *
 * This is what makes "Pending — waiting on customer" not count against the
 * team. The pause is recorded as a conversation event rather than as a column:
 * the event log already exists, it is what an agent reads when asking why a due
 * date moved, and a pause that is invisible in the timeline looks like the SLA
 * quietly forgiving itself.
 */
export async function onStatusChanged(
  conversationId: string,
  stopsSlaClock: boolean,
  at: Date = new Date(),
): Promise<void> {
  try {
    const pausedSince = await pausedSinceAt(conversationId);

    if (stopsSlaClock) {
      if (pausedSince) return; // already paused; nothing to record
      await db.insert(conversationEvents).values({
        conversationId,
        type: 'sla_paused',
        actorLabel: 'sla',
        data: { at: at.toISOString() },
      });
      return;
    }

    if (!pausedSince) return;

    const row = await loadConversation(conversationId);
    if (!row) return;

    const policy = await policyFor(row.conversation.slaPolicyId);
    const pausedMinutes = Math.max(0, Math.round((at.getTime() - pausedSince.getTime()) / 60_000));

    // Push each live clock forward by the time the ticket spent parked. Clocks
    // that have already been satisfied are left alone — extending the
    // first-response due date of a ticket that was answered hours ago would
    // rewrite history rather than pause it.
    const conversation = row.conversation;
    const shift = (due: Date | null, satisfied: Date | null): Date | null => {
      if (!due || satisfied) return due;
      if (!policy) return new Date(due.getTime() + pausedMinutes * 60_000);
      return dueAt(policy, pausedMinutes, due);
    };

    await db
      .update(conversations)
      .set({
        firstResponseDueAt: shift(conversation.firstResponseDueAt, conversation.firstRespondedAt),
        nextResponseDueAt: shift(conversation.nextResponseDueAt, null),
        resolutionDueAt: shift(conversation.resolutionDueAt, conversation.resolvedAt),
      })
      .where(eq(conversations.id, conversationId));

    await db.insert(conversationEvents).values({
      conversationId,
      type: 'sla_resumed',
      actorLabel: 'sla',
      data: { pausedMinutes },
    });
  } catch (error) {
    console.error(`[sla] could not pause or resume the clock on ${conversationId}`, error);
  }
}

/** When the current pause began, or null if the clock is running. */
async function pausedSinceAt(conversationId: string): Promise<Date | null> {
  const rows = await db
    .select({ type: conversationEvents.type, createdAt: conversationEvents.createdAt })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ['sla_paused', 'sla_resumed']),
      ),
    )
    .orderBy(desc(conversationEvents.createdAt))
    .limit(1);

  const last = rows[0];
  return last?.type === 'sla_paused' ? last.createdAt : null;
}

/**
 * Tickets whose clock is running — the population the breach sweep considers.
 *
 * Resolved, closed, deleted and spam tickets are excluded, as are statuses that
 * stop the clock: a ticket waiting on the customer cannot breach, which is the
 * whole point of `stops_sla_clock`.
 */
export function liveTicketsFilter() {
  return and(
    isNull(conversations.deletedAt),
    eq(conversations.isSpam, false),
    eq(ticketStatuses.stopsSlaClock, false),
    inArray(ticketStatuses.category, ['open', 'pending']),
  );
}
