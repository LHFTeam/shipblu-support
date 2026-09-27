import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, conversations, sideConversationMessages, sideConversations } from '@/db/schema';
import { env, replyDomain } from '@/lib/env';
import { emailProvider } from '@/lib/email/providers';
import { REPLY_ABOVE_MARKER } from '@/lib/email/quote-strip';
import { textToHtml } from '@/lib/html/sanitize';
import { replyToAddress } from '@/lib/email/reply-address';
import { textToEscapedHtml } from '@/lib/email/html';
import { buildReferences, buildSideSubjectTag, formatMessageId } from '@/lib/email/threading';
import type { OutboundEmail } from '@/lib/email/types';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { alreadySent } from './already-sent';
import { subjectGone } from './subject-gone';
import {
  buildSideReplySubject,
  buildSideSubject,
  sideConversationFooter,
} from '@/lib/side-conversations/format';
import { errorMessage } from '@/lib/errors';

/**
 * Sends an agent's question — or their follow-up — to a hub or another internal
 * team.
 *
 * Deliberately a sibling of `send-email.ts` rather than a branch inside it. The
 * two share a provider and a delivery-status discipline and nothing else: the
 * recipient is not the ticket's requester, the Reply-To carries a different
 * token, the subject is built differently, and the message row lives in a
 * different table. Threading both through one handler would mean a
 * `if (isSide)` at every step, and the step somebody forgets to branch is the
 * one that emails the customer.
 */
export async function sendSideEmail(job: ClaimedJob): Promise<void> {
  const { messageId } = parseJobPayload(job, 'send_side_email');

  const rows = await db
    .select({
      message: sideConversationMessages,
      side: sideConversations,
      conversationNumber: conversations.number,
      agent: agents,
    })
    .from(sideConversationMessages)
    .innerJoin(
      sideConversations,
      eq(sideConversations.id, sideConversationMessages.sideConversationId),
    )
    .innerJoin(conversations, eq(conversations.id, sideConversations.conversationId))
    .leftJoin(agents, eq(agents.id, sideConversationMessages.authorAgentId))
    .where(eq(sideConversationMessages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) throw subjectGone('send_side_email', `side conversation message ${messageId}`);

  // Already delivered: a retry after a partial failure must not send twice.
  if (alreadySent('send_side_email', messageId, row.message.deliveryStatus)) return;

  const e = env();
  if (!e.EMAIL_FROM_ADDRESS) throw new Error('EMAIL_FROM_ADDRESS is not configured');

  const recipients = row.message.toAddresses.length
    ? row.message.toAddresses
    : row.side.toAddresses;

  if (recipients.length === 0) {
    throw new Error(`side conversation message ${messageId} has no recipient`);
  }

  const domain = replyDomain();
  const sideTag = buildSideSubjectTag(row.side.number, e.APP_SECRET);

  const ownMessageId = row.message.channelMessageId ?? `${row.message.id}@${domain}`;
  const references = buildReferences(row.message.inReplyTo, ownMessageId);

  // The first message states the subject; every later one wears "Re:" so the
  // hub's mail client groups the exchange rather than showing four unrelated
  // questions about the same parcel.
  const isFirst = row.message.inReplyTo === null;
  const subject = isFirst
    ? buildSideSubject(row.side.subject, row.conversationNumber, sideTag)
    : buildSideReplySubject(row.side.subject, row.conversationNumber, sideTag);

  const footer = sideConversationFooter(row.conversationNumber);
  const signature = row.agent?.signature ?? null;

  const textBody = [
    row.message.bodyText,
    '',
    REPLY_ABOVE_MARKER,
    signature ? `\n${signature}` : '',
    '',
    footer,
  ]
    .join('\n')
    .trimEnd();

  const htmlBody = [
    // A side message is written as text only, so its paragraphs come from the
    // same textToHtml the ticket reply uses, rather than one <p> joined by <br>s.
    row.message.bodyHtml ?? textToHtml(row.message.bodyText),
    // The marker doubles as the strip anchor for the hub's reply, so it has to
    // survive in the HTML part too — hidden from view, present in source.
    `<div style="color:#999;font-size:11px;margin-top:24px">${REPLY_ABOVE_MARKER}</div>`,
    signature ? `<div style="margin-top:12px">${signature}</div>` : '',
    `<div style="color:#666;font-size:12px;margin-top:16px;border-top:1px solid #ddd;padding-top:8px">${textToEscapedHtml(footer)}</div>`,
  ].join('\n');

  const outbound: OutboundEmail = {
    to: recipients.map((address) => ({ address })),
    cc: row.message.ccAddresses.map((address) => ({ address })),
    from: {
      address: e.EMAIL_FROM_ADDRESS,
      name: row.agent ? `${row.agent.name} (${e.EMAIL_FROM_NAME})` : e.EMAIL_FROM_NAME,
    },
    // The `s` token, not the `c` one. A hub replying to the ticket's reply
    // address would put their answer on the customer's timeline, where the
    // portal can read it.
    replyTo: replyToAddress({ kind: 'side', sideNumber: row.side.number }),
    subject,
    textBody,
    htmlBody,
    messageId: ownMessageId,
    inReplyTo: row.message.inReplyTo ?? undefined,
    references,
  };

  try {
    const result = await emailProvider().send(outbound);

    // Only `rfcMessageId` is an RFC 5322 Message-ID; `providerMessageId` is the
    // vendor's internal handle and will never appear in a reply's In-Reply-To.
    // Storing the wrong one here breaks the References route home, which on this
    // path means a hub's answer opens a *new customer ticket*.
    await db
      .update(sideConversationMessages)
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
      .where(eq(sideConversationMessages.id, messageId));

    console.log(
      `[send_side_email] ${messageId} sent to side conversation #${row.side.number} ` +
        `as ${formatMessageId(outbound.messageId)}`,
    );
  } catch (error) {
    await db
      .update(sideConversationMessages)
      .set({
        deliveryStatus: 'failed',
        deliveryError: errorMessage(error),
      })
      .where(eq(sideConversationMessages.id, messageId));

    throw error;
  }
}
