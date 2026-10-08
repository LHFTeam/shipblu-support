import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationEvents,
  conversations,
  contacts,
  slaPolicies,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import type { HoursConfig } from '@/lib/hours';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { ticketHours, type HoursCatalog } from '@/lib/hours/resolve';
import { conversationFacts } from '@/lib/rules/facts';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import {
  dueAt,
  dueDatesOnCreate,
  nextResponseDueAt,
  selectPolicy,
  targetFor,
  type LoadedPolicy,
  type Priority,
} from './policy';
import { logger } from '@/lib/log';

const log = logger('sla');

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
      hoursSource: slaPolicies.hoursSource,
      businessHoursId: slaPolicies.businessHoursId,
    })
    .from(slaPolicies)
    .where(eq(slaPolicies.isActive, true))
    .orderBy(slaPolicies.position);

  return rows;
}

/**
 * The schedule one ticket's clocks run on.
 *
 * The group override lives here rather than on the policy because it is a fact
 * about who handles the ticket: move a ticket to a team that works Saturdays and
 * Saturday starts counting. `lib/hours/resolve.ts` owns the precedence.
 */
export function hoursForTicket(
  catalog: HoursCatalog,
  groupId: string | null,
  policy: LoadedPolicy | null,
): HoursConfig | null {
  return ticketHours(catalog, groupId, policy);
}

type ConversationRow = {
  conversation: typeof conversations.$inferSelect;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  stopsSlaClock: boolean;
  requesterEmail: string | null;
  formSlug: string | null;
};

async function loadConversation(conversationId: string): Promise<ConversationRow | null> {
  const rows = await db
    .select({
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      stopsSlaClock: ticketStatuses.stopsSlaClock,
      requesterEmail: contacts.primaryEmail,
      formSlug: ticketForms.slug,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(ticketForms, eq(ticketForms.id, conversations.formId))
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

    const catalog = await loadHoursCatalog();
    const due = dueDatesOnCreate(
      policy,
      row.conversation.priority as Priority,
      row.conversation.createdAt,
      hoursForTicket(catalog, row.conversation.groupId, policy),
    );

    await db
      .update(conversations)
      .set({ slaPolicyId: policy.id, ...due })
      .where(eq(conversations.id, conversationId));
  } catch (error) {
    log.error(`could not apply a policy to ${conversationId}`, error);
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
    log.error(`could not record an agent reply on ${conversationId}`, error);
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

    const catalog = await loadHoursCatalog();

    await db
      .update(conversations)
      .set({
        nextResponseDueAt: nextResponseDueAt(
          policy,
          row.conversation.priority as Priority,
          at,
          hoursForTicket(catalog, row.conversation.groupId, policy),
        ),
      })
      .where(eq(conversations.id, conversationId));
  } catch (error) {
    log.error(`could not record a customer reply on ${conversationId}`, error);
  }
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
    const catalog = await loadHoursCatalog();
    const hours = hoursForTicket(catalog, row.conversation.groupId, policy);
    const pausedMinutes = Math.max(0, Math.round((at.getTime() - pausedSince.getTime()) / 60_000));

    // Push each live clock forward by the time the ticket spent parked. Clocks
    // that have already been satisfied are left alone — extending the
    // first-response due date of a ticket that was answered hours ago would
    // rewrite history rather than pause it.
    const conversation = row.conversation;
    const shift = (due: Date | null, satisfied: Date | null): Date | null => {
      if (!due || satisfied) return due;
      return dueAt(hours, pausedMinutes, due);
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
    log.error(`could not pause or resume the clock on ${conversationId}`, error);
  }
}

/**
 * The ticket moved to another group: its clocks move with it.
 *
 * Groups can keep their own operating days, hours and holidays, so the same
 * four-hour target lands on a different instant in a team that works Saturdays
 * than in one that does not. Leaving the due date where it was would mean a
 * ticket handed to the weekend team is still due on a day that team is shut,
 * while reporting — which measures working time against the ticket's *current*
 * group — would already be counting the new calendar. Two answers to one
 * question is worse than either of them.
 *
 * Only the clocks that are still owed are recomputed, from the same anchors they
 * were first set from, carrying forward whatever time the ticket has already
 * spent parked on a status that stops the clock. The policy itself is not
 * re-selected: which targets a ticket is held to is what an agent was told when
 * it arrived, and quietly retargeting a ticket because it was routed elsewhere
 * is a different feature from honouring a team's calendar.
 *
 * Best-effort like the rest of this file, and a no-op when nothing would change
 * — a policy pinned to one schedule or counting round the clock resolves to the
 * same hours in every group.
 */
export async function onGroupChanged(conversationId: string): Promise<void> {
  await recomputeOwedClocks(conversationId, 'group_hours');
}

/**
 * The ticket's priority changed: the clocks still owed take the new targets.
 *
 * Every policy prices its targets per priority — in production a high or urgent
 * ticket is owed a first response in half the time a medium one is — and the
 * policy's own targets were only ever read once, in `applySlaOnCreate`. So before
 * this an agent who raised a ticket to urgent changed the badge and left the
 * deadline at medium's, and the breach report measured the ticket against a
 * target nobody was working to.
 *
 * The policy is not re-selected, for the reason `onGroupChanged` gives: which
 * policy holds a ticket is what it was told when it arrived. What moves is which
 * row of that policy's table applies, which is exactly what priority means. A
 * raise can bring a due date into the past; that is the honest answer — the
 * ticket was owed an urgent ticket's response from the moment it arrived — and
 * the breach sweep reports it on its next pass.
 *
 * Called by every writer of `conversations.priority` after its write commits:
 * the console, the `set_priority` automation and the priority classifier
 * (`lib/priority-ai/run.ts`). On a ticket created a moment ago it is a no-op,
 * because `applySlaOnCreate` has not written clocks yet and reads the priority
 * as it then stands.
 */
export async function onPriorityChanged(conversationId: string): Promise<void> {
  await recomputeOwedClocks(conversationId, 'priority');
}

/**
 * Re-times every clock still owed, from the anchors it was first set from,
 * against the ticket's current group and priority.
 *
 * Only a clock that is running moves. A target the old priority left unset is
 * not created here, and one the new priority leaves unset keeps its due date:
 * both are a policy configured differently per priority, which none of the
 * policies in production are, and inventing or dropping an obligation mid-ticket
 * is a different decision from re-timing one.
 */
async function recomputeOwedClocks(
  conversationId: string,
  reason: 'group_hours' | 'priority',
): Promise<void> {
  try {
    const row = await loadConversation(conversationId);
    if (!row) return;

    const conversation = row.conversation;

    // Nothing owed, nothing to move.
    if (
      !conversation.firstResponseDueAt &&
      !conversation.nextResponseDueAt &&
      !conversation.resolutionDueAt
    ) {
      return;
    }

    const policy = await policyFor(conversation.slaPolicyId);
    if (!policy) return;

    const catalog = await loadHoursCatalog();
    const hours = hoursForTicket(catalog, conversation.groupId, policy);
    const paused = await pausedMinutesTotal(conversationId);
    const priority = conversation.priority as Priority;
    const target = targetFor(policy, priority);

    /** The target plus the time already excused, in the ticket's current hours. */
    const recompute = (
      minutes: number | null,
      from: Date | null,
      satisfied: Date | null,
      existing: Date | null,
    ): Date | null => {
      if (satisfied || !existing) return existing;
      if (minutes === null || !from) return existing;
      return dueAt(hours, minutes + paused, from);
    };

    const firstResponse = recompute(
      target.firstResponseMins,
      conversation.createdAt,
      conversation.firstRespondedAt,
      conversation.firstResponseDueAt,
    );
    const resolution = recompute(
      target.resolutionMins,
      conversation.createdAt,
      conversation.resolvedAt,
      conversation.resolutionDueAt,
    );
    const nextResponse = recompute(
      target.nextResponseMins ?? target.firstResponseMins,
      conversation.lastCustomerMessageAt ?? conversation.createdAt,
      null,
      conversation.nextResponseDueAt,
    );

    const moved =
      !sameInstant(firstResponse, conversation.firstResponseDueAt) ||
      !sameInstant(resolution, conversation.resolutionDueAt) ||
      !sameInstant(nextResponse, conversation.nextResponseDueAt);

    if (!moved) return;

    await db
      .update(conversations)
      .set({
        firstResponseDueAt: firstResponse,
        nextResponseDueAt: nextResponse,
        resolutionDueAt: resolution,
      })
      .where(eq(conversations.id, conversationId));

    // On the timeline for the same reason a pause is: an agent who sees a due
    // date jump is owed the reason, and "the new group keeps different hours" is
    // not a guess anyone should have to make.
    await db.insert(conversationEvents).values({
      conversationId,
      type: 'sla_recalculated',
      actorLabel: 'sla',
      data: {
        reason,
        priority,
        timezone: hours?.timezone ?? null,
        firstResponseDueAt: firstResponse?.toISOString() ?? null,
        nextResponseDueAt: nextResponse?.toISOString() ?? null,
        resolutionDueAt: resolution?.toISOString() ?? null,
      },
    });
  } catch (error) {
    log.error(`could not move the clocks on ${conversationId}`, error);
  }
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * Every minute this ticket has spent on a clock-stopping status.
 *
 * Read back off the timeline rather than stored on the conversation: the pause
 * events are already the record, and a recomputed due date that forgot them
 * would hand back time the team was excused.
 */
async function pausedMinutesTotal(conversationId: string, at: Date = new Date()): Promise<number> {
  const rows = await db
    .select({
      type: conversationEvents.type,
      createdAt: conversationEvents.createdAt,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ['sla_paused', 'sla_resumed']),
      ),
    )
    .orderBy(conversationEvents.createdAt);

  let total = 0;
  let openedAt: Date | null = null;

  for (const row of rows) {
    if (row.type === 'sla_paused') {
      openedAt ??= row.createdAt;
      continue;
    }

    const recorded = (row.data as { pausedMinutes?: unknown } | null)?.pausedMinutes;
    if (typeof recorded === 'number' && Number.isFinite(recorded)) total += Math.max(0, recorded);
    else if (openedAt) total += minutesBetween(openedAt, row.createdAt);
    openedAt = null;
  }

  // Still parked: count the pause up to now, which is the same time the resume
  // will credit when it happens.
  if (openedAt) total += minutesBetween(openedAt, at);

  return total;
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
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
    // A read-only channel never gets a due date in the first place, so this is
    // belt to that brace — and it is the brace that would be easy to lose. A
    // ticket nobody is allowed to answer must not be able to hold a clock.
    notInArray(conversations.channel, readOnlyChannels()),
    inArray(ticketStatuses.category, ['open', 'pending']),
  );
}
