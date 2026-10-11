import { and, desc, eq, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationEvents,
  conversations,
  contacts,
  slaPolicies,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { businessMinutesBetween, type HoursConfig } from '@/lib/hours';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { ticketHours, type HoursCatalog } from '@/lib/hours/resolve';
import { conversationFacts } from '@/lib/rules/facts';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { earliest } from '@/lib/tickets/latest';
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The ticket and the facts about it the clocks read. Given a transaction, the
 * ticket's row is locked for it (`withTicketLocked`); the joined rows are read,
 * not claimed.
 */
async function loadConversation(conversationId: string, tx?: Tx): Promise<ConversationRow | null> {
  const query = (tx ?? db)
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

  const rows = tx ? await query.for('update', { of: conversations }) : await query;
  return rows[0] ?? null;
}

/**
 * Runs `work` holding the ticket's row lock, with the row read under it.
 *
 * Every clock writer here reads the ticket, computes due dates from what it
 * read — the priority, the group, the pauses on the timeline — and writes them
 * back. Each writer of those inputs re-times after its own commit, so two of
 * them on one ticket interleave: a re-time computed from `high` landing after
 * the one for `urgent`, or a resume shifting the clocks for a pause while a
 * re-time that read the timeline before the resume existed overwrites the
 * shift. A write conditional on the priority it read, retried on a miss, closed
 * the first for three writers and not the second for any; the lock closes both
 * for all four, because the second writer reads what the first wrote.
 *
 * Callers reach this after their own transactions commit, so the lock never
 * waits on one its own caller holds. The policies and the hours catalog are
 * loaded before it, on their own connections: read inside, every holder of a
 * transaction would want a second pooled connection, and a worker whose every
 * connection was such a holder would wait on itself.
 */
async function withTicketLocked(
  conversationId: string,
  work: (tx: Tx, row: ConversationRow) => Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await loadConversation(conversationId, tx);
    if (row) await work(tx, row);
  });
}

function policyIn(policies: readonly LoadedPolicy[], policyId: string | null): LoadedPolicy | null {
  if (!policyId) return null;
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
    const policies = await loadPolicies();
    if (policies.length === 0) return;
    const catalog = await loadHoursCatalog();

    // Under the row lock (`withTicketLocked`): the priority classifier is a job
    // that can commit while a new ticket's web request is still between reading
    // the priority and writing the due dates. Its own `onPriorityChanged` finds
    // no clocks yet and does nothing, so a write here from the priority read
    // before it would store the old priority's targets under the new badge, for
    // good. Locked, one of the two waits and reads the other's write.
    await withTicketLocked(conversationId, async (tx, row) => {
      const policy = selectPolicy(policies, conversationFacts(row));
      if (!policy) return;

      const due = dueDatesOnCreate(
        policy,
        row.conversation.priority as Priority,
        row.conversation.createdAt,
        hoursForTicket(catalog, row.conversation.groupId, policy),
      );

      await tx
        .update(conversations)
        .set({ slaPolicyId: policy.id, ...due })
        .where(eq(conversations.id, conversationId));
    });
  } catch (error) {
    log.error(`could not apply a policy to ${conversationId}`, error);
  }
}

/**
 * An agent replied: the response clocks stop.
 *
 * `firstRespondedAt` is recorded even when the ticket has no policy, because
 * reporting measures response time whether or not anyone committed to a target.
 *
 * `at` is when the reply was written, and it need not be the newest thing on
 * the ticket. A reply typed on the WhatsApp Business app arrives as an echo,
 * and deliveries are processed in no order (`docs/PROJECT-STATE.md` §6.77), so
 * a phone reply typed at 10:00 can be processed after the customer's 10:05
 * message. It answered what came before it, not that message, so the clocks
 * come out as they would have in arrival order — the SLA must not depend on
 * which worker got there first:
 *
 * - **The next-response clock stops only when the reply is at least as new as
 *   the customer's newest message.** Decided in the UPDATE, against the row as
 *   it is when the write lands: a check in JavaScript after a read would lose
 *   the clock to a customer message committed in between.
 * - **`firstRespondedAt` takes the earliest reply** (`earliest()`, which
 *   ignores the null of a ticket nobody has answered), so an older phone reply
 *   processed late records the true first response rather than whichever was
 *   processed first.
 * - **A customer message the clock never started for is picked up here.** One
 *   that arrived before anybody had answered left the next-response clock
 *   alone — `onCustomerReply` waits for a first response — and this late reply
 *   has just become that first response. So when the customer's newest message
 *   is newer than every reply the team has sent and no clock is running, the
 *   clock starts from that message. Not when one is already running: it was
 *   started for that same message, and recomputing it would throw away any time
 *   a pause has since credited to it. That decision is taken again under the
 *   ticket's lock, from the row as it is then (`startReplyClock`), and it never
 *   touches a pause: this is the team's reply, and a reopen committing after
 *   the UPDATE above is the customer's own message to account for.
 *
 * In the console `at` is now, which no customer message is later than, so
 * there this is the plain "answered, nothing owed" it always was.
 */
export async function onAgentReply(conversationId: string, at: Date = new Date()): Promise<void> {
  try {
    // Bound as text behind `::timestamptz`: a bare Date in a `sql` template
    // reaches postgres.js untyped (AGENTS.md, Tests).
    const instant = at.toISOString();
    const [row] = await db
      .update(conversations)
      .set({
        firstRespondedAt: earliest(conversations.firstRespondedAt, at),
        // Answered, so nothing is owed until the customer writes again — unless
        // they already have, after this reply was written.
        nextResponseDueAt: sql`case when ${conversations.lastCustomerMessageAt} > ${instant}::timestamptz
                                    then ${conversations.nextResponseDueAt} else null end`,
      })
      .where(eq(conversations.id, conversationId))
      .returning({
        lastCustomerMessageAt: conversations.lastCustomerMessageAt,
        lastAgentMessageAt: conversations.lastAgentMessageAt,
        nextResponseDueAt: conversations.nextResponseDueAt,
      });

    // Nothing to pick up as of this write, which is every console reply. A
    // customer message committed after it is that message's own path to clock.
    if (!row || !unanswered(row, at)) return;

    // Asked again under the lock, rather than handing what the UPDATE returned
    // to `onCustomerReply`. That instant was read before the lock, and a
    // reopen can commit in between: `onCustomerReply`'s `closeStrayPause`
    // would then end the reopen's pause at an instant earlier than the pause,
    // which it clamps to the pause's own start — a resume crediting nothing,
    // which a later re-time pairs with the pause in place of the real one.
    await startReplyClock(conversationId, ({ conversation }) =>
      unanswered(conversation, at) ? conversation.lastCustomerMessageAt : null,
    );
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
  await closeStrayPause(conversationId, at);
  await startReplyClock(conversationId, () => at);
}

/**
 * Whether the customer's newest message is newer than every reply the team has
 * sent, `at` included — the caller moves `lastAgentMessageAt` before calling,
 * and `at` covers one that does not — with no next-response clock running for
 * it. A console reply sent after the customer's message answered it, even
 * though an older phone reply processed later did not.
 */
function unanswered(
  row: {
    lastCustomerMessageAt: Date | null;
    lastAgentMessageAt: Date | null;
    nextResponseDueAt: Date | null;
  },
  at: Date,
): boolean {
  if (!row.lastCustomerMessageAt || row.nextResponseDueAt) return false;
  const answeredAt = Math.max(at.getTime(), row.lastAgentMessageAt?.getTime() ?? 0);
  return row.lastCustomerMessageAt.getTime() > answeredAt;
}

/**
 * Starts the next-response clock from the instant `from` picks off the row read
 * under the ticket's lock, or leaves it alone when that is null. The half of
 * `onCustomerReply` that is about the clock and not about a pause, so the
 * team's late reply in `onAgentReply` can start one without ending anything.
 */
async function startReplyClock(
  conversationId: string,
  from: (row: ConversationRow) => Date | null,
): Promise<void> {
  try {
    const policies = await loadPolicies();
    const catalog = await loadHoursCatalog();

    // Locked, for the reason `applySlaOnCreate` gives: the classifier answering
    // this same message can commit between the read and the write.
    await withTicketLocked(conversationId, async (tx, row) => {
      if (!row.conversation.firstRespondedAt) return;
      const at = from(row);
      if (!at) return;

      const policy = policyIn(policies, row.conversation.slaPolicyId);
      if (!policy) return;

      await tx
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
    });
  } catch (error) {
    log.error(`could not record a customer reply on ${conversationId}`, error);
  }
}

/**
 * Resume a clock left paused on a ticket whose status no longer stops it.
 *
 * Resolving pauses the clock, and `reopenResolved` — the five inbound paths
 * that put a resolved ticket back to Open — changes the status inside its
 * caller's transaction and never resumed it. The reopened ticket then owed its
 * resolution clock nothing for the time it sat resolved, and breached on the
 * spot; and its next trip to Pending found the clock "already paused", so the
 * resume after it credited everything since the resolve. Every reopen is a
 * customer writing, and every one of them ends here after its transaction
 * commits, so this is the one place that sees all five — where a call in each
 * would be five copies of a rule that only has to be missed once.
 *
 * The pause ends at the reopen, or at this message if that came first: the
 * `reopened` event is when the status stopped stopping the clock. That also
 * repairs a ticket left like this before the fix — production had one,
 * reopened on 21 August — on its next message, with the credit it was owed
 * rather than everything since.
 */
async function closeStrayPause(conversationId: string, at: Date): Promise<void> {
  try {
    // Read before the lock to find where the pause ended; `onStatusChanged`
    // reads it again under the lock, so a pause closed in between is left alone.
    const pausedSince = await pausedSinceAt(conversationId, db);
    if (!pausedSince) return;

    const row = await loadConversation(conversationId);
    if (!row || row.stopsSlaClock) return;

    const [reopened] = await db
      .select({ createdAt: conversationEvents.createdAt })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversationId),
          eq(conversationEvents.type, 'reopened'),
          gte(conversationEvents.createdAt, pausedSince),
        ),
      )
      .orderBy(desc(conversationEvents.createdAt))
      .limit(1);

    // The earlier of the reopen and this message, and never before the pause.
    // The reopen is stamped when its transaction committed, which is after the
    // message it reopened for by however long ingest took — and `at` is where
    // the reply clock below starts, so ending the pause later would credit that
    // lag to the reply clock on the next re-time and not now. A reopen long
    // before this message is a ticket left like this before the fix.
    const reopenedAt = reopened && reopened.createdAt < at ? reopened.createdAt : at;
    await onStatusChanged(
      conversationId,
      false,
      reopenedAt < pausedSince ? pausedSince : reopenedAt,
    );
  } catch (error) {
    log.error(`could not close the paused clock on ${conversationId}`, error);
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
    const policies = await loadPolicies();
    const catalog = await loadHoursCatalog();

    // Under the row lock, with the pause read under it (`withTicketLocked`). Two
    // writers deciding at once — two customer messages reopening one ticket
    // (`closeStrayPause`), an agent and a rule — each read the same open pause,
    // each shifted the clocks by it, and each wrote its own resume; every
    // re-time after that credited the pause once per resume row. Serialised,
    // the second finds the pause already closed and does nothing — and a
    // re-time that read the timeline before this resume cannot write over it.
    await withTicketLocked(conversationId, (tx, row) =>
      changeClock(tx, row, policies, catalog, stopsSlaClock, at),
    );
  } catch (error) {
    log.error(`could not pause or resume the clock on ${conversationId}`, error);
  }
}

async function changeClock(
  tx: Tx,
  row: ConversationRow,
  policies: readonly LoadedPolicy[],
  catalog: HoursCatalog,
  stopsSlaClock: boolean,
  at: Date,
): Promise<void> {
  const conversationId = row.conversation.id;
  const pausedSince = await pausedSinceAt(conversationId, tx);

  if (stopsSlaClock) {
    if (pausedSince) return; // already paused; nothing to record
    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'sla_paused',
      actorLabel: 'sla',
      createdAt: at,
      data: { at: at.toISOString() },
    });
    return;
  }

  if (!pausedSince) return;

  const policy = policyIn(policies, row.conversation.slaPolicyId);
  const hours = hoursForTicket(catalog, row.conversation.groupId, policy);
  // Wall-clock, for the timeline's "resumed after N minutes"; what a clock is
  // credited is the working time inside the pause, below.
  const pausedMinutes = minutesBetween(pausedSince, at);
  const pause: Pause = { from: pausedSince, to: at };

  // Push each live clock forward by the time the ticket spent parked. Clocks
  // that have already been satisfied are left alone — extending the
  // first-response due date of a ticket that was answered hours ago would
  // rewrite history rather than pause it.
  const conversation = row.conversation;
  const shift = (due: Date | null, satisfied: Date | null, minutes: number): Date | null => {
    // A pause with no working time in it excuses nothing, so it moves
    // nothing — `dueAt` from a deadline sitting at closing time would step to
    // the next opening, and a re-time from the anchors would step it back.
    if (!due || satisfied || minutes === 0) return due;
    return dueAt(hours, minutes, due);
  };

  // In the hours the clock counts. Adding the pause's wall-clock minutes as
  // working minutes, which this did, moved a ticket parked from Thursday
  // afternoon to Sunday morning by 3,960 working minutes — about ten days on a
  // five-day week — where the clock had been stopped for two working hours.
  const excused = excusedSince(hours, [pause], conversation.createdAt);

  // The reply clock is owed only the part of the pause after the customer's
  // latest message, which is where `onCustomerReply` started it: a customer
  // writing to a parked ticket set it from that instant, and the hours parked
  // before they wrote excuse nothing. `recomputeOwedClocks` counts it the same
  // way, from the same instants — the event below is stamped with `at` and
  // records where the pause began — so re-timing a ticket afterwards does not
  // move a deadline nothing changed.
  const replyPaused = excusedSince(
    hours,
    [pause],
    conversation.lastCustomerMessageAt ?? conversation.createdAt,
  );

  await tx
    .update(conversations)
    .set({
      firstResponseDueAt: shift(
        conversation.firstResponseDueAt,
        conversation.firstRespondedAt,
        excused,
      ),
      nextResponseDueAt: shift(conversation.nextResponseDueAt, null, replyPaused),
      resolutionDueAt: shift(conversation.resolutionDueAt, conversation.resolvedAt, excused),
    })
    .where(eq(conversations.id, conversationId));

  await tx.insert(conversationEvents).values({
    conversationId,
    type: 'sla_resumed',
    actorLabel: 'sla',
    createdAt: at,
    data: { pausedMinutes, from: pausedSince.toISOString() },
  });
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
 * because `applySlaOnCreate` has not written clocks yet — and that function
 * reads the priority under the row lock, so a change landing in between is
 * either waited for and read there, or waits for it and re-times what it wrote.
 * A lowering that moves a missed target back into the future clears its breach
 * flag (`recomputeOwedClocks`).
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
    const policies = await loadPolicies();
    const catalog = await loadHoursCatalog();

    await withTicketLocked(conversationId, async (tx, row) => {
      const conversation = row.conversation;

      // Nothing owed, nothing to move.
      if (
        !conversation.firstResponseDueAt &&
        !conversation.nextResponseDueAt &&
        !conversation.resolutionDueAt
      ) {
        return;
      }

      const policy = policyIn(policies, conversation.slaPolicyId);
      if (!policy) return;

      const hours = hoursForTicket(catalog, conversation.groupId, policy);
      const priority = conversation.priority as Priority;
      const target = targetFor(policy, priority);
      const nextAnchor = conversation.lastCustomerMessageAt ?? conversation.createdAt;
      const pauses = await completedPauses(conversationId, tx);

      /** The target plus the time already excused since `from`, in the ticket's current hours. */
      const recompute = (
        minutes: number | null,
        from: Date | null,
        satisfied: Date | null,
        existing: Date | null,
      ): Date | null => {
        if (satisfied || !existing) return existing;
        if (minutes === null || !from) return existing;
        return dueAt(hours, minutes + excusedSince(hours, pauses, from), from);
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
        nextAnchor,
        null,
        conversation.nextResponseDueAt,
      );

      const moved =
        !sameInstant(firstResponse, conversation.firstResponseDueAt) ||
        !sameInstant(resolution, conversation.resolutionDueAt) ||
        !sameInstant(nextResponse, conversation.nextResponseDueAt);

      if (!moved) return;

      // A breach flag stands for a target the ticket missed, and the target just
      // changed. Lowered from urgent after urgent's target passed, a ticket whose
      // new due date is still ahead has not missed anything it is held to, and the
      // flag left set kept it in the live report's breached count and the backlog
      // snapshot. Only the sweep sets the flag, so a re-time into the past leaves
      // it to the sweep, which records the breach with its event as for any
      // other; a re-time into the future is the one case nothing else would undo.
      const now = new Date();
      const cleared = [
        ...(conversation.firstResponseBreached && firstResponse && firstResponse > now
          ? (['first_response'] as const)
          : []),
        ...(conversation.resolutionBreached && resolution && resolution > now
          ? (['resolution'] as const)
          : []),
      ];

      await tx
        .update(conversations)
        .set({
          firstResponseDueAt: firstResponse,
          nextResponseDueAt: nextResponse,
          resolutionDueAt: resolution,
          ...(cleared.includes('first_response') ? { firstResponseBreached: false } : {}),
          ...(cleared.includes('resolution') ? { resolutionBreached: false } : {}),
        })
        .where(eq(conversations.id, conversationId));

      // On the timeline for the same reason a pause is: an agent who sees a due
      // date jump is owed the reason, and "the new group keeps different hours" is
      // not a guess anyone should have to make.
      await tx.insert(conversationEvents).values({
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
          clearedBreaches: cleared,
        },
      });
    });
  } catch (error) {
    log.error(`could not move the clocks on ${conversationId}`, error);
  }
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return a === b;
  return a.getTime() === b.getTime();
}

/** One finished stretch on a clock-stopping status. */
type Pause = { from: Date; to: Date };

/**
 * Every pause this ticket has finished, read back off the timeline.
 *
 * Read off the timeline rather than stored on the conversation: the pause
 * events are already the record, and a recomputed due date that forgot them
 * would hand back time the team was excused.
 *
 * **Finished pauses only.** A ticket still parked has not been credited for
 * the pause yet — `onStatusChanged` credits the whole of it, by shifting the
 * stored due dates, when the clock resumes. Counting the open pause here as
 * well, which this once did, credited it twice: a ticket re-timed while on
 * Pending came back with every owed clock late by however long it had waited.
 */
async function completedPauses(conversationId: string, tx: Tx): Promise<Pause[]> {
  const rows = await tx
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

  const pauses: Pause[] = [];
  let openedAt: Date | null = null;

  for (const row of rows) {
    if (row.type === 'sla_paused') {
      openedAt ??= row.createdAt;
      continue;
    }

    // A resume with no pause open before it closed nothing: a duplicate that
    // one writer raced another to, before `onStatusChanged` took the row lock.
    // Counted, it handed the same pause back again on every re-time.
    if (!openedAt) continue;

    // The pause as the resume credited it: from where it began — which the
    // resume records, since the credit is working time and cannot be turned back
    // into instants — to the resume, which is stamped with the instant it
    // computed from. A resume written before it recorded `from` falls back to
    // the pause event that opened it.
    const data = row.data as { from?: unknown } | null;
    const recordedFrom = typeof data?.from === 'string' ? new Date(data.from) : null;
    const from = recordedFrom && !Number.isNaN(recordedFrom.getTime()) ? recordedFrom : openedAt;
    pauses.push({ from, to: row.createdAt });
    openedAt = null;
  }

  return pauses;
}

/**
 * The paused minutes a clock anchored at `anchor` has been excused, counted in
 * `hours` — the calendar the clock itself counts in, or wall-clock time when it
 * runs round the clock. A pause over a weekend excuses the working time inside
 * it, not the weekend.
 *
 * Only the part of each pause after the anchor. First response and resolution
 * count from `created_at`, so that is all of them. Next response counts from
 * the customer's latest message, and `onCustomerReply` sets it from that
 * instant with no pause added — so a pause that ended before the customer last
 * wrote excuses nothing, and adding the ticket's lifetime total to it, which
 * this once did, pushed a raised ticket's reply deadline back by days.
 */
function excusedSince(hours: HoursConfig | null, pauses: readonly Pause[], anchor: Date): number {
  let total = 0;
  for (const pause of pauses) {
    const from = pause.from > anchor ? pause.from : anchor;
    if (pause.to <= from) continue;
    total += hours
      ? Math.round(businessMinutesBetween(hours, from, pause.to))
      : minutesBetween(from, pause.to);
  }
  return total;
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

/** When the current pause began, or null if the clock is running. */
async function pausedSinceAt(
  conversationId: string,
  executor: typeof db | Tx,
): Promise<Date | null> {
  const rows = await executor
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
