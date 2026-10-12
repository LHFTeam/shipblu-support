import type { LinkedShipment } from '@/lib/shipments/queries';
import {
  humaniseStatus,
  RETURN_STEPS,
  returnStepLabel,
  stageDisplay,
  type StatusTone,
} from '@/lib/shipments/status';

/**
 * What a parcel's card in the details column says about it: the status in
 * words, the badge's tone, which bar it walks and how far along, and the date
 * it is due.
 *
 * Pure, and kept out of the component, because the rule it encodes is the one
 * that has already been wrong in production. The platform leaves the status
 * reading `delivery_attempted` for the whole of a return, so a card that drew
 * the label would tell an agent on a call that a parcel is still coming
 * (`docs/PROJECT-STATE.md` §6.40). A return therefore outranks the label
 * everywhere here — the words, the tone and the bar — and the return's own
 * step is the honest answer, the one the customer is ringing about.
 *
 * `LinkedShipment` is imported as a type only: `lib/shipments/queries.ts`
 * reaches the database, and a value import would put the schema in the
 * console's client bundle.
 */
export function shipmentCard(
  shipment: Pick<
    LinkedShipment,
    'returnStep' | 'syncState' | 'statusLabel' | 'currentEstimatedDate'
  >,
): {
  label: string;
  tone: StatusTone;
  bar: { tone: 'brand' | 'returning'; step: number; labels: string[] } | null;
  due: string | null;
} {
  const { returnStep, syncState, statusLabel, currentEstimatedDate } = shipment;
  const stage = stageDisplay(statusLabel);

  if (returnStep !== null) {
    return {
      label: returnStepLabel('en', returnStep),
      tone: 'returned',
      bar: { tone: 'returning', step: returnStep, labels: RETURN_LABELS_EN },
      // A returning parcel is not being delivered to anybody, so it has no
      // date to be due on.
      due: null,
    };
  }

  const synced = syncState === 'synced';
  const label = synced
    ? statusLabel
      ? humaniseStatus(statusLabel)
      : 'No status yet'
    : syncState === 'not_found'
      ? 'Not a shipment on the platform'
      : 'Not synced yet';

  return {
    label,
    // A stub or a number the platform does not know has no status to colour:
    // drawn as words alone, it cannot be mistaken for a state somebody acts on.
    tone: synced && statusLabel ? stage.tone : 'unknown',
    bar:
      synced && stage.step !== null
        ? { tone: 'brand', step: stage.step, labels: TRACKING_LABELS_EN }
        : null,
    // The date the customer is actually asking about, and only while it is
    // still a prediction — never under a delivered parcel. Not gated on the
    // sync state, as it never has been: the estimate is its own read. A string
    // throughout, because `new Date('2026-08-29')` is midnight UTC and the
    // evening before further west.
    due: currentEstimatedDate && !stage.terminal ? currentEstimatedDate : null,
  };
}

/**
 * The four outbound steps in English, in `TRACKING_STEPS` order.
 *
 * Written out rather than read from `lib/kb/locale.ts`, whose `trackStep*`
 * entries say the same words: that module is the help centre's whole bilingual
 * dictionary, and importing it here would ship it to every agent on the
 * console's busiest route — the reason `knowledge.tsx` gives for not importing
 * `direction()`. If the help centre's English steps are reworded, these follow.
 */
const TRACKING_LABELS_EN = ['Picked up', 'In transit', 'Out for delivery', 'Delivered'];

const RETURN_LABELS_EN = RETURN_STEPS.map((_, step) => returnStepLabel('en', step));
