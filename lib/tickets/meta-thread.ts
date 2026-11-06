import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, messages } from '@/db/schema';
import { defaultAppSince } from '@/lib/meta/app-roles';
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
  const [rows, facts] = await Promise.all([
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
    threadOwnershipFacts(conversationId, platform),
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
      controlTakenAt: facts.controlTakenAt,
      defaultAppSince: facts.defaultAppSince,
    }),
  };
}

export type ThreadOwnershipFacts = {
  /** When this app last took thread control of the conversation, or null. */
  controlTakenAt: Date | null;
  /**
   * Since when this app has been the account's default app in the sense that
   * moves threads — Instagram's, never Messenger's — or null
   * (`defaultAppSince`, `lib/meta/app-roles.ts`).
   */
  defaultAppSince: Date | null;
};

/**
 * The two facts that can be newer than a message's `standby` and say the
 * thread is this app's now, read once for the ticket page and once for
 * `metaReplyTarget` — the composer, the reply and take-control actions, and
 * `send_meta` — so the console and the worker weigh the same two and cannot
 * disagree about whether a reply may go (`docs/PROJECT-STATE.md` §6.111).
 *
 * One after the other rather than at once: the ticket page calls this from
 * inside `allLimited`'s eight places, where a second query of its own would be
 * a ninth. `platform` is null for a ticket that is not a Meta direct message,
 * which reads only the first and asks nothing of the second.
 */
export async function threadOwnershipFacts(
  conversationId: string,
  platform: MetaPlatform | null,
): Promise<ThreadOwnershipFacts> {
  const controlTakenAt = await threadControlTakenAt(conversationId);
  return {
    controlTakenAt,
    defaultAppSince: platform ? await defaultAppSince(platform) : null,
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
async function threadControlTakenAt(conversationId: string): Promise<Date | null> {
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
