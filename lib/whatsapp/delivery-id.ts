import { boundedDeliveryKey } from '@/lib/webhooks/delivery-key';
import type { WhatsAppWebhookPayload } from './types';

/**
 * A WhatsApp delivery's idempotency key, derived from what it carries.
 *
 * Meta sends no event id of its own, so one is built from the batch contents:
 * the wamids of every message, echo and status in it, which is stable across
 * redeliveries of the same batch and differs between distinct ones. Out of the
 * route so the parts a coexistence number adds are keyed beside the ones that
 * were already here, and tested without a request.
 *
 *   m:<wamid>                 a message
 *   e:<wamid>                 an echo
 *   s:<wamid>:<status>        a delivery status
 *   hm:<wamid>                a message of a copied chat history — distinct
 *                             from `m:`, because the file behind a copied
 *                             placeholder arrives later under the same wamid
 *   c:<phone>:<action>:<ts>   a contact from the phone's address book
 *
 * Nothing for `account_update`: the index behind this key is spent for good,
 * and a number disconnected, reconnected and disconnected again sends the same
 * body twice — the second must not be swallowed. Its handler is idempotent
 * instead. A declined history carries nothing to key on either, for the same
 * reason, and recording it twice changes nothing.
 *
 * Null for a batch with nothing to key on — the unique index treats nulls as
 * distinct, so contentless deliveries are stored rather than colliding. A batch
 * too long for the column is hashed whole rather than truncated
 * (`boundedDeliveryKey`).
 */
export function deliveryId(payload: WhatsAppWebhookPayload): string | null {
  const parts: string[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const message of value?.messages ?? []) {
        if (message.id) parts.push(`m:${message.id}`);
      }
      for (const echo of value?.message_echoes ?? []) {
        if (echo.id) parts.push(`e:${echo.id}`);
      }
      for (const status of value?.statuses ?? []) {
        if (status.id) parts.push(`s:${status.id}:${status.status}`);
      }
      for (const chunk of value?.history ?? []) {
        for (const thread of chunk.threads ?? []) {
          for (const message of thread.messages ?? []) {
            if (message.id) parts.push(`hm:${message.id}`);
          }
        }
      }
      for (const item of value?.state_sync ?? []) {
        const phone = item.contact?.phone_number;
        if (phone) {
          parts.push(`c:${phone}:${item.action ?? ''}:${String(item.metadata?.timestamp ?? '')}`);
        }
      }
    }
  }

  if (parts.length === 0) return null;
  return boundedDeliveryKey(parts.sort().join('|'));
}
