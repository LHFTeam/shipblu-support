import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, messages } from '@/db/schema';
import { metaWindowState } from '@/lib/meta/window';
import { enqueue } from '@/lib/queue';
import { windowState as whatsappWindowState } from '@/lib/whatsapp/window';

/**
 * Putting a message the software wrote in front of the customer.
 *
 * The automation engine's canned reply and the out-of-hours acknowledgement send
 * the same way, and it is not a short way: which body a channel takes, which
 * delivery status it starts in, which queue job carries it, and the timestamps
 * the inbox sorts on. Two copies of that drift, and the drift shows up as one
 * channel quietly not delivering.
 *
 * What is deliberately *not* in here is what the message means beyond one firm
 * boundary: software writing to a customer is not an agent replying. Automated
 * messages therefore move the thread but not `lastAgentMessageAt`, and their
 * callers must not stop an SLA response clock. They do stamp
 * `firstAutoRepliedAt`, which is how the rule engine knows the acknowledgement
 * already went out without any of it counting as a first response. Whether
 * anything gets a usage count still belongs to the caller.
 */

/**
 * Why this channel will not carry an automated reply right now, or null.
 *
 * One function rather than a check at each sender, because the two senders — the
 * out-of-hours acknowledgement and the automation engine's canned reply — write
 * through the same door and a guard on one of them is not a guard. The
 * out-of-hours message is composed moments after the customer wrote and so
 * almost never trips this; the automation engine runs from a cron every fifteen
 * minutes over every live ticket, and a "chase after three days" rule reaches
 * these channels squarely outside the window.
 *
 * It refuses *before* the message row exists, which is the point. Delivery
 * refuses it too — `send_meta` will not tag an automated message `HUMAN_AGENT`
 * — but by then the customer's timeline carries a reply that permanently failed,
 * and an agent reading the ticket has to work out that nobody was ever going to
 * see it.
 *
 * The three channels that answer non-null:
 *
 *   whatsapp             outside 24 hours only an approved template sends, and
 *                        an automation has no way to fill one in.
 *   facebook, instagram  outside 24 hours only `HUMAN_AGENT` sends, and that tag
 *                        may only be used for a message a person wrote. So the
 *                        seven days Meta allows are a human's to use, not a
 *                        rule's, and this closes at 24 hours rather than at
 *                        seven days.
 *
 * Everything else — email, the portal, web chat — has no window at all.
 */
export function automatedReplyBlocked(
  channel: string,
  lastCustomerMessageAt: Date | null,
  now: Date = new Date(),
): string | null {
  if (channel === 'whatsapp') {
    return whatsappWindowState(lastCustomerMessageAt, now).isOpen
      ? null
      : 'the WhatsApp 24-hour window is closed and only an approved template would send';
  }

  if (channel === 'facebook' || channel === 'instagram') {
    return metaWindowState(lastCustomerMessageAt, now).isOpen
      ? null
      : 'the 24-hour window is closed, and past it only HUMAN_AGENT sends — a tag ' +
          'reserved for a message a person wrote';
  }

  return null;
}

export type AutomatedReply = {
  conversationId: string;
  channel: string;
  /** The requester's address; only used on email, where there is nowhere else to send. */
  requesterEmail: string | null;
  bodyText: string;
  /** Ignored off email, which sends text. */
  bodyHtml: string | null;
  /** Shown on the timeline in place of an agent's name: `automation:Out of hours`. */
  actorLabel: string;
  eventType: string;
  eventData?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

/** The new message's id, for the caller's log and follow-up writes. */
export async function deliverAutomatedReply(reply: AutomatedReply): Promise<string> {
  const isEmail = reply.channel === 'email';
  // Web chat has no carrier: the message is in the database, and the widget's
  // stream is already reading from it. Marking it pending would leave every
  // chat reply showing as unsent forever.
  const isWebchat = reply.channel === 'webchat';

  const now = new Date();

  const inserted = await db
    .insert(messages)
    .values({
      conversationId: reply.conversationId,
      direction: 'outbound',
      kind: 'reply',
      // No author agent — the timeline shows this as sent by the rule.
      bodyText: reply.bodyText,
      bodyHtml: isEmail ? reply.bodyHtml : null,
      toAddresses: isEmail && reply.requesterEmail ? [reply.requesterEmail] : [],
      deliveryStatus: isWebchat ? 'delivered' : 'pending',
      ...(isWebchat ? { deliveredAt: now } : {}),
      meta: reply.meta ?? {},
    })
    .returning({ id: messages.id });

  const messageId = inserted[0]!.id;

  await db
    .update(conversations)
    .set({
      lastMessageAt: now,
      // Coalesced rather than overwritten: this records that the customer has
      // been acknowledged at all, so the second automated reply on a ticket
      // must not move it and make a rule keyed off it fire again.
      firstAutoRepliedAt: sql`coalesce(${conversations.firstAutoRepliedAt}, ${now})`,
    })
    .where(eq(conversations.id, reply.conversationId));

  await db.insert(conversationEvents).values({
    conversationId: reply.conversationId,
    type: reply.eventType,
    actorLabel: reply.actorLabel,
    data: { messageId, ...(reply.eventData ?? {}) },
  });

  if (!isWebchat) {
    await enqueue(
      carrier(reply.channel),
      { messageId },
      { priority: 20, dedupeKey: `send:${messageId}` },
    );
  }

  return messageId;
}

/**
 * The job that carries a message on each channel.
 *
 * Facebook and Instagram go to `send_meta` rather than falling into the email
 * branch, which is what the console has always done and what the automated
 * senders — reading `channel === 'whatsapp' ? … : 'send_email'` — did not: an
 * automated reply on a Facebook ticket was queued as an email to a contact who
 * usually has no address, and failed in the worker rather than anywhere anybody
 * was looking. `send_meta` needs no more than the message id; it infers a public
 * reply from a private one by looking at what came in last.
 *
 * `portal` sends by email deliberately. A portal ticket's customer is reachable
 * at the address they registered with, and `send_email` falls back to it when
 * the message names no recipient.
 */
function carrier(channel: string): 'send_whatsapp' | 'send_meta' | 'send_email' {
  if (channel === 'whatsapp') return 'send_whatsapp';
  if (channel === 'facebook' || channel === 'instagram') return 'send_meta';
  return 'send_email';
}
