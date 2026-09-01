import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, contacts, conversations, messages } from '@/db/schema';
import { env, replyDomain } from '@/lib/env';
import { emailProvider } from '@/lib/email/providers';
import { REPLY_ABOVE_MARKER } from '@/lib/email/quote-strip';
import { replyToAddress } from '@/lib/email/reply-address';
import { buildReplySubject, formatMessageId } from '@/lib/email/threading';
import type { OutboundEmail } from '@/lib/email/types';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Sends an agent's reply.
 *
 * The message row is written first by the console (so the agent sees it
 * immediately) and this job delivers it, updating delivery_status. That
 * ordering means a provider outage delays delivery but never loses the reply.
 */
export async function sendEmail(job: ClaimedJob): Promise<void> {
  const messageId = job.payload.messageId;
  if (typeof messageId !== 'string') {
    throw new Error('send_email requires a messageId');
  }

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
  if (!row) throw new Error(`message ${messageId} not found`);

  // Already delivered: a retry after a partial failure must not send twice.
  if (row.message.deliveryStatus !== 'pending' && row.message.deliveryStatus !== 'failed') {
    console.log(`[send_email] ${messageId} is ${row.message.deliveryStatus}, skipping`);
    return;
  }

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
    row.message.bodyHtml ?? `<p>${escapeHtml(row.message.bodyText)}</p>`,
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

    console.log(`[send_email] ${messageId} sent as ${formatMessageId(outbound.messageId)}`);
  } catch (error) {
    await db
      .update(messages)
      .set({
        deliveryStatus: 'failed',
        deliveryError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(messages.id, messageId));

    // Rethrown so the queue retries with backoff, and lands in `dead` if the
    // provider keeps refusing it.
    throw error;
  }
}

/**
 * The References chain: the parent, then this message's own id.
 *
 * Including our own id is a deliberate belt against providers that replace the
 * Message-ID header — Postmark and SES both reserve the right to, and neither
 * announces it. References is left alone by every provider we have used, so an
 * id that appears there is still findable when the customer replies, even if
 * the header we set never reached them.
 */
function buildReferences(inReplyTo: string | null, ownMessageId: string): string[] {
  const chain = inReplyTo ? [inReplyTo] : [];
  if (!chain.includes(ownMessageId)) chain.push(ownMessageId);
  return chain;
}

/** Stable per message, so the id in References matches the one in the header. */
function generatedMessageId(
  row: { message: { channelMessageId: string | null; id: string } },
  domain: string,
): string {
  return row.message.channelMessageId ?? `${row.message.id}@${domain}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}
