import {
  ARCHIVE_STARTS,
  applyCategoryRun,
  recordCategoryRun,
  type RecordTally,
} from '@/lib/category-ai/backfill';
import { dayWindow } from '@/lib/hours/wall-clock';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import { logger } from '@/lib/log';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { logChannelTable, requestedChannels } from '@/lib/queue/backfill';
import { parseJobPayload } from '@/lib/queue/payloads';
import { typesafeConfigured } from '@/lib/typesafe/client';

/**
 * Jev's category classifier over tickets it never saw live: `record` asks and
 * writes only run rows under a label of its own, `apply` files open tickets
 * from a record label's answers and fires nothing. What each mode reads and
 * why is in `lib/category-ai/backfill.ts`; this is the queue's side of it.
 *
 * Hand-run and on no cron, for the reason `backfill_subcategorise_ai` gives.
 * The order 4.2 runs them in:
 *
 *     npm run job -- backfill_category_ai mode=record runLabel=archive-1 dryRun=true limit=5
 *     npm run job -- backfill_category_ai mode=record runLabel=archive-1
 *     npm run job -- backfill_category_ai mode=record runLabel=backlog-1
 *     npm run job -- backfill_category_ai mode=apply fromLabel=backlog-1 dryRun=true
 *     npm run job -- backfill_category_ai mode=apply fromLabel=backlog-1
 *
 * A label whose rows answered another question — a category added, renamed or
 * retired since — is refused in both modes, as a dead job naming the
 * fingerprints: a new label is the answer, not a retry.
 */

const TAG = '[backfill_category_ai]';
const log = logger('backfill_category_ai');

export async function backfillCategoryAi(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'backfill_category_ai');
  const dryRun = payload.dryRun === true;
  const scope = {
    channels: requestedChannels(payload.channels, TAG),
    since: payload.since ?? dayWindow(ARCHIVE_STARTS, TEAM_TIME_ZONE)!.start,
    until: payload.until,
    limit: payload.limit,
    dryRun,
  };

  if (payload.mode === 'apply') {
    const result = await applyCategoryRun({ ...scope, fromLabel: payload.fromLabel! });
    if (result.status === 'refused') throw new PermanentJobError(`${TAG} ${result.reason}`);

    log.info(
      `from="${payload.fromLabel}" candidates=${result.candidates} ` +
        `${dryRun ? 'would_apply' : 'applied'}=${result.applied} dry_run=${dryRun}`,
    );
    for (const [reason, count] of [...result.left].sort()) {
      log.info('left', { reason, count });
    }
    // What filing would wake, had it fired anything: nothing here runs these.
    for (const rule of result.rules) {
      log.info('rule', {
        trigger: rule.trigger,
        name: rule.name,
        newly_matches: rule.newly,
        stops_matching: rule.stops,
      });
    }
    return;
  }

  if (!dryRun && !typesafeConfigured()) {
    // A skip rather than a failure, as the subcategoriser's backfill answers:
    // a hand-run that throws teaches less than one that says what is missing.
    log.info(`TYPESAFE_API_KEY is not set — nothing to run`);
    return;
  }

  const result = await recordCategoryRun({ ...scope, runLabel: payload.runLabel! });
  if (result.status === 'refused') throw new PermanentJobError(`${TAG} ${result.reason}`);

  const column = (heading: string, value: (tally: RecordTally) => number) => ({
    heading,
    width: Math.max(8, heading.length + 1),
    value,
  });
  logChannelTable(log, result.tallies, [
    column('tickets', (t) => t.tickets),
    column('skipped', (t) => t.skipped),
    column('resumed', (t) => t.resumed),
    column('asked', (t) => t.asked),
    column('would_apply', (t) => t.outcomes.would_apply),
    column('unknown', (t) => t.outcomes.unknown),
    column('below', (t) => t.outcomes.below_threshold),
    column('owned', (t) => t.outcomes.owned),
    column('settled', (t) => t.outcomes.after_settle),
    column('capped', (t) => t.outcomes.capped),
    column('failed', (t) => t.outcomes.failed),
    column('transient', (t) => t.transient),
  ]);

  const transient = [...result.tallies.values()].reduce((sum, t) => sum + t.transient, 0);
  if (transient > 0) {
    // Thrown after everything durable is written, so the queue's retry only
    // resumes the stopped tickets: every message answered is read back, not
    // asked again.
    throw new Error(
      `${TAG} ${transient} ticket(s) stopped on a transient failure; re-run to resume`,
    );
  }
  log.info(`run="${payload.runLabel}" dry_run=${dryRun}`);
}
