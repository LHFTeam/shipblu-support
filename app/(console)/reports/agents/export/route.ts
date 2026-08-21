import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import {
  adherence,
  agentDays,
  agentSummaries,
  focusMeasured,
  handlingSeconds,
  minutesLate,
  occupancy,
  rangeIn,
  reopenRate,
  resolvedPerHour,
} from '@/lib/reports/agent-queries';
import { csvFile, csvHeaders } from '@/lib/reports/csv';
import { averageRating, averageSeconds, metPercentage } from '@/lib/reports/queries';
import { reportingContext } from '@/lib/reports/rollup';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90];

/**
 * The report as a spreadsheet: one row per agent per day.
 *
 * A row per agent-day rather than the page's summary, because the thing this
 * gets used for is a review conversation, and "which days were the bad ones" is
 * the first question asked of it. Summing days in a spreadsheet is easy;
 * recovering them from a total is not.
 *
 * Re-checks the permission itself rather than relying on the page having done
 * it. A route handler is reachable by URL, and gating the link would only hide
 * the door.
 */
export async function GET(request: Request) {
  const agent = await requireAgent();
  // 404 rather than 403, matching how the console hides everything else an
  // agent may not see: whether the report exists is itself the answer.
  if (!can(agent, 'report.agents')) return new Response('not found', { status: 404 });

  const requested = Number(new URL(request.url).searchParams.get('days'));
  const days = RANGES.includes(requested) ? requested : 30;

  const { zone } = await reportingContext();
  const summaries = await agentSummaries(zone, days);

  const rows: unknown[][] = [];

  for (const summary of summaries) {
    for (const day of await agentDays(zone, days, summary.agentId)) {
      rows.push([
        day.day,
        summary.name,
        // ISO instants rather than the page's wall-clock times: a spreadsheet
        // has no timezone, and "09:05" with the zone left behind is a number
        // somebody will compare against a shift in a different one.
        day.firstOnlineAt,
        day.lastOnlineAt,
        day.scheduledStartAt,
        day.scheduledEndAt,
        minutesLate(day) ?? '',
        Math.round(day.onlineSeconds / 60),
        Math.round(day.acceptingSeconds / 60),
        Math.round(day.onlineWithinHoursSeconds / 60),
        Math.round(day.scheduledSeconds / 60),
        adherence(day) ?? '',
        occupancy(day) ?? '',
        day.sessionCount,
        day.assignedCount,
        day.ticketsResolved,
        day.touchedCount,
        day.publicReplies,
        day.privateNotes,
        day.transferredAwayCount,
        day.reclaimedFromCount,
        day.openAtDayEnd ?? '',
        day.pendingAtDayEnd ?? '',
        // Blank, never zero, when the beat reported nothing for a day with work
        // on it — an unmeasured agent must not export as an idle one.
        focusMeasured(day) ? (handlingSeconds(day) ?? '') : '',
        averageSeconds(day.firstResponseSecondsSum, day.firstResponseCount) ?? '',
        averageSeconds(day.resolutionSecondsSum, day.resolutionCount) ?? '',
        metPercentage(day.slaFirstResponseMet, day.slaFirstResponseBreached) ?? '',
        metPercentage(day.slaResolutionMet, day.slaResolutionBreached) ?? '',
        day.reopenedAfterResolveCount,
        reopenRate(day) ?? '',
        resolvedPerHour(day) ?? '',
        averageRating(day.csatRatingSum, day.csatResponseCount) ?? '',
        day.csatResponseCount,
      ]);
    }
  }

  const { from, to } = rangeIn(zone, days);

  return new Response(csvFile(HEADER, rows), {
    headers: csvHeaders(`agent-productivity-${from}-to-${to}.csv`),
  });
}

const HEADER = [
  'day',
  'agent',
  'first_online_at',
  'last_online_at',
  'scheduled_start_at',
  'scheduled_end_at',
  'minutes_late',
  'online_minutes',
  'available_minutes',
  'online_within_hours_minutes',
  'scheduled_minutes',
  'adherence_pct',
  'occupancy_pct',
  'sessions',
  'assigned',
  'resolved',
  'conversations_touched',
  'public_replies',
  'private_notes',
  'transferred_away',
  'reclaimed_from',
  'open_at_day_end',
  'pending_at_day_end',
  'avg_handling_seconds',
  'avg_first_response_seconds',
  'avg_resolution_seconds',
  'first_response_sla_pct',
  'resolution_sla_pct',
  'reopened_after_resolve',
  'reopen_rate_pct',
  'resolved_per_online_hour',
  'csat_avg',
  'csat_responses',
];
