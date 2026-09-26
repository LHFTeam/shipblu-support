/**
 * What an agent should be told about a WhatsApp send whose wamid was lost.
 *
 * `send_whatsapp` records `wamidLost` when Meta accepted a send and the answer
 * carrying its id never arrived, or arrived unreadable. Receipts — delivered,
 * read, and an asynchronous rejection such as 131047 — are matched on that id,
 * so the row reads "sent" for ever. Without a word beside it, "sent" is read as
 * "sent and nothing went wrong", when it means "sent, and nothing will be heard
 * about it either way".
 *
 * Pure and import-free because the conversation view is a client component, and
 * a row that has since failed says nothing here: the failure is the answer.
 */
export function lostReceiptNote(message: {
  direction: 'inbound' | 'outbound';
  deliveryStatus: string;
  meta: Record<string, unknown> | null;
}): string | null {
  if (message.direction !== 'outbound' || message.deliveryStatus === 'failed') return null;
  if (message.meta?.wamidLost !== true) return null;

  return (
    "Sent — WhatsApp's confirmation was lost, so delivery and read receipts will not arrive, " +
    'and neither will a later rejection.'
  );
}
