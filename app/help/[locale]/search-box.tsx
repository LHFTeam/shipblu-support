import { SearchIcon } from '@/components/icons';
import { buttonClass } from '@/components/ui';
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
 *
 * Three shapes, from the help-centre design:
 *
 * - `hero` is the front door's: a tall field and a separate, labelled Search
 *   button beside it, because the first thing a visitor does here is the thing
 *   the button names.
 * - `field` is a topic page's "Search in …": as tall, on the pale band, with
 *   the magnifier as its only button.
 * - `compact` is the one at the end of a page header's trail.
 */
export function SearchBox({
  locale,
  initial = '',
  size = 'compact',
  id = 'kb-search',
  placeholderKey = 'searchPlaceholder',
  placeholder,
  within,
}: {
  locale: Locale;
  initial?: string;
  size?: 'compact' | 'hero' | 'field';
  id?: string;
  /**
   * Which placeholder to show. The front page has room for one that names an
   * example question, which is worth far more than "Search…" at teaching a
   * visitor what this box will accept; the field in a page header does not, and
   * a placeholder that truncates mid-example teaches nothing.
   */
  placeholderKey?: 'searchPlaceholder' | 'searchPlaceholderHero';
  /** A placeholder already filled in — "Search in ShipBlu Partners". Wins over the key. */
  placeholder?: string;
  /**
   * A category's slug: the results page then searches that category alone, and
   * says so. Carried as `c` in the query string, so the scoped results have a
   * URL like any other.
   */
  within?: string;
}) {
  const hint = placeholder ?? t(locale, placeholderKey);

  if (size === 'hero') {
    return (
      <form action={`/${locale}/search`} role="search" className="kb-noprint flex gap-2">
        <label htmlFor={id} className="sr-only">
          {t(locale, 'search')}
        </label>
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            size={20}
            className="pointer-events-none absolute inset-y-0 start-3.5 my-auto text-(--color-text-tertiary)"
          />
          <input
            id={id}
            type="search"
            name="q"
            defaultValue={initial}
            required
            placeholder={hint}
            enterKeyHint="search"
            /* 16px on a phone: iOS Safari zooms into anything smaller when it
               takes focus, and it does not zoom back out. */
            className={`h-12 ps-11 pe-3 text-base ${FIELD} ${EMPTY_NO_CANCEL}`}
          />
        </div>
        {within ? <input type="hidden" name="c" value={within} /> : null}
        {/* Labelled from `sm` up, as the design draws it; a magnifier on a phone,
            where the label's 70px were the end of the placeholder's example. */}
        <button type="submit" className={`${buttonClass()} h-12! px-5! text-base! max-sm:px-3.5!`}>
          <SearchIcon size={20} className="sm:hidden" />
          <span className="max-sm:sr-only">{t(locale, 'search')}</span>
        </button>
      </form>
    );
  }

  const tall = size === 'field';

  return (
    <form action={`/${locale}/search`} role="search" className="kb-noprint relative">
      <label htmlFor={id} className="sr-only">
        {hint}
      </label>

      {within ? <input type="hidden" name="c" value={within} /> : null}

      <input
        id={id}
        type="search"
        name="q"
        defaultValue={initial}
        required
        placeholder={hint}
        enterKeyHint="search"
        className={`${FIELD} ${EMPTY_NO_CANCEL} ${tall ? 'h-12 ps-4 pe-12 text-base' : 'h-10 ps-3 pe-11 text-base sm:text-sm'}`}
      />

      <button
        type="submit"
        aria-label={t(locale, 'search')}
        className={`absolute inset-y-0 end-0 flex items-center justify-center rounded-e-md text-(--color-text-tertiary) transition-colors hover:text-(--color-text-primary) ${
          tall ? 'w-12' : 'w-10'
        }`}
      >
        <SearchIcon size={tall ? 20 : 18} />
      </button>
    </form>
  );
}

/** The surface and focus ring are the design system's field, the same as `Input`'s. */
const FIELD =
  'w-full rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) text-(--color-text-primary) transition-colors placeholder:text-(--color-text-tertiary) hover:border-(--color-border-default) focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20';

/**
 * Chromium keeps room for a `type="search"` field's clear button even while the
 * field is empty and the button is hidden, which cut the hero's example
 * placeholder off mid-word at tablet width. Hidden until there is something to
 * clear.
 */
const EMPTY_NO_CANCEL = 'placeholder-shown:[&::-webkit-search-cancel-button]:hidden';
