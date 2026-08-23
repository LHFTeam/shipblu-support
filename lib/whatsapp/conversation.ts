import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversations, messages } from '@/db/schema';
import { accountForPhoneNumberId, type WhatsAppAccount } from './accounts';

/**
 * Which number a WhatsApp ticket is answered from, and therefore which business
 * account it belongs to.
 *
 * Shared by the console and the worker deliberately. The console decides which
 * templates an agent may pick, the worker decides which credential the send
 * goes out with, and if those two disagree the failure is invisible until Meta
 * rejects the message on a status webhook — by which point the agent has been
 * told it went. One function, so they cannot.
 */

/**
 * The business number to reply from: the one this conversation arrived on.
 *
 * Meta's 24-hour window belongs to a (business number, customer) pair, not to
 * the business. Replying from a different number is a re-engagement message to
 * someone who never engaged, and Meta rejects it with 131047 — but only on a
 * later status webhook, after the send API has already returned a message id.
 * Nothing upstream can catch that, so the number has to be right here.
 *
 * Null rather than an error when there is nothing to go on: a conversation with
 * no inbound history is an outbound-first template send, which is exactly the
 * case the environment default exists for.
 */
export async function sendingNumberFor(
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

/** The business account a ticket sends on, from its id alone. */
export async function accountForConversation(
  conversationId: string,
): Promise<WhatsAppAccount | null> {
  const rows = await db
    .select({ channelId: conversations.channelId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const from = await sendingNumberFor(conversationId, rows[0]?.channelId ?? null);
  return accountForPhoneNumberId(from);
}

/** As above, reduced to what the template queries key off. */
export async function accountIdForConversation(conversationId: string): Promise<string | null> {
  return (await accountForConversation(conversationId))?.id ?? null;
}
