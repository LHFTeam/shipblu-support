import type { MetaConnection } from './connection';
import type { MetaWebhookPayload } from './types';

/**
 * Turning a Meta webhook batch into a key the unique index can reject twice on.
 *
 * Its own module rather than a helper inside the route because it carries an
 * invariant the route cannot state: two deliveries of the same message that
 * arrived on different connections are two deliveries, and one that arrived
 * twice on the same connection is one. Nothing local can call Meta to check
 * that, so it is asserted in a test against the real batch shapes instead.
 */

/**
 * Delivery-level idempotency key, derived from the connection and the batch
 * contents.
 *
 * Meta sends no event id of its own. Message ids and comment ids are stable
 * across redeliveries of the same batch and differ between distinct ones, which
 * is exactly the property needed. Null for a contentless delivery, because the
 * unique index treats nulls as distinct and storing them separately is better
 * than colliding unrelated empty batches onto one row.
 *
 * **The connection is part of the key**, which is what stops the two Instagram
 * connections deduplicating each other. They deliver the same message with the
 * same `mid`, so a key made of the contents alone collapses them onto one row —
 * and the row kept is whichever arrived first, meaning the record of the second
 * connection is a coin toss. Two consequences, both bad: a per-connection
 * delivery count becomes unmeasurable, which is the number that would have
 * shown §6.29's Page connection going silent within the hour; and a batch whose
 * job fails permanently loses the other connection's identical copy, which
 * would have been a second chance at the same customer's message. Ingest
 * deduplicates on the `mid` itself, so storing both costs a row and a no-op
 * job, never a second ticket.
 */
export function deliveryId(payload: MetaWebhookPayload, connection: MetaConnection): string | null {
  const parts: string[] = [];

  for (const entry of payload.entry ?? []) {
    for (const event of [...(entry.messaging ?? []), ...(entry.standby ?? [])]) {
      if (event.message?.mid) parts.push(`m:${event.message.mid}`);
      // Receipts carry no id of their own; the watermark plus the sender is
      // what makes one delivery distinguishable from the next.
      if (event.delivery?.watermark)
        parts.push(`d:${event.sender?.id}:${event.delivery.watermark}`);
      if (event.read?.watermark) parts.push(`r:${event.sender?.id}:${event.read.watermark}`);

      // Window-opening interactions, which carry no usable id of their own
      // either. Without these a postback-only or referral-only batch produces
      // *no* parts at all and so a null key, which the unique index treats as
      // distinct every time — every redelivery of the same button press would be
      // stored and processed again.
      //
      // A reaction's `mid` names the message reacted *to*, not the reaction, so
      // neither it nor the action is enough on its own: the timestamp is what
      // separates reacting 👍, taking it back, and reacting again. Without it the
      // third rebuilds the first's key exactly — and the unique index spans the
      // whole table with no expiry, so that delivery is answered "duplicate" and
      // the reaction never reaches the timeline.
      if (event.postback) {
        parts.push(
          `p:${event.sender?.id}:${event.timestamp ?? ''}:${event.postback.payload ?? ''}`,
        );
      }
      if (event.reaction) {
        parts.push(
          `k:${event.sender?.id}:${event.timestamp ?? ''}:${event.reaction.mid ?? ''}:` +
            `${event.reaction.action ?? ''}`,
        );
      }
      if (event.referral && !event.postback) {
        parts.push(`f:${event.sender?.id}:${event.timestamp ?? ''}:${event.referral.ref ?? ''}`);
      }
    }

    for (const change of entry.changes ?? []) {
      const value = change.value;
      const commentId = value?.comment_id ?? value?.id;
      if (commentId) parts.push(`c:${commentId}:${value?.verb ?? 'add'}`);
    }
  }

  if (parts.length === 0) return null;
  return `${connection}|${parts.sort().join('|')}`.slice(0, 500);
}
