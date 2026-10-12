import { buttonClass, Label } from '@/components/ui';
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
    <form action={`/${locale}/track`} className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-45 flex-1 flex-col">
        <Label htmlFor={id}>{t(locale, 'trackNumber')}</Label>

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
             smaller when it takes focus and never zooms back out. Aligned to
             the page's start edge on an Arabic page while still typed
             left-to-right, so the number sits under its label. */
          className="h-11 w-full rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) px-3 text-base text-(--color-text-primary) tabular-nums outline-none transition-colors placeholder:text-(--color-text-tertiary) hover:border-(--color-border-default) focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20 rtl:text-right"
        />
      </div>

      <button type="submit" className={`${buttonClass()} h-11`}>
        {t(locale, 'trackAction')}
      </button>
    </form>
  );
}
