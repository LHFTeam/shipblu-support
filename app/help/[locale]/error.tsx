'use client';

import { useParams } from 'next/navigation';
import { DEFAULT_LOCALE, isLocale, t } from '@/lib/kb/locale';
import { PageBody, Panel } from './chrome';

/**
 * A help-centre page that failed, shown inside the help centre.
 *
 * Without this a page error fell through to `app/global-error.tsx`, which
 * replaces the root layout, so the help layout above went with it — and the
 * chat with the layout, because `ChatWidget` takes the chat down when the help
 * layout goes. A customer mid-conversation lost the panel and whatever they
 * had typed into it to a database hiccup on an unrelated page. Caught here, the
 * header, the footer and the chat all stay, and only the page is replaced.
 *
 * Says nothing about the failure, for the reason `global-error.tsx` gives: an
 * error message can carry ticket content or database detail.
 */
export default function KbError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ locale?: string }>();
  const locale = isLocale(params?.locale) ? params.locale : DEFAULT_LOCALE;

  return (
    <PageBody>
      <Panel className="mx-auto max-w-lg p-8 text-center sm:p-10">
        <h1 className="text-xl font-semibold text-[var(--kb-heading)]">{t(locale, 'pageError')}</h1>
        <p className="mt-2 text-sm text-[var(--kb-muted)]">{t(locale, 'pageErrorHint')}</p>

        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-md bg-[var(--button-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
        >
          {t(locale, 'tryAgain')}
        </button>
      </Panel>
    </PageBody>
  );
}
