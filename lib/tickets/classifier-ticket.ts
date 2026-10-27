import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { isReadOnlyChannel, type ConversationChannel } from '@/lib/tickets/channel-policy';

/** What the classifiers' enqueuers read off a stored message's ticket. */
export type ClassifierTicket = { channel: ConversationChannel; firstRespondedAt: Date | null };

/**
 * One read of a stored message's ticket for every classifier that queues a job
 * for it, made at most once however many ask: `afterMessageStored` builds one
 * and hands it to both enqueuers, which read it only once their own cheaper
 * checks — the switch, the message's own words — have passed.
 *
 * Null when the ticket is gone, or on a read-only channel: the bot, which
 * nobody on the team works and which is nearly all of the volume, so a job per
 * bot message would be most of the queue, spent on tickets the job refuses.
 *
 * A read that fails is forgotten, so the next enqueuer reads again: each one
 * queues in its own try/catch so that one failing cannot stop the other, and
 * a refusal at the pool's admission gate handed on would stop it all the
 * same — with no row and no dead job to show the message was never asked.
 */
export function classifierTicket(conversationId: string): () => Promise<ClassifierTicket | null> {
  let read: Promise<ClassifierTicket | null> | null = null;
  return () =>
    (read ??= db
      .select({ channel: conversations.channel, firstRespondedAt: conversations.firstRespondedAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .then(
        ([ticket]) => (ticket && !isReadOnlyChannel(ticket.channel) ? ticket : null),
        (error: unknown) => {
          read = null;
          throw error;
        },
      ));
}
