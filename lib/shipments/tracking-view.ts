import type { AgentTracking } from './detail';
import { humaniseStatus, returnProgress, returnStepLabel, type ReturnProgress } from './status';

/**
 * What an agent's screen says about one parcel's tracking: its status in words
 * and its history, newest first, each event marked with the leg it belongs to.
 *
 * One copy for the console's shipment page and the WhatsApp Web extension's
 * Shipments tab, because both rules in it have already been wrong once. The
 * platform leaves the status at `delivery_attempted` for the whole of a return,
 * so the words come from the return's own step when there is one (§6.40); and
 * the same `in_transit` event means "on its way to you" before the turnaround
 * and "on its way back" after it, so a flat history has to say which leg each
 * row is on. A second screen deriving either for itself is where the two would
 * start to disagree about the same parcel.
 *
 * Pure, and over the type rather than the column: `shipments.data` is read in
 * `lookup.ts` and `detail.ts` only.
 */
export type TrackingView = {
  /** Null when the parcel is not going back. */
  returning: ReturnProgress | null;
  /** The status as the agent should read it. */
  statusLabel: string;
  /** The platform's own word on a return, kept because an agent comparing screens sees it. */
  platformSays: string | null;
  events: { label: string; at: Date; comment: string | null; onReturnLeg: boolean }[];
};

export function trackingView(detail: AgentTracking): TrackingView {
  const returning = returnProgress({
    rtoRequested: detail.rtoRequested,
    status: detail.status,
    events: detail.events,
  });
  const turnedAt = returning?.startedAt?.getTime() ?? null;

  return {
    returning,
    statusLabel: returning ? returnStepLabel('en', returning.step) : humaniseStatus(detail.status),
    platformSays: returning ? humaniseStatus(detail.status) : null,
    // `mapDeliveryOrder` sorted these oldest-first on the way in — the platform
    // sends them unordered — so this reverses a known order rather than
    // establishing one.
    events: detail.events
      .slice()
      .reverse()
      .map((event) => ({
        label: humaniseStatus(event.status),
        at: event.at,
        comment: event.comment,
        onReturnLeg: turnedAt !== null && event.at.getTime() >= turnedAt,
      })),
  };
}
