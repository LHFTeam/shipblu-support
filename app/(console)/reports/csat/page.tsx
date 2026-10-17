import { DateTime } from 'luxon';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ChannelBadge } from '@/components/channel';
import { Columns, RatingBars, Stat } from '@/components/charts';
import {
  buttonClass,
  Card,
  Cell,
  EmptyState,
  Notice,
  PageHeader,
  Row,
  Table,
} from '@/components/ui';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { allLimited } from '@/lib/concurrency';
import { ratingLabels } from '@/lib/csat/wording';
import { channelLabel, formatDateTime } from '@/lib/format';
import {
  latestComments,
  sentSurveys,
  skipReasons,
  COMMENT_LIMIT,
} from '@/lib/reports/csat-queries';
import {
  averageRating,
  byAgent,
  byChannel,
  byGroup,
  daily,
  ratingCounts,
  ratingShares,
  responseRate,
  rolledUpDays,
  surveyedRate,
  totals,
  windowDays,
  type Row as ReportRow,
  type Totals,
} from '@/lib/reports/queries';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';
import { RangeNav } from '../range-nav';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

/**
 * Customer satisfaction: what the surveys said, how many were answered, and
 * why the rest of the work was never asked about.
 *
 * The figures are the nightly rollup's, like every report here, so today's
 * appear tomorrow. Three sections read `csat_surveys` live instead, because a
 * sum cannot hold them (`lib/reports/csat-queries.ts`): why tickets went
 * unsurveyed, what customers wrote, and a count of the sends to check the
 * rollup against — so a window rolled up before survey counts were kept says
 * so instead of reading as a quiet week.
 *
 * Behind `report.view` like `/reports`; the table naming agents, and the
 * agent beside each comment, behind `report.agents` as on `/reports/agents`.
 */
export default async function CsatReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const agent = await requireAgent();
  if (!can(agent, 'report.view')) notFound();
  const namesAgents = can(agent, 'report.agents');

  const { days: requested } = await searchParams;
  const days = RANGES.includes(Number(requested) as (typeof RANGES)[number])
    ? Number(requested)
    : 30;

  // One window, in the team's zone, for every query and for the dates printed
  // above them (§6.54). The figures are the rollup's, which ends yesterday at
  // best; the comments run to now, since they total nothing on the page and
  // today's are the ones to read.
  const { zone } = await reportingContext();
  const range = rangeIn(zone, days);
  const yesterday = DateTime.fromISO(range.to).minus({ days: 1 }).toISODate()!;
  const window = { ...range, zone };

  // A few at a time rather than all at once: a report page holding every
  // place in the pool for its render is the §6.91 freeze waiting to happen.
  const [summary, channelRows, groupRows, agentRows, series, rolledUp, comments] = await allLimited(
    3,
    [
      () => totals(range),
      () => byChannel(range),
      () => byGroup(range),
      () => (namesAgents ? byAgent(range) : Promise.resolve([])),
      () => daily(range),
      () => rolledUpDays(range),
      () => latestComments(window),
    ] as const,
  );

  // The live reads with a figure above them to agree with — the sends the
  // rollup is checked against, and the skips its tile counts — stop on the
  // last day the rollup holds, not on yesterday: for the hours between the
  // team's midnight and the nightly run, yesterday is not in the figures yet,
  // and counting it live would report a gap that is only the clock.
  const countedThrough =
    rolledUp.last === null
      ? DateTime.fromISO(range.from).minus({ days: 1 }).toISODate()!
      : rolledUp.last < yesterday
        ? rolledUp.last
        : yesterday;
  const countedWindow = { ...window, to: countedThrough };
  const [reasons, live] = await allLimited(2, [
    () => skipReasons(countedWindow),
    () => sentSurveys(countedWindow),
  ] as const);

  const startsLate = rolledUp.first !== null && rolledUp.first > range.from;
  // Only when it says something the notice above does not: surveys starting
  // after the rollup's history did, inside this window.
  const surveysStartLate =
    live.first !== null &&
    live.first > range.from &&
    (rolledUp.first === null || live.first > rolledUp.first);
  // Sends the rollup has not counted, on days it has rolled up: a night the
  // job did not run, or a day rolled up before the survey columns existed,
  // whose counts read 0 until it is computed again. Either way the figures
  // below are short by this many, and the page says so rather than reading
  // them as none. It does not say to recompute: over a day older than three,
  // that is not safe yet (`docs/PROJECT-STATE.md` §6.98).
  const uncounted = Math.max(0, live.sent - summary.csatSentCount);

  const labels = ratingLabels('en');
  const shares = ratingShares(summary);
  const average = averageRating(summary.csatRatingSum, summary.csatResponseCount);
  const answered = ratingCounts(summary).reduce((sum, count) => sum + count, 0);

  const byDay = new Map(series.map((day) => [day.day, day]));
  const trend = windowDays({ from: range.from, to: yesterday }).map((day) => ({
    day,
    label: DateTime.fromISO(day).toFormat('d/M'),
    sent: byDay.get(day)?.csatSentCount ?? 0,
    answered: byDay.get(day)?.csatResponseCount ?? 0,
  }));
  const surveyedDays = series.filter(hasSurveys);

  return (
    <div className="app-scroll h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Customer satisfaction"
        description={`${range.from} to ${range.to}, in ${zone}. Rolled up nightly: the figures run to ${rolledUp.last && rolledUp.last >= range.from ? rolledUp.last : 'no day in this window yet'}; the comments, read live, to now.`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <RangeNav
              ranges={RANGES}
              current={days}
              href={(each) => `/reports/csat?days=${each}`}
            />
            <Link
              href={`/reports/csat/export?days=${days}`}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Export CSV
            </Link>
            <Link
              href={`/reports?days=${days}`}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              All reports
            </Link>
          </div>
        }
      />

      <div className="mb-6 max-w-2xl space-y-2">
        {startsLate ? (
          <Notice tone="info" icon>
            This window opens on {range.from}, but the rolled-up history{' '}
            <b>begins on {rolledUp.first}</b> — {rolledUp.days}{' '}
            {rolledUp.days === 1 ? 'day' : 'days'} of figures in this window.
          </Notice>
        ) : null}
        {surveysStartLate ? (
          <Notice tone="info" icon>
            The first survey went out on <b>{live.first}</b>, after this window opens, so the days
            before it hold no surveys sent or answered.
          </Notice>
        ) : null}
        {uncounted > 0 ? (
          <Notice tone="warning" icon>
            <b>
              {uncounted} {uncounted === 1 ? 'survey' : 'surveys'} sent in this window{' '}
              {uncounted === 1 ? 'is' : 'are'} not in the figures below.
            </b>{' '}
            {uncounted === 1 ? 'It went' : 'They went'} out on a day the nightly rollup has no
            survey counts for — one rolled up before it kept them, or a night it did not run — so
            the sends, and every rate divided by them, leave {uncounted === 1 ? 'it' : 'them'} out.
          </Notice>
        ) : null}
      </div>

      {/* Nothing at all: not a send, an answer or a decision against. A
          window of skips alone is a page, whose "Why not surveyed" is the one
          section that explains why nothing went out. */}
      {live.first === null &&
      answered === 0 &&
      summary.csatSkippedCount === 0 &&
      reasons.length === 0 ? (
        <EmptyState
          title="No surveys yet"
          hint="Nothing has been sent. Surveys are switched on, and their wording set, at Admin → Satisfaction surveys."
        />
      ) : (
        <>
          <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat
              label="Average"
              explain="Mean rating out of 5 across the surveys answered in this window, on the day they were answered. A rating belongs to whoever handled the ticket when the survey went out."
              value={average === null ? '—' : average.toFixed(1)}
              hint={`${count(summary.csatResponseCount, 'answer')}`}
            />
            <Stat
              label="Rated 4 or 5"
              explain="The share of this window's answers that were a 4 or a 5, beside the share that were a 1 or a 2. A 3 is neither."
              value={percent(shares.positive)}
              hint={`${percent(shares.negative)} rated 1 or 2`}
            />
            <Stat
              label="Response rate"
              explain="Answers in this window over surveys sent in it. A rate, not a cohort: a survey answered weeks after it went out counts in the week it was answered, so a short window can read above 100%."
              value={percent(responseRate(summary))}
              hint={`${summary.csatResponseCount.toLocaleString('en-GB')} answered of ${summary.csatSentCount.toLocaleString('en-GB')} sent`}
            />
            <Stat
              label="Surveys sent"
              explain="Surveys that went out in this window, including those since replaced by a newer survey on the same ticket. The decisions not to send one are counted under “Why not surveyed”."
              value={summary.csatSentCount.toLocaleString('en-GB')}
              hint={`${summary.csatSkippedCount.toLocaleString('en-GB')} decided against`}
            />
            <Stat
              label="Resolutions surveyed"
              explain="Surveys sent in this window over tickets resolved in it. A survey follows its resolve by the delay, so the window's edges do not hold exactly the same tickets; and a ticket on a channel nobody surveys, or resolved with surveys switched off, counts as resolved and in nothing else."
              value={percent(surveyedRate(summary))}
              hint={`${summary.csatSentCount.toLocaleString('en-GB')} sent of ${summary.ticketsResolved.toLocaleString('en-GB')} resolved`}
            />
          </section>

          <Section
            title="How they rated"
            hint="Every answer in the window, by the step chosen. An average hides a week of ones and fives; this does not."
          >
            {answered > 0 ? (
              <Card className="max-w-2xl">
                <RatingBars
                  counts={ratingCounts(summary)}
                  labels={labels}
                  caption={`How the ${answered} answers in this window rated, from 5 down to 1`}
                />
              </Card>
            ) : (
              <Quiet>No answers in this window.</Quiet>
            )}
          </Section>

          <Breakdown
            title="By channel"
            hint="The channel each survey was asked on."
            rows={channelRows.filter(hasSurveys)}
            mark={(row) => <ChannelBadge channel={row.label} />}
            label={(row) => channelLabel(row.label)}
          />
          <Breakdown
            title="By group"
            hint="The group the ticket was in when its survey went out."
            rows={groupRows.filter(hasSurveys)}
          />
          {namesAgents ? (
            <Breakdown
              title="By agent"
              hint="The agent the ticket was assigned to when its survey went out. A resolution counts against whoever held the ticket when its day was rolled up, so a ticket reassigned in between counts its survey and its resolve against different people."
              rows={agentRows.filter(hasSurveys)}
            />
          ) : null}

          <Section title="By day" hint="Surveys sent and answered on each day of the window.">
            {surveyedDays.length > 0 ? (
              <>
                <Card className="mb-3">
                  <Columns
                    caption={`Surveys sent and answered on each of the window's ${trend.length} days up to yesterday`}
                    labels={trend.map((point) => point.label)}
                    series={[
                      {
                        label: 'Sent',
                        values: trend.map((point) => point.sent),
                        color: 'var(--color-series-1)',
                      },
                      {
                        label: 'Answered',
                        values: trend.map((point) => point.answered),
                        color: 'var(--color-series-2)',
                      },
                    ]}
                    tickEvery={trend.length <= 7 ? 1 : trend.length <= 30 ? 5 : 10}
                  />
                </Card>
                <Table
                  head={['Day', 'Sent', 'Answered', 'Response rate', 'Average', 'Rated 4 or 5']}
                >
                  {surveyedDays.map((day) => (
                    <Row key={day.day}>
                      <Cell>{day.day}</Cell>
                      <Cell>{day.csatSentCount.toLocaleString('en-GB')}</Cell>
                      <Cell>{day.csatResponseCount.toLocaleString('en-GB')}</Cell>
                      <Cell>{percent(responseRate(day))}</Cell>
                      <Cell>{rating(day)}</Cell>
                      <Cell>{percent(ratingShares(day).positive)}</Cell>
                    </Row>
                  ))}
                </Table>
              </>
            ) : (
              <Quiet>No surveys were sent or answered on the window&rsquo;s rolled-up days.</Quiet>
            )}
          </Section>

          <Section
            title="Why not surveyed"
            hint="Each time a resolved ticket was decided against, by reason, over the days the figures above cover. One ticket can be decided against more than once — reopened and resolved again, or sent by hand — and surveyed after. A ticket resolved while surveys or its channel were switched off, or on a channel nobody surveys, is turned away before a decision is written, so it is in neither this table nor the sends."
          >
            {reasons.length > 0 ? (
              <Table head={['Reason', 'Decisions']}>
                {reasons.map((reason) => (
                  <Row key={reason.reason}>
                    <Cell className="first-letter:uppercase">{reason.label}</Cell>
                    <Cell>{reason.count.toLocaleString('en-GB')}</Cell>
                  </Row>
                ))}
              </Table>
            ) : (
              <Quiet>No resolved ticket in this window was decided against.</Quiet>
            )}
          </Section>

          <Section
            title="Comments"
            hint={`The newest ${COMMENT_LIMIT} answers in the window that came with words, today's included.`}
          >
            {comments.length > 0 ? (
              <Table
                head={[
                  'Answered',
                  'Rating',
                  'Channel',
                  ...(namesAgents ? ['Agent'] : []),
                  'Comment',
                  'Ticket',
                ]}
              >
                {comments.map((row) => (
                  <Row key={row.id}>
                    <Cell className="whitespace-nowrap">{formatDateTime(row.respondedAt)}</Cell>
                    <Cell className="whitespace-nowrap">{row.rating} / 5</Cell>
                    <Cell>
                      <ChannelBadge channel={row.channel} />
                    </Cell>
                    {namesAgents ? <Cell>{row.agent ?? '—'}</Cell> : null}
                    {/* The customer's own words, in whichever direction they
                        wrote them. */}
                    <Cell className="min-w-64 whitespace-pre-line [overflow-wrap:anywhere]">
                      <span dir="auto">{row.comment}</span>
                    </Cell>
                    <Cell>
                      <Link
                        href={`/inbox/${row.number}`}
                        className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
                      >
                        #{row.number}
                      </Link>
                    </Cell>
                  </Row>
                ))}
              </Table>
            ) : (
              <Quiet>No answer in this window came with a comment.</Quiet>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

/** A row worth a line in a survey table: something was sent, skipped or answered. */
function hasSurveys(row: Totals): boolean {
  return row.csatSentCount > 0 || row.csatSkippedCount > 0 || row.csatResponseCount > 0;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function rating(row: Totals): string {
  return averageRating(row.csatRatingSum, row.csatResponseCount)?.toFixed(1) ?? '—';
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString('en-GB')} ${noun}${value === 1 ? '' : 's'}`;
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-semibold text-(--color-text-secondary)">{title}</h2>
      <p className="mb-2 max-w-3xl text-xs text-(--color-text-tertiary)">{hint}</p>
      {children}
    </section>
  );
}

/** An empty section said in words: an empty table reads as a page not finished. */
function Quiet({ children }: { children: ReactNode }) {
  return (
    <Notice tone="neutral" className="max-w-2xl">
      {children}
    </Notice>
  );
}

/** The same figures per channel, group or agent, each row with its denominators. */
function Breakdown({
  title,
  hint,
  rows,
  mark,
  label = (row) => row.label,
}: {
  title: string;
  hint: string;
  rows: ReportRow[];
  mark?: (row: ReportRow) => ReactNode;
  label?: (row: ReportRow) => string;
}) {
  return (
    <Section title={title} hint={hint}>
      {rows.length > 0 ? (
        <Table
          head={[
            '',
            'Sent',
            'Answered',
            'Response rate',
            'Average',
            'Rated 4 or 5',
            'Resolutions surveyed',
          ]}
        >
          {/* Keyed by position: two agents can share a name. */}
          {rows.map((row, index) => (
            <Row key={index}>
              <Cell>{mark ? mark(row) : label(row)}</Cell>
              <Cell>{row.csatSentCount.toLocaleString('en-GB')}</Cell>
              <Cell>{row.csatResponseCount.toLocaleString('en-GB')}</Cell>
              <Cell>{percent(responseRate(row))}</Cell>
              <Cell>{rating(row)}</Cell>
              <Cell>{percent(ratingShares(row).positive)}</Cell>
              <Cell>{percent(surveyedRate(row))}</Cell>
            </Row>
          ))}
        </Table>
      ) : (
        <Quiet>No surveys in this window.</Quiet>
      )}
    </Section>
  );
}
