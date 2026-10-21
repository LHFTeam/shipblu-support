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
 * type where an admin has added one, as `channelFor` in ingest would have
 * chosen; with none it keeps the row it had. Its group is not touched: a ticket
 * stays where it is being worked, and a comments row's default group applies to
 * the tickets that arrive after it.
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
}

type TicketCount = { channel: string; tickets: number; onto_row: number };
type Counts = { tickets: TicketCount[]; surveys: number; suggestions: number };

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

/** A ticket filed on its platform's channel whose external id says it is a comment. */
const unmoved = sql`
  c.channel IN ('facebook', 'instagram')
  AND c.external_id ~ '^(facebook|instagram):comment:'
`;

/** A copy still on its platform although its ticket has moved to the comment channel. */
const copyBehind = sql`
  copy.channel IN ('facebook', 'instagram')
  AND c.channel::text = copy.channel::text || '_comment'
`;

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

    return { tickets: [...tickets], surveys: surveys.length, suggestions: suggestions.length };
  });
}
