import { describe, expect, it } from 'vitest';
import { toClaimedJob } from './index';

/**
 * The claim query is raw SQL, so its rows arrive with the database's own column
 * names. Nothing else in the worker notices — until `failJob` compares
 * `attempts` against `maxAttempts` and finds nothing there, and a job that
 * should have died at five attempts retries for as long as the worker runs.
 */
describe('toClaimedJob', () => {
  const row = {
    id: '11d547d4-28ce-4858-93a3-d78581c6d197',
    type: 'send_meta',
    payload: { messageId: 'abc' },
    status: 'processing',
    priority: 10,
    run_at: new Date('2026-08-20T20:56:09Z'),
    attempts: 5,
    max_attempts: 5,
    last_error: 'An unknown error has occurred.',
    dedupe_key: 'send:abc',
    locked_at: new Date('2026-08-20T20:56:10Z'),
    locked_by: 'worker-1',
    completed_at: null,
    created_at: new Date('2026-08-20T20:51:05Z'),
  };

  it('reads the attempt limit the queue enforces', () => {
    const job = toClaimedJob(row);

    expect(job.maxAttempts).toBe(5);
    expect(job.attempts >= job.maxAttempts).toBe(true);
  });

  it('carries the rest of the row across', () => {
    const job = toClaimedJob(row);

    expect(job).toMatchObject({
      id: row.id,
      type: 'send_meta',
      payload: { messageId: 'abc' },
      status: 'processing',
      priority: 10,
      runAt: row.run_at,
      lastError: row.last_error,
      dedupeKey: 'send:abc',
      lockedBy: 'worker-1',
      completedAt: null,
      createdAt: row.created_at,
    });
  });

  it('defaults a missing payload rather than handing a handler undefined', () => {
    expect(toClaimedJob({ ...row, payload: null }).payload).toEqual({});
  });
});
