import { beforeEach, describe, expect, it, vi } from 'vitest';

const updates: Record<string, unknown>[] = [];

vi.mock('@/db/client', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => {} };
      },
    }),
  },
}));

const { failJob, PermanentJobError } = await import('./index');
type ClaimedJob = Parameters<typeof failJob>[0];

function job(attempts: number, maxAttempts = 5): ClaimedJob {
  return {
    id: 'job-1',
    type: 'send_notification_email',
    payload: {},
    status: 'processing',
    priority: 100,
    runAt: new Date(),
    attempts,
    maxAttempts,
    lastError: null,
    dedupeKey: null,
    lockedAt: new Date(),
    lockedBy: 'worker-1',
    completedAt: null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  updates.length = 0;
});

/**
 * What a failure does to the job row. `failJob` has been wrong before in a way
 * nothing noticed — it once read `maxAttempts` off a raw row, got `undefined`,
 * and no job ever died (see `toClaimedJob`) — so each of its three outcomes is
 * pinned here.
 */
describe('failJob', () => {
  it('puts an ordinary failure back in the queue with a backoff', async () => {
    const before = Date.now();
    await failJob(job(1), new Error('Postmark answered 503'));

    expect(updates[0]).toMatchObject({ status: 'pending', lockedAt: null, lockedBy: null });
    expect((updates[0]!.runAt as Date).getTime()).toBeGreaterThanOrEqual(before + 10_000);
    expect(updates[0]!.lastError).toMatch(/^Postmark answered 503/);
  });

  it('marks a job dead once it has used every attempt', async () => {
    await failJob(job(5), new Error('still 503'));

    expect(updates[0]).toMatchObject({ status: 'dead' });
  });

  /**
   * The case the handlers' own comments described and the queue did not
   * implement: `send_notification_email` said a malformed payload fails "rather
   * than burning five attempts", and then threw an Error the queue retried five
   * times over most of an hour.
   */
  it('marks a permanent failure dead on its first attempt, keeping the reason', async () => {
    await failJob(job(1), new PermanentJobError('invalid payload — to: expected email'));

    expect(updates[0]).toMatchObject({ status: 'dead' });
    expect(updates[0]!.lastError).toMatch(/^invalid payload — to: expected email/);
  });
});
