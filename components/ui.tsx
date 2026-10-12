import type { ComponentProps, JSX, ReactNode } from 'react';
import {
  AlertCircleIcon,
  CheckIcon,
  ClockIcon,
  GlobeIcon,
  HubIcon,
  InfoIcon,
  LockIcon,
  WarningIcon,
} from './icons';
import { InfoTip } from './tooltip';

/**
 * Shared primitives.
 *
 * Deliberately not a component library: the console needs about a dozen
 * repeated shapes, and a dependency would cost more in bundle size and upgrade
 * churn than it saves. Everything here is a styled element — behaviour lives in
 * the feature that needs it.
 */

/**
 * A native element's props, minus `title`.
 *
 * The primitives here spread what they are given onto the element they wrap, so
 * a `title` handed to `<Button>` lands on a `<button>` as the tooltip a phone
 * never shows. The `dom-title` repo rule refuses that on a lowercase tag and
 * cannot see through a capitalised one, so the type refuses it instead, at the
 * call site, in `tsc`. `ComponentProps<'svg'>` has no `title` to begin with,
 * which is why the icons need nothing.
 */
type NativeProps<T extends keyof JSX.IntrinsicElements> = Omit<ComponentProps<T>, 'title'>;

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'note';
type ButtonSize = 'sm' | 'md';

/*
 * There is no coral variant, and that is the point rather than an omission.
 * Coral is attention — a count, a window about to close, a hub that answered —
 * and a button painted in it reads as one more thing shouting, so every action
 * on every surface is the one blue. `note` is the composer's "Add note", amber
 * because a private note has to look nothing like a reply at the moment it is
 * sent, not because it is more urgent than one.
 *
 * Each filled variant carries its own `border-transparent` rather than the base
 * carrying it once: Tailwind orders same-property utilities by name, not by
 * where they sit in the class attribute, so a base `border-transparent` would
 * outrank `secondary`'s border colour and erase it. The 1px border is on every
 * variant so a primary and a secondary beside each other are the same height.
 */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border-transparent bg-(--button-primary) text-(--color-text-on-action) shadow-sm hover:bg-(--button-primary-hover) active:bg-(--button-primary-active) disabled:hover:bg-(--button-primary)',
  secondary:
    'border-(--color-border-default) bg-(--color-background-surface) text-(--color-text-primary) hover:bg-(--color-background-hover) active:bg-(--color-background-pressed) disabled:hover:bg-(--color-background-surface)',
  ghost:
    'border-transparent text-(--color-text-primary) hover:bg-(--color-background-hover) active:bg-(--color-background-pressed) disabled:hover:bg-transparent',
  danger:
    'border-transparent bg-(--button-danger) text-(--color-text-on-action) hover:bg-(--button-danger-hover) active:bg-(--button-danger-hover) disabled:hover:bg-(--button-danger)',
  note: 'border-transparent bg-(--color-feedback-warning-fg) text-(--color-text-on-action) shadow-sm hover:bg-(--color-message-note-fg) active:bg-(--color-message-note-fg) disabled:hover:bg-(--color-feedback-warning-fg)',
};

/*
 * 42px tall on a phone, beside the 42px field it usually sits next to; 34px
 * from `sm` up. A minimum rather than a height, so a label that wraps grows
 * the button instead of spilling out of it.
 */
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-[26px] px-2.5 py-1 text-xs',
  md: 'min-h-[34px] px-3 py-1.5 text-sm max-sm:min-h-[42px] max-sm:px-3.5',
};

/**
 * A button's classes without the button, for a `Link` that has to look like
 * one — "New article", "All reports". Server-safe, so a page can call it.
 *
 * A caller's `className` is appended after these and can still lose to any
 * utility here that sets the same property (see `BUTTON_VARIANTS`). A width or
 * a margin is safe; a colour or a height needs the `!` suffix, or a variant of
 * its own.
 */
export function buttonClass({
  variant = 'primary',
  size = 'md',
}: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  return `inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]}`;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className = '',
  children,
  ...props
}: NativeProps<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Shows a spinner and sets `aria-busy`. It does not disable the button —
   * the caller decides that, as `SubmitButton` does — and it does not replace
   * the label, which should say what is happening in words ("Sending…"),
   * because motion alone is not a message.
   */
  loading?: boolean;
  /** A leading glyph. Hidden while loading, so a busy button shows one mark, not two. */
  icon?: ReactNode;
}) {
  return (
    <button
      // HTML defaults a button inside a form to `submit`, and almost every
      // Button here is a `<Button onClick={…}>` that opens an editor — which,
      // the first time one of those was placed *inside* a form, meant clicking
      // "show me the validation rules" saved the record instead. Defaulting to
      // `button` makes the safe case the one you get by not thinking about it;
      // `SubmitButton` is the only thing that submits, and it says so.
      type="button"
      aria-busy={loading || undefined}
      {...props}
      className={`${buttonClass({ variant, size })} ${className}`}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-e-transparent motion-reduce:animate-none motion-reduce:border-e-current motion-reduce:opacity-50"
        />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

/**
 * 16px on a phone, 14px from `sm` up.
 *
 * Not a taste decision: iOS Safari zooms the page in when a field smaller than
 * 16px takes focus, and it does not zoom back out. In a viewport-height layout
 * with no page scroll that leaves the agent stranded inside a composer they
 * then have to pan around, which is most of what "the composer is broken on my
 * phone" turns out to mean.
 *
 * `aria-invalid` is styled here because callers already set it — the ticket
 * field inputs and the help-centre forms do — and until now it showed nothing.
 */
const FIELD_BASE =
  'w-full rounded-md border text-base sm:text-sm placeholder:text-(--color-text-tertiary) outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-(--color-feedback-danger-fg)';

/**
 * A field's surface and its focus, held apart from `FIELD_BASE` so the
 * component can swap them, which a caller cannot.
 *
 * Passing a background through `className` looks like it should win and often
 * does not: two background utilities are of equal specificity, so the winner is
 * whichever Tailwind emits later, and it orders same-property utilities by
 * name, not by where they sit in the class attribute. A read-only field styled
 * from the call site therefore rendered exactly like an editable one, which is
 * the opposite of the point. The focus ring is the same trap in a variant: no
 * class can be relied on to cancel `focus:border-(--color-border-focus)`, so
 * the read-only surface, which must not light up as if it took typing, leaves
 * the focus classes out instead.
 *
 * `note` is the private-note composer: amber paper, focused in amber rather
 * than in the action blue, so an agent typing a note never sees the box turn
 * into the reply box.
 */
const FIELD_SURFACE = {
  default:
    'border-(--color-border-subtle) bg-(--color-background-surface) text-(--color-text-primary) hover:border-(--color-border-default) focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20 aria-invalid:focus:ring-(--color-feedback-danger-fg)/20',
  note: 'border-(--color-message-note-border) bg-(--color-message-note-bg) text-(--color-text-primary) focus:border-(--color-feedback-warning-fg) focus:ring-2 focus:ring-(--color-feedback-warning-fg)/20',
  readOnly:
    'border-(--color-border-subtle) bg-(--color-background-hover) text-(--color-text-secondary) cursor-default',
};

type FieldTone = 'default' | 'note';

export function Input({
  className = '',
  tone = 'default',
  ...props
}: NativeProps<'input'> & { tone?: FieldTone }) {
  /*
   * A read-only field is not a disabled one — it stays focusable, announced and
   * copyable, which is what a prefilled identity on the invite-activation page
   * needs. It just must not look like a box somebody is expected to type in.
   *
   * Keyed off the prop rather than the `read-only:` variant because CSS
   * `:read-only` also matches every *disabled* field, and dimming those was not
   * asked for here.
   */
  const surface = props.readOnly ? FIELD_SURFACE.readOnly : FIELD_SURFACE[tone];

  return <input {...props} className={`${FIELD_BASE} ${surface} px-3 py-2 ${className}`} />;
}

export function Textarea({
  className = '',
  tone = 'default',
  ...props
}: NativeProps<'textarea'> & { tone?: FieldTone }) {
  return (
    <textarea
      {...props}
      className={`${FIELD_BASE} ${FIELD_SURFACE[tone]} resize-y px-3 py-2 ${className}`}
    />
  );
}

export function Select({ className = '', ...props }: NativeProps<'select'>) {
  // Taller on a phone, where 1.5 of padding around 14px text is a 34px tap
  // target sat next to a 42px input in the same row.
  //
  // Still the native control, arrow included: the platform's picker is what a
  // phone shows, and `name`, `defaultValue` and React's form reset — which
  // `useActionForm` and `rereadOnRefusal` are written against — all come with it.
  return (
    <select
      {...props}
      className={`${FIELD_BASE} ${FIELD_SURFACE.default} px-2 py-2 sm:py-1.5 ${className}`}
    />
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-medium text-(--color-text-secondary)"
    >
      {children}
    </label>
  );
}

/**
 * A labelled control with optional help text, which is most of an admin form.
 *
 * The label *wraps* the control rather than pointing at it with `htmlFor`.
 * Implicit association needs no ids, which means no caller can forget to keep
 * an id and a `htmlFor` in step — and a label nobody can click is a label a
 * screen reader does not read out either.
 *
 * `group` is for a composite control (a rule builder, a grid of inputs), where
 * one label cannot belong to one input; that renders a labelled group instead,
 * which is what assistive technology expects for a set of related fields.
 */
export function Field({
  label,
  hint,
  explain,
  as = 'label',
  children,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  /**
   * The ⓘ beside the label. A `hint` is always on screen and belongs to
   * anything an admin needs while filling the field in; `explain` is for what
   * the setting *is*, which is read once and would be clutter underneath every
   * control in a twelve-field form.
   */
  explain?: ReactNode;
  as?: 'label' | 'group';
  children: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-(--color-text-secondary)">
        {label}
        {explain ? <InfoTip label={label}>{explain}</InfoTip> : null}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-(--color-text-secondary)">{hint}</span>
      ) : null}
    </>
  );

  if (as === 'group') {
    return (
      <div role="group" aria-label={label} className={className}>
        {body}
      </div>
    );
  }

  return <label className={`block ${className}`}>{body}</label>;
}

/*
 * A statically enumerated union rather than the design system's
 * `channel-${string}`: Tailwind cannot see a class name built at runtime, and
 * a typo in a tone should fail `tsc`, not render unstyled. Channels and parcel
 * statuses are not here at all — `components/channel.tsx` and
 * `components/shipment-status.tsx` own those, so each has one map.
 */
export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'open'
  | 'pending'
  | 'resolved'
  | 'closed'
  | 'priority-low'
  | 'priority-medium'
  | 'priority-high'
  | 'priority-urgent'
  | 'window-open'
  | 'window-closing'
  | 'window-closed'
  | 'hub-waiting'
  | 'hub-replied'
  | 'attention'
  | 'note'
  | 'public'
  | 'private'
  | 'automated';

/*
 * One entry of the state grid each. The decisions that are not obvious from the
 * names:
 *
 * - `open` is an ink outline, not green. Most rows in the inbox are open, and a
 *   colour on every one of them is a colour that says nothing; green belongs to
 *   `resolved`, which is the state worth noticing.
 * - A `note` is amber paper with a lock and a `public` post a solid ink pill
 *   with a globe, so "only we see this" and "the whole post sees this" cannot be
 *   mistaken for one another at a glance.
 * - `automated` is dashed: the dashed edge is the system's one sign for
 *   something a machine wrote, on badges, bubbles and the bot channel alike.
 * - The solid tones (`window-closing`, `hub-replied`, `attention`) are coral,
 *   the attention colour, and are the only badges a row should ever shout with.
 */
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-transparent bg-(--color-feedback-neutral-bg) text-(--color-feedback-neutral-fg)',
  brand: 'border-transparent bg-(--color-feedback-info-bg) text-(--color-feedback-info-fg)',
  info: 'border-transparent bg-(--color-feedback-info-bg) text-(--color-feedback-info-fg)',
  success: 'border-transparent bg-(--color-feedback-success-bg) text-(--color-feedback-success-fg)',
  warning: 'border-transparent bg-(--color-feedback-warning-bg) text-(--color-feedback-warning-fg)',
  danger: 'border-transparent bg-(--color-feedback-danger-bg) text-(--color-feedback-danger-fg)',
  open: 'border-(--color-ticket-open-border) bg-(--color-ticket-open-bg) text-(--color-ticket-open-fg)',
  pending: 'border-transparent bg-(--color-ticket-pending-bg) text-(--color-ticket-pending-fg)',
  resolved: 'border-transparent bg-(--color-ticket-resolved-bg) text-(--color-ticket-resolved-fg)',
  closed: 'border-transparent bg-(--color-ticket-closed-bg) text-(--color-ticket-closed-fg)',
  'priority-low': 'border-transparent bg-(--color-priority-low-bg) text-(--color-priority-low-fg)',
  'priority-medium':
    'border-transparent bg-(--color-priority-medium-bg) text-(--color-priority-medium-fg)',
  'priority-high':
    'border-transparent bg-(--color-priority-high-bg) text-(--color-priority-high-fg)',
  'priority-urgent':
    'border-transparent bg-(--color-priority-urgent-bg) text-(--color-priority-urgent-fg)',
  'window-open': 'border-transparent bg-(--color-window-open-bg) text-(--color-window-open-fg)',
  'window-closing':
    'border-transparent bg-(--color-window-closing-bg) text-(--color-window-closing-fg)',
  'window-closed':
    'border-transparent bg-(--color-window-closed-bg) text-(--color-window-closed-fg)',
  'hub-waiting': 'border-transparent bg-(--color-hub-waiting-bg) text-(--color-hub-waiting-fg)',
  'hub-replied': 'border-transparent bg-(--color-hub-replied-bg) text-(--color-hub-replied-fg)',
  attention: 'border-transparent bg-(--color-attention-bg) text-(--color-attention-fg)',
  note: 'border-(--color-message-note-border) bg-(--color-message-note-bg) text-(--color-message-note-fg)',
  public:
    'border-(--color-message-public-border) bg-(--color-message-public-bg) text-(--color-message-public-fg)',
  private: 'border-transparent bg-(--color-feedback-neutral-bg) text-(--color-feedback-neutral-fg)',
  automated:
    'border-dashed border-(--color-border-strong) bg-(--color-message-system-bg) text-(--color-feedback-neutral-fg)',
};

/** How many of the four bars each priority fills. */
const PRIORITY_BARS: Partial<Record<BadgeTone, number>> = {
  'priority-low': 1,
  'priority-medium': 2,
  'priority-high': 3,
  'priority-urgent': 4,
};

/**
 * The signal-strength mark: all four bars are always drawn, so "low" reads as
 * one of four rather than as a lone tick, and the unreached ones are faint.
 */
function PriorityBars({ filled }: { filled: number }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
      {[0, 1, 2, 3].map((index) => (
        <rect
          key={index}
          x={index * 2.6}
          y={8 - index * 2.4}
          width="1.8"
          height={2 + index * 2.4}
          rx="0.6"
          fill="currentColor"
          opacity={index < filled ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

/** The mark a tone carries when the caller names none. */
function badgeGlyph(tone: BadgeTone): ReactNode {
  const bars = PRIORITY_BARS[tone];
  if (bars) return <PriorityBars filled={bars} />;

  const glyph = { size: 12, className: 'shrink-0' };
  switch (tone) {
    case 'open':
      return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />;
    case 'note':
    case 'private':
    case 'window-closed':
      return <LockIcon {...glyph} />;
    case 'public':
      return <GlobeIcon {...glyph} />;
    case 'window-open':
    case 'window-closing':
      return <ClockIcon {...glyph} />;
    case 'hub-waiting':
    case 'hub-replied':
      return <HubIcon {...glyph} />;
    default:
      return null;
  }
}

/**
 * A small worded label. The word is always there and the tone's glyph beside
 * it, so the colour is never the only thing carrying the meaning — the same
 * rule a colour-blind agent and a greyscale screenshot both need.
 */
export function Badge({
  children,
  tone = 'neutral',
  icon,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  /**
   * Replaces the tone's own mark — the lock, the clock, a priority's bars, the
   * open dot. `false` draws none, for a badge whose neighbour already says it.
   */
  icon?: false | ReactNode;
}) {
  const glyph = icon === false ? null : (icon ?? badgeGlyph(tone));

  return (
    <span
      // 1px of border and 1px of padding: the same 20px as the borderless
      // badges this replaced, so an outlined `open` lines up with the rest.
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-xs font-medium whitespace-nowrap ${BADGE_TONES[tone]}`}
    >
      {glyph}
      {children}
    </span>
  );
}

/**
 * The coral count on a nav item: hidden at zero, capped at 99+.
 *
 * The number is drawn and `label` follows it for a screen reader as a visually
 * hidden word, so it is announced as "12 unread" rather than as a bare "12" —
 * an `aria-label` on a plain span would not do that, because ARIA does not
 * name an element with no role. `ring` cuts it out of the icon it overlaps, in
 * the colour of whatever is behind it; `className` is for placing it.
 */
export function CountBadge({
  count,
  label,
  ring,
  className = '',
}: {
  count: number;
  label: string;
  ring?: 'surface' | 'rail';
  className?: string;
}) {
  if (count <= 0) return null;
  const rings = {
    surface: 'ring-2 ring-(--color-background-surface)',
    rail: 'ring-2 ring-(--color-background-rail)',
  };

  return (
    <span
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-(--color-attention-bg) px-1 text-2xs font-semibold text-(--color-attention-fg) tabular-nums ${ring ? rings[ring] : ''} ${className}`}
    >
      {count > 99 ? '99+' : count}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

type NoticeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const NOTICE_TONES: Record<NoticeTone, string> = {
  neutral:
    'border-(--color-feedback-neutral-border) bg-(--color-feedback-neutral-bg) text-(--color-feedback-neutral-fg)',
  info: 'border-(--color-feedback-info-border) bg-(--color-feedback-info-bg) text-(--color-feedback-info-fg)',
  success:
    'border-(--color-feedback-success-border) bg-(--color-feedback-success-bg) text-(--color-feedback-success-fg)',
  warning:
    'border-(--color-feedback-warning-border) bg-(--color-feedback-warning-bg) text-(--color-feedback-warning-fg)',
  danger:
    'border-(--color-feedback-danger-border) bg-(--color-feedback-danger-bg) text-(--color-feedback-danger-fg)',
};

function noticeGlyph(tone: NoticeTone) {
  const glyph = { size: 16, className: 'shrink-0' };
  if (tone === 'success') return <CheckIcon {...glyph} />;
  if (tone === 'warning') return <WarningIcon {...glyph} />;
  if (tone === 'danger') return <AlertCircleIcon {...glyph} />;
  return <InfoIcon {...glyph} />;
}

/**
 * A standing note about the page — "the figures start on 8 September", "nothing
 * will be sent while this is off" — as opposed to `ErrorText`/`SuccessText`,
 * which answer something the reader just did.
 *
 * Pick the tone by what the note *is*: an observation is `info` even when it
 * explains a gap, and `warning` is kept for something that will go wrong if
 * nobody acts. No role, because it is part of the page rather than news about
 * it. `icon` takes the tone's own glyph when `true`.
 */
export function Notice({
  tone = 'info',
  icon,
  className = '',
  children,
}: {
  tone?: NoticeTone;
  icon?: boolean | ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const glyph = icon === true ? noticeGlyph(tone) : icon || null;

  return (
    <div
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${NOTICE_TONES[tone]} ${className}`}
    >
      {glyph}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/*
 * Each message's text is wrapped in a span of its own. A flex `<p>` makes every
 * inline child a flex item, so a sentence with a link in it would come apart
 * into three blocks with gaps between them.
 */

/**
 * An error, with `role="alert"` so it is announced when it appears.
 *
 * `inline` is the cell-sized form — beside a button in a table row, under one
 * field — with no fill and no role, because a table whose rows each announce
 * themselves is noise; the block form is for a form's own answer.
 */
export function ErrorText({ children, inline = false }: { children: ReactNode; inline?: boolean }) {
  if (!children) return null;

  if (inline) {
    return (
      <span className="inline-flex items-start gap-1 text-xs text-(--color-feedback-danger-fg)">
        <AlertCircleIcon size={14} className="mt-px shrink-0" />
        <span className="min-w-0">{children}</span>
      </span>
    );
  }

  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md bg-(--color-feedback-danger-bg) px-3 py-2 text-sm text-(--color-feedback-danger-fg)"
    >
      <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A confirmation, announced politely: `status` waits for the reader to finish. */
export function SuccessText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md bg-(--color-feedback-success-bg) px-3 py-2 text-sm text-(--color-feedback-success-fg)"
    >
      <CheckIcon size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-(--color-text-secondary)">{hint}</p> : null}
      {action}
    </div>
  );
}

/**
 * The panel most admin content sits in: flat, with 20px of padding, which is
 * the console's "airier" density rather than the 16px it started at.
 */
export function Card({
  children,
  className = '',
  padded = true,
  ...props
}: NativeProps<'div'> & { padded?: boolean }) {
  return (
    <div
      {...props}
      className={`rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) ${padded ? 'p-(--density-card-pad)' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A page title with its actions on the same line.
 *
 * An action may expand into a form in place — "New group" opens the editor
 * right here — and a form squeezed into the sliver of row left over beside a
 * two-line description is unusable. So an expanded action (anything marked
 * `data-expanded`) takes the whole width and drops onto its own row, which is
 * what `flex-wrap` on a full-width item does.
 *
 * The actions wrap among themselves for the same reason. With two of them,
 * one expanded, a row that could not wrap shared its width between the open
 * card and the other button, and at phone width the card — the channels
 * page's connect card — was squeezed to a column of single words. Wrapping
 * puts the open card on a row of its own and the button on the next, and lets
 * plain buttons that do not fit beside each other stack rather than overflow.
 */
export function PageHeader({
  title,
  description,
  actions,
  leading,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Rendered before the title — an avatar, an icon. Vertically centred on it. */
  leading?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start gap-3">
      {leading ? <div className="shrink-0 pt-0.5">{leading}</div> : null}
      <div className="min-w-0">
        <h1 className="text-lg font-semibold">{title}</h1>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-sm text-(--color-text-secondary)">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="ms-auto flex flex-wrap items-center gap-2 has-[[data-expanded]]:w-full">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * A table that scrolls inside its own box.
 *
 * Admin tables get wide — an SLA policy has four targets and two escalations —
 * and a table that widens the page instead of scrolling itself takes the whole
 * layout with it.
 */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="app-scroll overflow-x-auto rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-(--color-border-subtle) text-start">
            {head.map((cell, index) => (
              <th
                key={index}
                className="px-(--density-row-x) py-(--density-cell-y) text-start text-xs font-medium whitespace-nowrap text-(--color-text-secondary)"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b border-(--color-border-subtle) last:border-0 hover:bg-(--color-background-hover)/60">
      {children}
    </tr>
  );
}

export function Cell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <td className={`px-(--density-row-x) py-(--density-cell-y) align-middle ${className}`}>
      {children}
    </td>
  );
}

/** A checkbox that reads as a setting rather than as a form control. */
export function Toggle({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 shrink-0 accent-(--color-control-accent)"
      />
      {/*
        An unchecked checkbox submits nothing at all, which is invisible to a
        reader written as `get(name) !== 'off'` — the shape every "on by
        default" setting here uses. The effect was that nothing in the admin
        console could be deactivated: unticking Active submitted no value, the
        reader saw "not 'off'", and the row saved as active again.

        The hidden field comes *after* the checkbox on purpose. FormData follows
        DOM order, so a ticked box submits ['on', 'off'] and `get` returns 'on',
        while an unticked one submits only 'off'. Both reader shapes — `=== 'on'`
        and `!== 'off'` — then agree, which is what lets this be fixed in one
        place rather than in every action that reads a toggle.
      */}
      <input type="hidden" name={name} value="off" />
      <span>
        <span className="block font-medium">{label}</span>
        {hint ? <span className="block text-xs text-(--color-text-secondary)">{hint}</span> : null}
      </span>
    </label>
  );
}
