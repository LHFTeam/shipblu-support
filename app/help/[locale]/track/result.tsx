import type { ReactNode } from 'react';
import { CheckIcon } from '@/components/icons';
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
 * neither appears at all when there is no status. A tracking page
 * that fills its gaps with plausible-looking furniture is worse than one that
 * says it does not know — the person reading it is standing somewhere waiting
 * for a box, and will believe what it says.
 */

/**
 * Written out rather than built from the tone name, because Tailwind reads
 * these as source text: `bg-[var(--color-status-${tone}-bg)]` compiles to a
 * class nobody generated and a badge with no background at all.
 */
const TONE_CLASS: Record<StatusTone, string> = {
  'in-transit': 'bg-[var(--color-status-in-transit-bg)] text-[var(--color-status-in-transit-fg)]',
  'out-for-delivery':
    'bg-[var(--color-status-out-for-delivery-bg)] text-[var(--color-status-out-for-delivery-fg)]',
  delivered: 'bg-[var(--color-status-delivered-bg)] text-[var(--color-status-delivered-fg)]',
  attempted: 'bg-[var(--color-status-attempted-bg)] text-[var(--color-status-attempted-fg)]',
  returned: 'bg-[var(--color-status-returned-bg)] text-[var(--color-status-returned-fg)]',
  exception: 'bg-[var(--color-status-exception-bg)] text-[var(--color-status-exception-fg)]',
  unknown: 'bg-[var(--color-status-unknown-bg)] text-[var(--color-status-unknown-fg)]',
};

/**
 * The status, in the language the page is being read in.
 *
 * The dot repeats the tone in a second channel so the badge is not colour
 * alone — the design system is explicit that a bare coloured square is never
 * the status. But the word is what carries the meaning, which is why it is not
 * left in the platform's English on an Arabic page: `statusLabel` in
 * `lib/shipments/status.ts` decides the wording, and this only draws it.
 */
export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden className="size-2 rounded-full bg-current" />
      {label}
    </span>
  );
}

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
 * The four steps, with everything up to the current one filled in.
 *
 * Rendered as an ordered list rather than as a row of divs, so a screen reader
 * gets "3 of 4" from the markup instead of from a colour. `aria-current` marks
 * where the parcel is; the steps behind it say so in text, because "this circle
 * is filled" is not information a reader who cannot see it receives.
 *
 * One row at every width, never wrapping. Four steps wrapped to two rows leave
 * the connector after the second one pointing off the edge of the card at
 * nothing — the labels shrink and wrap instead, which costs a line of height and
 * keeps the line reading as one line.
 *
 * Not drawn at all when `step` is null. A held parcel and a returned one are off
 * this line entirely, and putting them on a bar that ends at "delivered" would
 * say the parcel is still on its way.
 */
/**
 * Which colour a bar is filled in.
 *
 * The return leg is not drawn in the brand band, and that is the point rather
 * than decoration: two bars that look identical read as one journey continuing,
 * which is exactly the impression a return must not give. The fill inverts the
 * design system's `returned` pair — its foreground as the fill, its background
 * as the text — so the contrast is one the system already guarantees rather than
 * a colour picked here.
 */
const BAR_TONE = {
  brand: {
    fill: 'bg-[var(--kb-band)] text-[var(--kb-band-text)]',
    line: 'bg-[var(--kb-band)]',
  },
  returning: {
    fill: 'bg-[var(--color-status-returned-fg)] text-[var(--color-status-returned-bg)]',
    line: 'bg-[var(--color-status-returned-fg)]',
  },
} as const;

/**
 * A progress bar over any list of step labels.
 *
 * Takes its labels rather than reading `TRACKING_STEPS` itself, because there
 * are two journeys a parcel can be on and only one of them ends at the
 * recipient. The outbound leg passes the four delivery steps; a return passes
 * `RETURN_STEPS`, whose wording comes from `returnStepLabel` so an admin can
 * correct the Arabic in `/admin/tracking` like any other phrase.
 */
export function Stepper({
  labels,
  current,
  tone = 'brand',
}: {
  labels: readonly string[];
  current: number;
  tone?: keyof typeof BAR_TONE;
}) {
  const colour = BAR_TONE[tone];

  return (
    <ol className="flex">
      {labels.map((label, index) => {
        const done = index < current;
        const here = index === current;
        const reached = done || here;

        return (
          <li
            key={label}
            aria-current={here ? 'step' : undefined}
            className="flex min-w-0 flex-1 basis-0 flex-col gap-2"
          >
            <span className="flex items-center gap-2">
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  reached
                    ? colour.fill
                    : 'bg-[var(--kb-surface-2)] text-[var(--kb-muted)] ring-1 ring-[var(--kb-border-strong)] ring-inset'
                }`}
              >
                {done ? <CheckIcon size={12} /> : index + 1}
              </span>
              {index < labels.length - 1 ? (
                <span
                  aria-hidden
                  className={`h-0.5 min-w-4 flex-1 rounded-full ${
                    done ? colour.line : 'bg-[var(--kb-border)]'
                  }`}
                />
              ) : null}
            </span>
            <span
              className={`pe-2 text-[11px] sm:pe-3 sm:text-xs ${
                here
                  ? 'font-semibold text-[var(--kb-heading)]'
                  : reached
                    ? 'text-[var(--kb-muted)]'
                    : 'text-[var(--kb-muted)] opacity-60'
              }`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
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
export function LastUpdate({ locale, when }: { locale: Locale; when: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-s-2 border-[var(--kb-band)] ps-3.5">
      <span className="text-xs font-semibold tracking-wide text-[var(--kb-muted)] uppercase">
        {t(locale, 'trackLastUpdate')}
      </span>
      <span className="font-medium text-[var(--kb-heading)]">{when}</span>
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
      <h2 className="mb-3 text-xs font-semibold tracking-wide text-[var(--kb-muted)] uppercase">
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
                    latest ? TONE_DOT[tone] : 'bg-[var(--kb-border-strong)]'
                  }`}
                />
                {index < newestFirst.length - 1 ? (
                  <span aria-hidden className="w-px flex-1 bg-[var(--kb-border)]" />
                ) : null}
              </div>

              <div className={index < newestFirst.length - 1 ? 'pb-4' : ''}>
                <p
                  className={
                    latest
                      ? 'font-semibold text-[var(--kb-heading)]'
                      : 'text-[var(--kb-heading)]/80'
                  }
                >
                  {onReturnLeg
                    ? returnStatusLabel(locale, event.status, overrides)
                    : statusLabel(locale, event.status, overrides)}
                </p>
                <time
                  dir="ltr"
                  dateTime={event.at.toISOString()}
                  className="text-xs text-[var(--kb-muted)] tabular-nums"
                >
                  {formatTimestamp(locale, event.at)}
                </time>
                {event.comment ? (
                  <p className="mt-0.5 text-xs text-[var(--kb-muted)]">
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
 * Written out rather than interpolated, for the reason `TONE_CLASS` above is:
 * Tailwind reads these as source text and a built class name is never generated.
 * Only the newest row is toned — colouring all ten turns a history into a
 * fairground and stops the current status being the thing the eye lands on.
 */
const TONE_DOT: Record<StatusTone, string> = {
  'in-transit': 'bg-[var(--color-status-in-transit-fg)]',
  'out-for-delivery': 'bg-[var(--color-status-out-for-delivery-fg)]',
  delivered: 'bg-[var(--color-status-delivered-fg)]',
  attempted: 'bg-[var(--color-status-attempted-fg)]',
  returned: 'bg-[var(--color-status-returned-fg)]',
  exception: 'bg-[var(--color-status-exception-fg)]',
  unknown: 'bg-[var(--color-status-unknown-fg)]',
};
