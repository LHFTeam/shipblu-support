import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { conversations, ticketStatuses } from '@/db/schema';
import { readOnlyChannels } from './channel-policy';

/**
 * What counts as a real ticket at all: not deleted, not merged away, not spam,
 * and not on a channel nobody may answer.
 *
 * Shared by both predicates below rather than written twice, so a channel added
 * to `readOnlyChannels()` cannot end up excluded from one of them and counted by
 * the other.
 *
 * Requires `ticket_statuses` to be joined by the caller — the status category
 * lives there, not on the conversation.
 */
function realTickets() {
  return and(
    isNull(conversations.deletedAt),
    isNull(conversations.mergedIntoId),
    eq(conversations.isSpam, false),
    notInArray(conversations.channel, readOnlyChannels()),
  );
}

/**
 * The open backlog: every ticket the team still has on its hands, whether it is
 * waiting on us (`open`) or on the customer (`pending`). Resolved and closed
 * ones are out.
 *
 * One definition, imported rather than copied, because the inbox, the dashboard,
 * the hourly backlog snapshot and the assignment sweep all ask exactly this
 * question — and a number that means "the queue" on one page and something
 * slightly different on the next is how a dashboard loses an argument.
 *
 * This is deliberately *not* `liveTicketsFilter()` in `lib/sla`, which asks a
 * different question: that one excludes statuses flagged `stops_sla_clock`,
 * because a ticket waiting on the customer cannot breach. It is still work
 * somebody is holding, so it counts here.
 */
export function openBacklog() {
  return and(realTickets(), inArray(ticketStatuses.category, ['open', 'pending']));
}

/**
 * The narrower slice a per-agent cap is counted against: `open` only.
 *
 * A cap is a statement about how much work one person may be *given at once*,
 * and a ticket on a pending status is waiting on the customer — there is nothing
 * for the agent to do with it until they answer. Counting those let an agent sit
 * at their cap for a week while holding nothing they could act on, and the queue
 * stopped draining for a reason no page showed.
 *
 * The consequence is worth stating, because it is what these two predicates
 * being one function used to prevent: an agent's total load can now exceed their
 * cap. So anything that renders a cap renders *this* count beside it and never
 * `openBacklog()`'s — an admin reading "9 / 8" against a cap that is plainly not
 * being enforced at 9 concludes the cap is broken, and they are right to.
 */
export function capacityBacklog() {
  return and(realTickets(), eq(ticketStatuses.category, 'open'));
}
