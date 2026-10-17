import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { wordingForRule } from '@/lib/csat/rules';
import { preselectedRating } from '@/lib/csat/wording';
import { isUuid } from '@/lib/http/uuid';
import { isLocale } from '@/lib/kb/locale';
import { PageBody } from '../../chrome';
import { SurveyForm } from '../[token]/form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Where the links in an admin's test email land: the survey page as a
 * customer would see it, for a wording rule, recording nothing.
 *
 * Public, like the page it previews — the only thing it shows is a rule's
 * wording, active or not, since an admin's test is as often of a draft as of
 * what goes out — and keyed on the rule's id, which is a uuid, so there is
 * nothing to enumerate. An id that names no rule shows the built-in wording,
 * the same answer a survey whose rule was deleted gets.
 */
export default async function CsatPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ rule?: string; rating?: string | string[] }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const ruleId = query.rule && isUuid(query.rule) ? query.rule : null;
  const wording = await wordingForRule(ruleId, locale);

  return (
    <PageBody>
      <SurveyForm
        token=""
        locale={locale}
        wording={wording}
        preselected={preselectedRating(query.rating)}
        preview
      />
    </PageBody>
  );
}
