import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, messages } from '@/db/schema';
import { rootCommentId } from '@/lib/meta/comments';
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
 * Why this ticket will not carry an automated reply right now, or null.
 *
 * One function rather than a check at each sender, because the senders write
 * through the same door and a guard on one of them is not a guard. The
 * out-of-hours acknowledgement is composed moments after the customer wrote and
 * so almost never trips this; the automation engine runs from a cron every
 * fifteen minutes over every live ticket, and a "chase after three days" rule
 * reaches these channels squarely outside the window.
 *
 * It refuses *before* the message row exists, which is the point. Delivery
 * refuses it too — `send_meta` will not tag an automated message `HUMAN_AGENT`
 * — but by then the customer's timeline carries a reply that permanently failed,
 * and an agent reading the ticket has to work out that nobody was ever going to
 * see it.
 *
 * What answers non-null:
 *
 *   whatsapp             outside 24 hours only an approved template sends, and
 *                        an automation has no way to fill one in.
 *   facebook, instagram  outside 24 hours only `HUMAN_AGENT` sends, and that tag
 *                        may only be used for a message a person wrote. So the
 *                        seven days Meta allows are a human's to use, not a
 *                        rule's, and this closes at 24 hours rather than at
 *                        seven days.
 *
 * **A Meta comment ticket has no messaging window and is never blocked here.**
 * It is answered by posting to the comment edge, which `send_meta` reaches
 * before it ever consults the clock, so blocking one on the customer's last
 * message would silently stop every automated reply on a public thread older
 * than a day — a reply that would have posted perfectly well. The ticket is
 * identified the way the send path identifies it, through `rootCommentId`
 * rather than a second reading of `external_id`.
 *
 * `now` defaults to the real clock and callers should leave it alone outside a
 * test. It is deliberately *not* the instant of the message being handled: the
 * ingest lifecycle passes the inbound message's own `sentAt` through as its
 * timestamp, and that is exactly `lastCustomerMessageAt`, so measuring the
 * window against it compares a value with itself and reports every window open.
 * That is what a replayed backlog looks like, which is the one case this guard
 * exists for.
 */
export function automatedReplyBlocked(
  ticket: {
    channel: string;
    /** A comment ticket's `${platform}:comment:${root}`; null for a DM. */
    externalId: string | null;
    lastCustomerMessageAt: Date | null;
  },
  now: Date = new Date(),
): string | null {
  if (ticket.channel === 'whatsapp') {
    return whatsappWindowState(ticket.lastCustomerMessageAt, now).isOpen
      ? null
      : 'the WhatsApp 24-hour window is closed and only an approved template would send';
  }

  if (ticket.channel === 'facebook' || ticket.channel === 'instagram') {
    if (rootCommentId(ticket.externalId)) return null;

    return metaWindowState(ticket.lastCustomerMessageAt, now).isOpen
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
  // Null means the channel has no carrier: the message is in the database and
  // the customer's own client is already reading from it. Marking it pending
  // would leave every chat reply showing as unsent forever.
  const carrier = carrierFor(reply.channel);

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
      deliveryStatus: carrier ? 'pending' : 'delivered',
      ...(carrier ? {} : { deliveredAt: now }),
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

  if (carrier) {
    await enqueue(carrier, { messageId }, { priority: 20, dedupeKey: `send:${messageId}` });
  }

  return messageId;
}

/**
 * The job that carries a message on each channel, or **null where writing the
 * row is delivery**.
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
 *
 * **Null is the third answer, and it used to be three copies of
 * `channel === 'webchat'`.** Web chat and the myBlu app both read the `messages`
 * table the reply is written to, so there is no provider to hand it to: the row
 * *is* the delivery, and a `pending` status on one would show the customer's own
 * screen a message that never finishes sending. Each of the three senders —
 * the console composer, `deliverAutomatedReply` below and `send_csat` — spelled
 * that as its own local `isWebchat`, guarding both the `delivered`/`deliveredAt`
 * stamp and the enqueue. Anything not literally `'webchat'` therefore got
 * `pending` plus whatever this function returned, and for an in-app channel that
 * is `send_email` to a recipient who usually has no address: the agent sees a
 * sent reply, the job dies in a worker log, the customer gets nothing.
 *
 * That is the same bug `send_csat`'s private copy of this mapping already caused
 * once for Facebook. One function answering both halves is what stops a fourth
 * sender, or a fourth in-place channel, from having to notice.
 */
export function carrierFor(channel: string): 'send_whatsapp' | 'send_meta' | 'send_email' | null {
  if (channel === 'webchat' || channel === 'mobile') return null;
  if (channel === 'whatsapp') return 'send_whatsapp';
  if (channel === 'facebook' || channel === 'instagram') return 'send_meta';
  return 'send_email';
}
