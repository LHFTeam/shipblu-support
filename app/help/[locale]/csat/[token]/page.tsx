import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { surveyByToken } from '@/lib/csat';
import { wordingForRule } from '@/lib/csat/rules';
import { preselectedRating } from '@/lib/csat/wording';
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
 *
 * A link from the email names a rating, and the page arrives with it chosen —
 * chosen, not recorded: mail scanners fetch every link in a mail before the
 * person sees it, so nothing is written until the customer taps. The words
 * are the ones the survey went out with (`rule_id`), so the page asks the
 * question the mail asked.
 */
export default async function CsatPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<{ rating?: string | string[] }>;
}) {
  const [{ locale, token }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const survey = await surveyByToken(token);

  // An unknown token and an expired one are the same page on purpose: telling a
  // stranger which tokens exist is the only thing distinguishing them would do.
  if (!survey) notFound();

  const wording = await wordingForRule(survey.ruleId, locale);

  if (survey.respondedAt) {
    return (
      <PageBody>
        <Panel className="mx-auto max-w-[600px] p-7">
          <h1 className="text-2xl font-bold text-(--color-text-primary)">{wording.thanks}</h1>
          <p className="mt-2 text-sm text-(--color-text-secondary)">
            {t(locale, 'csatAlreadyAnswered')}
          </p>
        </Panel>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <SurveyForm
        token={token}
        locale={locale}
        wording={wording}
        preselected={preselectedRating(query.rating)}
      />
    </PageBody>
  );
}
