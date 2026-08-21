import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { surveyByToken } from '@/lib/csat';
import { isLocale, t } from '@/lib/kb/locale';
import { PageBody, Panel } from '../../chrome';
import { SurveyForm } from './form';

export const dynamic = 'force-dynamic';

// A survey link is personal and single-use; it has no business in an index.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The page a customer lands on from a satisfaction survey link.
 *
 * Under the locale prefix like every other public page, so it is rewritten to
 * the help centre on both hostnames and renders right-to-left in Arabic without
 * any special casing.
 */
export default async function CsatPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  if (!isLocale(locale)) notFound();

  const survey = await surveyByToken(token);

  // An unknown token and an expired one are the same page on purpose: telling a
  // stranger which tokens exist is the only thing distinguishing them would do.
  if (!survey) notFound();

  if (survey.respondedAt) {
    return (
      <PageBody>
        <Panel className="mx-auto max-w-lg p-8 text-center">
          <h1 className="text-xl font-semibold text-[var(--kb-heading)]">
            {t(locale, 'csatThanks')}
          </h1>
          <p className="mt-2 text-sm text-[var(--kb-muted)]">{t(locale, 'csatAlreadyAnswered')}</p>
        </Panel>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <SurveyForm token={token} locale={locale} />
    </PageBody>
  );
}
