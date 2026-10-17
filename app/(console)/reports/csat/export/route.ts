import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
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
 * goes out beside the counts it divides, so a spreadsheet can re-cut them —
 * sum two channels, take a week of days — where a column of percentages can
 * only be averaged, which is wrong.
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

  // One at a time: an export is not waited on the way a page is, and four
  // reads at once would take half the pool for it (§6.91).
  const channels = await byChannel(range);
  const groups = await byGroup(range);
  const agents = can(agent, 'report.agents') ? await byAgent(range) : [];
  const series = await daily(range);

  const rows: unknown[][] = [
    ...channels.map((row) => figures('channel', row.label, row)),
    ...groups.map((row) => figures('group', row.label, row)),
    ...agents.map((row) => figures('agent', row.label, row)),
    ...series.map((row) => figures('day', row.day, row)),
  ];

  return new Response(csvFile(HEADER, rows), {
    headers: csvHeaders(`customer-satisfaction-${range.from}-to-${range.to}.csv`),
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

const HEADER = [
  'kind',
  'label',
  'surveys_sent',
  'not_surveyed',
  'answered',
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
