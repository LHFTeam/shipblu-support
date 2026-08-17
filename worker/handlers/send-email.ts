import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, contacts, conversations, messages } from '@/db/schema';
import { env, replyDomain } from '@/lib/env';
import { emailProvider } from '@/lib/email/providers';
import { REPLY_ABOVE_MARKER } from '@/lib/email/quote-strip';
import { buildReplyAddress, buildReplySubject, formatMessageId } from '@/lib/email/threading';
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
  const mailbox = e.EMAIL_FROM_ADDRESS.split('@')[0] ?? 'support';

  const references = buildReferences(row.message.inReplyTo);

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
    replyTo: buildReplyAddress(row.conversation.number, e.APP_SECRET, mailbox, domain),
    subject: buildReplySubject(row.conversation.subject, row.conversation.number, e.APP_SECRET),
    textBody,
    htmlBody,
    messageId: row.message.channelMessageId ?? `${row.message.id}@${domain}`,
    inReplyTo: row.message.inReplyTo ?? undefined,
    references,
  };

  try {
    const result = await emailProvider().send(outbound);

    await db
      .update(messages)
      .set({
        deliveryStatus: 'sent',
        channelMessageId: outbound.messageId,
        deliveryError: null,
        meta: {
          ...(row.message.meta as Record<string, unknown>),
          providerMessageId: result.providerMessageId,
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

/** Rebuilds the References chain from the parent message id. */
function buildReferences(inReplyTo: string | null): string[] {
  return inReplyTo ? [inReplyTo] : [];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}
