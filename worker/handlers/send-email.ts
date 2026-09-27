import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, contacts, conversations, messages } from '@/db/schema';
import { env, replyDomain } from '@/lib/env';
import { emailProvider } from '@/lib/email/providers';
import { REPLY_ABOVE_MARKER } from '@/lib/email/quote-strip';
import { textToHtml } from '@/lib/html/sanitize';
import { replyToAddress } from '@/lib/email/reply-address';
import { buildReferences, buildReplySubject, formatMessageId } from '@/lib/email/threading';
import type { OutboundEmail } from '@/lib/email/types';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { alreadySent } from './already-sent';
import { subjectGone } from './subject-gone';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

const log = logger('send_email');

/**
 * Sends an agent's reply.
 *
 * The message row is written first by the console (so the agent sees it
 * immediately) and this job delivers it, updating delivery_status. That
 * ordering means a provider outage delays delivery but never loses the reply.
 */
export async function sendEmail(job: ClaimedJob): Promise<void> {
  const { messageId } = parseJobPayload(job, 'send_email');

  const rows = await db
    .select({
      message: messages,
      conversation: conversations,
      contact: contacts,
      agent: agents,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(eq(messages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) throw subjectGone('send_email', `message ${messageId}`);

  // Already delivered: a retry after a partial failure must not send twice.
  if (alreadySent('send_email', messageId, row.message.deliveryStatus)) return;

  const e = env();
  if (!e.EMAIL_FROM_ADDRESS) throw new Error('EMAIL_FROM_ADDRESS is not configured');

  const recipients = row.message.toAddresses.length
    ? row.message.toAddresses
    : [row.contact.primaryEmail].filter((a): a is string => Boolean(a));

  if (recipients.length === 0) {
    throw new Error(`message ${messageId} has no recipient`);
  }

  const domain = replyDomain();

  const references = buildReferences(row.message.inReplyTo, generatedMessageId(row, domain));

  const signature = row.agent?.signature ?? null;
  const textBody = [row.message.bodyText, '', REPLY_ABOVE_MARKER, signature ? `\n${signature}` : '']
    .join('\n')
    .trimEnd();

  const htmlBody = [
    // A message written without an HTML part gets its paragraphs from the same
    // textToHtml the writers use, rather than one <p> joined by <br>s.
    row.message.bodyHtml ?? textToHtml(row.message.bodyText),
    // The marker doubles as the strip anchor for the customer's reply, so it
    // must survive in the HTML part too — hidden from view, present in source.
    `<div style="color:#999;font-size:11px;margin-top:24px">${REPLY_ABOVE_MARKER}</div>`,
    signature ? `<div style="margin-top:12px">${signature}</div>` : '',
  ].join('\n');

  const outbound: OutboundEmail = {
    to: recipients.map((address) => ({ address })),
    cc: row.message.ccAddresses.map((address) => ({ address })),
    from: {
      address: e.EMAIL_FROM_ADDRESS,
      name: row.agent ? `${row.agent.name} (${e.EMAIL_FROM_NAME})` : e.EMAIL_FROM_NAME,
    },
    replyTo: replyToAddress({ kind: 'ticket', conversationNumber: row.conversation.number }),
    subject: buildReplySubject(row.conversation.subject, row.conversation.number, e.APP_SECRET),
    textBody,
    htmlBody,
    messageId: generatedMessageId(row, domain),
    inReplyTo: row.message.inReplyTo ?? undefined,
    references,
  };

  try {
    const result = await emailProvider().send(outbound);

    // channelMessageId must hold an RFC 5322 Message-ID, because that is what a
    // reply's In-Reply-To and References will quote. Only `rfcMessageId` is one
    // — `providerMessageId` is the vendor's internal handle (a Postmark UUID)
    // and matching against it would never hit.
    await db
      .update(messages)
      .set({
        deliveryStatus: 'sent',
        channelMessageId: result.rfcMessageId ?? outbound.messageId,
        deliveryError: null,
        meta: {
          ...(row.message.meta as Record<string, unknown>),
          providerMessageId: result.providerMessageId,
          generatedMessageId: outbound.messageId,
          sentAt: new Date().toISOString(),
        },
      })
      .where(eq(messages.id, messageId));

    log.info(`${messageId} sent as ${formatMessageId(outbound.messageId)}`);
  } catch (error) {
    await db
      .update(messages)
      .set({
        deliveryStatus: 'failed',
        deliveryError: errorMessage(error),
      })
      .where(eq(messages.id, messageId));

    // Rethrown so the queue retries with backoff, and lands in `dead` if the
    // provider keeps refusing it.
    throw error;
  }
}

/** Stable per message, so the id in References matches the one in the header. */
function generatedMessageId(
  row: { message: { channelMessageId: string | null; id: string } },
  domain: string,
): string {
  return row.message.channelMessageId ?? `${row.message.id}@${domain}`;
}
