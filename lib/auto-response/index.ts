import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { autoResponses, contacts, conversations, messages } from '@/db/schema';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { groupHours } from '@/lib/hours/resolve';
import { holidayName, holidayOn, isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { textToHtml } from '@/lib/html/sanitize';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { automatedReplyBlocked, deliverAutomatedReply } from '@/lib/tickets/outbound';
import { requesterLocale } from '@/lib/tickets/locale';
import { pickBody, pickRule, substitute, type AutoResponseRule } from './resolve';

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
  channel: string;
  groupId: string | null;
  isSpam: boolean;
  deletedAt: Date | null;
  lastCustomerMessageAt: Date | null;
  externalId: string | null;
  autoRespondedAt: Date | null;
  contactEmail: string | null;
  contactName: string | null;
};

/**
 * Send the out-of-hours acknowledgement for a customer's message, if one applies.
 *
 * Called from the ticket lifecycle for every inbound customer message on every
 * channel. Best-effort, like the other lifecycle hooks: this runs inside ingest
 * jobs, and throwing here would fail the job and have the retry re-run every
 * engine that already succeeded — including sending this reply again.
 *
 * `at` is the moment the reply goes out, and defaults to it. Deliberately not
 * the timestamp on the customer's message: that one is the sender's own `Date:`
 * header on email, and everything below — whether the office is shut, what
 * `{{next_opening}}` resolves to, when the claim says we last answered — is a
 * statement about now that a wrong clock would make wrong in both directions.
 */
export async function maybeSendAutoResponse(
  conversationId: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    await send(conversationId, at);
  } catch (error) {
    console.error(`[auto-response] failed on conversation ${conversationId}`, error);
  }
}

async function send(conversationId: string, at: Date): Promise<void> {
  // The rules first, and on their own, because the overwhelmingly common answer
  // is "none configured" and that costs one indexed query on a table with a
  // handful of rows. Everything below it — the calendar, the last inbound
  // message — would be work done to reach the same conclusion.
  const [rules, ticket] = await Promise.all([activeRules(), loadTicket(conversationId)]);
  if (rules.length === 0 || !ticket) return;

  if (ticket.deletedAt || ticket.isSpam) return;

  // A conversation the team never had. The bot answers these itself, from a
  // number whose replies we do not receive.
  if (isReadOnlyChannel(ticket.channel)) return;

  const rule = pickRule(rules, { groupId: ticket.groupId, channel: ticket.channel });
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
  const inbound = await lastInboundMessage(conversationId);
  if (inbound?.isAutomated) return;

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

  if (ticket.channel === 'email' && !ticket.contactEmail) return;

  // Already acknowledged, and the office has not opened since. One message per
  // closed stretch, however many times the customer writes into it — the office
  // reopening is what makes the next one worth sending.
  if (ticket.autoRespondedAt && !hasOpenedSince(hours, ticket.autoRespondedAt, at)) return;

  const holiday = holidayOn(hours, at);

  const context = {
    // Asked of `lib/tickets/locale`, not read off `inbound` above. That message
    // is the last inbound row of any kind — including the English `system`
    // notice we write when a form attachment fails — and answering an Arabic
    // customer in English because of our own notice is exactly the divergence
    // the shared module exists to close. It costs one indexed query, on a path
    // that sends at most one message per closed stretch.
    locale: await requesterLocale(conversationId),
    holiday,
    ticketNumber: ticket.number,
    customerName: ticket.contactName,
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
    meta: { autoResponse: holiday ? 'holiday' : 'out_of_hours' },
  });

  // English first in the log line — the audience is whoever is reading Render's
  // logs, not the customer — falling back to the Arabic name when that is the
  // only one the calendar carries.
  console.log(
    `[auto-response] acknowledged #${ticket.number} on ${ticket.channel}` +
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
      // Only to tell a comment ticket from a direct message; the guard reads it.
      externalId: conversations.externalId,
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
 * parser recorded on it.
 *
 * Read back rather than passed down through the lifecycle: three ingest paths
 * call that seam and only one of them has an RFC 3834 verdict to hand, so an
 * argument would be a parameter two callers pass null for — and the one that
 * matters would be the one somebody forgot to wire up.
 */
async function lastInboundMessage(
  conversationId: string,
): Promise<{ isAutomated: boolean } | null> {
  const rows = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound')))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const meta = row.meta ?? {};

  return { isAutomated: meta.isAutomated === true || meta.isBounce === true };
}
