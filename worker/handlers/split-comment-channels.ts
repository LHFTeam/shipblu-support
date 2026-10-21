import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

const log = logger('split_comment_channels');

/**
 * Moves the comment tickets filed before Stage 1.2 onto their comment channels.
 *
 * Until 1.2 every Facebook or Instagram comment ticket carried its platform's
 * channel and was told apart by its external id (`<platform>:comment:<root>`);
 * ingest now files a new one as `facebook_comment` / `instagram_comment`. This
 * moves the rest, so the inbox's comment views, the condition builder's comment
 * values and the reports' per-channel slices see every comment, and so the
 * CHECK of Stage 1.3 — the channel and the external id one answer — can be
 * added without a row to fail it. Deleted and merged tickets move too, because
 * the CHECK reads every row.
 *
 * A moved ticket's `channel_id` points at the oldest active comments row of its
 * type if an admin has added one by the time this runs, as `channelFor` in
 * ingest would have chosen then; with none it keeps the row it had. That is
 * once, at the move, as ingest chooses once, at filing: `channel_id` is the row
 * a ticket was filed through, so a comments row added later is the row of the
 * tickets that arrive after it, as its default group is, and a moved ticket is
 * not re-pointed. Its group is not touched either: a ticket stays where it is
 * being worked.
 *
 * The frozen copies move with it, the ones taken from the ticket's channel when
 * they were written: a CSAT survey's and a canned suggestion's. Left on the
 * platform, a rebuilt report would count a comment's skip or suggestion in the
 * direct-message slice, and the rollup's reconcile check — channel slices sum
 * to the total — could not see it. They are matched by their ticket's channel
 * as it now stands rather than by the tickets this run moved, so a copy written
 * on the old channel after its ticket moved is caught by the next run.
 *
 * One transaction, and safe to run again: a moved ticket no longer matches, and
 * neither does a moved copy, so a second run reports nothing. Run it once every
 * service runs 1.2 — a worker still on 1.1 files new comments on the platform
 * channel — and again until `dryRun=true` reports nothing to move; then
 * `rollup_metrics from=2026-08-29`, so the history shows the split.
 *
 * Every run also names the tickets 1.3's CHECK would refuse that this job does
 * not move: a comment's external id on any channel but its own platform's — a
 * non-Meta one, or the other platform's — or a comment channel without one.
 * Nothing files any of them today, and none is a comment this job can tell the
 * channel of, so they are left for a person — but the dry run is what 1.3
 * waits on, and a gate that counted only what it can move would read clear
 * with a row left that fails the constraint as it is added, and web's
 * preDeploy with it.
 */
export async function splitCommentChannels(job: ClaimedJob): Promise<void> {
  const { dryRun = false } = parseJobPayload(job, 'split_comment_channels');

  const counts = dryRun ? await wouldMove() : await move();

  for (const row of counts.tickets) {
    log.info(
      `${row.channel}: ${row.tickets} ${row.tickets === 1 ? 'ticket' : 'tickets'} ${dryRun ? 'would move' : 'moved'} to ${row.channel}_comment, ${row.onto_row} onto a comments row`,
    );
  }
  log.info(
    `${dryRun ? 'dry run: ' : ''}${sum(counts.tickets)} comment tickets, ` +
      `${counts.surveys} csat_surveys and ${counts.suggestions} canned_suggestions ` +
      `${dryRun ? 'would move' : 'moved'}`,
  );

  const { tickets, numbers } = counts.unmovable;
  const named = numbers.map((number) => `#${number}`).join(', ');
  const more = tickets > numbers.length ? ` and ${tickets - numbers.length} more` : '';
  log.info(
    `${tickets} ${tickets === 1 ? 'ticket' : 'tickets'} left that this job cannot move ` +
      `and Stage 1.3's CHECK would refuse${tickets ? `: ${named}${more}` : ''}`,
  );
}

type TicketCount = { channel: string; tickets: number; onto_row: number };
type Unmovable = { tickets: number; numbers: number[] };
type Counts = {
  tickets: TicketCount[];
  surveys: number;
  suggestions: number;
  unmovable: Unmovable;
};

const sum = (rows: TicketCount[]) => rows.reduce((total, row) => total + row.tickets, 0);

/**
 * The oldest active comments row for the platform of `c`, the ticket being
 * moved, if an admin has added one — read from its old channel, so it belongs
 * in a SET or a WHERE, never in a RETURNING, which sees the new one.
 */
const commentsRow = sql`(
  SELECT ch.id FROM channels ch
  WHERE ch.type = (c.channel::text || '_comment')::channel AND ch.is_active
  ORDER BY ch.created_at, ch.id
  LIMIT 1
)`;

/**
 * A ticket filed on its platform's channel whose external id says it is a
 * comment on that platform. The platforms are matched, not merely both Meta: a
 * Facebook comment's id on an Instagram ticket would otherwise move to
 * `instagram_comment`, which the CHECK accepts and nothing would ever correct.
 */
const unmoved = sql`
  c.channel IN ('facebook', 'instagram')
  AND c.external_id ~ ('^' || c.channel::text || ':comment:')
`;

/** A copy still on its platform although its ticket has moved to the comment channel. */
const copyBehind = sql`
  copy.channel IN ('facebook', 'instagram')
  AND c.channel::text = copy.channel::text || '_comment'
`;

/**
 * A ticket Stage 1.3's CHECK refuses: its channel is a comment channel, or its
 * external id names a comment, but not both. Spelled as the plan spells the
 * constraint, `coalesce` included, so a null external id is "not a comment"
 * rather than a null that would pass it.
 */
const refusedByCheck = sql`
  (coalesce(c.external_id, '') ~ '^(facebook|instagram):comment:')
    <> (c.channel IN ('facebook_comment', 'instagram_comment'))
`;

/**
 * What 1.3's CHECK would refuse once this job has moved what it can: every
 * refused ticket `unmoved` does not match, which after the move is every
 * refused ticket. The `coalesce` is a guard rather than a fix: `unmoved` is
 * null only for a platform-channel ticket with no external id, which the CHECK
 * accepts, so nothing it would refuse is lost to a null today; it keeps a
 * later change to either fragment from dropping rows silently. The first
 * twenty numbers are named, for a person to look at, and the count is whole.
 */
async function unmovable(run: Pick<typeof db, 'execute'>): Promise<Unmovable> {
  const [row] = await run.execute<{ tickets: number; numbers: (number | string)[] | null }>(sql`
    SELECT count(*)::int AS tickets,
      coalesce((array_agg(c.number ORDER BY c.number))[1:20], '{}') AS numbers
    FROM conversations c
    WHERE ${refusedByCheck} AND NOT coalesce((${unmoved}), false)
  `);
  return { tickets: row?.tickets ?? 0, numbers: (row?.numbers ?? []).map(Number) };
}

async function wouldMove(): Promise<Counts> {
  const tickets = await db.execute<TicketCount>(sql`
    SELECT c.channel::text AS channel,
      count(*)::int AS tickets,
      count(*) FILTER (WHERE ${commentsRow} IS NOT NULL)::int AS onto_row
    FROM conversations c
    WHERE ${unmoved}
    GROUP BY c.channel
    ORDER BY c.channel
  `);
  // Behind a ticket already moved, or on one this run would move.
  const stranded = sql`(${copyBehind}) OR (copy.channel = c.channel AND ${unmoved})`;
  const [copies] = await db.execute<{ surveys: number; suggestions: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM csat_surveys copy
        JOIN conversations c ON c.id = copy.conversation_id WHERE ${stranded}) AS surveys,
      (SELECT count(*)::int FROM canned_suggestions copy
        JOIN conversations c ON c.id = copy.conversation_id WHERE ${stranded}) AS suggestions
  `);
  return {
    tickets: [...tickets],
    surveys: copies?.surveys ?? 0,
    suggestions: copies?.suggestions ?? 0,
    unmovable: await unmovable(db),
  };
}

async function move(): Promise<Counts> {
  return db.transaction(async (tx) => {
    // The ticket first, so the copies below read it on its new channel. Whether
    // it landed on a comments row is read off the row as written: its channel
    // id now names a channel of its new type.
    const tickets = await tx.execute<TicketCount>(sql`
      WITH moved AS (
        UPDATE conversations c
        SET channel = (c.channel::text || '_comment')::channel,
          channel_id = coalesce(${commentsRow}, c.channel_id)
        WHERE ${unmoved}
        RETURNING c.channel::text AS comment_channel,
          EXISTS (
            SELECT 1 FROM channels ch WHERE ch.id = c.channel_id AND ch.type = c.channel
          ) AS onto_row
      )
      SELECT replace(comment_channel, '_comment', '') AS channel,
        count(*)::int AS tickets,
        count(*) FILTER (WHERE onto_row)::int AS onto_row
      FROM moved
      GROUP BY comment_channel
      ORDER BY comment_channel
    `);

    const surveys = await tx.execute(sql`
      UPDATE csat_surveys copy SET channel = c.channel
      FROM conversations c
      WHERE c.id = copy.conversation_id AND ${copyBehind}
      RETURNING copy.id
    `);
    const suggestions = await tx.execute(sql`
      UPDATE canned_suggestions copy SET channel = c.channel
      FROM conversations c
      WHERE c.id = copy.conversation_id AND ${copyBehind}
      RETURNING copy.id
    `);

    return {
      tickets: [...tickets],
      surveys: surveys.length,
      suggestions: suggestions.length,
      unmovable: await unmovable(tx),
    };
  });
}
