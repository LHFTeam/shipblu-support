'use client';

import { useParams } from 'next/navigation';
import { DEFAULT_LOCALE, isLocale, t } from '@/lib/kb/locale';
import { PageBody, Panel } from './[locale]/chrome';

/**
 * What a help-centre reader sees in place of something that failed to render,
 * shared by the two boundaries that catch it (`error.tsx` here and under
 * `[locale]/`).
 *
 * Says nothing about the failure, for the reason `app/global-error.tsx` gives:
 * an error message can carry ticket content or database detail.
 *
 * "Try again" is `retry`, not `reset`. `reset` only clears the boundary and
 * re-renders what the router already holds, which for a server component that
 * failed is the same failed payload, so the button did nothing however long the
 * reader waited. `retry` fetches it again first.
 */
export function HelpFailed({ retry }: { retry: () => void }) {
  const params = useParams<{ locale?: string }>();
  const locale = isLocale(params?.locale) ? params.locale : DEFAULT_LOCALE;

  return (
    <PageBody>
      <Panel className="mx-auto max-w-lg p-8 text-center sm:p-10">
        <h1 className="text-xl font-semibold text-[var(--kb-heading)]">{t(locale, 'pageError')}</h1>
        <p className="mt-2 text-sm text-[var(--kb-muted)]">{t(locale, 'pageErrorHint')}</p>

        <button
          type="button"
          onClick={() => retry()}
          className="mt-6 rounded-md bg-[var(--button-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
        >
          {t(locale, 'tryAgain')}
        </button>
      </Panel>
    </PageBody>
  );
}
