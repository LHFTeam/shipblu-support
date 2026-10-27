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
  countedThrough,
  daysUncounted,
  firstSend,
  latestComments,
  liveSurveys,
  skipReasons,
  uncounted,
  COMMENT_LIMIT,
} from '@/lib/reports/csat-queries';
import {
  averageRating,
  byAgent,
  byChannel,
  byGroup,
  daily,
  lastWholeDay,
  ratedCount,
  ratingCounts,
  perDay,
  ratingShares,
  responseRate,
  rolledUpDays,
  surveyedRate,
  totals,
  unsplitAnswers,
  type Row as ReportRow,
  type Totals,
} from '@/lib/reports/queries';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';
import { RangeNav } from '../range-nav';
import { Quiet, Section } from '../report-parts';
import { daysFrom, RANGES } from './ranges';

export const dynamic = 'force-dynamic';

/**
 * Customer satisfaction: what the surveys said, how many were answered, and
 * why the rest of the work was never asked about.
 *
 * The figures are the nightly rollup's, like every report here, so today's
 * appear tomorrow. Three sections read `csat_surveys` live instead, because a
 * sum cannot hold them (`lib/reports/csat-queries.ts`): why tickets went
 * unsurveyed, what customers wrote, and the sends and decisions against day
 * by day to check the rollup against — so a day rolled up before survey
 * counts were kept says so instead of reading as a quiet one.
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

  const days = daysFrom((await searchParams).days);

  // One window, in the team's zone, for every query and for the dates printed
  // above them (§6.54). The figures are the rollup's, which ends yesterday at
  // best; the comments run to now, since they total nothing on the page and
  // today's are the ones to read.
  const { zone } = await reportingContext();
  const range = rangeIn(zone, days);
  const window = { ...range, zone };

  const [lastWhole, comments] = await allLimited(2, [
    () => lastWholeDay(window),
    () => latestComments(window, namesAgents),
  ] as const);

  // Every figure, the trend, and the live reads checked against them end on
  // the last day the rollup can be counted on to have computed — not on
  // yesterday, which is not in the figures for the hours between the team's
  // midnight and the nightly run. One end for all of them, so a day cannot be
  // in the figures and not in the check, or the other way round.
  const through = countedThrough(window, lastWhole);
  const counted = { from: range.from, to: through };
  // Over the counted days too, so the notice's "days of figures" counts the
  // days the figures hold, and not a rolled-up yesterday they stop before.
  const rolledUp = await rolledUpDays(counted);
  const startsLate = rolledUp.first !== null && rolledUp.first > range.from;
  // The live reads start where the figures' rows do. A day before the
  // rolled-up history was never rolled up at all, which the first notice
  // already says; read live, its sends would be named a second time, for the
  // wrong reason. The figures there are rows that do not exist, so starting
  // them later would change nothing but the trend's first bar.
  const countedWindow = { from: startsLate ? rolledUp.first! : range.from, to: through, zone };

  // A few at a time rather than all at once: a report page holding every
  // place in the pool for its render is the §6.91 freeze waiting to happen.
  const [summary, channelRows, groupRows, agentRows, series, reasons, liveDays, firstSent] =
    await allLimited(3, [
      () => totals(counted),
      () => byChannel(counted),
      () => byGroup(counted),
      () => (namesAgents ? byAgent(counted) : Promise.resolve([])),
      () => daily(counted),
      () => skipReasons(countedWindow),
      () => liveSurveys(countedWindow),
      () => firstSend(zone),
    ] as const);

  // Only when it says something the notice above does not: surveys starting
  // after the rollup's history did, inside this window.
  const surveysStartLate =
    firstSent !== null &&
    firstSent > range.from &&
    (rolledUp.first === null || firstSent > rolledUp.first);
  // Sends and decisions against the rollup has not counted, day by day: a
  // day rolled up before the survey columns existed, whose counts read 0
  // until it is computed again, or a day no run computed whole, behind a
  // later one that was. The figures below are short by this much, and the page says so rather than reading
  // them as none. It does not say to recompute: a rebuild of an old day takes
  // off it a resolution reopened or resolved again since, which counts on the
  // later resolve's day or on none (`docs/PROJECT-STATE.md` §6.98).
  const missing = uncounted(liveDays, series);
  // Answers on days rolled up before the distribution was kept: in the
  // average, and in nothing beside it.
  const unsplit = unsplitAnswers(series);
  // The rollup's own lag, said when it is more than tonight's run explains:
  // ending on the newest day computed whole, the page would otherwise show a
  // stalled rollup only as an older date in its header. With no day of the
  // window computed, every figure would read as none, so none is shown.
  const behind = daysUncounted(window, through);
  const noFigures = through < range.from;

  const labels = ratingLabels('en');
  const shares = ratingShares(summary);
  const average = averageRating(summary.csatRatingSum, summary.csatResponseCount);
  const answered = ratedCount(summary);

  const trend = perDay(counted, series).map(({ day, label, row }) => ({
    day,
    label,
    sent: row?.csatSentCount ?? 0,
    answered: row?.csatResponseCount ?? 0,
  }));
  const surveyedDays = series.filter(hasSurveys);

  return (
    <div className="app-scroll relative h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Customer satisfaction"
        description={`${range.from} to ${range.to}, in ${zone}. Rolled up nightly: the figures run to ${noFigures ? 'no day in this window' : through}; the comments, read live, to now.`}
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
        {behind > 1 ? (
          <Notice tone="warning" icon>
            <b>The nightly rollup has computed no day after {through}.</b>{' '}
            {noFigures
              ? 'No day of this window is in the figures, so none are shown; the comments below are read live.'
              : `The ${behind} days since are in no figure below, and the comments run past them.`}
          </Notice>
        ) : null}
        {startsLate ? (
          <Notice tone="info" icon>
            This window opens on {range.from}, but the rolled-up history{' '}
            <b>begins on {rolledUp.first}</b> — {rolledUp.days}{' '}
            {rolledUp.days === 1 ? 'day' : 'days'} of figures in this window.
          </Notice>
        ) : null}
        {surveysStartLate ? (
          <Notice tone="info" icon>
            The first survey went out on <b>{firstSent}</b>, after this window opens, so the days
            before it hold no surveys sent or answered.
          </Notice>
        ) : null}
        {missing.days.length > 0 ? (
          <Notice tone="warning" icon>
            <b>{missingSentence(missing)}</b>{' '}
            {fromDays(
              missing.sent + missing.skipped,
              missing.days.map((day) => day.day),
            )}{' '}
            whose rolled-up figures do not count them — rolled up before survey counts were kept, or
            missed by the nightly run — so the figures below, and every rate divided by them, leave
            them out.
          </Notice>
        ) : null}
        {unsplit.answers > 0 ? (
          <Notice tone="warning" icon>
            <b>
              {count(unsplit.answers, 'answer')} in this window{' '}
              {unsplit.answers === 1 ? 'is' : 'are'} in the average but not in the bars, the shares
              or the response rate.
            </b>{' '}
            {fromDays(unsplit.answers, unsplit.days)} rolled up before the rollup kept how each
            answer split, so only their sum and count are there to read.
          </Notice>
        ) : null}
      </div>

      {/* Nothing at all: not a send, an answer or a decision against. A
          window of skips alone is a page, whose "Why not surveyed" is the one
          section that explains why nothing went out. */}
      {firstSent === null &&
      answered === 0 &&
      summary.csatSkippedCount === 0 &&
      reasons.length === 0 ? (
        <EmptyState
          title="No surveys yet"
          hint="Nothing has been sent. Surveys are switched on, and their wording set, at Admin → Satisfaction surveys."
        />
      ) : (
        <>
          {noFigures ? null : (
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
                  explain="Answers in this window over surveys sent in it. A rate, not a cohort: a survey answered weeks after it went out counts in the week it was answered, so a short window can read above 100%. Answers on a day rolled up before survey counts were kept are left out, since that day's sends were not counted either."
                  value={percent(responseRate(summary))}
                  hint={`${answered.toLocaleString('en-GB')} answered of ${summary.csatSentCount.toLocaleString('en-GB')} sent`}
                />
                <Stat
                  label="Surveys sent"
                  explain="Surveys that went out in this window, including those since replaced by a newer survey on the same ticket. The decisions not to send one are counted under “Why not surveyed”."
                  value={summary.csatSentCount.toLocaleString('en-GB')}
                  hint={`${summary.csatSkippedCount.toLocaleString('en-GB')} decided against`}
                />
                <Stat
                  label="Resolutions surveyed"
                  explain="Surveys sent in this window over tickets resolved in it. A survey follows its resolve by the delay, so the window's edges do not hold exactly the same tickets; and a ticket on a channel nobody surveys, or resolved with surveys switched off, counts as resolved and in nothing else. A resolution counts on the day of the ticket's latest resolve, and on none while it is open again, but a survey stays on the day it was sent, so this can read a little high."
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
                rows={channelRows.filter(hasSurveysOrResolutions)}
                mark={(row) => <ChannelBadge channel={row.label} />}
                label={(row) => channelLabel(row.label)}
              />
              <Breakdown
                title="By group"
                hint="The group the ticket was in when its survey went out. A resolution counts in the group the ticket was in when its day was rolled up, so a ticket moved in between counts its survey and its resolve in different groups."
                rows={groupRows.filter(hasSurveysOrResolutions)}
              />
              {namesAgents ? (
                <Breakdown
                  title="By agent"
                  hint="The agent the ticket was assigned to when its survey went out. A resolution counts against the owner of the ticket's WhatsApp number when it has one, and otherwise against whoever held it when its day was rolled up — so an owned ticket somebody else worked, or any ticket reassigned in between, counts its survey and its resolve against different people, and their Resolutions surveyed reads low for one and blank for the other."
                  rows={agentRows.filter(hasSurveysOrResolutions)}
                />
              ) : null}

              <Section title="By day" hint="Surveys sent and answered on each day of the window.">
                {surveyedDays.length > 0 ? (
                  <>
                    <Card className="mb-3">
                      <Columns
                        caption={`Surveys sent and answered on each day from ${counted.from} to ${counted.to}`}
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
                  <Quiet>
                    No surveys were sent or answered on the window&rsquo;s rolled-up days.
                  </Quiet>
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
                  <Quiet>
                    No resolved ticket was decided against on the days the figures cover.
                  </Quiet>
                )}
              </Section>
            </>
          )}

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

/** A day worth a line in the by-day table: something was sent, skipped or answered. */
function hasSurveys(row: Totals): boolean {
  return row.csatSentCount > 0 || row.csatSkippedCount > 0 || row.csatResponseCount > 0;
}

/**
 * A row worth a line in a breakdown: a survey fact, or resolutions to have
 * surveyed. A channel with surveys switched off writes no skip — it is turned
 * away before a decision is written — so without its resolutions it would
 * vanish from the table while counting in the "Resolutions surveyed" tile,
 * and its 0% is the one line that shows it is off.
 */
function hasSurveysOrResolutions(row: Totals): boolean {
  return hasSurveys(row) || row.ticketsResolved > 0;
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

/** "1 survey sent and 2 decisions against in this window are not in the figures below." */
function missingSentence({ sent, skipped }: { sent: number; skipped: number }): string {
  const parts = [
    ...(sent > 0 ? [`${count(sent, 'survey')} sent`] : []),
    ...(skipped > 0 ? [`${count(skipped, 'decision')} against`] : []),
  ];
  const one = parts.length === 1 && sent + skipped === 1;
  return `${parts.join(' and ')} in this window ${one ? 'is' : 'are'} not in the figures below.`;
}

/**
 * "They are from 2026-08-31 and 2026-09-02, days" — the first three days, and
 * how many more; "It is" when the count before it is one thing.
 */
function fromDays(things: number, days: string[]): string {
  const named = days.slice(0, 3);
  const rest = days.length - named.length;
  const list =
    rest > 0
      ? `${named.join(', ')} and ${count(rest, 'other day')}`
      : named.length > 1
        ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
        : named[0];
  return `${things === 1 ? 'It is' : 'They are'} from ${list}, ${days.length === 1 ? 'a day' : 'days'}`;
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
