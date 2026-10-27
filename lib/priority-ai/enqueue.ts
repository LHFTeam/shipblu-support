import { enqueue } from '@/lib/queue';
import { queueableMessage } from '@/lib/tickets/classifiable';
import { classifierTicket, type ClassifierTicket } from '@/lib/tickets/classifier-ticket';
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
export async function enqueuePriorityClassification(
  message: {
    conversationId: string;
    messageId: string;
    bodyText: string;
    kind: string;
    direction: string;
  },
  ticket: () => Promise<ClassifierTicket | null> = classifierTicket(message.conversationId),
): Promise<void> {
  if (priorityAiMode() === 'off') return;
  if (!queueableMessage(message)) return;
  if (!(await ticket())) return;

  // Keyed on the message, which is once-ever work: one answer per message is
  // what `ai_priority_runs` holds, so a spent key is the right answer to a
  // webhook retry delivering the same message twice.
  //
  // 30: behind every send a customer is waiting on — webhooks and agent replies
  // at 10, profiles at 20, and the out-of-hours acknowledgement and automated
  // replies at 20 (`deliverAutomatedReply`). That orders which job a free slot
  // takes next, and no more. The worker's pool (`worker/pool.ts`) refills each
  // slot as its job finishes, so a slow answer here — up to the client's
  // 15-second timeout — holds only its own slot; but a slot that is free when
  // this job is queued takes it at once, before this message's acknowledgement
  // exists, since ingest queues that later in the same pass. Only when every
  // slot is busy does the order matter, and then the acknowledgement goes
  // first. Ahead of notification email (40) and bulk work, because the
  // first-response targets it moves are minutes long.
  await enqueue(
    'classify_priority',
    { messageId: message.messageId },
    { priority: 30, dedupeKey: `classify_priority:${message.messageId}` },
  );
}
