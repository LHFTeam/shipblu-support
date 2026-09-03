import type { ComponentProps, ReactNode } from 'react';
import { InfoTip } from './tooltip';

/**
 * Shared primitives.
 *
 * Deliberately not a component library: the console needs about a dozen
 * repeated shapes, and a dependency would cost more in bundle size and upgrade
 * churn than it saves. Everything here is a styled element — behaviour lives in
 * the feature that needs it.
 */

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  size?: 'sm' | 'md';
}) {
  const styles = {
    /* Through variables rather than `bg-brand-600` directly, so the help centre
       can hand this component its own navy without a second Button. The console
       defines them as the brand blue; `.kb-shell` re-points them. */
    primary:
      'bg-[var(--button-primary)] text-white hover:bg-[var(--button-primary-hover)] disabled:opacity-50 shadow-sm',
    // Coral is the one "do the thing" colour and is used sparingly, so that
    // when it appears it actually means something.
    accent: 'bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-600/50 shadow-sm',
    secondary:
      'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--muted)] disabled:opacity-50',
    ghost: 'hover:bg-[var(--muted)] disabled:opacity-50',
    danger: 'bg-[var(--color-critical)] text-white hover:opacity-90 disabled:opacity-50',
  }[variant];

  const sizing = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';

  return (
    <button
      // HTML defaults a button inside a form to `submit`, and almost every
      // Button here is a `<Button onClick={…}>` that opens an editor — which,
      // the first time one of those was placed *inside* a form, meant clicking
      // "show me the validation rules" saved the record instead. Defaulting to
      // `button` makes the safe case the one you get by not thinking about it;
      // `SubmitButton` is the only thing that submits, and it says so.
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${sizing} ${styles} ${className}`}
    />
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
 */
const FIELD_BASE =
  'w-full rounded-md border border-[var(--border)] text-base sm:text-sm outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60';

/**
 * Held apart from `FIELD_BASE` so `Input` can swap it, which a caller cannot.
 *
 * Passing `bg-[var(--muted)]` through `className` looks like it should win and
 * does not: both are single-class background utilities of equal specificity, so
 * the winner is whichever Tailwind emits later in the stylesheet — and it emits
 * `--surface` after `--muted`, whatever order the class attribute lists them
 * in. A read-only field styled from the call site therefore rendered exactly
 * like an editable one, which is the opposite of the point.
 */
const FIELD_SURFACE = 'bg-[var(--surface)]';

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  /*
   * A read-only field is not a disabled one — it stays focusable, announced and
   * copyable, which is what a prefilled identity on the invite-activation page
   * needs. It just must not look like a box somebody is expected to type in.
   *
   * Keyed off the prop rather than the `read-only:` variant because CSS
   * `:read-only` also matches every *disabled* field, and dimming those was not
   * asked for here.
   */
  const surface = props.readOnly
    ? 'bg-[var(--muted)] text-[var(--muted-foreground)] cursor-default'
    : FIELD_SURFACE;

  return <input {...props} className={`${FIELD_BASE} ${surface} px-3 py-2 ${className}`} />;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={`${FIELD_BASE} ${FIELD_SURFACE} resize-y px-3 py-2 ${className}`}
    />
  );
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  // Taller on a phone, where 1.5 of padding around 14px text is a 34px tap
  // target sat next to a 42px input in the same row.
  return (
    <select
      {...props}
      className={`${FIELD_BASE} ${FIELD_SURFACE} px-2 py-2 sm:py-1.5 ${className}`}
    />
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]"
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
      <span className="mb-1 flex items-center gap-1 text-xs font-medium text-[var(--muted-foreground)]">
        {label}
        {explain ? <InfoTip label={label}>{explain}</InfoTip> : null}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-[var(--muted-foreground)]">{hint}</span>
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

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?:
    | 'neutral'
    | 'brand'
    | 'open'
    | 'pending'
    | 'resolved'
    | 'closed'
    | 'warning'
    | 'danger'
    | 'success';
}) {
  const styles = {
    neutral: 'bg-[var(--muted)] text-[var(--muted-foreground)]',
    brand: 'bg-brand-500/15 text-brand-700 dark:text-brand-300',
    open: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    resolved: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
    closed: 'bg-[var(--muted)] text-[var(--muted-foreground)]',
    warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    danger: 'bg-red-500/15 text-red-700 dark:text-red-300',
    success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${styles}`}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
    >
      {children}
    </p>
  );
}

export function SuccessText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
      {children}
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
      {hint ? <p className="max-w-sm text-xs text-[var(--muted-foreground)]">{hint}</p> : null}
      {action}
    </div>
  );
}

/** The panel most admin content sits in. */
export function Card({
  children,
  className = '',
  padded = true,
  ...props
}: ComponentProps<'div'> & { padded?: boolean }) {
  return (
    <div
      {...props}
      className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] ${padded ? 'p-4' : ''} ${className}`}
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
          <p className="mt-0.5 max-w-2xl text-sm text-[var(--muted-foreground)]">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="ms-auto flex items-center gap-2 has-[[data-expanded]]:w-full">
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
    <div className="app-scroll overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-start">
            {head.map((cell, index) => (
              <th
                key={index}
                className="px-3 py-2 text-start text-xs font-medium whitespace-nowrap text-[var(--muted-foreground)]"
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
    <tr className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]/60">
      {children}
    </tr>
  );
}

export function Cell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
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
        className="mt-0.5 size-4 accent-brand-600"
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
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-xs text-[var(--muted-foreground)]">{hint}</span> : null}
      </span>
    </label>
  );
}
