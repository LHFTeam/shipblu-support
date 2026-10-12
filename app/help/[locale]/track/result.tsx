import type { ReactNode } from 'react';
import { formatTimestamp, t, type Locale, type StringKey } from '@/lib/kb/locale';
import {
  commentText,
  returnStatusLabel,
  stageDisplay,
  statusLabel,
  TRACKING_STEPS,
  type PhraseOverrides,
  type StatusTone,
} from '@/lib/shipments/status';
import type { TrackingEvent } from '@/lib/shipments/platform';

/**
 * How a shipment's state is drawn on the public tracking page.
 *
 * The one rule this file exists to hold: nothing here invents a fact. The badge
 * shows the status the shipping platform sent — worded in the reader's language,
 * but never saying more than the platform said; the stepper is drawn only when
 * `lib/shipments/status.ts` recognised that label well enough to place it; and
 * neither appears at all when there is no status. (The badge and the bar
 * themselves live in `components/shipment-status.tsx`, shared with the
 * console's sidebar.) A tracking page
 * that fills its gaps with plausible-looking furniture is worse than one that
 * says it does not know — the person reading it is standing somewhere waiting
 * for a box, and will believe what it says.
 */

const STEP_LABELS: Record<(typeof TRACKING_STEPS)[number], StringKey> = {
  pickedUp: 'trackStepPickedUp',
  inTransit: 'trackStepInTransit',
  outForDelivery: 'trackStepOutForDelivery',
  delivered: 'trackStepDelivered',
};

/** The outbound step names in the reader's language. */
export function deliveryStepLabels(locale: Locale): string[] {
  return TRACKING_STEPS.map((step) => t(locale, STEP_LABELS[step]));
}

/**
 * When the status last moved — the whole of the shipment history this system
 * holds.
 *
 * Used only where the platform sent a status but no events to go with it. Where
 * there is a history, `Timeline` below draws it and carries its own times, and
 * showing both would print the newest event's timestamp twice under two
 * different headings — a timeline drawn with one dot on it invites the reader to
 * wonder what happened to the rest, and a "last update" sitting above a list
 * whose first row says the same thing invites them to wonder which is right.
 *
 * Only the time, not the status word: that word is already the badge four lines
 * above, and printing it twice on a card this short reads as two separate facts
 * that happen to agree.
 */
export function LastUpdate({
  locale,
  when,
  tone = 'brand',
}: {
  locale: Locale;
  when: ReactNode;
  /** `returning` rules it in the return's colour, matching the bar above it. */
  tone?: 'brand' | 'returning';
}) {
  return (
    <TrackFact
      label={t(locale, 'trackLastUpdate')}
      rule={
        tone === 'returning'
          ? 'border-(--color-status-returned-fg)'
          : 'border-(--color-action-primary-default)'
      }
    >
      {when}
    </TrackFact>
  );
}

/**
 * One fact about the parcel — the estimated date, the last update — as a label
 * over its value with a rule at the start edge.
 *
 * The label is never set in capitals or letter-spaced, though a small label
 * over a value often is: the page is read in Arabic first, Arabic has no case,
 * and tracking pulls its joined letters apart.
 */
export function TrackFact({
  label,
  rule = 'border-(--color-action-primary-default)',
  children,
}: {
  label: string;
  /** The border colour, written out in full so Tailwind can see it. */
  rule?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 border-s-2 ps-3.5 ${rule}`}>
      <span className="text-xs font-bold text-(--color-text-secondary)">{label}</span>
      <span className="text-base font-bold text-(--color-text-primary)">{children}</span>
    </div>
  );
}

/**
 * Every event the platform has recorded, newest first.
 *
 * Newest first because the question this page is opened to answer is "what has
 * happened *now*", and a customer on a phone should not have to scroll a
 * ten-row journey to reach the row they came for. The stepper above already
 * carries the shape of the journey; this carries its detail.
 *
 * Ordering is not done here. `mapDeliveryOrder` sorts oldest-first once, on the
 * way out of the platform client, because the endpoint sends these in no order
 * at all — so this reverses a known order rather than establishing one, which is
 * why it can be a single `slice().reverse()` and not a comparator.
 *
 * Every row is worded by `statusLabel`, the same function the badge above uses.
 * A history that stayed in the platform's English under an Arabic badge would be
 * the worst of both: the customer can read that the parcel is out for delivery
 * but not one line of how it got there.
 *
 * The comment under a row goes through `commentText`, which translates the
 * courier's reason code and leaves the courier's own words alone. On a failed
 * delivery that line is the one the recipient came for, and it is the only place
 * on this page where our wording and a human being's sit in the same sentence.
 *
 * `dir="ltr"` on the timestamp for the same reason the number field has it: a
 * date and time is a run of Latin digits, and left to inherit RTL the browser
 * reorders the parts.
 */
export function Timeline({
  locale,
  events,
  overrides,
  returnFrom = null,
}: {
  locale: Locale;
  events: TrackingEvent[];
  overrides: PhraseOverrides;
  /**
   * When the journey back began, so the rows after it can be read as the way
   * back. Null on an ordinary parcel.
   *
   * Without this the history contradicts the bar above it: the same
   * `in_transit` event means "on its way to you" outbound and "on its way back"
   * during a return, and the delivery table only knows the first reading.
   */
  returnFrom?: Date | null;
}) {
  if (events.length === 0) return null;

  const newestFirst = events.slice().reverse();

  return (
    <section>
      <h2 className="mb-3 text-xs font-bold text-(--color-text-secondary)">
        {t(locale, 'trackHistory')}
      </h2>

      <ol className="flex flex-col">
        {newestFirst.map((event, index) => {
          const latest = index === 0;
          const onReturnLeg = returnFrom !== null && event.at.getTime() >= returnFrom.getTime();
          // A parcel on its way back wears the returned tone, whatever the
          // outbound reading of the same event would have been.
          const tone = onReturnLeg ? 'returned' : stageDisplay(event.status).tone;

          return (
            <li key={`${event.status}-${event.at.toISOString()}`} className="flex gap-3">
              {/* The rail: a dot per event and a line between them, drawn as one
                  column so the line ends at the last dot rather than running on
                  past it. */}
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className={`mt-1.5 size-2.5 shrink-0 rounded-full ${
                    latest ? TONE_DOT[tone] : 'bg-(--color-border-default)'
                  }`}
                />
                {index < newestFirst.length - 1 ? (
                  <span aria-hidden className="w-px flex-1 bg-(--color-border-subtle)" />
                ) : null}
              </div>

              <div className={index < newestFirst.length - 1 ? 'pb-4' : ''}>
                <p className={`text-base text-(--color-text-primary) ${latest ? 'font-bold' : ''}`}>
                  {onReturnLeg
                    ? returnStatusLabel(locale, event.status, overrides)
                    : statusLabel(locale, event.status, overrides)}
                </p>
                <time
                  dir="ltr"
                  dateTime={event.at.toISOString()}
                  className="text-xs text-(--color-text-secondary) tabular-nums"
                >
                  {formatTimestamp(locale, event.at)}
                </time>
                {event.comment ? (
                  /* `dir="auto"`: a courier's own words can be in the other
                     script from the page, and inheriting its direction would
                     reorder them. */
                  <p dir="auto" className="mt-0.5 text-start text-xs text-(--color-text-secondary)">
                    {commentText(locale, event.comment, overrides)}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The dot colour for the newest event only.
 *
 * Written out rather than interpolated: Tailwind reads these as source text,
 * and a built class name is never generated.
 * Only the newest row is toned — colouring all ten turns a history into a
 * fairground and stops the current status being the thing the eye lands on.
 */
const TONE_DOT: Record<StatusTone, string> = {
  'in-transit': 'bg-(--color-status-in-transit-fg)',
  'out-for-delivery': 'bg-(--color-status-out-for-delivery-fg)',
  delivered: 'bg-(--color-status-delivered-fg)',
  attempted: 'bg-(--color-status-attempted-fg)',
  returned: 'bg-(--color-status-returned-fg)',
  exception: 'bg-(--color-status-exception-fg)',
  unknown: 'bg-(--color-status-unknown-fg)',
};
