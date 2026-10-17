import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { countedThrough, liveSurveys, uncounted, type LiveDay } from '@/lib/reports/csat-queries';
import { csvFile, csvHeaders } from '@/lib/reports/csv';
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
  type Totals,
} from '@/lib/reports/queries';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90];

/**
 * The satisfaction report as a spreadsheet: one row per channel, group, agent
 * and day, the page's tables in one sheet with a column saying which.
 *
 * The rows the page's figures are made of, not the figures alone: every rate
 * goes out beside the counts it divides, the average beside its sum, so a
 * spreadsheet can re-cut them — sum two channels, take a week of days — where
 * a column of percentages can only be averaged, which is wrong.
 *
 * Over the page's window, to the last day the rollup can be counted on
 * (`countedThrough`), and with the page's warning in its own rows: a
 * `not_rolled_up` row for each day holding sends or decisions against that
 * the figures do not, so a file opened without the page cannot read a 0
 * there as none sent.
 *
 * Re-checks the permission itself, as the agents export does: a route handler
 * is reachable by URL. The agent rows only for `report.agents`, as on the
 * page. 404 rather than 403, matching how the console hides everything else.
 */
export async function GET(request: Request) {
  const agent = await requireAgent();
  if (!can(agent, 'report.view')) return new Response('not found', { status: 404 });

  const requested = Number(new URL(request.url).searchParams.get('days'));
  const days = RANGES.includes(requested) ? requested : 30;

  const { zone } = await reportingContext();
  const range = rangeIn(zone, days);
  const counted = {
    from: range.from,
    to: countedThrough({ ...range, zone }, await rolledUpDays(range)),
  };

  // One at a time: an export is not waited on the way a page is, and four
  // reads at once would take half the pool for it (§6.91).
  const channels = await byChannel(counted);
  const groups = await byGroup(counted);
  const agents = can(agent, 'report.agents') ? await byAgent(counted) : [];
  const series = await daily(counted);
  const missing = uncounted(await liveSurveys({ ...counted, zone }), series);

  const rows: unknown[][] = [
    ...channels.map((row) => figures('channel', row.label, row)),
    ...groups.map((row) => figures('group', row.label, row)),
    ...agents.map((row) => figures('agent', row.label, row)),
    ...series.map((row) => figures('day', row.day, row)),
    ...missing.days.map(notRolledUp),
  ];

  return new Response(csvFile(HEADER, rows), {
    headers: csvHeaders(`customer-satisfaction-${counted.from}-to-${counted.to}.csv`),
  });
}

/** One row: what it is, then the counts, then the rates made from them. */
function figures(kind: string, label: string, row: Totals): unknown[] {
  const shares = ratingShares(row);
  return [
    kind,
    label,
    row.csatSentCount,
    row.csatSkippedCount,
    row.csatResponseCount,
    row.csatRatingSum,
    ...ratingCounts(row),
    row.ticketsResolved,
    // Blank, never zero, where there is nothing to divide: a rate of 0 is a
    // figure somebody will act on, and no surveys is not one.
    averageRating(row.csatRatingSum, row.csatResponseCount) ?? '',
    shares.positive ?? '',
    shares.negative ?? '',
    responseRate(row) ?? '',
    surveyedRate(row) ?? '',
  ];
}

/**
 * A day's sends and decisions against that its rolled-up row does not hold,
 * in the columns they would be counted in, and nothing else: what they were
 * rated, and the resolutions beside them, are what the rollup is missing.
 */
function notRolledUp(day: LiveDay): unknown[] {
  return ['not_rolled_up', day.day, day.sent, day.skipped, ...HEADER.slice(4).map(() => '')];
}

const HEADER = [
  'kind',
  'label',
  'surveys_sent',
  // Decisions, not tickets: one ticket can be decided against twice, and
  // surveyed after.
  'decided_against',
  'answered',
  // The average's numerator, beside the answers it is over.
  'rating_sum',
  'rated_1',
  'rated_2',
  'rated_3',
  'rated_4',
  'rated_5',
  'tickets_resolved',
  'average_rating',
  'percent_rated_4_or_5',
  'percent_rated_1_or_2',
  'response_rate_percent',
  'resolutions_surveyed_percent',
];
