import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { configuredAccountId } from '@/lib/meta/client';
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
  const rows = await db
    .select({ fromAddress: messages.fromAddress, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound')))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const row = rows[0];

  return {
    recipientId: row?.fromAddress ?? null,
    thread: metaThreadStateFromMessage({
      platform,
      configuredAccountId: configuredAccountId(platform),
      lastInboundMeta: (row?.meta ?? null) as Record<string, unknown> | null,
    }),
  };
}
