import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { NONE_KEY } from './request';

/**
 * How the reply box's suggestions are doing: how often Jev's pick is taken, and
 * which picks are right.
 *
 * Read from `canned_suggestions` alone, apart from the coverage figure. The
 * grade on each row — `sent_choice`, `sent_matches`, `sent_edit` — was frozen when its reply
 * was sent (`outcome.ts`), so these queries count rather than judge, and a
 * response deleted since cannot re-grade the past.
 *
 * **Correct** is the definition decided when this was built: the sent reply
 * carried the response Jev chose, by Tab or by the picker, edited or not; and a
 * reply carrying none after Jev said `none` is correct too. Every rate below
 * states its numerator and denominator in the page that prints it, because a
 * rate whose denominator is not on screen is a number anybody can misread.
 *
 * The window is the day the suggestion was asked for, in the team's zone, by the
 * `rangeIn()` rule: a pair of dates and the zone they are dates in, never the
 * database's `current_date`.
 */

export type ReportWindow = { from: string; to: string; zone: string };

/** `created_at` falls on one of the window's days, in the team's zone. */
function within(column: SQL, window: ReportWindow): SQL {
  return sql`${column} >= (${window.from}::date)::timestamp at time zone ${window.zone}
    and ${column} < ((${window.to}::date + 1))::timestamp at time zone ${window.zone}`;
}

const SUGGESTED = sql`cs.choice is not null and cs.choice <> ${NONE_KEY}`;

export type Headline = {
  requests: number;
  errored: number;
  unanswered: number;
  answered: number;
  none: number;
  suggested: number;
  shown: number;
  accepted: number;
  dismissed: number;
  /** Shown, and the ticket was then replied to — the denominator of precision. */
  shownReplied: number;
  /** …and the reply carried the suggested response: Jev was right. */
  shownRight: number;
  /** Never shown — the reply was typed first — and replied to: the anchoring check. */
  blindReplied: number;
  blindRight: number;
  /** Jev said `none` and the ticket was replied to. */
  noneReplied: number;
  /** …but the agent used a canned response after all. */
  noneMissed: number;
  /** Shown and right, by how the reply came to carry it — the two add up to `shownRight`. */
  rightViaTab: number;
  rightViaPicker: number;
  /** Right, by how much of the text survived. */
  unchanged: number;
  extended: number;
  reworded: number;
  latencyP50: number | null;
  latencyP90: number | null;
  tokensAvg: number | null;
  tokensTotal: number;
};

export async function headline(window: ReportWindow): Promise<Headline> {
  const rows = await db.execute<Record<keyof Headline, number | null>>(sql`
    select
      count(*)::int as "requests",
      count(*) filter (where cs.error is not null)::int as "errored",
      count(*) filter (where cs.settled_at is null)::int as "unanswered",
      count(*) filter (where cs.choice is not null)::int as "answered",
      count(*) filter (where cs.choice = ${NONE_KEY})::int as "none",
      count(*) filter (where ${SUGGESTED})::int as "suggested",
      count(*) filter (where cs.shown_at is not null)::int as "shown",
      count(*) filter (where cs.accepted_at is not null)::int as "accepted",
      count(*) filter (where cs.dismissed_at is not null)::int as "dismissed",
      count(*) filter (where cs.shown_at is not null and cs.replied_at is not null)::int as "shownReplied",
      count(*) filter (where cs.shown_at is not null and cs.replied_at is not null and cs.sent_matches)::int as "shownRight",
      count(*) filter (where ${SUGGESTED} and cs.shown_at is null and cs.replied_at is not null)::int as "blindReplied",
      count(*) filter (where ${SUGGESTED} and cs.shown_at is null and cs.replied_at is not null and cs.sent_matches)::int as "blindRight",
      count(*) filter (where cs.choice = ${NONE_KEY} and cs.replied_at is not null)::int as "noneReplied",
      count(*) filter (where cs.choice = ${NONE_KEY} and cs.replied_at is not null and cs.sent_choice <> ${NONE_KEY})::int as "noneMissed",
      count(*) filter (where ${SUGGESTED} and cs.shown_at is not null and cs.sent_matches and cs.accepted_at is not null)::int as "rightViaTab",
      count(*) filter (where ${SUGGESTED} and cs.shown_at is not null and cs.sent_matches and cs.accepted_at is null)::int as "rightViaPicker",
      count(*) filter (where cs.sent_edit = 'unchanged')::int as "unchanged",
      count(*) filter (where cs.sent_edit = 'extended')::int as "extended",
      count(*) filter (where cs.sent_edit = 'reworded')::int as "reworded",
      (percentile_cont(0.5) within group (order by cs.latency_ms) filter (where cs.choice is not null))::float8 as "latencyP50",
      (percentile_cont(0.9) within group (order by cs.latency_ms) filter (where cs.choice is not null))::float8 as "latencyP90",
      (avg(cs.input_tokens) filter (where cs.choice is not null))::float8 as "tokensAvg",
      coalesce(sum(cs.input_tokens), 0)::int as "tokensTotal"
    from canned_suggestions cs
    where ${within(sql`cs.created_at`, window)}
  `);

  const row = rows[0];
  const count = (key: keyof Headline) => Number(row?.[key] ?? 0);
  const maybe = (key: keyof Headline) => (row?.[key] == null ? null : Number(row[key]));

  return {
    requests: count('requests'),
    errored: count('errored'),
    unanswered: count('unanswered'),
    answered: count('answered'),
    none: count('none'),
    suggested: count('suggested'),
    shown: count('shown'),
    accepted: count('accepted'),
    dismissed: count('dismissed'),
    shownReplied: count('shownReplied'),
    shownRight: count('shownRight'),
    blindReplied: count('blindReplied'),
    blindRight: count('blindRight'),
    noneReplied: count('noneReplied'),
    noneMissed: count('noneMissed'),
    rightViaTab: count('rightViaTab'),
    rightViaPicker: count('rightViaPicker'),
    unchanged: count('unchanged'),
    extended: count('extended'),
    reworded: count('reworded'),
    latencyP50: maybe('latencyP50'),
    latencyP90: maybe('latencyP90'),
    tokensAvg: maybe('tokensAvg'),
    tokensTotal: count('tokensTotal'),
  };
}

export type ResponseRow = {
  /** The canned response's id. */
  id: string;
  /** Its current title if it still exists, else the title frozen when it was last suggested or sent. */
  title: string;
  /** Whether the response has since been deleted. */
  gone: boolean;
  suggested: number;
  shown: number;
  accepted: number;
  /** Shown and replied to — the denominator of this response's precision. */
  shownReplied: number;
  shownRight: number;
  /** Replies that carried it after Jev suggested it, by either route. */
  sentAsSuggested: number;
  /** Shown and right, taken with Tab or picked from the list — the two add up to `shownRight`. */
  viaTab: number;
  viaPicker: number;
  unchanged: number;
  edited: number;
  /** Suggested and replied to, but the reply carried another response. */
  replaced: number;
  /** Suggested and replied to, with no canned response at all. */
  ownWords: number;
  /** The agent sent this one when Jev had chosen something else, or none. */
  missed: number;
};

/**
 * One row per canned response that was suggested, or that an agent sent when
 * Jev had chosen otherwise — the second is how a response Jev never picks shows
 * up at all.
 */
export async function byResponse(window: ReportWindow): Promise<ResponseRow[]> {
  const rows = await db.execute<{
    id: string;
    frozen_title: string | null;
    live_title: string | null;
    suggested: number;
    shown: number;
    accepted: number;
    shown_replied: number;
    shown_right: number;
    sent_as_suggested: number;
    via_tab: number;
    via_picker: number;
    unchanged: number;
    edited: number;
    replaced: number;
    own_words: number;
    missed: number;
  }>(sql`
    with windowed as (
      select * from canned_suggestions cs where ${within(sql`cs.created_at`, window)}
    ),
    suggested as (
      select cs.choice as id,
             max(cs.canned_title) as frozen_title,
             count(*)::int as suggested,
             count(*) filter (where cs.shown_at is not null)::int as shown,
             count(*) filter (where cs.accepted_at is not null)::int as accepted,
             count(*) filter (where cs.shown_at is not null and cs.replied_at is not null)::int as shown_replied,
             count(*) filter (where cs.shown_at is not null and cs.replied_at is not null and cs.sent_matches)::int as shown_right,
             count(*) filter (where cs.sent_matches)::int as sent_as_suggested,
             count(*) filter (where cs.shown_at is not null and cs.sent_matches and cs.accepted_at is not null)::int as via_tab,
             count(*) filter (where cs.shown_at is not null and cs.sent_matches and cs.accepted_at is null)::int as via_picker,
             count(*) filter (where cs.sent_edit = 'unchanged')::int as unchanged,
             count(*) filter (where cs.sent_edit in ('extended', 'reworded'))::int as edited,
             count(*) filter (where cs.replied_at is not null and not cs.sent_matches
                                and cs.sent_choice <> ${NONE_KEY})::int as replaced,
             count(*) filter (where cs.replied_at is not null and cs.sent_choice = ${NONE_KEY})::int as own_words
      from windowed cs
      where ${SUGGESTED}
      group by cs.choice
    ),
    missed as (
      select cs.sent_choice as id,
             max(cs.sent_canned_title) as frozen_title,
             count(*)::int as missed
      from windowed cs
      where cs.replied_at is not null
        and cs.sent_choice <> ${NONE_KEY}
        and not cs.sent_matches
      group by cs.sent_choice
    )
    select coalesce(s.id, m.id) as id,
           coalesce(s.frozen_title, m.frozen_title) as frozen_title,
           cr.title as live_title,
           coalesce(s.suggested, 0) as suggested,
           coalesce(s.shown, 0) as shown,
           coalesce(s.accepted, 0) as accepted,
           coalesce(s.shown_replied, 0) as shown_replied,
           coalesce(s.shown_right, 0) as shown_right,
           coalesce(s.sent_as_suggested, 0) as sent_as_suggested,
           coalesce(s.via_tab, 0) as via_tab,
           coalesce(s.via_picker, 0) as via_picker,
           coalesce(s.unchanged, 0) as unchanged,
           coalesce(s.edited, 0) as edited,
           coalesce(s.replaced, 0) as replaced,
           coalesce(s.own_words, 0) as own_words,
           coalesce(m.missed, 0) as missed
    from suggested s
    full join missed m on m.id = s.id
    left join canned_responses cr on cr.id::text = coalesce(s.id, m.id)
    order by coalesce(s.suggested, 0) desc, coalesce(m.missed, 0) desc, coalesce(s.id, m.id)
  `);

  return rows.map((row) => ({
    id: row.id,
    title: row.live_title ?? row.frozen_title ?? '(untitled)',
    gone: row.live_title === null,
    suggested: Number(row.suggested),
    shown: Number(row.shown),
    accepted: Number(row.accepted),
    shownReplied: Number(row.shown_replied),
    shownRight: Number(row.shown_right),
    sentAsSuggested: Number(row.sent_as_suggested),
    viaTab: Number(row.via_tab),
    viaPicker: Number(row.via_picker),
    unchanged: Number(row.unchanged),
    edited: Number(row.edited),
    replaced: Number(row.replaced),
    ownWords: Number(row.own_words),
    missed: Number(row.missed),
  }));
}

export type ConfusionRow = {
  /** A canned response id or `none` — the row's identity, since titles repeat. */
  suggestedId: string;
  suggested: string;
  sentId: string;
  sent: string;
  count: number;
};

/**
 * Where Jev and the agent disagreed about which response, most frequent first —
 * `none` included on Jev's side, which is how a response the instructions steer
 * Jev away from shows up.
 */
export async function confusions(window: ReportWindow, limit = 10): Promise<ConfusionRow[]> {
  // Grouped on the frozen `choice` and `sent_choice`, so a response deleted
  // since keeps its pairs; titles are the live ones where they still exist.
  const rows = await db.execute<{
    suggested_id: string;
    suggested: string;
    sent_id: string;
    sent: string;
    count: number;
  }>(sql`
    select cs.choice as suggested_id,
           case when cs.choice = ${NONE_KEY} then ${NONE_KEY}
                else coalesce(sc.title, max(cs.canned_title), '(untitled)') end as suggested,
           cs.sent_choice as sent_id,
           coalesce(rc.title, max(cs.sent_canned_title), '(untitled)') as sent,
           count(*)::int as count
    from canned_suggestions cs
    left join canned_responses sc on sc.id::text = cs.choice
    left join canned_responses rc on rc.id::text = cs.sent_choice
    where ${within(sql`cs.created_at`, window)}
      and cs.replied_at is not null
      and cs.sent_choice <> ${NONE_KEY}
      and not cs.sent_matches
    group by cs.choice, sc.title, cs.sent_choice, rc.title
    order by count desc, suggested, sent
    limit ${limit}
  `);
  return rows.map((row) => ({
    suggestedId: row.suggested_id,
    suggested: row.suggested,
    sentId: row.sent_id,
    sent: row.sent,
    count: Number(row.count),
  }));
}

export type BandRow = {
  band: string;
  suggested: number;
  shown: number;
  accepted: number;
  shownReplied: number;
  shownRight: number;
};

/** The bands, lowest first. Edges are inclusive at the bottom. */
const BANDS = [
  { label: 'below 0.3', min: 0, max: 0.3 },
  { label: '0.3 – 0.6', min: 0.3, max: 0.6 },
  { label: '0.6 – 0.9', min: 0.6, max: 0.9 },
  { label: '0.9 and above', min: 0.9, max: Number.POSITIVE_INFINITY },
] as const;

/**
 * Suggestions by how much of the distribution Jev gave its pick.
 *
 * The evidence for a threshold, should one ever be wanted: if precision in the
 * lowest band is poor and its suggestions are mostly waved away, hiding them is
 * an argument this table makes and v1 does not act on. A probability, not an
 * evidence grade — nothing here is comparable to `conversation_categories.confidence`.
 */
export async function byProbability(window: ReportWindow): Promise<BandRow[]> {
  const rows = await db.execute<{
    probability: number | null;
    suggested: number;
    shown: number;
    accepted: number;
    shown_replied: number;
    shown_right: number;
  }>(sql`
    select cs.probability,
           count(*)::int as suggested,
           count(*) filter (where cs.shown_at is not null)::int as shown,
           count(*) filter (where cs.accepted_at is not null)::int as accepted,
           count(*) filter (where cs.shown_at is not null and cs.replied_at is not null)::int as shown_replied,
           count(*) filter (where cs.shown_at is not null and cs.replied_at is not null and cs.sent_matches)::int as shown_right
    from canned_suggestions cs
    where ${within(sql`cs.created_at`, window)} and ${SUGGESTED}
    group by cs.probability
  `);

  const bands: BandRow[] = BANDS.map((band) => ({
    band: band.label,
    suggested: 0,
    shown: 0,
    accepted: 0,
    shownReplied: 0,
    shownRight: 0,
  }));
  let unreported: BandRow | null = null;

  for (const row of rows) {
    const p = row.probability === null ? null : Number(row.probability);
    let target: BandRow;
    if (p === null) {
      unreported ??= {
        band: 'not reported',
        suggested: 0,
        shown: 0,
        accepted: 0,
        shownReplied: 0,
        shownRight: 0,
      };
      target = unreported;
    } else {
      const index = BANDS.findIndex((band) => p >= band.min && p < band.max);
      target = bands[index === -1 ? 0 : index]!;
    }
    target.suggested += Number(row.suggested);
    target.shown += Number(row.shown);
    target.accepted += Number(row.accepted);
    target.shownReplied += Number(row.shown_replied);
    target.shownRight += Number(row.shown_right);
  }

  return unreported ? [...bands, unreported] : bands;
}

export type SliceRow = {
  channel: string;
  locale: string;
  requests: number;
  suggested: number;
  shown: number;
  accepted: number;
  shownReplied: number;
  shownRight: number;
};

/**
 * By channel and the customer's language — the dimensions a suggester can fail
 * along without the total showing it. A model that does well on English email
 * and badly on Arabic Messenger averages to "fine" on a traffic mix that is
 * almost all Arabic Messenger.
 */
export async function byChannelAndLanguage(window: ReportWindow): Promise<SliceRow[]> {
  const rows = await db.execute<{
    channel: string;
    locale: string;
    requests: number;
    suggested: number;
    shown: number;
    accepted: number;
    shown_replied: number;
    shown_right: number;
  }>(sql`
    select cs.channel::text as channel,
           coalesce(cs.customer_locale, '—') as locale,
           count(*)::int as requests,
           count(*) filter (where ${SUGGESTED})::int as suggested,
           count(*) filter (where cs.shown_at is not null)::int as shown,
           count(*) filter (where cs.accepted_at is not null)::int as accepted,
           count(*) filter (where cs.shown_at is not null and cs.replied_at is not null)::int as shown_replied,
           count(*) filter (where cs.shown_at is not null and cs.replied_at is not null and cs.sent_matches)::int as shown_right
    from canned_suggestions cs
    where ${within(sql`cs.created_at`, window)}
    group by 1, 2
    order by requests desc, 1, 2
  `);
  return rows.map((row) => ({
    channel: row.channel,
    locale: row.locale,
    requests: Number(row.requests),
    suggested: Number(row.suggested),
    shown: Number(row.shown),
    accepted: Number(row.accepted),
    shownReplied: Number(row.shown_replied),
    shownRight: Number(row.shown_right),
  }));
}

export type Coverage = {
  /** Replies agents sent in the window, on channels with a reply box. */
  agentReplies: number;
  /** …that a suggestion was linked to. */
  linked: number;
  /** When an agent last sent a reply at all — the measured answer to "is anybody replying yet?". */
  lastAgentReplyAt: Date | null;
  /** The first suggestion ever recorded, so the page can say where its figures start. */
  firstSuggestionAt: Date | null;
};

/**
 * How much of the team's replying the suggestions saw.
 *
 * The one query that reads `messages`. A low figure is not Jev's fault: it is
 * the switch having been off, agents typing before clicking, or a reply box
 * with no inbound message to answer. Read-only channels are left out by
 * `readOnlyChannels()`, since nobody replies there.
 */
export async function coverage(window: ReportWindow): Promise<Coverage> {
  const readOnly = sql.join(
    readOnlyChannels().map((channel) => sql`${channel}`),
    sql`, `,
  );

  const [replies, edges] = await Promise.all([
    db.execute<{ agent_replies: number; linked: number }>(sql`
      select count(*)::int as agent_replies,
             count(cs.id)::int as linked
      from messages m
      join conversations c on c.id = m.conversation_id
      left join canned_suggestions cs on cs.message_id = m.id
      where m.direction = 'outbound'
        and m.kind = 'reply'
        and m.author_agent_id is not null
        and c.channel::text not in (${readOnly})
        and ${within(sql`m.created_at`, window)}
    `),
    db.execute<{ last_reply: string | null; first_suggestion: string | null }>(sql`
      select (select max(m.created_at)
                from messages m
               where m.direction = 'outbound'
                 and m.kind = 'reply'
                 and m.author_agent_id is not null)::text as last_reply,
             (select min(cs.created_at) from canned_suggestions cs)::text as first_suggestion
    `),
  ]);

  const counts = replies[0];
  const edge = edges[0];
  return {
    agentReplies: Number(counts?.agent_replies ?? 0),
    linked: Number(counts?.linked ?? 0),
    lastAgentReplyAt: edge?.last_reply ? new Date(edge.last_reply) : null,
    firstSuggestionAt: edge?.first_suggestion ? new Date(edge.first_suggestion) : null,
  };
}
