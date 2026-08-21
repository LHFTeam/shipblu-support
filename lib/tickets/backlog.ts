import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { conversations, ticketStatuses } from '@/db/schema';
import { readOnlyChannels } from './channel-policy';

/**
 * The open backlog: every ticket somebody on the team still owes an answer on.
 *
 * Deleted, merged and spam tickets are out, as are resolved and closed ones and
 * the read-only channels nobody may answer.
 *
 * One definition, imported rather than copied, because two of its consumers now
 * disagree in a way a user can see: the dashboard says an agent is holding seven
 * tickets and the capacity check decides whether they may hold an eighth. If
 * those two counted differently, an admin who set a cap of eight would watch a
 * ninth arrive and reasonably conclude the cap was broken.
 *
 * Requires `ticket_statuses` to be joined — the category lives there, not on the
 * conversation.
 *
 * This is deliberately *not* `liveTicketsFilter()` in `lib/sla`, which asks a
 * different question: that one excludes statuses flagged `stops_sla_clock`,
 * because a ticket waiting on the customer cannot breach. It is still work
 * somebody is holding, so it counts here.
 */
export function openBacklog() {
  return and(
    isNull(conversations.deletedAt),
    isNull(conversations.mergedIntoId),
    eq(conversations.isSpam, false),
    notInArray(conversations.channel, readOnlyChannels()),
    inArray(ticketStatuses.category, ['open', 'pending']),
  );
}
