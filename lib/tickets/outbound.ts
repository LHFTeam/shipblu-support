import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, messages } from '@/db/schema';
import { feedbackTemplateTag, metaWindowState } from '@/lib/meta/window';
import { enqueue } from '@/lib/queue';
import {
  isCommentTicket,
  isMetaChannel,
  isReadOnlyChannel,
  type ConversationChannel,
} from '@/lib/tickets/channel-policy';
import { firstAt } from '@/lib/tickets/latest';
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
 * `facebook_comment` and `instagram_comment` answer null, for the reason below.
 *
 * With one exception, which is Meta's own and is asked for by name:
 * Messenger's customer feedback card (`kind: 'feedback_template'`) carries a
 * tag of its own, `CUSTOMER_FEEDBACK`, valid on that card and nothing else,
 * up to seven days after the customer's last message (`feedbackTemplateTag`).
 * The survey is the only sender that writes one. On Instagram, which has no
 * such card, the kind changes nothing.
 *
 * **A Meta comment ticket has no messaging window and is never blocked here.**
 * It is answered by posting to the comment edge, which `send_meta` reaches
 * before it ever consults the clock, so blocking one on the customer's last
 * message would silently stop every automated reply on a public thread older
 * than a day — a reply that would have posted perfectly well. The ticket is
 * identified by `isCommentTicket`: its channel, or, the way the send path
 * identifies it, the root comment in its external id. Both, because comment
 * tickets carried the platform's channel until they were given their own, and
 * carry it again once the plan's rollback of Stage 1.2 has run; a CHECK makes
 * the two one answer until then (`isCommentTicket`).
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
  kind: 'message' | 'feedback_template' = 'message',
): string | null {
  if (ticket.channel === 'whatsapp') {
    return whatsappWindowState(ticket.lastCustomerMessageAt, now).isOpen
      ? null
      : 'the WhatsApp 24-hour window is closed and only an approved template would send';
  }

  if (isMetaChannel(ticket.channel)) {
    if (isCommentTicket(ticket.channel, ticket.externalId)) return null;

    const window = metaWindowState(ticket.lastCustomerMessageAt, now);
    // The literal, not the platform: Messenger's card is for a Facebook
    // conversation, and a `facebook_comment` ticket must never be offered it.
    // The return above already keeps comments out; this does not lean on it.
    if (kind === 'feedback_template' && ticket.channel === 'facebook') {
      return feedbackTemplateTag(window)
        ? null
        : "seven days have passed since the customer's last message, and past them " +
            'not even the feedback card sends';
    }

    return window.isOpen
      ? null
      : 'the 24-hour window is closed, and past it only HUMAN_AGENT sends — a tag ' +
          'reserved for a message a person wrote';
  }

  return null;
}

export type AutomatedReply = {
  conversationId: string;
  channel: ConversationChannel;
  /** The requester's address; used where the carrier is email and there is nowhere else to send. */
  requesterEmail: string | null;
  bodyText: string;
  /** Ignored on any channel `carrierFor` does not answer `send_email` for, which sends text. */
  bodyHtml: string | null;
  /** Shown on the timeline in place of an agent's name: `automation:Out of hours`. */
  actorLabel: string;
  eventType: string;
  eventData?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

/**
 * Anything that can run the writes: the pool, or a transaction a caller holds
 * open so the message commits with the row that explains it (the survey's).
 */
type Executor = Pick<typeof db, 'insert' | 'update'>;

export type AutomatedReplyOptions = {
  /**
   * Whether this message counts as the acknowledgement the rule engine looks
   * for (`firstAutoRepliedAt`). On for the two senders that acknowledge; off
   * for the survey, which is sent after the ticket is resolved and must not
   * make a "has been acknowledged" rule read a survey as the acknowledgement.
   */
  stampFirstAutoReply?: boolean;
};

/**
 * Writes the message, moves the thread and records the event, on the executor
 * it is given, and returns the new message's id. The carrier is queued apart
 * (`enqueueAutomatedDelivery`), on the same executor when the caller holds a
 * transaction, so the job commits with the message it carries.
 */
export async function writeAutomatedReply(
  on: Executor,
  reply: AutomatedReply,
  { stampFirstAutoReply = true }: AutomatedReplyOptions = {},
): Promise<string> {
  // Asked of the carrier rather than of the channel name, because `send_email`
  // is what carries `portal` and `api` as well as `email` — and it is the
  // carrier that decides whether an HTML part and a recipient are worth
  // storing. Testing `channel === 'email'` stored a portal reply with no
  // HTML body and no address, and the worker then rebuilt the body as one
  // escaped paragraph with every line break in a three-paragraph message lost.
  const job = carrierFor(reply.channel);
  const isEmail = job === 'send_email';
  // Web chat has no carrier: the message is in the database, and the widget's
  // stream is already reading from it. Marking it pending would leave every
  // chat reply showing as unsent forever.
  const isWebchat = reply.channel === 'webchat';

  const now = new Date();

  const inserted = await on
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

  await on
    .update(conversations)
    .set({
      lastMessageAt: now,
      // Set once rather than overwritten: this records that the customer has
      // been acknowledged at all, so the second automated reply on a ticket
      // must not move it and make a rule keyed off it fire again.
      //
      // Through `firstAt`, which binds the instant as a string behind
      // `::timestamptz`. The inline coalesce this replaced bound the `Date`
      // itself, which postgres.js refuses (AGENTS.md, Tests) — on every call,
      // after the message row above was written: on every carrier channel the
      // reply was left `pending` with no send job, never sent, and on web chat,
      // where the row is the delivery, the visitor saw it. Either way no event
      // was written, so a time-based rule wrote it again on its next sweep.
      // Unseen only because production had no rule that replies and the
      // out-of-hours reply switched off (§6.84).
      ...(stampFirstAutoReply
        ? { firstAutoRepliedAt: firstAt(conversations.firstAutoRepliedAt, now) }
        : {}),
    })
    .where(eq(conversations.id, reply.conversationId));

  await on.insert(conversationEvents).values({
    conversationId: reply.conversationId,
    type: reply.eventType,
    actorLabel: reply.actorLabel,
    data: { messageId, ...(reply.eventData ?? {}) },
  });

  return messageId;
}

/**
 * Queues the carrier for a message `writeAutomatedReply` wrote: on the pool
 * once it has committed, or on the transaction that wrote it (`on`), so the
 * two commit together. Nothing on web chat, where the row is the delivery.
 * Keyed on the message, which is once-ever for it, so a second call queues
 * nothing.
 */
export async function enqueueAutomatedDelivery(
  channel: ConversationChannel,
  messageId: string,
  priority = 20,
  on?: Executor,
): Promise<void> {
  if (channel === 'webchat') return;
  await enqueue(
    carrierFor(channel),
    { messageId },
    { priority, dedupeKey: `send:${messageId}`, on },
  );
}

/**
 * The two acknowledging senders' door: the write on the pool, then the
 * carrier at an acknowledgement's priority. The survey takes the two halves
 * itself, both inside its own transaction and at its own priority.
 */
export async function deliverAutomatedReply(reply: AutomatedReply): Promise<string> {
  const messageId = await writeAutomatedReply(db, reply);
  await enqueueAutomatedDelivery(reply.channel, messageId);
  return messageId;
}

/**
 * The job that carries a message on each channel.
 *
 * Every Meta channel goes to `send_meta` rather than falling into the email
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
 * Exhaustive over the enum, with no default arm. This used to send anything it
 * did not recognise to email, which is how a new channel would have mailed its
 * replies to contacts with no address; now a channel added to the enum does not
 * compile until somebody says what carries it. Web chat and the customer bot
 * keep the answer they always had, `send_email`, and neither is meant to be
 * carried by it. A web chat message is never queued, because its row is its
 * delivery: `enqueueAutomatedDelivery`, `storeAgentReply` and `sendsByEmail` set
 * web chat aside by name, and `writeAutomatedReply` names it only for the
 * delivery status, so an automated web chat message is stored with the
 * requester's address and whatever HTML its sender passed, as it always was.
 * The bot's conversations are not answered from the console, but nothing on
 * the `on_update` automation path refuses one, so a rule's `send_reply` there
 * would be queued here as an email — a gap older than this switch.
 */
export function carrierFor(
  channel: ConversationChannel,
): 'send_whatsapp' | 'send_meta' | 'send_email' {
  switch (channel) {
    case 'whatsapp':
      return 'send_whatsapp';
    case 'facebook':
    case 'facebook_comment':
    case 'instagram':
    case 'instagram_comment':
      return 'send_meta';
    case 'email':
    case 'portal':
    case 'api':
    // Neither is carried by it; the docstring says why they answer it anyway.
    case 'webchat':
    case 'whatsapp_bot':
      return 'send_email';
  }
}

/**
 * Whether a message on this channel is written as an email: with an HTML part
 * and the recipient's address on the row, for `send_email` to carry.
 *
 * Asked of the carrier for the reason `deliverAutomatedReply` gives: `portal`
 * rides `send_email` too, and a sender testing `channel === 'email'` wrote an
 * agent's portal reply and a portal CSAT survey with neither part. The worker
 * then fell back to the contact's address at send time and rebuilt the body
 * from plain text.
 *
 * `carrierFor` answers `send_email` for two kinds of channel that do not send
 * by email, so they are excluded by name rather than by carrier. Web chat has no
 * carrier at all — writing its row is its delivery. A read-only channel
 * (`whatsapp_bot`) is not answered from the console, and the acknowledgement
 * and the survey refuse it before they ask; the `on_update` automation path
 * does not (`carrierFor` says what follows).
 * Answering "email" for it would only be true by accident. `api` does go out by
 * email, and is written as email.
 */
export function sendsByEmail(channel: ConversationChannel): boolean {
  return (
    channel !== 'webchat' && !isReadOnlyChannel(channel) && carrierFor(channel) === 'send_email'
  );
}

/**
 * Whether an automated message on this ticket would be queued for an email
 * carrier with nowhere to send it.
 *
 * The CSAT survey and the out-of-hours acknowledgement both skip that case, and
 * both used to ask it as `channel === 'email' && !address` — so a portal ticket
 * whose contact has no primary address passed, was queued to `send_email`, and
 * failed "has no recipient" on every retry until the job died, leaving a
 * permanently failed message on the customer's timeline. One question, asked
 * one way, by every sender that needs it.
 */
export function lacksEmailRecipient(channel: ConversationChannel, address: string | null): boolean {
  return sendsByEmail(channel) && !address;
}
