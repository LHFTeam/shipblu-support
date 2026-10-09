import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  claimJobs,
  completeJob,
  enqueue,
  failJob,
  hasActiveJob,
  PermanentJobError,
  reclaimStalledJobs,
  STALLED_AFTER_MS,
  touchJobs,
} from './index';

/**
 * The queue against real Postgres. `claim.test.ts` and `fail.test.ts` pin the
 * halves that can be read without one; what is here is the part that only the
 * database can answer — the claim is raw SQL, the dedupe is a unique index, and
 * the bug `toClaimedJob` exists for lived in the gap between the two.
 */

withCleanDatabase();

async function enqueued(...args: Parameters<typeof enqueue>): Promise<string> {
  const id = await enqueue(...args);
  if (!id) throw new Error('enqueue returned no id');
  return id;
}

async function row(id: string) {
  const [found] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!found) throw new Error(`no job ${id}`);
  return found;
}

describe('enqueue', () => {
  // The note on `dedupeKey` says this in prose; this is the index saying it.
  it('spends a dedupe key for good, not only until its job finishes', async () => {
    await enqueued('cleanup', {}, { dedupeKey: 'once' });
    expect(await enqueue('cleanup', {}, { dedupeKey: 'once' })).toBeNull();

    const [first] = await claimJobs(1, 'worker-a');
    expect(await completeJob(first!)).toBe(true);
    expect(await enqueue('cleanup', {}, { dedupeKey: 'once' })).toBeNull();
  });
});

describe('hasActiveJob', () => {
  it('sees a queued or running job of its own type, and nothing else', async () => {
    expect(await hasActiveJob('import_freshdesk_kb')).toBe(false);

    // Sitting out a backoff is still the same run.
    const id = await enqueued('import_freshdesk_kb', {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await hasActiveJob('import_freshdesk_kb')).toBe(true);
    expect(await hasActiveJob('backfill_shipment_links')).toBe(false);

    await db.update(jobs).set({ status: 'processing' }).where(eq(jobs.id, id));
    expect(await hasActiveJob('import_freshdesk_kb')).toBe(true);

    // Marked processing by hand above, so this attempt holds no worker id.
    expect(await completeJob({ id, lockedBy: null, attempts: 0 })).toBe(true);
    expect(await hasActiveJob('import_freshdesk_kb')).toBe(false);

    await db.update(jobs).set({ status: 'dead' }).where(eq(jobs.id, id));
    expect(await hasActiveJob('import_freshdesk_kb')).toBe(false);
  });
});

describe('claimJobs', () => {
  it('takes the most urgent due job first, and never hands one out twice', async () => {
    await enqueued('cleanup', {}, { priority: 200 });
    const urgent = await enqueued('send_email', { messageId: 'm1' }, { priority: 10 });
    await enqueued('rollup_metrics', {}, { runAt: new Date(Date.now() + 60_000) });

    const [first, ...none] = await claimJobs(1, 'worker-a');
    expect(none).toEqual([]);
    expect(first?.id).toBe(urgent);

    const rest = await claimJobs(10, 'worker-b');
    expect(rest.map((job) => job.type)).toEqual(['cleanup']);
    expect(await claimJobs(10, 'worker-c')).toEqual([]);
  });

  // `RETURNING` promises no order; the worker starts a claim's jobs as listed.
  it('lists a claim most urgent first', async () => {
    for (const priority of [300, 10, 200, 20, 100, 30]) {
      await enqueued('cleanup', {}, { priority });
    }

    const claimed = await claimJobs(6, 'worker-a');
    expect(claimed.map((job) => job.priority)).toEqual([10, 20, 30, 100, 200, 300]);
  });

  it('hands the row back under the schema’s names, not the database’s', async () => {
    const id = await enqueued('send_email', { messageId: 'm1' }, { maxAttempts: 3 });

    const [job] = await claimJobs(1, 'worker-a');
    expect(job).toMatchObject({
      id,
      type: 'send_email',
      payload: { messageId: 'm1' },
      status: 'processing',
      attempts: 1,
      maxAttempts: 3,
      lockedBy: 'worker-a',
      lastError: null,
    });
  });

  it('hands its instants back as the Dates its type promises', async () => {
    const runAt = new Date(Date.now() - 60_000);
    await enqueued('cleanup', {}, { runAt });

    const [job] = await claimJobs(1, 'worker-a');
    if (!job) throw new Error('nothing claimed');
    expect(job.runAt).toBeInstanceOf(Date);
    expect(job.runAt.getTime()).toBe(runAt.getTime());
    expect(job.lockedAt).toBeInstanceOf(Date);
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.completedAt).toBeNull();
  });
});

describe('failJob', () => {
  it('retries a claimed job until its attempts run out, then leaves it dead', async () => {
    const id = await enqueued('cleanup', {}, { maxAttempts: 2 });

    const [first] = await claimJobs(1, 'worker-a');
    if (!first) throw new Error('nothing claimed');
    await failJob(first, new Error('first failure'));

    const retrying = await row(id);
    expect(retrying.status).toBe('pending');
    expect(retrying.lockedBy).toBeNull();
    expect(retrying.lastError).toMatch(/^first failure/);
    expect(retrying.runAt.getTime()).toBeGreaterThan(Date.now());

    // Bring the retry due rather than waiting out its backoff.
    await db
      .update(jobs)
      .set({ runAt: new Date(0) })
      .where(eq(jobs.id, id));

    const [second] = await claimJobs(1, 'worker-a');
    if (!second) throw new Error('retry not claimed');
    expect(second.attempts).toBe(2);
    await failJob(second, new Error('second failure'));

    expect(await row(id)).toMatchObject({ status: 'dead', attempts: 2, lockedBy: null });
    expect(await claimJobs(1, 'worker-a')).toEqual([]);
  });

  it('leaves a PermanentJobError dead on its first attempt', async () => {
    const id = await enqueued('send_notification_email', {});

    const [job] = await claimJobs(1, 'worker-a');
    if (!job) throw new Error('nothing claimed');
    await failJob(job, new PermanentJobError('payload has no recipient'));

    expect(await row(id)).toMatchObject({ status: 'dead', attempts: 1 });
  });
});

describe('reclaimStalledJobs', () => {
  it('returns a job whose worker stopped holding it, and leaves a live one alone', async () => {
    const stalled = await enqueued('cleanup', {});
    const live = await enqueued('rollup_metrics', {});
    await claimJobs(2, 'worker-a');

    await db
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - STALLED_AFTER_MS - 1_000) })
      .where(eq(jobs.id, stalled));

    expect(await reclaimStalledJobs()).toBe(1);
    expect(await row(stalled)).toMatchObject({ status: 'pending', lockedAt: null, lockedBy: null });
    expect(await row(live)).toMatchObject({ status: 'processing', lockedBy: 'worker-a' });
  });
});

describe('reclaimStalledJobs, from a worker still running some of them', () => {
  it('leaves the jobs it says it is running, whatever their locks say', async () => {
    const mine = await enqueued('import_freshdesk_kb', {}, { priority: 1 });
    const orphan = await enqueued('cleanup', {}, { priority: 2 });
    await claimJobs(2, 'worker-a');
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - STALLED_AFTER_MS - 1_000) });

    expect(await reclaimStalledJobs(STALLED_AFTER_MS, [mine])).toBe(1);
    expect((await row(mine)).status).toBe('processing');
    expect((await row(orphan)).status).toBe('pending');
  });
});

describe('touchJobs', () => {
  it('refreshes only the running jobs this worker holds, and says which', async () => {
    const mine = await enqueued('cleanup', {}, { priority: 1 });
    const theirs = await enqueued('cleanup', {}, { priority: 2 });
    const waiting = await enqueued('cleanup', {}, { runAt: new Date(Date.now() + 60_000) });
    await claimJobs(1, 'worker-a');
    await claimJobs(1, 'worker-b');
    const old = new Date(Date.now() - 60_000);
    await db.update(jobs).set({ lockedAt: old });

    expect(await touchJobs([mine, theirs, waiting], 'worker-a')).toEqual([mine]);
    expect((await row(mine)).lockedAt!.getTime()).toBeGreaterThan(old.getTime());
    expect((await row(theirs)).lockedAt!.getTime()).toBe(old.getTime());
    expect(await touchJobs([], 'worker-a')).toEqual([]);
  });

  // The point of the heartbeat: a job slower than the window is not a dead worker's.
  it('keeps a slow job it refreshed out of the stalled sweep', async () => {
    const slow = await enqueued('import_freshdesk_kb', {});
    await claimJobs(1, 'worker-a');
    await db
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - STALLED_AFTER_MS - 1_000) })
      .where(eq(jobs.id, slow));

    await touchJobs([slow], 'worker-a');

    expect(await reclaimStalledJobs()).toBe(0);
    expect(await row(slow)).toMatchObject({ status: 'processing', lockedBy: 'worker-a' });
  });
});

describe('a finished job reported by an attempt that no longer holds it', () => {
  async function reclaimedAndClaimedAgain() {
    const id = await enqueued('cleanup', {}, { maxAttempts: 5 });
    const [stale] = await claimJobs(1, 'worker-a');
    await db
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - STALLED_AFTER_MS - 1_000) })
      .where(eq(jobs.id, id));
    await reclaimStalledJobs();
    // The same process takes it again, so only `attempts` tells the runs apart.
    const [current] = await claimJobs(1, 'worker-a');
    return { id, stale: stale!, current: current! };
  }

  it('is not recorded over the run that holds it now', async () => {
    const { id, stale, current } = await reclaimedAndClaimedAgain();

    expect(await completeJob(stale)).toBe(false);
    expect(await failJob(stale, new Error('late failure'))).toBe(false);
    expect(await row(id)).toMatchObject({
      status: 'processing',
      attempts: 2,
      lastError: null,
      lockedBy: 'worker-a',
    });

    expect(await completeJob(current)).toBe(true);
    expect((await row(id)).status).toBe('completed');
  });

  it('completes a reclaimed job nobody has taken again, so it does not run twice', async () => {
    const id = await enqueued('send_email', { messageId: 'm1' });
    const [job] = await claimJobs(1, 'worker-a');
    await db
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - STALLED_AFTER_MS - 1_000) })
      .where(eq(jobs.id, id));
    await reclaimStalledJobs();

    expect(await completeJob(job!)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'completed', lockedBy: null });
    expect(await claimJobs(1, 'worker-b')).toEqual([]);
  });

  it('does not fail a reclaimed job: the next run is its retry', async () => {
    const id = await enqueued('cleanup', {});
    const [job] = await claimJobs(1, 'worker-a');
    await db
      .update(jobs)
      .set({ lockedAt: new Date(Date.now() - STALLED_AFTER_MS - 1_000) })
      .where(eq(jobs.id, id));
    await reclaimStalledJobs();

    expect(await failJob(job!, new Error('late'))).toBe(false);
    expect(await row(id)).toMatchObject({ status: 'pending', lastError: null });
  });
});
