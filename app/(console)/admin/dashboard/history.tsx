import Link from 'next/link';
import { Columns, Meter, Stat } from '@/components/charts';
import { Card, EmptyState } from '@/components/ui';
import {
  averageRating,
  averageSeconds,
  formatDuration,
  metPercentage,
  responsesHint,
  type totals,
} from '@/lib/reports/queries';

import { RangeNav } from '../../reports/range-nav';
import { Section, TableView, slaTone, type Point } from './section';

export const RANGES = [7, 30, 90] as const;

export function History({
  days,
  hasHistory,
  trend,
  window,
  firstResponseSla,
  canViewReports,
}: {
  days: number;
  hasHistory: boolean;
  trend: Point[];
  window: Awaited<ReturnType<typeof totals>>;
  firstResponseSla: number | null;
  /**
   * The dashboard is `admin.agents`, the reports `report.view`, and the two
   * part company on an account given one by hand without the other: no link
   * to a page that answers 404.
   */
  canViewReports: boolean;
}) {
  return (
    <Section
      title={`The last ${days} days`}
      hint="From the nightly rollup, which is what Reports reads. Complete days only — today is above."
      actions={
        <RangeNav ranges={RANGES} current={days} href={(each) => `/admin/dashboard?days=${each}`} />
      }
    >
      {!hasHistory ? (
        <EmptyState
          title="No rollups yet"
          hint="The nightly job writes the first day of figures tonight. Run `npm run job -- rollup_metrics` to build them now."
        />
      ) : (
        <>
          <Card className="mb-3">
            <h3 className="mb-3 text-sm font-medium">Created and resolved</h3>
            <Columns
              caption={`Tickets created and resolved on each of the last ${days} days`}
              labels={trend.map((point) => point.label)}
              series={[
                {
                  label: 'Created',
                  values: trend.map((point) => point.created),
                  color: 'var(--color-series-1)',
                },
                {
                  label: 'Resolved',
                  values: trend.map((point) => point.resolved),
                  color: 'var(--color-series-2)',
                },
              ]}
              tickEvery={days <= 7 ? 1 : days <= 30 ? 5 : 10}
            />
            <TableView
              summary="Created and resolved by day, as a table"
              head={['Day', 'Created', 'Resolved']}
              rows={trend.map((point) => [
                point.day,
                point.created.toLocaleString('en-GB'),
                point.resolved.toLocaleString('en-GB'),
              ])}
            />
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Created"
              value={window.ticketsCreated.toLocaleString('en-GB')}
              hint={`${window.ticketsResolved.toLocaleString('en-GB')} resolved`}
            />
            <Stat
              label="First response"
              value={formatDuration(
                averageSeconds(window.firstResponseSecondsSum, window.firstResponseCount),
              )}
              hint="Mean, in working hours"
            />
            <Stat
              label="Resolution within SLA"
              value={percentage(
                metPercentage(window.slaResolutionMet, window.slaResolutionBreached),
              )}
              hint={`${percentage(firstResponseSla)} for first response`}
            >
              <Meter
                value={metPercentage(window.slaResolutionMet, window.slaResolutionBreached)}
                tone={slaTone(metPercentage(window.slaResolutionMet, window.slaResolutionBreached))}
                label={`Resolution within SLA over ${days} days`}
              />
            </Stat>
            <Stat
              label="CSAT"
              explain="Mean rating out of 5 across the surveys answered in this window. Surveys sent and never answered are not counted, and a score belongs to whoever handled the ticket at the time rather than to whoever owns it now. The share beside the count is answers over surveys sent in the same days: a rate, not a cohort, so an answer to an older survey counts on the day it arrived."
              value={
                averageRating(window.csatRatingSum, window.csatResponseCount)?.toFixed(1) ?? '—'
              }
              hint={`${responsesHint(window)} · ${window.ticketsReopened.toLocaleString('en-GB')} reopened`}
            />
          </div>

          {canViewReports ? (
            <p className="mt-2 text-xs text-(--color-text-secondary)">
              Cuts by agent, group and channel live in{' '}
              <Link
                href={`/reports?days=${days}`}
                className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
              >
                Reports
              </Link>
              ; how customers rated the work, and what they wrote, in{' '}
              <Link
                href={`/reports/csat?days=${days}`}
                className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
              >
                Customer satisfaction
              </Link>
              .
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}
