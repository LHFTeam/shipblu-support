import { DateTime } from 'luxon';
import { and, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agentBacklogSnapshots,
  agentFocusIntervals,
  agentPresenceIntervals,
  agents,
  conversationEvents,
  conversations,
  groupMembers,
  messages,
} from '@/db/schema';
import { businessMinutesBetween, scheduledWindow, type HoursConfig } from '@/lib/hours';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { HEARTBEAT_TTL_MS } from '@/lib/assignment/eligibility';
import { FOCUS_TTL_MS } from '@/lib/presence/focus';
import {
  clampSpans,
  firstStart,
  lastEnd,
  longestSeconds,
  mergeSpans,
  toSpan,
  totalSeconds,
  type Span,
} from './intervals';
import type { ReportingContext } from './rollup';

/**
 * One day of agent-productivity figures.
 *
 * The sibling of `lib/reports/rollup`, and deliberately a separate module rather
 * than more work inside it. That one measures *tickets* and slices them four
 * ways with null meaning "all"; this one measures *people* and has exactly one
 * dimension. Folding them together would mean a login time with a channel
 * attached, and would break the reconciliation that guards the ticket figures.
 *
 * What it does share is the day: both are driven by `ReportingContext`, from the
 * same nightly job, so "resolved" on the ticket report and "resolved" beside an
 * agent's shift are the same measurement of the same twenty-four hours.
 *
 * It computes only what `metrics_daily` does not already hold per agent.
 * Resolved counts, response times, SLA attainment and CSAT are joined from there
 * at read time instead of being recomputed here — two copies of "resolved
 * today" is two numbers that will eventually disagree, and the one that
 * disagrees silently is the one somebody's appraisal is based on.
 */

/**
 * Gaps up to this long are treated as one continuous stretch of presence.
 *
 * The heartbeat TTL, deliberately: assignment already treats a beat older than
 * this as an agent who has gone, so using anything else here would mean the
 * rota and the report disagreeing about when somebody's shift ended. It is also
 * what absorbs the reconnect flapping that `lib/assignment/presence.ts`
 * documents — without it a single shift reads as forty sessions.
 */
const PRESENCE_STITCH_MS = HEARTBEAT_TTL_MS;

/** Tighter, matching the focus beat's own staleness rule. */
const FOCUS_STITCH_MS = FOCUS_TTL_MS;

export type AgentDay = {
  agentId: string;

  firstOnlineAt: Date | null;
  lastOnlineAt: Date | null;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;

  onlineSeconds: number;
  acceptingSeconds: number;
  onlineWithinHoursSeconds: number;
  scheduledSeconds: number;
  sessionCount: number;
  longestSessionSeconds: number;

  assignedCount: number;
  touchedCount: number;
  publicReplies: number;
  privateNotes: number;
  transferredAwayCount: number;
  reclaimedFromCount: number;

  openAtDayEnd: number | null;
  pendingAtDayEnd: number | null;

  focusSeconds: number;
  conversationsFocused: number;

  resolutionsMade: number;
  reopenedAfterResolveCount: number;
};

export function emptyDay(agentId: string): AgentDay {
  return {
    agentId,
    firstOnlineAt: null,
    lastOnlineAt: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    onlineSeconds: 0,
    acceptingSeconds: 0,
    onlineWithinHoursSeconds: 0,
    scheduledSeconds: 0,
    sessionCount: 0,
    longestSessionSeconds: 0,
    assignedCount: 0,
    touchedCount: 0,
    publicReplies: 0,
    privateNotes: 0,
    transferredAwayCount: 0,
    reclaimedFromCount: 0,
    openAtDayEnd: null,
    pendingAtDayEnd: null,
    focusSeconds: 0,
    conversationsFocused: 0,
    resolutionsMade: 0,
    reopenedAfterResolveCount: 0,
  };
}

/**
 * The shift a day's presence is measured against.
 *
 * Pure, and separated from the querying, because every way of getting it wrong
 * is quiet. An agent on a closed day gets a null window rather than a zero-long
 * one, so "late" is null rather than "late by the whole day"; an agent in
 * several groups is measured against the earliest opening among them, because
 * the earliest is the one that had them expected at a desk.
 */
export function shiftWindow(
  schedules: (HoursConfig | null)[],
  day: Date,
): { hours: HoursConfig; start: Date; end: Date } | null {
  let earliest: { hours: HoursConfig; start: Date; end: Date } | null = null;

  for (const hours of schedules) {
    if (!hours) continue;

    const window = scheduledWindow(hours, day);
    if (!window) continue;

    if (!earliest || window.start.getTime() < earliest.start.getTime()) {
      earliest = { hours, start: window.start, end: window.end };
    }
  }

  return earliest;
}

/**
 * Compute every active agent's day.
 *
 * `until` bounds the window early for the same reason `computeDay` takes it: a
 * day still in progress must be measured up to now rather than up to a midnight
 * that has not happened, or every figure for today reads as a collapse.
 */
export async function computeAgentDay(
  day: string,
  { zone, hoursFor }: ReportingContext,
  until?: Date,
): Promise<AgentDay[]> {
  const start = DateTime.fromISO(day, { zone });
  if (!start.isValid) {
    console.warn(`[agent-rollup] ignoring an unparseable day "${day}"`);
    return [];
  }

  const from = start.startOf('day').toJSDate();
  const endOfDay = start.plus({ days: 1 }).startOf('day').toJSDate();
  const to = until && until < endOfDay ? until : endOfDay;

  const roster = await db.select({ id: agents.id }).from(agents).where(eq(agents.isActive, true));

  if (roster.length === 0) return [];

  const days = new Map(roster.map((agent) => [agent.id, emptyDay(agent.id)]));
  /** Only agents on the roster get a row; a deleted one is not a day of zeros. */
  const forAgent = (agentId: string | null) => (agentId ? days.get(agentId) : undefined);

  const worked = notInArray(conversations.channel, readOnlyChannels());

  // --- Presence, and the shift it is measured against ------------------------
  const memberships = await db
    .select({ agentId: groupMembers.agentId, groupId: groupMembers.groupId })
    .from(groupMembers);

  const groupsByAgent = new Map<string, (string | null)[]>();
  for (const row of memberships) {
    groupsByAgent.set(row.agentId, [...(groupsByAgent.get(row.agentId) ?? []), row.groupId]);
  }

  const presence = await db
    .select({
      agentId: agentPresenceIntervals.agentId,
      startedAt: agentPresenceIntervals.startedAt,
      lastBeatAt: agentPresenceIntervals.lastBeatAt,
      endedAt: agentPresenceIntervals.endedAt,
      accepting: agentPresenceIntervals.accepting,
    })
    .from(agentPresenceIntervals)
    .where(
      and(
        lt(agentPresenceIntervals.startedAt, to),
        // Overlap, not containment: a shift that began yesterday evening and a
        // stream still open both belong to this day in part.
        or(
          isNull(agentPresenceIntervals.endedAt),
          gte(agentPresenceIntervals.endedAt, from),
          gte(agentPresenceIntervals.lastBeatAt, from),
        ),
      ),
    );

  const online = new Map<string, Span[]>();
  const accepting = new Map<string, Span[]>();

  for (const row of presence) {
    if (!days.has(row.agentId)) continue;

    const [span] = clampSpans([toSpan(row)], from.getTime(), to.getTime());
    if (!span) continue;

    online.set(row.agentId, [...(online.get(row.agentId) ?? []), span]);
    if (row.accepting) {
      accepting.set(row.agentId, [...(accepting.get(row.agentId) ?? []), span]);
    }
  }

  for (const [agentId, bucket] of days) {
    // Merged, never summed: two instances racing leave overlapping rows, and
    // summing them would report a sixteen-hour day. See lib/reports/intervals.
    const spans = mergeSpans(online.get(agentId) ?? [], PRESENCE_STITCH_MS);

    bucket.onlineSeconds = totalSeconds(spans);
    bucket.sessionCount = spans.length;
    bucket.longestSessionSeconds = longestSeconds(spans);
    bucket.firstOnlineAt = firstStart(spans);
    bucket.lastOnlineAt = lastEnd(spans);
    bucket.acceptingSeconds = totalSeconds(
      mergeSpans(accepting.get(agentId) ?? [], PRESENCE_STITCH_MS),
    );

    const schedules = (groupsByAgent.get(agentId) ?? [null]).map((groupId) =>
      hoursFor(null, groupId),
    );
    const shift = shiftWindow(schedules.length ? schedules : [hoursFor(null, null)], from);
    if (!shift) continue;

    bucket.scheduledStartAt = shift.start;
    bucket.scheduledEndAt = shift.end;
    bucket.scheduledSeconds = Math.round(businessMinutesBetween(shift.hours, from, endOfDay) * 60);
    // Intersected through the same function the SLA clock measures working time
    // with, so a shift and the due dates set during it cannot disagree about
    // which hours counted.
    bucket.onlineWithinHoursSeconds = spans.reduce(
      (running, span) =>
        running +
        Math.round(
          businessMinutesBetween(shift.hours, new Date(span.start), new Date(span.end)) * 60,
        ),
      0,
    );
  }

  // --- Focus: measured handling time ----------------------------------------
  const focus = await db
    .select({
      agentId: agentFocusIntervals.agentId,
      conversationId: agentFocusIntervals.conversationId,
      startedAt: agentFocusIntervals.startedAt,
      lastBeatAt: agentFocusIntervals.lastBeatAt,
      endedAt: agentFocusIntervals.endedAt,
    })
    .from(agentFocusIntervals)
    .where(
      and(
        lt(agentFocusIntervals.startedAt, to),
        or(
          isNull(agentFocusIntervals.endedAt),
          gte(agentFocusIntervals.endedAt, from),
          gte(agentFocusIntervals.lastBeatAt, from),
        ),
      ),
    );

  const focused = new Map<string, Span[]>();
  const focusedOn = new Map<string, Set<string>>();

  for (const row of focus) {
    if (!days.has(row.agentId)) continue;

    const [span] = clampSpans([toSpan(row)], from.getTime(), to.getTime());
    if (!span) continue;

    focused.set(row.agentId, [...(focused.get(row.agentId) ?? []), span]);
    focusedOn.set(row.agentId, (focusedOn.get(row.agentId) ?? new Set()).add(row.conversationId));
  }

  for (const [agentId, bucket] of days) {
    // Merged across every ticket they looked at, not per ticket and summed.
    // Only the focused tab beats, so overlap should not happen — but if a race
    // produces it, summing would let handling time exceed the working day and
    // push occupancy past 100%, which is the one thing that would make the
    // ratio unreadable.
    bucket.focusSeconds = totalSeconds(mergeSpans(focused.get(agentId) ?? [], FOCUS_STITCH_MS));
    bucket.conversationsFocused = focusedOn.get(agentId)?.size ?? 0;
  }

  // --- Assignment ------------------------------------------------------------
  // Keyed on `data->>'to'`, not `actor_agent_id`: the actor is whoever *did* the
  // assigning — often a rule or the sweep — and counting that would credit an
  // agent for handing work to somebody else.
  const assigned = await db
    .select({
      to: sql<string | null>`${conversationEvents.data}->>'to'`,
      from: sql<string | null>`${conversationEvents.data}->>'from'`,
      type: conversationEvents.type,
      previous: conversations.assigneeAgentId,
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(
      and(
        inArray(conversationEvents.type, ['assigned', 'unassigned', 'assignment_reclaimed']),
        gte(conversationEvents.createdAt, from),
        lt(conversationEvents.createdAt, to),
        worked,
      ),
    );

  for (const row of assigned) {
    if (row.type === 'assigned') {
      const bucket = forAgent(row.to);
      if (bucket) bucket.assignedCount += 1;
      continue;
    }

    // The reclaim pass writes `assignment_reclaimed` with `from` rather than an
    // `unassigned` with a null `to`, so work quietly taken back off an absent
    // agent would appear nowhere if this only looked at one of the two.
    const bucket = forAgent(row.from);
    if (!bucket) continue;

    if (row.type === 'assignment_reclaimed') bucket.reclaimedFromCount += 1;
    else bucket.transferredAwayCount += 1;
  }

  // --- What they wrote -------------------------------------------------------
  const written = await db
    .select({
      agentId: messages.authorAgentId,
      kind: messages.kind,
      conversationId: messages.conversationId,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        gte(messages.createdAt, from),
        lt(messages.createdAt, to),
        ne(messages.kind, 'system'),
        worked,
      ),
    );

  const touched = new Map<string, Set<string>>();

  for (const row of written) {
    const bucket = forAgent(row.agentId);
    if (!bucket) continue;

    if (row.kind === 'note') bucket.privateNotes += 1;
    else bucket.publicReplies += 1;

    touched.set(row.agentId!, (touched.get(row.agentId!) ?? new Set()).add(row.conversationId));
  }

  // Anything else they did to a ticket counts as a touch too — a status change
  // or a reassignment is work even when it left no message behind.
  const acted = await db
    .select({
      agentId: conversationEvents.actorAgentId,
      conversationId: conversationEvents.conversationId,
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(
      and(gte(conversationEvents.createdAt, from), lt(conversationEvents.createdAt, to), worked),
    );

  for (const row of acted) {
    if (!row.agentId || !days.has(row.agentId)) continue;
    touched.set(row.agentId, (touched.get(row.agentId) ?? new Set()).add(row.conversationId));
  }

  for (const [agentId, bucket] of days) bucket.touchedCount = touched.get(agentId)?.size ?? 0;

  // --- Resolutions they performed, and the ones that came back ---------------
  // The counterweight that makes the speed columns safe to publish. Resolution
  // time and handling time are both trivially improved by closing tickets that
  // are not finished, and these two columns are what show it happening.
  //
  // Both are keyed on who actually resolved the ticket, never on who holds it
  // now. `assigneeAgentId` was the obvious source and is wrong twice over: a
  // ticket handed on after the fact moves the mark onto somebody who never
  // closed it, and since this job rebuilds the last three days, the same day's
  // figure would change depending on when it was recomputed.
  const resolutions = await db
    .select({ agentId: conversations.resolvedByAgentId })
    .from(conversations)
    .where(
      and(
        gte(conversations.resolvedAt, from),
        lt(conversations.resolvedAt, to),
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
        worked,
      ),
    );

  for (const row of resolutions) {
    const bucket = forAgent(row.agentId);
    if (bucket) bucket.resolutionsMade += 1;
  }

  // Read from the event's own snapshot rather than from the conversation. The
  // column the snapshot came from is overwritten by the next resolution, so a
  // ticket resolved by one agent, reopened, then resolved by another would have
  // this reopening silently move onto the second agent on the next rebuild.
  // Same reasoning as `csat_surveys` snapshotting its agent at send time.
  const reopened = await db
    .select({ resolvedBy: sql<string | null>`${conversationEvents.data}->>'resolvedBy'` })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(
      and(
        eq(conversationEvents.type, 'reopened'),
        gte(conversationEvents.createdAt, from),
        lt(conversationEvents.createdAt, to),
        worked,
      ),
    );

  for (const row of reopened) {
    // Null for an automation's resolution, and for anything resolved before
    // this was recorded. Unattributed rather than guessed: putting a customer
    // coming back on the record of whoever happens to hold the ticket is the
    // exact error this replaced.
    const bucket = forAgent(row.resolvedBy);
    if (bucket) bucket.reopenedAfterResolveCount += 1;
  }

  // --- Backlog at the day's end ---------------------------------------------
  // The last sample taken before the boundary, rather than a count run now:
  // `conversations` holds only the current state, so counting it during a
  // rebuild would write today's backlog onto a day three weeks ago.
  const snapshots = await db
    .select({
      agentId: agentBacklogSnapshots.agentId,
      openCount: agentBacklogSnapshots.openCount,
      pendingCount: agentBacklogSnapshots.pendingCount,
      at: agentBacklogSnapshots.at,
    })
    .from(agentBacklogSnapshots)
    .where(and(gte(agentBacklogSnapshots.at, from), lte(agentBacklogSnapshots.at, to)))
    .orderBy(agentBacklogSnapshots.at);

  for (const row of snapshots) {
    const bucket = forAgent(row.agentId);
    if (!bucket) continue;

    // Ordered ascending, so the last one to land wins and is the latest sample
    // of the day. Left null when the day predates the snapshot job, which reads
    // as "not measured" instead of as an agent who finished with nothing.
    bucket.openAtDayEnd = row.openCount;
    bucket.pendingAtDayEnd = row.pendingCount;
  }

  return [...days.values()];
}

/**
 * Whether a reopening belongs to this agent.
 *
 * The whole rule is "the event's own snapshot, or nobody" — but it is the rule
 * that was wrong before, and getting it wrong is invisible in the output: a
 * reopen rate attributed to the wrong person still looks like a reopen rate.
 * Exported so it can be tested against the cases that actually differ.
 */
export function attributeReopen(event: { resolvedBy?: string | null }, agentId: string): boolean {
  return event.resolvedBy != null && event.resolvedBy === agentId;
}

/** Only rows with something on them — an agent who was off is not a day of zeros. */
export function withActivity(rows: AgentDay[]): AgentDay[] {
  return rows.filter(
    (row) =>
      row.onlineSeconds > 0 ||
      row.touchedCount > 0 ||
      row.assignedCount > 0 ||
      row.focusSeconds > 0 ||
      row.resolutionsMade > 0 ||
      row.openAtDayEnd !== null,
  );
}
