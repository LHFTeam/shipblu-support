import { and, eq, exists } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { recordSkip, sendSurvey, unsentSurveyMessage } from '@/lib/csat';
import { decideSurvey, type SurveyTrigger } from '@/lib/csat/decision';
import { loadCsatSettings } from '@/lib/csat/settings';
import { rootCommentId } from '@/lib/meta/comments';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { newestCustomerWords, preferredLocale } from '@/lib/tickets/locale';
import { notReaction } from '@/lib/tickets/not-reaction';
import {
  automatedReplyBlocked,
  enqueueAutomatedDelivery,
  sendsByEmail,
} from '@/lib/tickets/outbound';
import type { ClaimedJob } from '@/lib/queue';
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
 * pool_), and two jobs for one ticket can run together. `sendSurvey` is where
 * that is settled: under a lock on the ticket, a second survey inside the
 * window is refused and nothing is written, and a run stopped after its rows
 * committed is finished by the next one queueing the carrier it never did.
 */

/** The survey's carrier priority: behind an acknowledgement, which a customer is waiting on. */
const PRIORITY = 50;

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
      contactLocale: contacts.locale,
      // Whether the customer sent anything at all — a reaction aside, which is
      // an acknowledgement of an answer rather than taking part.
      hasCustomerMessage: exists(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversations.id),
              eq(messages.direction, 'inbound'),
              eq(messages.kind, 'reply'),
              notReaction(),
            ),
          ),
      ),
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

  const decision = decideSurvey(
    {
      channel: ticket.channel,
      statusCategory: ticket.statusCategory,
      deletedAt: ticket.deletedAt,
      isSpam: ticket.isSpam,
      mergedIntoId: ticket.mergedIntoId,
      hasCustomerMessage: Boolean(ticket.hasCustomerMessage),
      suppressed: ticket.csatSuppressed,
      trigger,
      contactEmail: ticket.contactEmail,
      commentThread: rootCommentId(ticket.externalId) !== null,
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

  // The customer's own words, not `contacts.locale` alone, which nothing
  // writes: read off the column, every survey went out in English (§6). The
  // same two ingredients `requesterLocale()` combines, read here with the
  // contact's column already in hand.
  const locale = preferredLocale(
    ticket.contactLocale ?? 'en',
    await newestCustomerWords(conversationId),
  );

  const sent = await sendSurvey({
    conversationId,
    locale,
    delivery: decision.delivery,
    snapshot,
    resurveyAfterDays: settings.resurveyAfterDays,
    requesterEmail: ticket.contactEmail,
    body: (url) => ({
      text: TEXT[locale](ticket.number, url),
      html: decision.delivery === 'email_link' ? HTML[locale](ticket.number, url) : null,
    }),
  });

  if (!sent) {
    // Surveyed inside the window already, by an earlier run or by the other of
    // two jobs for one ticket. The one thing left to check is whether that run
    // got as far as queueing the carrier.
    const unsent = await unsentSurveyMessage(conversationId);
    if (unsent) {
      await enqueueAutomatedDelivery(ticket.channel, unsent, PRIORITY);
      log.info(`#${ticket.number}: queued the carrier for a survey a stopped run left behind`);
    } else {
      log.info(`#${ticket.number}: surveyed inside the window already — nothing to do`);
    }
    return;
  }

  await enqueueAutomatedDelivery(ticket.channel, sent.messageId, PRIORITY);

  log.info(`surveyed #${ticket.number} on ${ticket.channel} in ${locale}`);
}
