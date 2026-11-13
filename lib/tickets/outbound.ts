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
 *   whatsapp_bot         always. Its conversations are the customer bot's, and
 *                        nobody on the team writes to them (`isReadOnlyChannel`):
 *                        a message there lands in front of a customer part-way
 *                        through the bot's flow, and `carrierFor` would queue it
 *                        as an email besides. The out-of-hours acknowledgement
 *                        and the survey turned the bot away themselves, but the
 *                        automation engine asked only this, so an `on_update`
 *                        rule's `send_reply` fired by an edit on a bot ticket
 *                        was written and queued. `writeAutomatedReply` refuses
 *                        it too, for a sender that refuses it nowhere.
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
  // Named by the ticket's own channel rather than by the bot, so a second
  // read-only channel cannot inherit a sentence about the first.
  if (isReadOnlyChannel(ticket.channel)) {
    return `the ${ticket.channel} channel is read-only, and nobody on the team writes to its conversations`;
  }

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
  /** The requester's address; stored only where the message goes out by email (`sendsByEmail`). */
  requesterEmail: string | null;
  bodyText: string;
  /** Ignored on any channel that does not send by email (`sendsByEmail`), which sends text. */
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
 *
 * It throws on a read-only channel (`whatsapp_bot`) before the row exists. Every
 * automated sender writes through here, and each turns the bot away first, in
 * its own way:
 *
 *   the acknowledgement  its own `isReadOnlyChannel` check, before it asks the
 *                        guard, and without a word;
 *   the engine           `automatedReplyBlocked`, with a warning in the log;
 *   the survey           `decideSurvey`, recorded as a `read_only_channel` skip,
 *                        since it asks the guard only on Meta's channels;
 *   the thanks           answering only a tap whose platform is the ticket's
 *                        channel, and then the guard.
 *
 * So this is the one refusal no sender can skip. Reaching it is a sender that
 * did not refuse, and a throw says so where a skip would leave nothing to find.
 */
export async function writeAutomatedReply(
  on: Executor,
  reply: AutomatedReply,
  { stampFirstAutoReply = true }: AutomatedReplyOptions = {},
): Promise<string> {
  if (isReadOnlyChannel(reply.channel)) {
    throw new Error(
      `automated reply refused on ${reply.channel} conversation ${reply.conversationId}: ` +
        'nobody on the team writes there, and its sender should have refused it first',
    );
  }

  // Asked of `sendsByEmail`, which an agent's reply asks too, rather than of
  // the channel name or of the carrier alone. `send_email` carries `portal` as
  // well as `email`, and testing `channel === 'email'` stored a portal reply
  // with no HTML body and no address, which the worker then rebuilt as one
  // escaped paragraph with every line break in a three-paragraph message lost.
  // But `carrierFor` also answers `send_email` for web chat and the myBlu app,
  // which nothing carries: asked of the carrier, an automated message there
  // was stored with an HTML part and the contact's address — on the app, an
  // address that can be a previous holder of the phone's.
  const isEmail = sendsByEmail(reply.channel);
  // No carrier: the message is in the database, where the customer's client —
  // the widget's stream, the app's poll — reads it. Marking it pending would
  // leave every such reply showing as unsent forever.
  const delivered = rowIsDelivery(reply.channel);

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
      deliveryStatus: delivered ? 'delivered' : 'pending',
      ...(delivered ? { deliveredAt: now } : {}),
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
 * two commit together. Nothing where the row is the delivery
 * (`rowIsDelivery`). Keyed on the message, which is once-ever for it, so a
 * second call queues nothing.
 */
export async function enqueueAutomatedDelivery(
  channel: ConversationChannel,
  messageId: string,
  priority = 20,
  on?: Executor,
): Promise<void> {
  if (rowIsDelivery(channel)) return;
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
 * compile until somebody says what carries it. Web chat, the myBlu app (`api`)
 * and the customer bot answer `send_email` because the return type has no
 * answer meaning "nothing carries it", and none of the three is carried by it.
 * A web chat or myBlu message is never queued, because its row is its
 * delivery: every sender asks `rowIsDelivery` before it queues and for the
 * status it writes, and `sendsByEmail` — which decides whether an HTML part and
 * an address are stored — sets both aside. Until `api` was set aside with web
 * chat, an agent's reply to a myBlu ticket was queued here as an email: never
 * sent to a contact with no address, and mailed to one with an address about a
 * conversation they had in the app.
 * The bot's conversations are answered by nobody: the console offers no reply
 * there, every automated sender turns the bot away before it writes, and
 * `writeAutomatedReply` throws for one that did not (its docstring says who
 * refuses where). So `whatsapp_bot` never reaches this. Until the guard refused
 * it, an `on_update` rule's `send_reply` on a bot ticket was queued here as an
 * email.
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
    // None of the three is carried by it; the docstring says why they answer it
    // anyway.
    case 'webchat':
    case 'api':
    case 'whatsapp_bot':
      return 'send_email';
  }
}

/**
 * Whether a message on this channel is written as an email: with an HTML part
 * and the recipient's address on the row, for `send_email` to carry.
 *
 * Asked of the carrier for the reason `writeAutomatedReply` gives: `portal`
 * rides `send_email` too, and a sender testing `channel === 'email'` wrote an
 * agent's portal reply and a portal CSAT survey with neither part. The worker
 * then fell back to the contact's address at send time and rebuilt the body
 * from plain text.
 *
 * `carrierFor` answers `send_email` for two kinds of channel that do not send
 * by email, so they are excluded by what they are rather than by carrier. Web
 * chat and the myBlu app have no carrier at all: writing the row is the
 * delivery (`rowIsDelivery`). An HTML part stored there would be what the
 * console draws in place of the text the customer's client shows, and an
 * address would name somebody the message never went to. A read-only channel
 * (`whatsapp_bot`) is answered by nobody: the console offers no reply there,
 * and every automated sender is refused it before the row exists
 * (`writeAutomatedReply` says by what). Answering "email" for either would only
 * be true by accident.
 */
export function sendsByEmail(channel: ConversationChannel): boolean {
  return (
    !rowIsDelivery(channel) && !isReadOnlyChannel(channel) && carrierFor(channel) === 'send_email'
  );
}

/**
 * Channels where storing the message is delivering it, because the customer's
 * own client reads the conversation from this database: the web chat widget,
 * through its stream, and the myBlu app (`api`), through its poll of `/api/v1`.
 */
const ROW_IS_DELIVERY: readonly ConversationChannel[] = ['webchat', 'api'];

/**
 * Whether writing a message's row is its delivery: no carrier is queued, the
 * row is written `delivered` — meaning "stored where the customer's client
 * reads it", not that a provider accepted it — and, through `sendsByEmail`, no
 * HTML part or address is stored on it.
 *
 * One predicate where web chat used to be named at each place it was set
 * aside: the status and the queueing for an automated message
 * (`writeAutomatedReply`, `enqueueAutomatedDelivery`), the queueing and the
 * status for an agent's (`storeAgentReply`, `sendReply`), and `sendsByEmail`.
 * The myBlu app joined web chat at all five at once; a test naming web chat at
 * one of them is how the next such channel would be queued as an email at that
 * one alone.
 *
 * A named list, as the read-only channels are: a channel added to the enum
 * answers false until somebody puts it here, so its messages are queued on the
 * carrier `carrierFor` names for it and fail where somebody looks, rather than
 * being stored as delivered with nothing sending them.
 */
export function rowIsDelivery(channel: ConversationChannel): boolean {
  return ROW_IS_DELIVERY.includes(channel);
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
