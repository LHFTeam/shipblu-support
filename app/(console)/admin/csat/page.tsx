import { Card, PageHeader } from '@/components/ui';
import { listGroupNames } from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { recentSurveys } from '@/lib/csat';
import { listWordingRules } from '@/lib/csat/rules';
import { readCsatSettings } from '@/lib/csat/settings';
import { publicBaseUrl } from '@/lib/kb/site';
import { SurveySettingsForm } from './forms';
import { RecentSurveyList } from './recent-list';
import { BuiltInWording, NewWordingRule, SendTestForm, WordingRuleEditor } from './wording-forms';

export const dynamic = 'force-dynamic';

/** How many of the newest decisions the page shows. */
const RECENT = 50;

/**
 * Satisfaction surveys: the switch, its numbers, and what it has done lately.
 *
 * The recent list is on this page rather than on a report because the first
 * thing an admin does after switching surveys on is wait half an hour and look
 * — and because a skipped row's reason is the answer to the question that
 * brings them here.
 */
export default async function CsatAdminPage() {
  const admin = await requirePermission('admin.csat');

  // The settings uncached, and a read that fails fails the page: this form is
  // saved back whole, so a thirty-second-old copy from another instance, or a
  // failed read drawn as all-off, would be written over the real settings by
  // the next save.
  const [settings, recent, rules, groups] = await Promise.all([
    readCsatSettings(),
    recentSurveys(RECENT),
    listWordingRules(),
    listGroupNames(),
  ]);
  // The built-in wording answers whenever no *active* every-group, every-channel
  // rule does, so that is when its card is shown; a switched-off default rule
  // still holds the scope, so "Customise" (which creates one) is offered only
  // when no default row exists at all.
  const defaultRule = rules.find((rule) => rule.groupId === null && rule.channel === null);
  const builtInAnswers = !defaultRule?.isActive;

  return (
    <>
      <PageHeader
        title="Satisfaction surveys"
        description="Ask customers to rate the support after a ticket is resolved, and see what went out."
      />

      <div className="flex flex-col gap-6">
        <SurveySettingsForm settings={settings} />

        <p className="text-xs text-(--color-text-secondary)">
          Survey links open on <code>{publicBaseUrl()}</code>, from <code>KB_PUBLIC_HOST</code> or,
          unset, <code>APP_URL</code>. A host that does not serve this app is a dead link in every
          survey.
        </p>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-(--color-text-secondary)">Wording</h2>
            <NewWordingRule groups={groups} />
          </div>
          <p className="text-xs text-(--color-text-secondary)">
            What the survey says, per group and channel, in both languages. The most specific rule
            wins: a channel beats a group, and a rule naming both beats either. The limits are
            Messenger&rsquo;s, held on every rule, so a wording that saves is one that sends.
          </p>
          {builtInAnswers ? (
            <Card>
              <BuiltInWording groups={groups} customisable={defaultRule === undefined} />
            </Card>
          ) : null}
          {rules.map((rule) => (
            <Card key={rule.id}>
              <WordingRuleEditor rule={rule} groups={groups} />
            </Card>
          ))}
          <Card>
            <SendTestForm rules={rules} groups={groups} email={admin.email} />
          </Card>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-(--color-text-secondary)">
            Recent decisions
          </h2>
          <RecentSurveyList rows={recent} />
        </section>
      </div>
    </>
  );
}
