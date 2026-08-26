import type { ReactNode } from 'react';
import { CheckIcon } from '@/components/icons';
import { t, type Locale, type StringKey } from '@/lib/kb/locale';
import { TRACKING_STEPS, type StatusTone } from '@/lib/shipments/status';

/**
 * How a shipment's state is drawn on the public tracking page.
 *
 * The one rule this file exists to hold: nothing here invents a fact. The badge
 * shows the label the shipping platform sent, in its own words; the stepper is
 * drawn only when `lib/shipments/status.ts` recognised that label well enough to
 * place it; and neither appears at all when there is no status. A tracking page
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
 * The status, as the platform wrote it.
 *
 * The dot repeats the tone in a second channel so the badge is not colour
 * alone — the design system is explicit that a bare coloured square is never
 * the status. But the word is what carries the meaning, and it is the
 * platform's word rather than a translation of it. Rewriting "Out for delivery" into our
 * own vocabulary would mean a customer reading one thing here and a different
 * thing in the SMS ShipBlu sent them about the same parcel.
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
export function Stepper({ locale, current }: { locale: Locale; current: number }) {
  return (
    <ol className="flex">
      {TRACKING_STEPS.map((step, index) => {
        const done = index < current;
        const here = index === current;
        const reached = done || here;

        return (
          <li
            key={step}
            aria-current={here ? 'step' : undefined}
            className="flex min-w-0 flex-1 basis-0 flex-col gap-2"
          >
            <span className="flex items-center gap-2">
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  reached
                    ? 'bg-[var(--kb-band)] text-[var(--kb-band-text)]'
                    : 'bg-[var(--kb-surface-2)] text-[var(--kb-muted)] ring-1 ring-[var(--kb-border-strong)] ring-inset'
                }`}
              >
                {done ? <CheckIcon size={12} /> : index + 1}
              </span>
              {index < TRACKING_STEPS.length - 1 ? (
                <span
                  aria-hidden
                  className={`h-0.5 min-w-4 flex-1 rounded-full ${
                    done ? 'bg-[var(--kb-band)]' : 'bg-[var(--kb-border)]'
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
              {t(locale, STEP_LABELS[step])}
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
 * `shipments` carries a single `status_label` and `status_at`, not a list of
 * events: the platform sync that would bring a real history is designed but not
 * built (`plans/shipment-customer-tracking.md` §7). So this is deliberately one
 * row and is labelled "last update" rather than "history" — a timeline drawn
 * with one dot on it invites the reader to wonder what happened to the rest.
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
