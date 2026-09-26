/**
 * What an agent should be told about a WhatsApp send whose wamid was lost.
 *
 * `send_whatsapp` records `wamidLost` when Meta accepted a send and the answer
 * carrying its id never arrived. Receipts — delivered,
 * read, and an asynchronous rejection such as 131047 — are matched on that id,
 * so the row reads "sent" for ever. Without a word beside it, "sent" is read as
 * "sent and nothing went wrong", when it means "sent, and nothing will be heard
 * about it either way".
 *
 * Pure and import-free because the conversation view is a client component.
 * It does not look at a failed row: `DeliveryState` renders the failure before
 * it asks, and `send_whatsapp` writes `wamidLost` only together with `sent`, a
 * status nothing moves such a row out of.
 */
export function lostReceiptNote(message: {
  direction: 'inbound' | 'outbound';
  meta: Record<string, unknown> | null;
}): string | null {
  if (message.direction !== 'outbound') return null;
  if (message.meta?.wamidLost !== true) return null;

  return (
    "Sent — WhatsApp's confirmation was lost, so delivery and read receipts will not arrive, " +
    'and neither will a later rejection.'
  );
}
