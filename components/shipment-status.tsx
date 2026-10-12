import { CheckIcon } from './icons';
import type { StatusTone } from '@/lib/shipments/status';

/**
 * A parcel's status, drawn the same way on the public tracking page and in the
 * console's ticket sidebar.
 *
 * Shared because the two are read about the same parcel, often at the same
 * moment — a customer on the phone with the page open, an agent with the ticket
 * — and a badge that is violet for one of them and blue for the other turns
 * "it says out for delivery" into a conversation about colours.
 *
 * Nothing here words anything. Labels arrive translated from the caller —
 * `statusLabel` and `returnStepLabel` in `lib/shipments/status.ts` decide what
 * a status is called, in which language — so this module needs no locale and
 * the console can use it without importing the help centre's strings.
 */

/**
 * Written out rather than built from the tone name, because Tailwind reads
 * these as source text: `bg-(--color-status-${tone}-bg)` compiles to a class
 * nobody generated and a badge with no background at all.
 *
 * `unknown` has no entry on purpose: a status we could not place is drawn as
 * its words alone, with no dot and no fill, so it never borrows the look of a
 * state somebody might act on.
 */
const TONE_CLASS: Record<Exclude<StatusTone, 'unknown'>, string> = {
  'in-transit': 'bg-(--color-status-in-transit-bg) text-(--color-status-in-transit-fg)',
  'out-for-delivery':
    'bg-(--color-status-out-for-delivery-bg) text-(--color-status-out-for-delivery-fg)',
  delivered: 'bg-(--color-status-delivered-bg) text-(--color-status-delivered-fg)',
  attempted: 'bg-(--color-status-attempted-bg) text-(--color-status-attempted-fg)',
  returned: 'bg-(--color-status-returned-bg) text-(--color-status-returned-fg)',
  exception: 'bg-(--color-status-exception-bg) text-(--color-status-exception-fg)',
};

/* Inline padding apart, so the unknown case can drop it without an override. */
const BADGE_SIZE = {
  sm: { box: 'gap-1.5 py-px text-xs font-medium', pad: 'px-2', dot: 'size-1.5' },
  md: { box: 'gap-2 py-1 text-sm font-semibold', pad: 'px-3', dot: 'size-2' },
} as const;

/**
 * The status as a pill with a dot.
 *
 * The dot repeats the tone in a second channel so the badge is not colour
 * alone — a bare coloured square is never the status. But the word is what
 * carries the meaning, which is why it is never left in the platform's English
 * on an Arabic page.
 */
export function StatusBadge({
  label,
  tone,
  size = 'md',
}: {
  label: string;
  tone: StatusTone;
  /** `sm` for the console's 312px column, `md` for the tracking page. */
  size?: 'sm' | 'md';
}) {
  const box = BADGE_SIZE[size];

  if (tone === 'unknown') {
    return (
      <span className={`inline-flex items-center text-(--color-text-primary) ${box.box}`}>
        {label}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full ${box.box} ${box.pad} ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden className={`${box.dot} shrink-0 rounded-full bg-current`} />
      {label}
    </span>
  );
}

/**
 * Which colour a bar is filled in.
 *
 * The return leg is not drawn in the brand blue, and that is the point rather
 * than decoration: two bars that look identical read as one journey continuing,
 * which is exactly the impression a return must not give. The fill inverts the
 * `returned` pair — its foreground as the fill, its background as the text — so
 * the contrast is one the system already guarantees rather than a colour picked
 * here.
 */
const BAR_TONE = {
  brand: {
    fill: 'bg-(--color-action-primary-default) text-(--color-text-on-action)',
    line: 'bg-(--color-action-primary-default)',
  },
  returning: {
    fill: 'bg-(--color-status-returned-fg) text-(--color-status-returned-bg)',
    line: 'bg-(--color-status-returned-fg)',
  },
} as const;

const STEP_SIZE = {
  sm: { label: 'pe-2 text-2xs', gap: 'gap-1.5' },
  md: { label: 'pe-2 text-2xs sm:pe-3 sm:text-xs', gap: 'gap-2' },
} as const;

/**
 * A progress bar over any list of step labels, with everything up to the
 * current one filled in.
 *
 * Takes its labels rather than reading `TRACKING_STEPS` itself, because there
 * are two journeys a parcel can be on and only one of them ends at the
 * recipient. The outbound leg passes the four delivery steps; a return passes
 * `RETURN_STEPS`, worded by `returnStepLabel`, in the `returning` tone.
 *
 * Rendered as an ordered list rather than as a row of divs, so a screen reader
 * gets "3 of 4" from the markup instead of from a colour. `aria-current` marks
 * where the parcel is; the steps behind it say so in text (`doneLabel`),
 * because "this circle is filled" is not information a reader who cannot see
 * it receives.
 *
 * One row at every width, never wrapping. Four steps wrapped to two rows leave
 * the connector after the second one pointing off the edge of the card at
 * nothing — the labels shrink and wrap instead, which costs a line of height and
 * keeps the line reading as one line.
 *
 * Not drawn at all when `current` is null. A held parcel and a returned one are
 * off this line entirely, and putting them on a bar that ends at "delivered"
 * would say the parcel is still on its way.
 */
export function Stepper({
  labels,
  current,
  tone = 'brand',
  size = 'md',
  doneLabel,
}: {
  labels: readonly string[];
  current: number | null;
  tone?: keyof typeof BAR_TONE;
  size?: 'sm' | 'md';
  /** Read after each step behind the current one, e.g. "done" / "تم". */
  doneLabel?: string;
}) {
  if (current === null) return null;

  const colour = BAR_TONE[tone];
  const scale = STEP_SIZE[size];

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
            className={`flex min-w-0 flex-1 basis-0 flex-col ${scale.gap}`}
          >
            <span className={`flex items-center ${scale.gap}`}>
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-bold ${
                  reached
                    ? colour.fill
                    : 'bg-(--color-background-surface-sunken) text-(--color-text-secondary) ring-1 ring-(--color-border-default) ring-inset'
                }`}
              >
                {done ? <CheckIcon size={12} strokeWidth={2.5} /> : index + 1}
              </span>
              {index < labels.length - 1 ? (
                <span
                  aria-hidden
                  className={`h-0.5 min-w-4 flex-1 rounded-full ${
                    done ? colour.line : 'bg-(--color-border-subtle)'
                  }`}
                />
              ) : null}
            </span>
            <span
              className={`${scale.label} ${
                here
                  ? 'font-bold text-(--color-text-primary)'
                  : reached
                    ? 'text-(--color-text-secondary)'
                    : 'text-(--color-text-tertiary)'
              }`}
            >
              {label}
              {done && doneLabel ? <span className="sr-only"> ({doneLabel})</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
