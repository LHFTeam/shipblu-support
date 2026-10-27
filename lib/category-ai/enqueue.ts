import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { isSubcategorisableMessage } from '@/lib/subcategorise/apply';
import { enqueue } from '@/lib/queue';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { hasCustomerText } from '@/lib/tickets/customer-text';
import { loadCategoryAiSettings } from './settings';

/**
 * Queue one inbound message for the category classifier, if it is one.
 *
 * A job rather than a call, priority's reason: the provider is external and
 * slow, and the customer's message must never wait on it. The job re-checks
 * everything; these checks exist so a message that cannot qualify never
 * becomes a row in `jobs`.
 *
 * The pure checks come first, so an agent's reply — which reaches
 * `afterMessageStored` too — never reads the settings at all. Then the switch,
 * through the 30-second memo, which answers off when it cannot be read, so the
 * classifier misses a message rather than breaking the ingest that stored it.
 * Then one read of the ticket: the bot channel, which nobody on the team works
 * and which is nearly all of the volume, and a ticket somebody has already
 * answered — classification stops at the first human reply, and most customer
 * messages come after one, so without this nearly every job would be queued
 * only to be recorded as capped.
 *
 * Must not import `run.ts`: `lib/tickets/lifecycle.ts` imports this, and the
 * job imports `lifecycle`.
 */
export async function enqueueCategoryClassification(message: {
  conversationId: string;
  messageId: string;
  bodyText: string;
  kind: string;
  direction: string;
}): Promise<void> {
  if (!isSubcategorisableMessage(message.kind, message.direction)) return;
  if (!hasCustomerText(message.bodyText)) return;
  if ((await loadCategoryAiSettings()).mode === 'off') return;

  const [conversation] = await db
    .select({
      channel: conversations.channel,
      firstRespondedAt: conversations.firstRespondedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, message.conversationId))
    .limit(1);
  if (!conversation || isReadOnlyChannel(conversation.channel)) return;
  if (conversation.firstRespondedAt) return;

  // Keyed on the message, once-ever work: one live answer per message is what
  // `ai_category_runs` holds. 30, priority's reason: behind every send a
  // customer is waiting on, ahead of notification email and bulk work.
  await enqueue(
    'classify_category',
    { messageId: message.messageId },
    { priority: 30, dedupeKey: `classify_category:${message.messageId}` },
  );
}
