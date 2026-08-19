import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { createSurvey, recentlySurveyed } from '@/lib/csat';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { enqueue, type ClaimedJob } from '@/lib/queue';
import { windowState } from '@/lib/whatsapp/window';

/**
 * Sends one satisfaction survey, half an hour after a ticket was resolved.
 *
 * Enqueued per ticket rather than swept: the trigger is a specific event with a
 * specific delay, and a queued job with a `runAt` says that directly.
 *
 * Everything it checks is re-checked here rather than at enqueue time, because
 * half an hour is long enough for all of it to have changed.
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
  const conversationId = (job.payload as { conversationId?: string }).conversationId;
  if (!conversationId) {
    console.warn('[send_csat] job had no conversationId');
    return;
  }

  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      channel: conversations.channel,
      isSpam: conversations.isSpam,
      deletedAt: conversations.deletedAt,
      assigneeAgentId: conversations.assigneeAgentId,
      groupId: conversations.groupId,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      statusCategory: ticketStatuses.category,
      contactEmail: contacts.primaryEmail,
      contactLocale: contacts.locale,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const ticket = rows[0];
  if (!ticket) return;

  // The customer came back and reopened it in the last half hour: they want an
  // answer, not a survey. The next resolution will schedule a new one.
  if (ticket.statusCategory !== 'resolved' && ticket.statusCategory !== 'closed') {
    console.log(`[send_csat] #${ticket.number} is open again — no survey`);
    return;
  }

  if (ticket.deletedAt || ticket.isSpam) return;

  // A read-only channel is a record of a conversation the team never had. Asking
  // the customer to rate our support on the strength of it would be asking about
  // someone else's work — and the survey would go out from a number they have
  // not been talking to.
  if (isReadOnlyChannel(ticket.channel)) {
    console.log(`[send_csat] #${ticket.number} is on a read-only channel — no survey`);
    return;
  }

  if (await recentlySurveyed(conversationId)) {
    console.log(`[send_csat] #${ticket.number} was surveyed recently — skipping`);
    return;
  }

  const isEmail = ticket.channel === 'email';
  const isWebchat = ticket.channel === 'webchat';

  if (isEmail && !ticket.contactEmail) {
    console.log(`[send_csat] #${ticket.number} has no email address to survey`);
    return;
  }

  // Outside the 24-hour window only an approved template can reach a WhatsApp
  // customer, and a survey is not worth spending a template on.
  if (ticket.channel === 'whatsapp' && !windowState(ticket.lastCustomerMessageAt).isOpen) {
    console.log(`[send_csat] #${ticket.number}: WhatsApp window closed — no survey`);
    return;
  }

  const locale = ticket.contactLocale === 'ar' ? 'ar' : 'en';
  const survey = await createSurvey(conversationId, locale, {
    agentId: ticket.assigneeAgentId,
    groupId: ticket.groupId,
  });

  const inserted = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'outbound',
      kind: 'reply',
      bodyText: TEXT[locale](ticket.number, survey.url),
      bodyHtml: isEmail ? HTML[locale](ticket.number, survey.url) : null,
      toAddresses: isEmail && ticket.contactEmail ? [ticket.contactEmail] : [],
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

  if (!isWebchat) {
    await enqueue(
      ticket.channel === 'whatsapp' ? 'send_whatsapp' : 'send_email',
      { messageId },
      { priority: 50, dedupeKey: `send:${messageId}` },
    );
  }

  console.log(`[send_csat] surveyed #${ticket.number} on ${ticket.channel}`);
}
