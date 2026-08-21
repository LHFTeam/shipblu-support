import Link from 'next/link';
import { DEFAULT_LOCALE, t } from '@/lib/kb/locale';
import { PageBody, Panel } from './chrome';
import { SearchBox } from './search-box';

/**
 * Scoped to the help centre so a missing article does not show a customer the
 * agent console's error page.
 *
 * The locale is not available here — Next renders not-found without route
 * params — so this falls back to the default locale and links home, where the
 * language switcher takes over.
 *
 * A search field rather than only a link back: somebody who followed a stale
 * link to an article that has been renamed still wants that article, and the
 * front page is one more click away from it than this box is.
 */
export default function KbNotFound() {
  return (
    <PageBody>
      <Panel className="mx-auto max-w-lg p-8 text-center sm:p-10">
        <h1 className="text-xl font-semibold text-[var(--kb-heading)]">
          {t(DEFAULT_LOCALE, 'notFound')}
        </h1>
        <p className="mt-2 text-sm text-[var(--kb-muted)]">{t(DEFAULT_LOCALE, 'notFoundHint')}</p>

        <div className="mt-6">
          <SearchBox locale={DEFAULT_LOCALE} size="hero" id="kb-search-404" />
        </div>

        <Link
          href={`/${DEFAULT_LOCALE}`}
          className="mt-6 inline-block text-sm font-medium text-[var(--kb-link)] underline underline-offset-4"
        >
          {t(DEFAULT_LOCALE, 'backToHelp')}
        </Link>
      </Panel>
    </PageBody>
  );
}
