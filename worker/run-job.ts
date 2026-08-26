import { randomUUID } from 'node:crypto';
import { closeDb } from '@/db/client';
import type { ClaimedJob, JobType } from '@/lib/queue';
import { isPlannedButUnimplemented, resolveHandler } from './handlers';

/**
 * One-shot job runner, invoked by Render cron jobs as `npm run job -- <type>`.
 *
 * Runs the handler directly rather than enqueueing it, so the cron job's own
 * exit code reflects whether the work succeeded — a failed nightly rollup shows
 * up as a failed cron run in Render instead of silently becoming a dead row.
 *
 * This is also why scheduled work does not go through HTTP endpoints: no shared
 * secret to guard, and no request timeout to fight.
 */

/**
 * Trailing `key=value` arguments, as the job's payload.
 *
 * Cron jobs pass none and get `{}`, exactly as before. It exists for the
 * handlers whose options were otherwise unreachable: a backfill documents a
 * `force` flag on its payload type and, run the only way anybody runs it, could
 * never receive one — the escape hatch existed solely for whoever thought to
 * hand-insert a `jobs` row.
 *
 * `true`, `false` and numbers are converted, because a handler checking
 * `payload.force === true` would otherwise be reading the string "true" and
 * quietly doing nothing.
 */
function parsePayload(args: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const arg of args) {
    const separator = arg.indexOf('=');
    if (separator <= 0) {
      console.error(`[job] ignoring argument "${arg}" — expected key=value`);
      continue;
    }

    const key = arg.slice(0, separator);
    const raw = arg.slice(separator + 1);

    if (raw === 'true' || raw === 'false') payload[key] = raw === 'true';
    else if (raw !== '' && Number.isFinite(Number(raw))) payload[key] = Number(raw);
    else payload[key] = raw;
  }

  return payload;
}

async function main() {
  const type = process.argv[2];
  if (!type) {
    console.error('Usage: npm run job -- <job_type> [key=value ...]');
    process.exit(1);
  }

  const payload = parsePayload(process.argv.slice(3));

  // The Blueprint provisions every cron job up front, so schedules for later
  // phases fire before their handler exists. Exit 0 rather than failing the run:
  // a cron that "fails" on every firing by design teaches people to ignore cron
  // failures, and then a real one goes unnoticed.
  if (isPlannedButUnimplemented(type)) {
    console.log(`[job] ${type} is scheduled but not implemented yet — skipping`);
    return;
  }

  const handler = resolveHandler(type);

  // Cron-invoked handlers get a synthetic job row: they are not queue-backed, but
  // handlers take a ClaimedJob so the same function can be used either way.
  const job: ClaimedJob = {
    id: randomUUID(),
    type: type as JobType,
    payload,
    status: 'processing',
    priority: 100,
    runAt: new Date(),
    attempts: 1,
    maxAttempts: 1,
    lastError: null,
    dedupeKey: null,
    lockedAt: new Date(),
    lockedBy: 'cron',
    completedAt: null,
    createdAt: new Date(),
  };

  const started = Date.now();
  console.log(`[job] ${type} starting`);

  try {
    await handler(job);
    console.log(`[job] ${type} ok in ${Date.now() - started}ms`);
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error('[job] failed', error);
  process.exit(1);
});
