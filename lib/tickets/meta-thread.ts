import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import { env } from '@/lib/env';
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
  /** What the console last established about thread control, for the button. */
  control: MetaControlSnapshot;
  /**
   * When the customer last wrote. Returned because it is what a control
   * snapshot has to be newer than to count, and re-reading it to find that out
   * would be a second query for a value this one already has in hand.
   */
  lastInboundAt: Date | null;
};

/**
 * The stored answer to "who owns this thread", with the instant it was true.
 *
 * `checkedAt` null means nobody has ever looked, which is not the same as
 * "nobody owns it" — that is a set `checkedAt` with a null `appId`.
 */
export type MetaControlSnapshot = { appId: string | null; checkedAt: Date | null };

export async function metaReplyTarget(
  conversationId: string,
  platform: MetaPlatform,
): Promise<MetaReplyTarget> {
  // Two reads rather than a join. The message read is `order by created_at desc
  // limit 1` over one conversation's messages and the conversation read is a
  // primary-key lookup; joining them would make the planner sort the whole
  // thread to carry two scalar columns along for the ride.
  const [rows, controlRows] = await Promise.all([
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
    db
      .select({
        appId: conversations.metaControlAppId,
        checkedAt: conversations.metaControlCheckedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1),
  ]);

  const row = rows[0];
  const control: MetaControlSnapshot = {
    appId: controlRows[0]?.appId ?? null,
    checkedAt: controlRows[0]?.checkedAt ?? null,
  };

  return {
    recipientId: row?.fromAddress ?? null,
    control,
    lastInboundAt: row?.createdAt ?? null,
    thread: metaThreadStateFromMessage({
      platform,
      configuredAccountId: configuredAccountId(platform),
      ourAppId: env().META_APP_ID ?? null,
      lastInboundMeta: (row?.meta ?? null) as Record<string, unknown> | null,
      lastInboundAt: row?.createdAt ?? null,
      control,
    }),
  };
}
