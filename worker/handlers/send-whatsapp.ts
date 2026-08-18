import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, contactIdentities, conversations, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { WhatsAppApiError, sendTemplate, sendText } from '@/lib/whatsapp/client';
import type { WhatsAppTemplateComponent } from '@/lib/whatsapp/templates';
import { windowState } from '@/lib/whatsapp/window';

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
  if (!row) throw new Error(`message ${messageId} not found`);

  // A retry after a partial failure must not send the customer a second copy.
  if (row.message.deliveryStatus !== 'pending' && row.message.deliveryStatus !== 'failed') {
    console.log(`[send_whatsapp] ${messageId} is ${row.message.deliveryStatus}, skipping`);
    return;
  }

  const to = await recipientNumber(row.conversation.requesterContactId, row.message.toAddresses);
  if (!to) throw new Error(`no WhatsApp number for conversation ${row.conversation.number}`);

  const from = await sendingNumber(row.conversation.id, row.conversation.channelId);

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
        ? await sendTemplateMessage(to, meta, from)
        : await sendText(to, row.message.bodyText, {
            replyToWamid: meta.replyToWamid ?? null,
            phoneNumberId: from,
          });

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
          // that happens.
          phoneNumberId: from,
          sentAt: new Date().toISOString(),
        },
      })
      .where(eq(messages.id, messageId));

    // Deliberately does not touch lastCustomerMessageAt: an agent's reply does
    // not extend the 24-hour window, only the customer's message does.
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date(), lastAgentMessageAt: new Date() })
      .where(eq(conversations.id, row.conversation.id));

    console.log(`[send_whatsapp] ${messageId} sent as ${result.wamid}`);
  } catch (error) {
    await markFailed(
      messageId,
      row.message.meta,
      error instanceof Error ? error.message : String(error),
    );

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

async function sendTemplateMessage(to: string, meta: SendMeta, from: string | null) {
  const template = meta.template;
  if (!template?.name || !template.language) {
    throw new Error('send_whatsapp with sendKind=template requires template name and language');
  }
  return sendTemplate(to, template.name, template.language, template.components ?? [], {
    phoneNumberId: from,
  });
}

/**
 * The business number to reply from: the one this conversation arrived on.
 *
 * Meta's 24-hour window belongs to a (business number, customer) pair, not to
 * the business. Replying from a different number is a re-engagement message to
 * someone who never engaged, and Meta rejects it with 131047 — but only on a
 * later status webhook, after the send API has already returned a message id.
 * Nothing upstream can catch that, so the number has to be right here.
 *
 * Falling back to the environment default rather than failing is deliberate: a
 * conversation with no inbound history is an outbound-first template send,
 * which is exactly the case the default exists for.
 */
async function sendingNumber(
  conversationId: string,
  channelId: string | null,
): Promise<string | null> {
  const inbound = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound')))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const fromInbound = inbound[0]?.meta as { phoneNumberId?: unknown } | undefined;
  if (typeof fromInbound?.phoneNumberId === 'string' && fromInbound.phoneNumberId) {
    return fromInbound.phoneNumberId;
  }

  if (channelId) {
    const channel = await db
      .select({ config: channels.config })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    const configured = channel[0]?.config?.phoneNumberId;
    if (typeof configured === 'string' && configured) return configured;
  }

  return null;
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
