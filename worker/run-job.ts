import { randomUUID } from 'node:crypto';
import { closeDb } from '@/db/client';
import type { ClaimedJob, JobType } from '@/lib/queue';
import { resolveHandler } from './handlers';

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

async function main() {
  const type = process.argv[2];
  if (!type) {
    console.error('Usage: npm run job -- <job_type>');
    process.exit(1);
  }

  const handler = resolveHandler(type);

  // Cron-invoked handlers get a synthetic job row: they are not queue-backed, but
  // handlers take a ClaimedJob so the same function can be used either way.
  const job: ClaimedJob = {
    id: randomUUID(),
    type: type as JobType,
    payload: {},
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
