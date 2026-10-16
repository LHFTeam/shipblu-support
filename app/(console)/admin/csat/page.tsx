import Link from 'next/link';
import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { RelativeTime } from '@/components/relative-time';
import { requirePermission } from '@/lib/auth/guard';
import { recentSurveys } from '@/lib/csat';
import { loadCsatSettings } from '@/lib/csat/settings';
import { describeSkip } from '@/lib/csat/skip-reasons';
import { ago, channelLabel } from '@/lib/format';
import { publicBaseUrl } from '@/lib/kb/site';
import { SurveySettingsForm } from './forms';

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
  await requirePermission('admin.csat');

  const [settings, recent] = await Promise.all([loadCsatSettings(), recentSurveys(RECENT)]);

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

        <section>
          <h2 className="mb-2 text-sm font-semibold text-(--color-text-secondary)">
            Recent decisions
          </h2>
          <Table head={['Ticket', 'Channel', 'What happened', 'Rating', 'When']}>
            {recent.map((row) => (
              <Row key={row.id}>
                <Cell>
                  <Link href={`/inbox/${row.number}`} className="underline">
                    #{row.number}
                  </Link>
                </Cell>
                <Cell className="text-xs text-(--color-text-secondary)">
                  {row.channel ? channelLabel(row.channel) : '—'}
                </Cell>
                <Cell className="text-xs">
                  {row.status === 'skipped' ? (
                    <>
                      <Badge tone="neutral">Not sent</Badge>{' '}
                      <span className="text-(--color-text-secondary)">
                        {describeSkip(row.skipReason)}
                      </span>
                    </>
                  ) : row.status === 'answered' ? (
                    <Badge tone="success">Answered</Badge>
                  ) : row.status === 'expired' ? (
                    <Badge tone="neutral">Replaced by a newer survey</Badge>
                  ) : (
                    <Badge tone="info">
                      Sent {row.delivery === 'email_link' ? 'by email' : 'as a message'}
                    </Badge>
                  )}
                </Cell>
                <Cell className="text-xs">{row.rating === null ? '—' : `${row.rating} / 5`}</Cell>
                <Cell className="text-xs text-(--color-text-secondary)">
                  <RelativeTime at={row.createdAt}>{(relative) => ago(relative)}</RelativeTime>
                </Cell>
              </Row>
            ))}
          </Table>
          {recent.length === 0 ? (
            <p className="mt-3 text-sm text-(--color-text-secondary)">
              Nothing yet. A decision is recorded for every ticket resolved while surveys are on.
            </p>
          ) : null}
        </section>
      </div>
    </>
  );
}
