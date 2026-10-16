import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { attachMessage, recentlySurveyed, recordSent, recordSkip } from '@/lib/csat';
import { decideSurvey, type SurveyTrigger } from '@/lib/csat/decision';
import { loadCsatSettings } from '@/lib/csat/settings';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { newestCustomerWords, requesterLocale } from '@/lib/tickets/locale';
import { automatedReplyBlocked, carrierFor, sendsByEmail } from '@/lib/tickets/outbound';
import { enqueue, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

const log = logger('send_csat');

/**
 * Sends one satisfaction survey, a while after a ticket was resolved.
 *
 * Enqueued per ticket rather than swept: the trigger is a specific event with a
 * specific delay, and a queued job with a `runAt` says that directly.
 *
 * Everything it checks is read here rather than at enqueue time, because the
 * delay is long enough for all of it to have changed — and every outcome is a
 * row (`lib/csat`), so "why was this customer not asked?" is answered on the
 * ticket rather than in this log. The decision itself is `decideSurvey`, pure
 * and tested; this reads what it needs and writes what it decided.
 *
 * The job runs at least once, not exactly once (AGENTS.md, _The worker is a
 * pool_): a second run finds `recentlySurveyed` true and records that, and two
 * runs racing meet `csat_surveys_open_idx`.
 */

const TEXT = {
  en: (number: number, url: string) =>
    `How did we do with ticket #${number}? It takes ten seconds to tell us: ${url}`,
  ar: (number: number, url: string) =>
    `كيف كان تعاملنا مع طلبك رقم ${number}؟ رأيك يستغرق عشر ثوانٍ فقط: ${url}`,
};

const HTML = {
  en: (number: number, url: string) =>
    `<p>How did we do with ticket #${number}?</p><p><a href="${url}">Rate our support</a> — it takes ten seconds.</p>`,
  ar: (number: number, url: string) =>
    `<p>كيف كان تعاملنا مع طلبك رقم ${number}؟</p><p><a href="${url}">قيّم خدمتنا</a> — الأمر يستغرق عشر ثوانٍ.</p>`,
};

export async function sendCsat(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'send_csat');
  const { conversationId } = payload;
  // Rows queued before the trigger existed were an agent's resolve.
  const trigger: SurveyTrigger = payload.trigger ?? 'agent';

  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      channel: conversations.channel,
      isSpam: conversations.isSpam,
      deletedAt: conversations.deletedAt,
      mergedIntoId: conversations.mergedIntoId,
      csatSuppressed: conversations.csatSuppressed,
      assigneeAgentId: conversations.assigneeAgentId,
      groupId: conversations.groupId,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      // Read by `automatedReplyBlocked`, to tell a comment ticket from a DM.
      externalId: conversations.externalId,
      statusCategory: ticketStatuses.category,
      contactEmail: contacts.primaryEmail,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const ticket = rows[0];
  if (!ticket) return;

  const settings = await loadCsatSettings();
  const isMeta = ticket.channel === 'facebook' || ticket.channel === 'instagram';

  const [words, surveyed] = await Promise.all([
    newestCustomerWords(conversationId),
    recentlySurveyed(conversationId, settings.resurveyAfterDays),
  ]);

  const decision = decideSurvey(
    {
      channel: ticket.channel,
      statusCategory: ticket.statusCategory,
      deletedAt: ticket.deletedAt,
      isSpam: ticket.isSpam,
      mergedIntoId: ticket.mergedIntoId,
      hasCustomerWords: words !== null,
      suppressed: ticket.csatSuppressed,
      trigger,
      recentlySurveyed: surveyed,
      contactEmail: ticket.contactEmail,
      // The third automated sender, through the same guard as the other two:
      // past 24 hours only `HUMAN_AGENT` sends on these platforms, and that tag
      // is reserved for a message a person wrote.
      metaWindowOpen: isMeta ? automatedReplyBlocked(ticket) === null : false,
      readOnly: isReadOnlyChannel(ticket.channel),
      byEmail: sendsByEmail(ticket.channel),
    },
    settings,
  );

  const snapshot = {
    agentId: ticket.assigneeAgentId,
    groupId: ticket.groupId,
    channel: ticket.channel,
  };

  if (decision.kind === 'drop') return;

  if (decision.kind === 'skip') {
    await recordSkip(conversationId, decision.reason, snapshot);
    log.info(`#${ticket.number}: no survey — ${decision.reason}`);
    return;
  }

  // The customer's own words, not `contacts.locale`, which nothing writes:
  // read off the column, every survey went out in English (§6).
  const locale = await requesterLocale(conversationId);
  const survey = await recordSent(conversationId, locale, decision.delivery, snapshot);

  const isEmail = decision.delivery === 'email_link';
  const isWebchat = ticket.channel === 'webchat';

  const inserted = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'outbound',
      kind: 'reply',
      bodyText: TEXT[locale](ticket.number, survey.url),
      bodyHtml: isEmail ? HTML[locale](ticket.number, survey.url) : null,
      toAddresses: isEmail && ticket.contactEmail ? [ticket.contactEmail] : [],
      // Web chat has no carrier: the row is the delivery, and the widget's
      // stream is already reading from it.
      deliveryStatus: isWebchat ? 'delivered' : 'pending',
      ...(isWebchat ? { deliveredAt: new Date() } : {}),
      meta: { csatSurveyId: survey.id },
    })
    .returning({ id: messages.id });

  const messageId = inserted[0]!.id;

  // Deliberately not touching `lastAgentMessageAt`: a survey is not a reply to
  // the customer, and counting it as one would flatter every response-time
  // report by half an hour.
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date() })
    .where(eq(conversations.id, conversationId));

  await attachMessage(
    { id: survey.id, conversationId, delivery: decision.delivery, locale },
    messageId,
  );

  if (!isWebchat) {
    // `carrierFor` rather than a second copy of the channel-to-job mapping: the
    // copy here once read `whatsapp ? send_whatsapp : send_email`, so a survey
    // on a Facebook ticket was queued as an email to a contact with no address.
    await enqueue(
      carrierFor(ticket.channel),
      { messageId },
      { priority: 50, dedupeKey: `send:${messageId}` },
    );
  }

  log.info(`surveyed #${ticket.number} on ${ticket.channel} in ${locale}`);
}
