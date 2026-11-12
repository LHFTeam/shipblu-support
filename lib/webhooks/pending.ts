import { and, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import type { MetaPlatform } from '@/lib/meta/types';

/**
 * How long a delivery still waiting to be processed counts as the customer's
 * message on its way. Past it, the delivery is stuck — a job gone `dead` leaves
 * `processed_at` null for good — and waiting on it would only delay giving up.
 */
const STILL_ON_ITS_WAY = sql`now() - interval '15 minutes'`;

/**
 * Whether a Meta delivery from this sender, other than the one being processed,
 * is stored and not yet processed: their message on its way, waiting on its
 * retry or running beside the caller.
 *
 * For the team's reply that found no ticket (`ingestMetaEcho`'s `no_ticket`).
 * Meta sends each Messenger event in a delivery of its own, so the reply can be
 * processed first; this is what tells "not yet" from "not at all" — a
 * follow-up to a customer whose ticket is closed, or one this app never heard
 * from — so only the first fails its delivery to be tried again, and the second
 * costs no retry, no logged failure and no `webhook_events.error`.
 *
 * Reads the partial index of unprocessed deliveries, a handful of rows, and
 * matches the sender in either array by containment.
 */
export async function metaDeliveryPendingFrom(
  platform: MetaPlatform,
  senderId: string,
  exceptWebhookEventId: string,
): Promise<boolean> {
  const object = platform === 'facebook' ? 'page' : 'instagram';
  const from = (array: 'messaging' | 'standby') =>
    sql`${webhookEvents.payload} @> ${JSON.stringify({
      object,
      entry: [{ [array]: [{ sender: { id: senderId } }] }],
    })}::jsonb`;

  const [pending] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, 'meta'),
        isNull(webhookEvents.processedAt),
        ne(webhookEvents.id, exceptWebhookEventId),
        gt(webhookEvents.receivedAt, STILL_ON_ITS_WAY),
        or(from('messaging'), from('standby')),
      ),
    )
    .limit(1);

  return pending !== undefined;
}
