import { t, type Locale } from '@/lib/kb/locale';

/**
 * The tracking-number lookup.
 *
 * A plain `GET` form, and therefore a server component, for exactly the reasons
 * `SearchBox` is one: this is the thing a recipient standing on a pavement with
 * one bar of signal is trying to do, and it has to work before React has
 * hydrated — or on a phone where it never does. Submitting to the page by
 * itself, with the number in the query string, also means the result has a URL
 * that can be bookmarked, re-opened and pasted to support.
 *
 * `dir="ltr"` on the field, always. A tracking number is a Latin identifier even
 * inside an Arabic page, and left to inherit RTL the browser reorders what the
 * customer typed — the caret jumps, and a number read back to an agent over the
 * phone comes out backwards.
 */
export function TrackForm({
  locale,
  id = 'tracking',
  initial = '',
  autoFocus = false,
}: {
  locale: Locale;
  id?: string;
  /** Pre-fills the field, so a mistyped number is corrected rather than retyped. */
  initial?: string;
  autoFocus?: boolean;
}) {
  return (
    <form action={`/${locale}/track`} className="flex flex-col gap-2.5">
      <label htmlFor={id} className="text-sm font-medium text-[var(--kb-heading)]">
        {t(locale, 'trackNumber')}
      </label>

      <input
        id={id}
        type="text"
        name="number"
        dir="ltr"
        defaultValue={initial}
        required
        autoFocus={autoFocus}
        maxLength={40}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        /* A real number's shape — thirteen digits — but not a real number.
           Putting a live one here would publish that parcel's recipient to
           anyone who pressed enter on the example (PROJECT-STATE §6.38). */
        placeholder="1700000000000"
        /* 16px, like the hero search field: iOS Safari zooms into anything
           smaller when it takes focus and never zooms back out. */
        className="h-11 w-full rounded-lg border border-[var(--kb-border-strong)] bg-[var(--kb-surface)] px-3 text-base tabular-nums text-[var(--kb-heading)] outline-none placeholder:text-[var(--kb-muted)]/60 focus:border-[var(--kb-band)]"
      />

      <button
        type="submit"
        className="h-10 rounded-md bg-[var(--button-primary)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
      >
        {t(locale, 'trackAction')}
      </button>
    </form>
  );
}
