import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, conversations, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { subjectGone } from './subject-gone';
import { credentialsForPhoneNumberId } from '@/lib/whatsapp/accounts';
import { sendingNumberFor } from '@/lib/whatsapp/conversation';
import { WhatsAppApiError, sendTemplate, sendText } from '@/lib/whatsapp/client';
import type { WhatsAppTemplateComponent } from '@/lib/whatsapp/templates';
import { windowState } from '@/lib/whatsapp/window';
import { errorMessage } from '@/lib/errors';

/**
 * Delivers an agent's WhatsApp reply.
 *
 * The console writes the message row first and enqueues this, so the agent sees
 * their reply immediately and a Meta outage delays delivery instead of losing
 * it. `channel_message_id` is filled in with the wamid on success, which is what
 * later delivery-status webhooks match against.
 */

type SendMeta = {
  /** 'text' or 'template'. Absent means text, for rows written before this. */
  sendKind?: 'text' | 'template';
  template?: {
    name: string;
    language: string;
    components?: WhatsAppTemplateComponent[];
  };
  replyToWamid?: string | null;
};

export async function sendWhatsApp(job: ClaimedJob): Promise<void> {
  const messageId = job.payload.messageId;
  if (typeof messageId !== 'string') {
    throw new Error('send_whatsapp requires a messageId');
  }

  const rows = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) throw subjectGone('send_whatsapp', `message ${messageId}`);

  // A retry after a partial failure must not send the customer a second copy.
  if (row.message.deliveryStatus !== 'pending' && row.message.deliveryStatus !== 'failed') {
    console.log(`[send_whatsapp] ${messageId} is ${row.message.deliveryStatus}, skipping`);
    return;
  }

  const to = await recipientNumber(row.conversation.requesterContactId, row.message.toAddresses);
  if (!to) throw new Error(`no WhatsApp number for conversation ${row.conversation.number}`);

  const from = await sendingNumberFor(row.conversation.id, row.conversation.channelId);

  // The token belongs to the business account that owns `from`, not to the
  // installation: with two WABAs connected, sending with the wrong one is
  // rejected as a number the credential has no access to.
  const credentials = await credentialsForPhoneNumberId(from);

  const meta = row.message.meta as SendMeta & Record<string, unknown>;
  const kind = meta.sendKind ?? 'text';

  // Re-checked here, not just in the console: a reply can sit in the queue while
  // the window closes, and Meta would reject it with an error the agent never
  // sees. Failing it here puts the reason on the message row instead.
  if (kind === 'text') {
    const state = windowState(row.conversation.lastCustomerMessageAt);
    if (!state.isOpen) {
      await markFailed(
        messageId,
        row.message.meta,
        'The 24-hour customer service window closed before this message was sent. ' +
          'Send an approved template instead.',
      );
      return;
    }
  }

  try {
    const result =
      kind === 'template'
        ? await sendTemplateMessage(to, meta, credentials)
        : await sendText(to, row.message.bodyText, {
            replyToWamid: meta.replyToWamid ?? null,
            token: credentials.token,
            phoneNumberId: credentials.phoneNumberId,
          });

    const sentAt = new Date();

    await db
      .update(messages)
      .set({
        deliveryStatus: 'sent',
        channelMessageId: result.wamid,
        deliveryError: null,
        meta: {
          ...(row.message.meta as Record<string, unknown>),
          wamid: result.wamid,
          recipientId: result.recipientId,
          // Recorded because a send can still be rejected asynchronously, and
          // the number it went out from is the first thing worth knowing when
          // that happens. The business account with it, because "which WABA
          // did this leave on?" is the next question once there are two.
          phoneNumberId: credentials.phoneNumberId,
          whatsappAccountId: credentials.accountId,
          sentAt: sentAt.toISOString(),
          // Meta accepted the send and the answer carrying its id was lost.
          // Receipts match on the wamid, so this row will never hear another
          // word — an asynchronous rejection included. Said on the row, where
          // "sent" can be read as "sent, unconfirmed", rather than only in a
          // worker log nobody reads next to the ticket; `lostReceiptNote`
          // (lib/whatsapp/receipts.ts) is what the console shows for it.
          ...(result.wamid === null ? { wamidLost: true } : {}),
        },
      })
      .where(eq(messages.id, messageId));

    // Automated acknowledgements and surveys share this carrier with replies an
    // agent wrote. They have no author and must leave the ticket unanswered;
    // otherwise WhatsApp alone would quietly satisfy the queue's human-reply
    // test after the shared outbound path deliberately left it alone.
    await db
      .update(conversations)
      .set({
        lastMessageAt: sentAt,
        ...(row.message.authorAgentId ? { lastAgentMessageAt: sentAt } : {}),
      })
      .where(eq(conversations.id, row.conversation.id));

    console.log(
      `[send_whatsapp] ${messageId} sent as ${result.wamid ?? 'an unknown wamid: Meta accepted it and its answer was lost'}`,
    );
  } catch (error) {
    await markFailed(messageId, row.message.meta, errorMessage(error));

    // Only retry what a retry could fix. A rejected template or an invalid
    // number fails identically every time, and retrying it four more times just
    // delays the agent seeing the reason.
    if (error instanceof WhatsAppApiError && !error.isTransient) {
      console.error(
        `[send_whatsapp] ${messageId} permanently rejected (code ${error.code}): ${error.message}`,
      );
      return;
    }
    throw error;
  }
}

async function sendTemplateMessage(
  to: string,
  meta: SendMeta,
  credentials: { token: string; phoneNumberId: string | null },
) {
  const template = meta.template;
  if (!template?.name || !template.language) {
    throw new Error('send_whatsapp with sendKind=template requires template name and language');
  }
  return sendTemplate(to, template.name, template.language, template.components ?? [], {
    token: credentials.token,
    phoneNumberId: credentials.phoneNumberId,
  });
}

async function markFailed(messageId: string, existingMeta: unknown, error: string): Promise<void> {
  await db
    .update(messages)
    .set({
      deliveryStatus: 'failed',
      deliveryError: error.slice(0, 2000),
      meta: {
        ...(existingMeta as Record<string, unknown>),
        failedAt: new Date().toISOString(),
      },
    })
    .where(eq(messages.id, messageId));
}

/**
 * Explicit recipients win — a conversation can be reassigned to a different
 * number — otherwise the requester's WhatsApp identity is used.
 */
async function recipientNumber(contactId: string, explicit: string[]): Promise<string | null> {
  if (explicit.length > 0) return explicit[0]!;

  const rows = await db
    .select({ identifier: contactIdentities.identifier })
    .from(contactIdentities)
    .where(
      and(eq(contactIdentities.contactId, contactId), eq(contactIdentities.channel, 'whatsapp')),
    )
    .limit(1);

  return rows[0]?.identifier ?? null;
}
