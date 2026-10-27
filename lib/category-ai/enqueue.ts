import { enqueue } from '@/lib/queue';
import { queueableMessage } from '@/lib/tickets/classifiable';
import { classifierTicket, type ClassifierTicket } from '@/lib/tickets/classifier-ticket';
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
 * Then the ticket, read once for both classifiers (`classifierTicket`): the
 * bot channel, and a ticket somebody has already answered — classification
 * stops at the first human reply, and most customer messages come after one,
 * so without this nearly every job would be queued only to be recorded as
 * capped. The message checks are priority's too (`queueableMessage`).
 *
 * Must not import `run.ts`: `lib/tickets/lifecycle.ts` imports this, and the
 * job imports `lifecycle`.
 */
export async function enqueueCategoryClassification(
  message: {
    conversationId: string;
    messageId: string;
    bodyText: string;
    kind: string;
    direction: string;
  },
  ticket: () => Promise<ClassifierTicket | null> = classifierTicket(message.conversationId),
): Promise<void> {
  if (!queueableMessage(message)) return;
  if ((await loadCategoryAiSettings()).mode === 'off') return;

  const read = await ticket();
  if (!read || read.firstRespondedAt) return;

  // Keyed on the message, once-ever work: one live answer per message is what
  // `ai_category_runs` holds. 30, priority's reason: behind every send a
  // customer is waiting on, ahead of notification email and bulk work.
  await enqueue(
    'classify_category',
    { messageId: message.messageId },
    { priority: 30, dedupeKey: `classify_category:${message.messageId}` },
  );
}
