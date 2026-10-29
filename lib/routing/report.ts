import { asc, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { CATEGORY_AI_LIVE_LABEL, channels } from '@/db/schema';
import { CATEGORY_AI_ACTOR, type CategoryOutcome } from '@/lib/category-ai/decide';
import type { AssignmentStrategy } from '@/lib/assignment';
import { asDate } from '@/lib/reports/live';
import { within, type ReportWindow } from '@/lib/reports/rollup';
import { openBacklog } from '@/lib/tickets/backlog';
import { SETTLE_ACTOR } from './apply';
import { ROUTING_OUTCOMES, type RoutingOutcome } from './decide';
import { ROUTING_GRACE_MS } from './hold';
import { routingModeOf, type RoutingMode } from './mode';

/**
 * The reads behind `/reports/routing`: where each channel's new tickets went,
 * how long the router took to decide, why a window ran out, and what is left
 * open now (`plans/ticket-category-routing.md`, Stage 6).
 *
 * Every figure is read off `routing_decisions`, one row per ticket that
 * entered routing, and never off the `routed` events: a shadow row writes
 * none, and the one fact only an event carries — `moved` — is false on
 * `category` only when the route group was deleted under the decision, which
 * the foreign key on `to_group_id` makes roll phase one back. So a `category`
 * row is a ticket that moved.
 *
 * Grouped by `(channel_id, shadow)`: the channel row whose mode started the
 * decision, and whether that mode was the shadow. Live and shadow are never
 * added together — a shadow outcome is where a ticket would have gone — and a
 * channel moved from shadow to live during a range is two lines. Four WhatsApp
 * numbers are four lines, as they are four rows. A deleted channel leaves its
 * rows with a null `channel_id`, and every one of them is one line.
 *
 * A range selects on `started_at`, the instant the ticket entered routing, cut
 * at the team's midnights (`within`), so an undecided row has a day too. Each
 * read is one statement, and each takes the page's `now` and reads nothing
 * that started after it: the page's reads run a few at a time, and a ticket
 * entering routing between two of them would otherwise be in one table and
 * missing from the next. The statements are exported, as `customerWroteSet`
 * is, so a test can read their parameters back and see no raw `Date`.
 *
 * The time a decision was made is `coalesce(phase_one_at, decided_at)`: the
 * instant the recorded outcome was written. `decided_at` alone is the
 * phase-one instant on an ordinary live decision, but the resume on one
 * `settle_routing` completed after its caller died, and a person's instant
 * when they ended the hold between the router's phases — in both, minutes
 * after the decision itself.
 */

/**
 * A routed ticket nobody holds this long after its hold ended is reported as
 * still unassigned. Assignment runs as the hold ends (`afterHoldEnded`) and
 * the sweep every five minutes behind it (`shipblu-sla-sweep`), so ten minutes
 * is two sweeps that found nobody.
 */
export const STILL_UNASSIGNED_AFTER_MS = 10 * 60_000;

/**
 * A length of time as the page's sentences say it, built from the constant it
 * describes. Written out by hand, "ten minutes" stood in seven strings that a
 * change to either constant would have left describing a threshold the page no
 * longer applied.
 */
function minutesInWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** The hold's grace (`ROUTING_GRACE_MS`), past which an undecided record is stranded. */
export const GRACE_IN_WORDS = minutesInWords(ROUTING_GRACE_MS);

/** `STILL_UNASSIGNED_AFTER_MS`, as the page's sentences say it. */
export const STILL_UNASSIGNED_IN_WORDS = minutesInWords(STILL_UNASSIGNED_AFTER_MS);

/** How many tickets a list on the page names; every count beside it is exact. */
const LISTED = 50;

/** The router's own answers, the denominator of its shares. */
const ROUTER_OUTCOMES = [
  'category',
  'no_route_for_category',
  'fallback',
  'taken',
] as const satisfies readonly RoutingOutcome[];

/** A category settled before the router decided: the decisions a window is tuned from. */
const SETTLED_OUTCOMES = [
  'category',
  'no_route_for_category',
] as const satisfies readonly RoutingOutcome[];

/** `endHold`'s two: a person or a rule decided before the router recorded anything. */
const DECIDED_FIRST = ['manual', 'rule'] as const satisfies readonly RoutingOutcome[];

/** The router would have left the ticket where it was. */
const KEPT_OUTCOMES = [
  'no_route_for_category',
  'fallback',
] as const satisfies readonly RoutingOutcome[];

/**
 * Jev answered and was not sure enough to file anything, in the classifier's
 * own words (`CATEGORY_OUTCOMES`) — typed, so a rename there fails here.
 */
const UNSURE_OUTCOMES = [
  'unknown',
  'below_threshold',
] as const satisfies readonly CategoryOutcome[];
const FAILED_OUTCOME = 'failed' satisfies CategoryOutcome;

/** An instant as text behind its cast: a bare `Date` in a template reaches postgres.js untyped and throws. */
function instant(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** `<column> in (…)`, one parameter per value — never `= any(${array})`, a row constructor (§6.46). */
function textIn(column: SQL, values: readonly string[]): SQL {
  return sql`${column} in (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

const outcomeIn = (values: readonly RoutingOutcome[]) => textIn(sql`rd.outcome`, values);

/** The rows a range-bound figure reads: entered routing on one of the window's days, by `now`. */
function entered(window: ReportWindow, now: Date): SQL {
  return sql`${within(sql`rd.started_at`, window)} and rd.started_at <= ${instant(now)}`;
}

/** The instant the recorded outcome was written (see the header). */
const RECORDED = sql`coalesce(rd.phase_one_at, rd.decided_at)`;

function asNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** An `int[]`/`bigint[]` aggregate, whichever way the driver parsed it. */
function asNumbers(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string' && value.startsWith('{')) {
    const inner = value.slice(1, -1);
    return inner === '' ? [] : inner.split(',').map(Number);
  }
  return [];
}

function isRoutingOutcome(value: unknown): value is RoutingOutcome {
  return ROUTING_OUTCOMES.some((outcome) => outcome === value);
}

/** The channel a line of the report is about. Null `channelId`: the channel was deleted. */
export type ReportChannel = {
  channelId: string | null;
  channelName: string | null;
  /** The `channels.type` value, for the badge. */
  channelType: string | null;
  shadow: boolean;
};

const byChannel = (a: ReportChannel, b: ReportChannel) =>
  Number(a.shadow) - Number(b.shadow) ||
  // A deleted channel last, behind every row that still has a name.
  Number(a.channelName === null) - Number(b.channelName === null) ||
  (a.channelName ?? '').localeCompare(b.channelName ?? '') ||
  (a.channelId ?? '').localeCompare(b.channelId ?? '');

// ---------------------------------------------------------------------------
// Routes by outcome
// ---------------------------------------------------------------------------

export type RoutingSlice = ReportChannel & {
  /** Every row that started in the range. `decided + deciding + stranded`. */
  entered: number;
  /** At stage `decided`. Not "carries an outcome": phase one writes one while the stage is still `holding`. */
  decided: number;
  /** Undecided, and the grace past its window has not run out: normal while a window runs. */
  deciding: number;
  /** Undecided, and the grace has run out: a record that never closed. Should be 0. */
  stranded: number;
  /** The decided rows by outcome. Sums to `decided`. */
  outcomes: Record<RoutingOutcome, number>;
};

/**
 * Deciding and stranded split where `isHeld` does: a hold lasts while `now`
 * is before the window's end plus `ROUTING_GRACE_MS`, so at that instant the
 * grace has run out, and a row nothing decided by then is stranded — the same
 * instant the dashboard stops counting a held ticket as being routed.
 */
export function outcomesStatement(window: ReportWindow, now: Date): SQL {
  const graceOver = instant(new Date(now.getTime() - ROUTING_GRACE_MS));
  return sql`
    select rd.channel_id as "channelId",
           c.name as "channelName",
           c.type::text as "channelType",
           rd.shadow as "shadow",
           case when rd.stage = 'decided' then rd.outcome::text end as "outcome",
           count(*)::int as "rows",
           count(*) filter (where rd.stage <> 'decided' and rd.window_ends_at > ${graceOver})::int as "deciding",
           count(*) filter (where rd.stage <> 'decided' and rd.window_ends_at <= ${graceOver})::int as "stranded"
      from routing_decisions rd
      left join channels c on c.id = rd.channel_id
     where ${entered(window, now)}
     group by rd.channel_id, c.name, c.type, rd.shadow, 5`;
}

/** One line per `(channel, shadow)`, the eight outcomes pivoted over `ROUTING_OUTCOMES`. */
export async function routingOutcomes(
  window: ReportWindow,
  now: Date = new Date(),
): Promise<RoutingSlice[]> {
  const rows = await db.execute<{
    channelId: string | null;
    channelName: string | null;
    channelType: string | null;
    shadow: boolean;
    outcome: string | null;
    rows: number;
    deciding: number;
    stranded: number;
  }>(outcomesStatement(window, now));

  // Keyed for the lookup only: the dimensions travel in the value, so nothing
  // is ever read back out of the key.
  const slices = new Map<string, RoutingSlice>();
  for (const row of rows) {
    const key = `${row.channelId ?? ''}|${String(row.shadow)}`;
    let slice = slices.get(key);
    if (!slice) {
      slice = {
        channelId: row.channelId,
        channelName: row.channelName,
        channelType: row.channelType,
        shadow: row.shadow,
        entered: 0,
        decided: 0,
        deciding: 0,
        stranded: 0,
        outcomes: noOutcomes(),
      };
      slices.set(key, slice);
    }
    const count = Number(row.rows);
    slice.entered += count;
    slice.deciding += Number(row.deciding);
    slice.stranded += Number(row.stranded);
    // The enum holds the column to the list; a decided row always carries one.
    if (isRoutingOutcome(row.outcome)) {
      slice.decided += count;
      slice.outcomes[row.outcome] += count;
    }
  }
  return [...slices.values()].sort(byChannel);
}

function noOutcomes(): Record<RoutingOutcome, number> {
  return Object.fromEntries(ROUTING_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    RoutingOutcome,
    number
  >;
}

/**
 * The decisions the router made itself, which its fallback and taken shares
 * are read over. Not every decision: `manual` and `rule` are tickets a person
 * or a rule decided before the router could, and `released` and `not_open`
 * ones it was never asked about. Over all of them a channel whose holds are
 * all ended by a rule — production's web chat, whose two `on_create` rules
 * move every new ticket — reads 0% fallback and looks perfect.
 */
export function routerDecided(outcomes: Record<RoutingOutcome, number>): number {
  return ROUTER_OUTCOMES.reduce((sum, outcome) => sum + outcomes[outcome], 0);
}

/** Decided by a person or a rule before the router recorded: its own share, over every decision. */
export function decidedFirst(outcomes: Record<RoutingOutcome, number>): number {
  return DECIDED_FIRST.reduce((sum, outcome) => sum + outcomes[outcome], 0);
}

// ---------------------------------------------------------------------------
// Time to decision
// ---------------------------------------------------------------------------

/** Durations in seconds, as Postgres computed them: round before `formatDuration`. */
export type DecisionTiming = ReportChannel & {
  /** Every window length in force on the line's rows, in minutes. */
  windowMinutes: number[];
  /** `category` and `no_route_for_category`: a category settled, and the router routed on it. */
  settled: number;
  settledP50: number | null;
  settledP90: number | null;
  /** Settled before the window's end, rather than routed on at the settle. */
  settledInWindow: number;
  /** `manual` and `rule`, measured apart: what a person or rule did is not the router's speed. */
  decidedFirst: number;
  decidedFirstP50: number | null;
  /** Decided by `settle_routing` at the window's end, and how far past the end it got there. */
  settledByJob: number;
  settleLagP90: number | null;
  settleLagMax: number | null;
  /** Live `category` decisions, and those an `assigned` event followed. Zero on a shadow line. */
  routed: number;
  routedAssigned: number;
  routedAssignedP50: number | null;
};

/**
 * Time to decision is `coalesce(phase_one_at, decided_at) - started_at`, over
 * the decisions a category settled. Not `fallback`, which is decided at the
 * window's end by definition: its duration is the window plus the job's lag,
 * reported as the lag. The window is `window_ends_at - started_at`, copied
 * onto each ticket when it entered, so it differs between rows only when an
 * admin changed `routing_window_minutes` — and percentiles over two windows
 * answer neither, which is why every length in force is returned.
 *
 * "Routed means assigned" is the plan's ask 5 read directly: of the live
 * `category` decisions, how many an `assigned` event followed — any writer's,
 * the rota's, a person's or a number's owner's — at or after the decision,
 * and how long the first one took.
 */
export function timingStatement(window: ReportWindow, now: Date): SQL {
  const settled = sql`rd.stage = 'decided' and ${outcomeIn(SETTLED_OUTCOMES)}`;
  const first = sql`rd.stage = 'decided' and ${outcomeIn(DECIDED_FIRST)}`;
  const byJob = sql`rd.stage = 'decided' and rd.decided_by_label = ${SETTLE_ACTOR}`;
  const routed = sql`not rd.shadow and rd.stage = 'decided' and rd.outcome = ${'category' satisfies RoutingOutcome}`;
  return sql`
    select rd.channel_id as "channelId",
           c.name as "channelName",
           c.type::text as "channelType",
           rd.shadow as "shadow",
           array_agg(distinct round(extract(epoch from rd.window_ends_at - rd.started_at) / 60)::int) as "windowMinutes",
           count(*) filter (where ${settled})::int as "settled",
           (percentile_cont(0.5) within group (order by t.took) filter (where ${settled}))::float8 as "settledP50",
           (percentile_cont(0.9) within group (order by t.took) filter (where ${settled}))::float8 as "settledP90",
           count(*) filter (where ${settled} and r.recorded < rd.window_ends_at)::int as "settledInWindow",
           count(*) filter (where ${first})::int as "decidedFirst",
           (percentile_cont(0.5) within group (order by t.took) filter (where ${first}))::float8 as "decidedFirstP50",
           count(*) filter (where ${byJob})::int as "settledByJob",
           (percentile_cont(0.9) within group (order by t.lag) filter (where ${byJob}))::float8 as "settleLagP90",
           (max(t.lag) filter (where ${byJob}))::float8 as "settleLagMax",
           count(*) filter (where ${routed})::int as "routed",
           count(a.at) filter (where ${routed})::int as "routedAssigned",
           (percentile_cont(0.5) within group (order by extract(epoch from a.at - r.recorded)::float8)
              filter (where ${routed} and a.at is not null))::float8 as "routedAssignedP50"
      from routing_decisions rd
      left join channels c on c.id = rd.channel_id
     cross join lateral (select ${RECORDED} as recorded) r
     cross join lateral (
           select extract(epoch from r.recorded - rd.started_at)::float8 as took,
                  extract(epoch from r.recorded - rd.window_ends_at)::float8 as lag
         ) t
      left join lateral (
           select min(e.created_at) as at
             from conversation_events e
            where ${routed}
              and e.conversation_id = rd.conversation_id
              and e.type = 'assigned'
              and e.created_at >= r.recorded
              and e.created_at <= ${instant(now)}
         ) a on true
     where ${entered(window, now)}
     group by rd.channel_id, c.name, c.type, rd.shadow`;
}

export async function decisionTiming(
  window: ReportWindow,
  now: Date = new Date(),
): Promise<DecisionTiming[]> {
  const rows = await db.execute<Record<string, unknown>>(timingStatement(window, now));
  return rows
    .map((row) => ({
      channelId: row.channelId as string | null,
      channelName: row.channelName as string | null,
      channelType: row.channelType as string | null,
      shadow: row.shadow as boolean,
      windowMinutes: asNumbers(row.windowMinutes).sort((a, b) => a - b),
      settled: Number(row.settled),
      settledP50: asNumber(row.settledP50),
      settledP90: asNumber(row.settledP90),
      settledInWindow: Number(row.settledInWindow),
      decidedFirst: Number(row.decidedFirst),
      decidedFirstP50: asNumber(row.decidedFirstP50),
      settledByJob: Number(row.settledByJob),
      settleLagP90: asNumber(row.settleLagP90),
      settleLagMax: asNumber(row.settleLagMax),
      routed: Number(row.routed),
      routedAssigned: Number(row.routedAssigned),
      routedAssignedP50: asNumber(row.routedAssignedP50),
    }))
    .sort(byChannel);
}

// ---------------------------------------------------------------------------
// Why a window ran out
// ---------------------------------------------------------------------------

export type FallbackReasons = ReportChannel & {
  fallbacks: number;
  /**
   * A category arrived after the decision: the first `category_changed`
   * naming one, after it. The evidence that a longer window would have routed
   * more. Split by who wrote it; the rest of `late` is a rule or a form.
   */
  late: number;
  lateJev: number;
  lateJevP50PastWindow: number | null;
  latePerson: number;
  latePersonP50PastWindow: number | null;
  /** By what Jev had said by the decision: nothing at all — no live row. */
  notAsked: number;
  /** Every answer `unknown` or below the threshold (failures beside them aside): a lower threshold might have routed it. */
  unsure: number;
  /** Every call failed. */
  failed: number;
};

/**
 * For `fallback` rows, live and shadow: why nothing had settled. Two views,
 * each answering its own question. The late category is what happened after
 * the window — a Jev answer that landed late, a person filing it. The live
 * runs written by the decision say why at the window's end: Jev never asked
 * (a caption-less photo opener, a job not run yet), Jev unsure, or every call
 * failed. A ticket can be in both: a late Jev answer has no run row by the
 * decision, so it reads as not asked there.
 *
 * `data->>'to'` is compared as text and never cast: one hand-edited event
 * would otherwise refuse the whole page.
 */
export function fallbackStatement(window: ReportWindow, now: Date): SQL {
  const unsure = textIn(sql`run.outcome`, UNSURE_OUTCOMES);
  return sql`
    select rd.channel_id as "channelId",
           c.name as "channelName",
           c.type::text as "channelType",
           rd.shadow as "shadow",
           count(*)::int as "fallbacks",
           count(late.at)::int as "late",
           count(late.at) filter (where late.by_jev)::int as "lateJev",
           (percentile_cont(0.5) within group (order by extract(epoch from late.at - rd.window_ends_at)::float8)
              filter (where late.by_jev))::float8 as "lateJevP50PastWindow",
           count(late.at) filter (where late.by_person)::int as "latePerson",
           (percentile_cont(0.5) within group (order by extract(epoch from late.at - rd.window_ends_at)::float8)
              filter (where late.by_person))::float8 as "latePersonP50PastWindow",
           count(*) filter (where runs.rows = 0)::int as "notAsked",
           count(*) filter (where runs.unsure > 0 and runs.unsure + runs.failed = runs.rows)::int as "unsure",
           count(*) filter (where runs.rows > 0 and runs.failed = runs.rows)::int as "failed"
      from routing_decisions rd
      left join channels c on c.id = rd.channel_id
      left join lateral (
           select e.created_at as at,
                  coalesce(e.actor_label = ${CATEGORY_AI_ACTOR}, false) as by_jev,
                  e.actor_agent_id is not null as by_person
             from conversation_events e
            where e.conversation_id = rd.conversation_id
              and e.type = 'category_changed'
              and e.data->>'to' is not null
              and e.created_at > ${RECORDED}
              and e.created_at <= ${instant(now)}
            order by e.created_at, e.id
            limit 1
         ) late on true
     cross join lateral (
           select count(*)::int as rows,
                  count(*) filter (where ${unsure})::int as unsure,
                  count(*) filter (where run.outcome = ${FAILED_OUTCOME})::int as failed
             from ai_category_runs run
            where run.conversation_id = rd.conversation_id
              and run.run_label = ${CATEGORY_AI_LIVE_LABEL}
              and run.created_at <= ${RECORDED}
         ) runs
     where rd.stage = 'decided'
       and rd.outcome = ${'fallback' satisfies RoutingOutcome}
       and ${entered(window, now)}
     group by rd.channel_id, c.name, c.type, rd.shadow`;
}

export async function fallbackReasons(
  window: ReportWindow,
  now: Date = new Date(),
): Promise<FallbackReasons[]> {
  const rows = await db.execute<Record<string, unknown>>(fallbackStatement(window, now));
  return rows
    .map((row) => ({
      channelId: row.channelId as string | null,
      channelName: row.channelName as string | null,
      channelType: row.channelType as string | null,
      shadow: row.shadow as boolean,
      fallbacks: Number(row.fallbacks),
      late: Number(row.late),
      lateJev: Number(row.lateJev),
      lateJevP50PastWindow: asNumber(row.lateJevP50PastWindow),
      latePerson: Number(row.latePerson),
      latePersonP50PastWindow: asNumber(row.latePersonP50PastWindow),
      notAsked: Number(row.notAsked),
      unsure: Number(row.unsure),
      failed: Number(row.failed),
    }))
    .sort(byChannel);
}

// ---------------------------------------------------------------------------
// Taken
// ---------------------------------------------------------------------------

export type ListedTicket = {
  conversationId: string;
  number: number;
  /** `conversations.channel`, for the badge. */
  channel: string;
  channelName: string | null;
};

/**
 * Live tickets the router found already assigned — by the sweep after the
 * grace, or a stuck worker — and so never moved. The plan: "should be near
 * 0; each one is read", so each is named. Never on a shadow row, where the
 * rota assigning on arrival is expected (`decide`).
 */
export function takenStatement(window: ReportWindow, now: Date): SQL {
  return sql`
    select rd.conversation_id as "conversationId",
           conv.number as "number",
           conv.channel::text as "channel",
           c.name as "channelName",
           count(*) over ()::int as "total"
      from routing_decisions rd
      join conversations conv on conv.id = rd.conversation_id
      left join channels c on c.id = rd.channel_id
     where not rd.shadow
       and rd.stage = 'decided'
       and rd.outcome = ${'taken' satisfies RoutingOutcome}
       and ${entered(window, now)}
     order by rd.decided_at desc, rd.id
     limit ${LISTED}`;
}

export async function takenTickets(
  window: ReportWindow,
  now: Date = new Date(),
): Promise<{ total: number; tickets: ListedTicket[] }> {
  const rows = await db.execute<Record<string, unknown>>(takenStatement(window, now));
  return { total: Number(rows[0]?.total ?? 0), tickets: rows.map(listed) };
}

function listed(row: Record<string, unknown>): ListedTicket {
  return {
    conversationId: row.conversationId as string,
    number: Number(row.number),
    channel: row.channel as string,
    channelName: row.channelName as string | null,
  };
}

// ---------------------------------------------------------------------------
// Now: routed tickets still unassigned, and stranded rows
// ---------------------------------------------------------------------------

export type StillUnassigned = {
  /** The ticket's group now — a rule may have moved it since the decision. */
  groupId: string | null;
  groupName: string | null;
  /** That group's assignment strategy now; `manual` leaves every ticket unassigned by design. */
  strategy: AssignmentStrategy | null;
  outcome: RoutingOutcome;
  tickets: number;
  /** The longest-waiting ones' numbers, at most `LISTED`. */
  numbers: number[];
};

/**
 * Live decided tickets, other than `not_open`, still in the open backlog that
 * nobody has been assigned since they entered routing, `STILL_UNASSIGNED_AFTER_MS`
 * after the hold ended. Not range-bound: a routed ticket left unassigned for
 * sixty days matters most and would fall out of a thirty-day window.
 *
 * Never assigned since, not merely unassigned now: a ticket the rota gave
 * somebody and the sweep then reclaimed, one an agent unassigned or handed on,
 * is waiting for reasons that are not routing's, and the dashboard's
 * Unassigned counts it. Read off the `assigned` events, which every writer of
 * an assignee records (assignment, the console, a rule, a handover), from
 * `started_at` rather than `decided_at`: a ticket taken during its hold was
 * held at the decision, and a person's assignment that ended a hold is stamped
 * at its transaction's start, before the `decided_at` its `endHold` writes.
 * Routing never starts on a ticket assigned at its insert, so nothing before
 * `started_at` needs asking about. Driven from the unassigned open tickets,
 * which `conversations_assignee_idx` serves, with each probe of this table and
 * of the events by conversation.
 *
 * The backlog is `openBacklog()`, imported rather than restated, so this and
 * the dashboard's Unassigned cannot disagree about which tickets are work. The
 * clock is `decided_at`, the hold's end — assignment cannot run before it —
 * where every other figure here reads when the outcome was recorded.
 */
export function stillUnassignedStatement(now: Date): SQL {
  return sql`
    select conversations.group_id as "groupId",
           g.name as "groupName",
           g.assignment_strategy::text as "strategy",
           rd.outcome::text as "outcome",
           count(*)::int as "tickets",
           (array_agg(conversations.number order by rd.decided_at, conversations.number))[1:${LISTED}::int] as "numbers"
      from routing_decisions rd
      join conversations on conversations.id = rd.conversation_id
      join ticket_statuses on ticket_statuses.id = conversations.status_id
      left join groups g on g.id = conversations.group_id
     where not rd.shadow
       and rd.stage = 'decided'
       and rd.outcome <> ${'not_open' satisfies RoutingOutcome}
       and conversations.assignee_agent_id is null
       and ${openBacklog()}
       and rd.decided_at < ${instant(new Date(now.getTime() - STILL_UNASSIGNED_AFTER_MS))}
       and not exists (
             select 1
               from conversation_events e
              where e.conversation_id = rd.conversation_id
                and e.type = 'assigned'
                and e.created_at >= rd.started_at
                and e.created_at <= ${instant(now)}
           )
     group by conversations.group_id, g.name, g.assignment_strategy, rd.outcome`;
}

export async function routedStillUnassigned(now: Date = new Date()): Promise<StillUnassigned[]> {
  const rows = await db.execute<Record<string, unknown>>(stillUnassignedStatement(now));
  return rows
    .filter((row) => isRoutingOutcome(row.outcome))
    .map((row) => ({
      groupId: row.groupId as string | null,
      groupName: row.groupName as string | null,
      strategy: row.strategy as AssignmentStrategy | null,
      outcome: row.outcome as RoutingOutcome,
      tickets: Number(row.tickets),
      numbers: asNumbers(row.numbers),
    }))
    .sort(
      (a, b) =>
        Number(a.groupName === null) - Number(b.groupName === null) ||
        (a.groupName ?? '').localeCompare(b.groupName ?? '') ||
        ROUTING_OUTCOMES.indexOf(a.outcome) - ROUTING_OUTCOMES.indexOf(b.outcome),
    );
}

export type StrandedRow = ListedTicket & {
  shadow: boolean;
  windowEndsAt: Date;
};

/**
 * Rows nothing decided by the end of the grace past their window, live and
 * shadow, whenever they started. A live one is no longer held — `isHeld` is
 * false once the grace runs out, so the sweep may assign it — so it is a
 * record that never closed, not a ticket stuck unassigned; its
 * `settle_routing` job died, or its phase three never finished. Read off the
 * rows, never off dead jobs: a purged ticket's job goes `dead` as a matter of
 * course, and its row has cascaded away.
 */
export function strandedStatement(now: Date): SQL {
  return sql`
    select listed.*
      from (
           select rd.conversation_id as "conversationId",
                  conv.number as "number",
                  conv.channel::text as "channel",
                  c.name as "channelName",
                  rd.shadow as "shadow",
                  rd.window_ends_at as "windowEndsAt",
                  count(*) over (partition by rd.shadow)::int as "total",
                  row_number() over (partition by rd.shadow order by rd.window_ends_at, rd.id) as "place"
             from routing_decisions rd
             join conversations conv on conv.id = rd.conversation_id
             left join channels c on c.id = rd.channel_id
            where rd.stage <> 'decided'
              and rd.window_ends_at <= ${instant(new Date(now.getTime() - ROUTING_GRACE_MS))}
              and rd.started_at <= ${instant(now)}
         ) listed
     where listed.place <= ${LISTED}
     order by listed."shadow", listed.place`;
}

export async function strandedRouting(now: Date = new Date()): Promise<{
  live: number;
  shadow: number;
  rows: StrandedRow[];
}> {
  const rows = await db.execute<Record<string, unknown>>(strandedStatement(now));
  const totals = { live: 0, shadow: 0 };
  for (const row of rows) totals[row.shadow ? 'shadow' : 'live'] = Number(row.total);
  return {
    ...totals,
    rows: rows.map((row) => ({
      ...listed(row),
      shadow: row.shadow as boolean,
      windowEndsAt: asDate(row.windowEndsAt)!,
    })),
  };
}

// ---------------------------------------------------------------------------
// Shadow against people
// ---------------------------------------------------------------------------

export type ShadowComparison = Omit<ReportChannel, 'shadow'> & {
  /** The router would have moved the ticket (`category`)… */
  wouldMove: number;
  /** …and a person moved it there. */
  movedThere: number;
  /** …and a person moved it somewhere else. */
  movedElsewhere: number;
  /** …and nobody moved it. */
  notMoved: number;
  /** The router would have kept it where it was (`no_route_for_category`, `fallback`)… */
  wouldKeep: number;
  /** …and a person moved it: a route missed. */
  missed: number;
  /** …and nobody moved it elsewhere. */
  kept: number;
  /** A person or a rule decided before the router recorded: no would-be answer to compare. */
  manual: number;
  rule: number;
};

/**
 * Decided shadow rows against what people then did (plan 5.2, step 2). "A
 * person moved it" is the latest `group_changed` with an agent on it at or
 * after the would-be decision: the console's Group field and Hand to both
 * write one in the move's own transaction. A move before it is already the
 * row's outcome — `endHold` records a person's move during a shadow window as
 * `manual` — and a rule's move carries no agent. `released` and `not_open`
 * compare nothing and are left to the outcome table.
 *
 * `data->>'to'` is compared as text with `to_group_id::text`, never cast to a
 * uuid: one hand-edited event would otherwise refuse the page.
 */
export function shadowStatement(window: ReportWindow, now: Date): SQL {
  const move = sql`rd.outcome = ${'category' satisfies RoutingOutcome}`;
  const keep = outcomeIn(KEPT_OUTCOMES);
  const elsewhere = sql`person.moved and person.to_group is distinct from rd.to_group_id::text`;
  return sql`
    select rd.channel_id as "channelId",
           c.name as "channelName",
           c.type::text as "channelType",
           count(*) filter (where ${move})::int as "wouldMove",
           count(*) filter (where ${move} and person.moved and person.to_group is not distinct from rd.to_group_id::text)::int as "movedThere",
           count(*) filter (where ${move} and ${elsewhere})::int as "movedElsewhere",
           count(*) filter (where ${move} and person.moved is null)::int as "notMoved",
           count(*) filter (where ${keep})::int as "wouldKeep",
           count(*) filter (where ${keep} and ${elsewhere})::int as "missed",
           count(*) filter (where ${keep} and not coalesce(${elsewhere}, false))::int as "kept",
           count(*) filter (where rd.outcome = ${'manual' satisfies RoutingOutcome})::int as "manual",
           count(*) filter (where rd.outcome = ${'rule' satisfies RoutingOutcome})::int as "rule"
      from routing_decisions rd
      left join channels c on c.id = rd.channel_id
      left join lateral (
           select true as moved, e.data->>'to' as to_group
             from conversation_events e
            where e.conversation_id = rd.conversation_id
              and e.type = 'group_changed'
              and e.actor_agent_id is not null
              and e.created_at >= rd.decided_at
              and e.created_at <= ${instant(now)}
            order by e.created_at desc, e.id desc
            limit 1
         ) person on true
     where rd.shadow
       and rd.stage = 'decided'
       and ${entered(window, now)}
     group by rd.channel_id, c.name, c.type`;
}

export async function shadowAgainstPeople(
  window: ReportWindow,
  now: Date = new Date(),
): Promise<ShadowComparison[]> {
  const rows = await db.execute<Record<string, unknown>>(shadowStatement(window, now));
  return rows
    .map((row) => ({
      channelId: row.channelId as string | null,
      channelName: row.channelName as string | null,
      channelType: row.channelType as string | null,
      wouldMove: Number(row.wouldMove),
      movedThere: Number(row.movedThere),
      movedElsewhere: Number(row.movedElsewhere),
      notMoved: Number(row.notMoved),
      wouldKeep: Number(row.wouldKeep),
      missed: Number(row.missed),
      kept: Number(row.kept),
      manual: Number(row.manual),
      rule: Number(row.rule),
    }))
    .sort((a, b) => byChannel({ ...a, shadow: true }, { ...b, shadow: true }));
}

// ---------------------------------------------------------------------------
// State: the history, and each channel's mode now
// ---------------------------------------------------------------------------

/**
 * When the first and the last ticket entered routing, whatever the range:
 * what the empty states and the "this window opens before…" notice are built
 * from (§6.54). A young table under a range control otherwise reads as range
 * buttons that do nothing.
 */
export function historyStatement(now: Date): SQL {
  return sql`
    select min(rd.started_at) as "first", max(rd.started_at) as "last"
      from routing_decisions rd
     where rd.started_at <= ${instant(now)}`;
}

export async function routingHistory(
  now: Date = new Date(),
): Promise<{ first: Date | null; last: Date | null }> {
  const [row] = await db.execute<{ first: unknown; last: unknown }>(historyStatement(now));
  return { first: asDate(row?.first), last: asDate(row?.last) };
}

export type RoutingChannel = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  /** Through `routingModeOf`, never off the column: a coexistence number or the bot reads `default_group`. */
  mode: RoutingMode;
};

/**
 * Every channel row and its routing mode now, for the state notice and for a
 * line saying a channel in a category mode had nothing enter routing in the
 * range. Configuration, not a figure, so it takes no `now`.
 */
export async function routingChannels(): Promise<RoutingChannel[]> {
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      config: channels.config,
      routingMode: channels.routingMode,
      isActive: channels.isActive,
    })
    .from(channels)
    .orderBy(asc(channels.name));
  return rows.map(({ config, routingMode, ...row }) => ({
    ...row,
    mode: routingModeOf({ type: row.type, config, routingMode }),
  }));
}
