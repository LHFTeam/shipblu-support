import { SearchIcon } from '@/components/icons';
import { t, type Locale } from '@/lib/kb/locale';

/**
 * The search field.
 *
 * A plain `GET` form, and therefore a server component: it submits to the
 * search page by itself, with no router, no state and no JavaScript. Search is
 * the one thing on a help centre that has to work — on a bad connection, on an
 * old phone, in a browser where a script failed to load — and the previous
 * version of this component could not submit at all until React had hydrated.
 *
 * `required` is doing real work: it is what stops an empty box from navigating
 * to a results page for the empty string.
 */
export function SearchBox({
  locale,
  initial = '',
  size = 'compact',
  id = 'kb-search',
}: {
  locale: Locale;
  initial?: string;
  /** `hero` is the front-door field; `compact` is the one in the page header. */
  size?: 'compact' | 'hero';
  id?: string;
}) {
  const hero = size === 'hero';

  return (
    <form action={`/${locale}/search`} role="search" className="relative">
      <label htmlFor={id} className="sr-only">
        {t(locale, 'search')}
      </label>

      <input
        id={id}
        type="search"
        name="q"
        defaultValue={initial}
        required
        placeholder={t(locale, 'searchPlaceholder')}
        /* 16px on the hero field: iOS Safari zooms into anything smaller when it
           takes focus, and it does not zoom back out. */
        className={`w-full rounded-lg border border-[var(--kb-border-strong)] bg-[var(--kb-surface)] text-[var(--kb-heading)] shadow-sm outline-none placeholder:text-[var(--kb-muted)]/70 focus:border-[var(--kb-band)] ${
          hero ? 'h-13 ps-4 pe-14 text-base' : 'h-10 ps-3 pe-11 text-sm'
        }`}
      />

      <button
        type="submit"
        aria-label={t(locale, 'search')}
        className={`absolute inset-y-0 end-0 flex items-center justify-center rounded-e-lg transition-colors ${
          hero
            ? 'w-13 bg-[var(--button-primary)] text-white hover:bg-[var(--button-primary-hover)]'
            : 'w-10 text-[var(--kb-muted)] hover:text-[var(--kb-heading)]'
        }`}
      >
        <SearchIcon size={hero ? 22 : 18} />
      </button>
    </form>
  );
}
