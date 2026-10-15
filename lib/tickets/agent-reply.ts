import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import { enqueue } from '@/lib/queue';
import { onAgentReply } from '@/lib/sla';
import { afterMessageStored } from '@/lib/tickets/lifecycle';
import { notReaction } from '@/lib/tickets/not-reaction';
import { carrierFor } from '@/lib/tickets/outbound';

/** The row an agent's reply is stored as, less what every reply shares. */
export type AgentReplyMessage = Omit<
  typeof messages.$inferInsert,
  'conversationId' | 'direction' | 'kind'
> & { authorAgentId: string; bodyText: string };

/**
 * What happens once an agent's reply is written, for both console senders: a
 * free-text reply and a WhatsApp template.
 *
 * Kept apart from `deliverAutomatedReply` in `outbound.ts` on purpose. This is
 * the path that moves `lastAgentMessageAt` and stops the SLA clocks for a reply
 * written in the console, and the `automated-reply-boundary` check forbids the
 * first in `outbound.ts`: an acknowledgement written by software must leave the
 * ticket in the unanswered queue. (The one other path is a person too: a reply
 * the business typed on the WhatsApp Business app of a number connected
 * through coexistence, which `ingestWhatsAppEcho` counts the same way.) What each sender checks before it gets here — permission, read-only
 * channels, the messaging windows, the template's account — stays in its action.
 *
 * Returns the new message's id.
 */
export async function storeAgentReply(
  conversationId: string,
  channel: string,
  message: AgentReplyMessage,
): Promise<string> {
  const inserted = await db
    .insert(messages)
    .values({ ...message, conversationId, direction: 'outbound', kind: 'reply' })
    .returning({ id: messages.id });

  const messageId = inserted[0]!.id;

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), lastAgentMessageAt: new Date() })
    .where(eq(conversations.id, conversationId));

  // The clock stops when the agent writes, not when the provider accepts the
  // message: the delay is ours to own, and a send that fails is visible on the
  // timeline anyway.
  await onAgentReply(conversationId);

  // Web chat has no outbound provider: writing the row *is* delivery, because
  // the visitor's open stream reads the same table.
  if (channel !== 'webchat') {
    await enqueue(
      carrierFor(channel),
      { messageId },
      // dedupeKey on the message id: a double-submit or a retried action can
      // never queue the same reply twice.
      { priority: 10, dedupeKey: `send:${messageId}` },
    );
  }

  // An agent looks a parcel up on the shipping platform and pastes the number
  // into their answer, which is why this runs on outbound as well as inbound.
  await afterMessageStored({
    conversationId,
    messageId,
    bodyText: message.bodyText,
    kind: 'reply',
    direction: 'outbound',
  });

  return messageId;
}

/**
 * The message a reply is threaded on: the provider's id for the customer's most
 * recent message — the email's Message-ID, the wamid a WhatsApp reply quotes.
 *
 * A `reply`, so not a reaction, or the reply would be recorded as answering a
 * thumbs-up; and not the notice a form writes when it could not keep a file,
 * which is inbound too, has no id of its own, and would leave the reply
 * threaded on nothing. Here rather than in the action so a test can reach it.
 */
export async function threadingParent(conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ channelMessageId: messages.channelMessageId })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        eq(messages.kind, 'reply'),
        notReaction(),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  return rows[0]?.channelMessageId ?? null;
}
