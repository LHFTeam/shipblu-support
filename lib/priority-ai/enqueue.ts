import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { isCategorisableMessage } from '@/lib/categorise/apply';
import { enqueue } from '@/lib/queue';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { priorityAiMode } from './settings';

/**
 * Queue one inbound message for the priority classifier, if it is one.
 *
 * A job rather than a call, because the provider is external and slow and the
 * customer's message must never wait on it — the rule `AGENTS.md` sets for
 * anything of that shape. The job re-checks every condition here; these exist so
 * a message that cannot qualify never becomes a row in `jobs`.
 *
 * The channel test matters most. The bot channel carries nearly all of the
 * message volume, and nobody on the team works it — a job per bot message would
 * be most of the queue, spent on tickets the classifier then refuses.
 *
 * The switch is read before anything else and through `process.env`, so with
 * the feature off this costs nothing on the ingest path: no query, no `env()`.
 * The key's presence is left to the job, which reports it, because `env()`
 * validates the whole schema and this runs on every path that stores a message.
 */
export async function enqueuePriorityClassification(message: {
  conversationId: string;
  messageId: string;
  bodyText: string;
  kind: string;
  direction: string;
}): Promise<void> {
  if (priorityAiMode() === 'off') return;
  if (!isCategorisableMessage(message.kind, message.direction)) return;
  if (!message.bodyText.trim()) return;

  const [conversation] = await db
    .select({ channel: conversations.channel })
    .from(conversations)
    .where(eq(conversations.id, message.conversationId))
    .limit(1);
  if (!conversation || isReadOnlyChannel(conversation.channel)) return;

  // Keyed on the message, which is once-ever work: one answer per message is
  // what `ai_priority_runs` holds, so a spent key is the right answer to a
  // webhook retry delivering the same message twice. Ahead of bulk work and
  // behind sends — the first-response targets this moves are minutes long.
  await enqueue(
    'classify_priority',
    { messageId: message.messageId },
    { priority: 15, dedupeKey: `classify_priority:${message.messageId}` },
  );
}
