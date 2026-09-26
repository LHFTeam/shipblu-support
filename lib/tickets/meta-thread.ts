import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, messages } from '@/db/schema';
import { configuredAccountId } from '@/lib/meta/client';
import { metaConnection } from '@/lib/meta/connection';
import { metaThreadStateFromMessage, type MetaThreadState } from '@/lib/meta/thread';
import type { MetaPlatform } from '@/lib/meta/types';

/**
 * Who a Facebook or Instagram reply would be addressed to, and whether this app
 * may address them.
 *
 * One helper for both because both answers come off the same row — the
 * customer's most recent message — and reading them separately is how they
 * could disagree. Shared by the composer, the reply action and the send job so
 * that all three reach the same verdict; the console showing a reply box over a
 * thread the worker will refuse is the failure this is here to prevent.
 */
export type MetaReplyTarget = {
  /** The customer's page-scoped id, or null when there is nothing inbound. */
  recipientId: string | null;
  thread: MetaThreadState;
};

export async function metaReplyTarget(
  conversationId: string,
  platform: MetaPlatform,
): Promise<MetaReplyTarget> {
  const [rows, controlTakenAt] = await Promise.all([
    db
      .select({
        fromAddress: messages.fromAddress,
        meta: messages.meta,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound')))
      .orderBy(desc(messages.createdAt))
      .limit(1),
    threadControlTakenAt(conversationId),
  ]);

  const row = rows[0];

  return {
    recipientId: row?.fromAddress ?? null,
    thread: metaThreadStateFromMessage({
      platform,
      connection: metaConnection(platform),
      configuredAccountId: configuredAccountId(platform),
      lastInboundMeta: (row?.meta ?? null) as Record<string, unknown> | null,
      lastInboundAt: row?.createdAt ?? null,
      controlTakenAt,
    }),
  };
}

/**
 * The timeline event written when an agent takes thread control.
 *
 * A plain `text` column, so the name is the contract between the four places
 * that touch it — the action that writes it, the two readers below and in
 * `lib/tickets/conversation.ts`, and the timeline sentence in the ticket view. Named
 * once here rather than spelled out in each.
 */
export const THREAD_CONTROL_TAKEN = 'thread_control_taken';

/**
 * When this app last took thread control of a conversation, or null.
 *
 * An event rather than a column on `conversations`, for the reason
 * `profile_refreshed` is one: it is something a person did to this ticket on a
 * date, and the timeline is where the team already looks for that. It also
 * costs no migration, and gives the agent who wonders why the composer opened
 * a line saying who opened it.
 *
 * Read as its own query rather than off the timeline the ticket page already
 * loads: that list is capped at fifty events, and the one event whose absence
 * silently re-refuses every reply is not one to leave to a cap.
 */
export async function threadControlTakenAt(conversationId: string): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: conversationEvents.createdAt })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, THREAD_CONTROL_TAKEN),
      ),
    )
    .orderBy(desc(conversationEvents.createdAt))
    .limit(1);

  return rows[0]?.createdAt ?? null;
}
