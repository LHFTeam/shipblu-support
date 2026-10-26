import { isSubcategorisableMessage } from '@/lib/subcategorise/apply';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { hasCustomerText } from '@/lib/tickets/customer-text';

/**
 * Which inbound messages Jev's classifiers ask about — the priority classifier
 * (`lib/priority-ai/`) and the category classifier (`lib/category-ai/`).
 *
 * One copy, so the two ask about the same messages for the same reasons: a
 * message one of them refuses as a passer-by's or as machine mail, the other
 * must not read as the customer's words. Each job loads the row itself and
 * asks here before it pays for an answer; the context both send with it
 * (`earlierMessages`, `stateFor`) is shared already, from the subcategoriser.
 */

/** The columns the decision reads, off the message and its ticket. */
export type ClassifiableMessage = {
  kind: string;
  direction: string;
  bodyText: string;
  meta: unknown;
  authorContactId: string | null;
  requesterContactId: string | null;
  channel: string;
  isSpam: boolean;
  deletedAt: Date | null;
};

/**
 * Why this message is not one to classify, or null if it is.
 *
 * Only the ticket's own customer is asked about. On a public comment thread
 * anybody may reply under the customer's comment, and ingest files the reply on
 * the customer's ticket — so a passer-by's "scammers, I'll sue" would otherwise
 * raise somebody else's ticket, or their "price?" file a complaint as a sales
 * enquiry, and go to the model as that customer's words. The same rule takes a
 * colleague copied on an email thread out too; their words reach the ticket
 * when the customer writes, and a wrong answer moves a deadline or a team where
 * a missed one only leaves it.
 *
 * The subcategoriser's own test for "a customer wrote something", so every
 * question is asked of the same messages; the bot channel through
 * `isReadOnlyChannel`, since nobody on the team works it and it is nearly all of
 * the volume. Machine mail is not the customer — the email ingest flags it and
 * keeps an autoresponder's time off the customer's clock — and a spam or
 * deleted ticket is not in anybody's queue.
 *
 * A message whose text is ours rather than the customer's alone is not asked
 * about either: our label for a caption-less photo, voice note or document, or
 * a WhatsApp edit wrapped in one (`hasCustomerText`). Asked about `[image]`, the
 * model sees a message too short to judge and answers `low`, as the priority
 * question's instructions tell it to; on an opening message that lowers a
 * ticket whose photo may well be of the damaged parcel. The model cannot see
 * the photo, so it is not asked about one. The message still counts as the
 * ticket's opening, so the words that follow it may raise and never lower. The
 * message an edit corrects was asked about when it arrived.
 *
 * The reasons are logged by both jobs and asserted by priority's tests, so they
 * stay word for word.
 */
export function skipReason(row: ClassifiableMessage): string | null {
  if (!isSubcategorisableMessage(row.kind, row.direction)) return 'not an inbound reply';
  if (
    row.authorContactId &&
    row.requesterContactId &&
    row.authorContactId !== row.requesterContactId
  ) {
    return 'not written by the requester';
  }
  if (!hasCustomerText(row.bodyText)) return 'no text';
  if (isReadOnlyChannel(row.channel)) return `read-only channel ${row.channel}`;
  if (row.isSpam) return 'spam';
  if (row.deletedAt) return 'deleted';
  if (isMachineMail(row.meta)) return 'an automated email';
  return null;
}

/**
 * An autoresponder or a bounce: neither is the customer saying anything about
 * their situation, and a bounce's text — "delivery failed", "permanent error" —
 * reads as urgent, and as a delivery problem, to anything that has not been
 * told what it is.
 *
 * Not `isAutomated`, which `lib/email/loop-protection.ts` documents as the broad
 * guess for "do not auto-reply", where a wrong yes costs nothing: it is set by a
 * `List-Id` header and by a `notifications@` sender, so a merchant writing from
 * a Google Group about forty missing COD payments carries it. Here a wrong yes
 * would hide exactly that ticket, and a skip writes no run row, so nothing
 * would show the gap.
 */
function isMachineMail(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) return false;
  const flags = meta as Record<string, unknown>;
  return flags.isAutoReply === true || flags.isBounce === true;
}
