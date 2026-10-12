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
  placeholderKey = 'searchPlaceholder',
}: {
  locale: Locale;
  initial?: string;
  /** `hero` is the front-door field; `compact` is the one in the page header. */
  size?: 'compact' | 'hero';
  id?: string;
  /**
   * Which placeholder to show. The front page has room for one that names an
   * example question, which is worth far more than "Search…" at teaching a
   * visitor what this box will accept; the field in a page header does not, and
   * a placeholder that truncates mid-example teaches nothing.
   */
  placeholderKey?: 'searchPlaceholder' | 'searchPlaceholderHero';
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
        placeholder={t(locale, placeholderKey)}
        enterKeyHint="search"
        /* 16px on a phone, in both sizes: iOS Safari zooms into anything smaller
           when it takes focus, and it does not zoom back out. The surface and
           focus ring are the design system's field, the same as `Input`'s. */
        className={`w-full rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) text-(--color-text-primary) outline-none transition-colors placeholder:text-(--color-text-tertiary) hover:border-(--color-border-default) focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20 ${
          hero ? 'h-13 ps-4 pe-14 text-base' : 'h-10 ps-3 pe-11 text-base sm:text-sm'
        }`}
      />

      <button
        type="submit"
        aria-label={t(locale, 'search')}
        className={`absolute inset-y-0 end-0 flex items-center justify-center rounded-e-md transition-colors ${
          hero
            ? 'w-13 bg-(--button-primary) text-(--color-text-on-action) hover:bg-(--button-primary-hover) active:bg-(--button-primary-active)'
            : 'w-10 text-(--color-text-tertiary) hover:text-(--color-text-primary)'
        }`}
      >
        <SearchIcon size={hero ? 22 : 18} />
      </button>
    </form>
  );
}
