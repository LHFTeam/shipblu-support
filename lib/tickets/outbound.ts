import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, messages } from '@/db/schema';
import { enqueue } from '@/lib/queue';

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

export type AutomatedReply = {
  conversationId: string;
  channel: string;
  /** The requester's address; used where the carrier is email and there is nowhere else to send. */
  requesterEmail: string | null;
  bodyText: string;
  /** Ignored on any channel that does not send by email, which sends text. */
  bodyHtml: string | null;
  /** Shown on the timeline in place of an agent's name: `automation:Out of hours`. */
  actorLabel: string;
  eventType: string;
  eventData?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

/** The new message's id, for the caller's log and follow-up writes. */
export async function deliverAutomatedReply(reply: AutomatedReply): Promise<string> {
  // Asked of the carrier rather than of the channel name, because `send_email`
  // is what carries `portal` and anything unrecognised as well as `email` — and
  // it is the carrier that decides whether an HTML part and a recipient are
  // worth storing. Testing `channel === 'email'` stored a portal reply with no
  // HTML body and no address, and the worker then rebuilt the body as one
  // escaped paragraph with every line break in a three-paragraph message lost.
  const job = carrier(reply.channel);
  const isEmail = job === 'send_email';
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
    await enqueue(job, { messageId }, { priority: 20, dedupeKey: `send:${messageId}` });
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
