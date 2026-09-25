import { t, type Locale } from '@/lib/kb/locale';

/**
 * What a chat about one parcel opens with.
 *
 * The tracking page's support button hands this to the widget's composer and
 * then gets out of the way: the visitor writes their question under it and
 * presses Send. It is a *draft*, not a message — nothing is sent until they
 * send it, and they can edit or delete every word of it, which is the whole
 * reason it is safe to put a tracking number in somebody's outbox.
 *
 * Two rules hold here.
 *
 * **It repeats what the page already showed, and never more.** The status is
 * passed in already worded by `statusLabel` / `returnStepLabel`, so the message
 * says exactly what the badge above the button said — in the same language, and
 * with the same reticence. Building it from `shipments.data` instead would put
 * the recipient's name or the COD amount into a message a neighbour holding the
 * number could send (`docs/PROJECT-STATE.md` §6.38); this function structurally
 * cannot, because it is never given them.
 *
 * **The number is the point.** `lib/shipments/detect.ts` reads it out of the
 * message body when the ticket is stored, so the conversation links itself to
 * the shipment the customer was looking at without an agent typing it a second
 * time — the same mechanism the emailed subject line uses. Which is why the
 * number is written bare rather than decorated: the detector's guards drop a
 * long run of digits that a letter or an adjacent word has grown into.
 *
 * The trailing blank line is where the visitor's own sentence goes. `submit`
 * trims, so it costs nothing if they send without adding one.
 */
export function shipmentChatPrefill(input: {
  locale: Locale;
  trackingNumber: string;
  /** As the badge worded it, or null where the platform gave no status. */
  statusLabel: string | null;
}): string {
  const lines = [`${t(input.locale, 'trackNumber')}: ${input.trackingNumber}`];

  // Omitted rather than filled in with "no status yet": the agent is about to
  // look the parcel up anyway, and a line saying we do not know is one more
  // thing for the customer to read past on the way to their question.
  if (input.statusLabel) {
    lines.push(`${t(input.locale, 'trackStatus')}: ${input.statusLabel}`);
  }

  return `${lines.join('\n')}\n\n`;
}
