import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { autoResponses, contacts, conversations, messages } from '@/db/schema';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { groupHours } from '@/lib/hours/resolve';
import { holidayName, holidayOn, isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { textToHtml } from '@/lib/html/sanitize';
import { commentIdOf } from '@/lib/meta/comments';
import {
  isCommentTicket,
  isReadOnlyChannel,
  type ConversationChannel,
} from '@/lib/tickets/channel-policy';
import {
  automatedReplyBlocked,
  deliverAutomatedReply,
  lacksEmailRecipient,
} from '@/lib/tickets/outbound';
import { requesterLocale } from '@/lib/tickets/locale';
import { answersRequester, pickBody, pickRule, substitute, type AutoResponseRule } from './resolve';
import { logger } from '@/lib/log';

const log = logger('auto-response');

/**
 * "Thanks — we are closed, and we will reply when we open."
 *
 * The one thing the helpdesk says on its own initiative, and the reason it is
 * worth being careful with: it goes to a real customer, unreviewed, at an hour
 * when nobody will notice it going wrong until the morning.
 *
 * Three decisions are made elsewhere on purpose. **Whether the office is open**
 * is the group's calendar in `lib/hours`, the same one every SLA due date is
 * counted against. **Which message** is `./resolve`, which is pure and tested.
 * **How it reaches the customer** is `lib/tickets/outbound`, shared with the
 * automation engine's canned reply. What is left here is the part that has to
 * touch the database: the guards, and the claim that makes "once" mean once.
 */

/** What the send needs to know about the ticket, in one query. */
type Ticket = {
  id: string;
  number: number;
  channel: ConversationChannel;
  groupId: string | null;
  isSpam: boolean;
  deletedAt: Date | null;
  lastCustomerMessageAt: Date | null;
  externalId: string | null;
  requesterContactId: string;
  autoRespondedAt: Date | null;
  contactEmail: string | null;
  contactName: string | null;
};

/**
 * Send the out-of-hours acknowledgement for a customer's message, if one applies.
 *
 * Called from the ticket lifecycle for every inbound customer message on every
 * channel, with the message that was just stored. Best-effort, like the other
 * lifecycle hooks: this runs inside ingest jobs, and throwing here would fail
 * the job and have the retry re-run every engine that already succeeded —
 * including sending this reply again.
 *
 * `at` is the moment the reply goes out, and defaults to it. Deliberately not
 * the timestamp on the customer's message, which is when that message reached
 * us: hours before now for a delivery processed late or replayed, which is the
 * case an acknowledgement most needs to get right. Everything below — whether
 * the office is shut, what `{{next_opening}}` resolves to, when the claim says
 * we last answered — is a statement about now.
 */
export async function maybeSendAutoResponse(
  trigger: { conversationId: string; messageId: string },
  at: Date = new Date(),
): Promise<void> {
  try {
    await send(trigger, at);
  } catch (error) {
    log.error(`failed on conversation ${trigger.conversationId}`, error);
  }
}

async function send(
  { conversationId, messageId }: { conversationId: string; messageId: string },
  at: Date,
): Promise<void> {
  // The rules first, and on their own, because the overwhelmingly common answer
  // is "none configured" and that costs one indexed query on a table with a
  // handful of rows. Everything below it — the calendar, the message that set
  // this off — would be work done to reach the same conclusion.
  const [rules, ticket] = await Promise.all([activeRules(), loadTicket(conversationId)]);
  if (rules.length === 0 || !ticket) return;

  if (ticket.deletedAt || ticket.isSpam) return;

  // A conversation the team never had. The bot answers these itself, from a
  // number whose replies we do not receive.
  if (isReadOnlyChannel(ticket.channel)) return;

  const rule = pickRule(rules, {
    groupId: ticket.groupId,
    channel: ticket.channel,
    externalId: ticket.externalId,
  });
  if (!rule || rule.silent) return;

  const hours = groupHours(await loadHoursCatalog(), ticket.groupId);
  // No schedule at all means no hours are "out" of anything. A deployment that
  // has not set up business hours gets silence rather than an acknowledgement on
  // every ticket at every hour of the day.
  if (!hours) return;
  if (isWithinBusinessHours(hours, at)) return;

  // An out-of-office answering our acknowledgement, which answers it back, is
  // the loop RFC 3834 exists to prevent — and a bounce is a machine that cannot
  // read the reply anyway. The classification was made at ingest, by the parser
  // that had the headers, and is on the message.
  const inbound = await triggeringMessage(conversationId, messageId);
  if (inbound?.isAutomated) return;

  // Before the claim, so a passer-by's comment on the requester's thread does
  // not spend the closed stretch either (`answersRequester`). Asked of the
  // comment that set this off rather than of the newest one, so the requester's
  // comment is answered even when it is stored after a passer-by's newer reply.
  const isComment = isCommentTicket(ticket.channel, ticket.externalId);
  if (
    !answersRequester({
      isComment,
      requesterContactId: ticket.requesterContactId,
      authorContactId: inbound?.authorContactId ?? null,
    })
  ) {
    return;
  }

  // WhatsApp, Facebook and Instagram all need the 24-hour window open for a
  // message the software wrote. The customer's message is what opened it, so
  // this only fires on a replay of something old — where sending would fail at
  // Meta and leave a permanently failed message on the customer's timeline.
  //
  // Measured against the real clock, not against `at`. `at` is the inbound
  // message's own `sentAt`, handed down by `afterInboundMessage`, and ingest
  // has just written that same instant to `lastCustomerMessageAt` — so passing
  // it here would compare the value with itself, report every window open and
  // silently disable the guard on exactly the replayed backlog it is for.
  if (automatedReplyBlocked(ticket)) return;

  // Asked of the carrier, as the CSAT survey asks it: a portal ticket is
  // acknowledged by email too, and with no address it would be queued to fail.
  if (lacksEmailRecipient(ticket.channel, ticket.contactEmail)) return;

  // Already acknowledged, and the office has not opened since. One message per
  // closed stretch, however many times the customer writes into it — the office
  // reopening is what makes the next one worth sending.
  if (ticket.autoRespondedAt && !hasOpenedSince(hours, ticket.autoRespondedAt, at)) return;

  const holiday = holidayOn(hours, at);

  const context = {
    // Asked of `lib/tickets/locale`, not read off `inbound` above. That one
    // message can carry none of the customer's words — a photo sent without a
    // caption is stored as our own English `[image]` — and the language is a
    // question about the newest words the requester wrote, which the shared
    // module answers for every unattended sender alike. It costs one indexed
    // query, on a path that sends at most one message per closed stretch.
    locale: await requesterLocale(conversationId),
    holiday,
    ticketNumber: ticket.number,
    // Never published under a post. The contact's name can have come from
    // another channel — a merge with the customer's email contact, an agent's
    // edit — and the commenter may never have used it in public; a greeting
    // without one closes its gap (`substitute`).
    customerName: isComment ? null : ticket.contactName,
  };

  const body = pickBody(rule, context);
  if (!body) return;

  const text = substitute(body, hours, context, at);
  if (!text) return;

  // Claimed before it is sent, and only sent if the claim took. Six messages at
  // 23:00 are six ingest jobs the worker runs in parallel, and every guard above
  // would pass in all six: the write is what serialises them.
  if (!(await claim(ticket, at))) return;

  await deliverAutomatedReply({
    conversationId: ticket.id,
    channel: ticket.channel,
    requesterEmail: ticket.contactEmail,
    bodyText: text,
    bodyHtml: textToHtml(text),
    actorLabel: 'automation:out of hours',
    eventType: 'auto_replied',
    eventData: { reason: holiday ? 'holiday' : 'out_of_hours', ruleId: rule.id },
    // Posted under the customer's comment on a comment ticket, and badged as
    // public on the timeline the way an agent's comment reply is. The comment
    // is the one `answersRequester` passed, named here because `send_meta`
    // would otherwise look up the newest comment when the job runs — which, if
    // a passer-by has replied since, is theirs.
    meta: {
      autoResponse: holiday ? 'holiday' : 'out_of_hours',
      ...(isComment ? { isPublic: true } : {}),
      ...(isComment && inbound?.commentId ? { commentId: inbound.commentId } : {}),
    },
  });

  // English first in the log line — the audience is whoever is reading Render's
  // logs, not the customer — falling back to the Arabic name when that is the
  // only one the calendar carries.
  // The rule's channel where it names one: a comment still filed on its
  // platform was matched as its comment channel, and is logged as one.
  log.info(
    `acknowledged #${ticket.number} on ${rule.channel ?? ticket.channel}` +
      `${holiday ? ` (${holidayName(holiday, 'en') ?? 'holiday'})` : ''}`,
  );
}

/**
 * Has the office opened at all between the last acknowledgement and now?
 *
 * Asked of the calendar rather than of a cooldown in minutes, because the answer
 * has to be right across a weekend and across Eid: a fixed window either sends a
 * second message into the same quiet evening or stays silent into the following
 * afternoon. `nextOpeningAt` scans forward from the last one; if the opening it
 * finds is still ahead of us, nothing has opened in between.
 */
function hasOpenedSince(
  hours: Parameters<typeof nextOpeningAt>[0],
  since: Date,
  at: Date,
): boolean {
  // A long enough lookahead to cross the longest shutdown a schedule can
  // express: without it a ticket last acknowledged before a two-week closure
  // would look like one nothing had opened after, forever.
  const opening = nextOpeningAt(hours, since, 366);
  return opening !== null && opening.getTime() <= at.getTime();
}

/**
 * Take the right to send, conditional on the row still holding what we read.
 *
 * Optimistic rather than a lock: if another ingest job acknowledged this ticket
 * between the read above and this write, its timestamp is no longer the one we
 * saw, no row matches, and this returns false. A lock would serialise the whole
 * ingest path to save a query.
 */
async function claim(ticket: Ticket, at: Date): Promise<boolean> {
  const previous = ticket.autoRespondedAt;

  const claimed = await db
    .update(conversations)
    .set({ autoRespondedAt: at })
    .where(
      and(
        eq(conversations.id, ticket.id),
        previous
          ? eq(conversations.autoRespondedAt, previous)
          : isNull(conversations.autoRespondedAt),
      ),
    )
    .returning({ id: conversations.id });

  return claimed.length > 0;
}

async function activeRules(): Promise<AutoResponseRule[]> {
  return db
    .select({
      id: autoResponses.id,
      groupId: autoResponses.groupId,
      channel: autoResponses.channel,
      bodyAr: autoResponses.bodyAr,
      bodyEn: autoResponses.bodyEn,
      holidayBodyAr: autoResponses.holidayBodyAr,
      holidayBodyEn: autoResponses.holidayBodyEn,
      silent: autoResponses.silent,
    })
    .from(autoResponses)
    .where(eq(autoResponses.isActive, true));
}

async function loadTicket(conversationId: string): Promise<Ticket | null> {
  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      channel: conversations.channel,
      groupId: conversations.groupId,
      isSpam: conversations.isSpam,
      deletedAt: conversations.deletedAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      // Only to tell a comment ticket from a direct message: the rule picker
      // and the 24-hour guard both read it.
      externalId: conversations.externalId,
      // Whose comment it was matters on a comment ticket (`answersRequester`).
      requesterContactId: conversations.requesterContactId,
      autoRespondedAt: conversations.autoRespondedAt,
      contactEmail: contacts.primaryEmail,
      contactName: contacts.name,
    })
    .from(conversations)
    // No join to `ticket_statuses`: every ingest path reopens a resolved ticket
    // before this runs (see `reopen` in lib/tickets/ingest-meta.ts and its two
    // siblings), so there is no resolved ticket here to guard against — and a
    // join that filters nothing and selects nothing is a cost on every inbound
    // message.
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return row;
}

/**
 * The message that triggered this, for the automation classification the email
 * parser recorded on it, for who wrote it and, on a comment thread, for the
 * comment the reply goes under.
 *
 * By id, never as the newest inbound row: deliveries are processed in no order,
 * so the newest is another message whenever this one was stored late — a Meta
 * batch retried whole, or a webhook delivered late — and on a comment thread
 * that is a passer-by's reply as often as the requester's own. The verdict is
 * still read back off the row rather than passed down through the lifecycle:
 * only one ingest path has an RFC 3834 verdict to hand, and every one of them
 * has the id.
 */
async function triggeringMessage(
  conversationId: string,
  messageId: string,
): Promise<{
  isAutomated: boolean;
  authorContactId: string | null;
  commentId: string | null;
} | null> {
  const rows = await db
    .select({
      meta: messages.meta,
      authorContactId: messages.authorContactId,
      channelMessageId: messages.channelMessageId,
    })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const meta = row.meta ?? {};

  return {
    isAutomated: meta.isAutomated === true || meta.isBounce === true,
    authorContactId: row.authorContactId,
    commentId: commentIdOf(meta, row.channelMessageId),
  };
}
