import { describe, expect, it } from 'vitest';
import { toClaimedJob } from './index';

/**
 * The claim query is raw SQL, so its rows arrive with the database's own column
 * names. Nothing else in the worker notices — until `failJob` compares
 * `attempts` against `maxAttempts` and finds nothing there, and a job that
 * should have died at five attempts retries for as long as the worker runs.
 */
describe('toClaimedJob', () => {
  // The instants are the text Postgres sends rather than Dates: drizzle leaves a
  // raw row's timestamps unparsed, and a fixture of Dates is what hid that.
  const row = {
    id: '11d547d4-28ce-4858-93a3-d78581c6d197',
    type: 'send_meta',
    payload: { messageId: 'abc' },
    status: 'processing',
    priority: 10,
    run_at: '2026-08-20 20:56:09+00',
    attempts: 5,
    max_attempts: 5,
    last_error: 'An unknown error has occurred.',
    dedupe_key: 'send:abc',
    locked_at: '2026-08-20 20:56:10+00',
    locked_by: 'worker-1',
    completed_at: null,
    created_at: '2026-08-20 20:51:05+00',
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
      runAt: new Date('2026-08-20T20:56:09Z'),
      lastError: row.last_error,
      dedupeKey: 'send:abc',
      lockedBy: 'worker-1',
      completedAt: null,
      lockedAt: new Date('2026-08-20T20:56:10Z'),
      createdAt: new Date('2026-08-20T20:51:05Z'),
    });
  });

  // An Invalid Date type-checks as a Date, so passing one on would move the
  // failure into whichever handler first did arithmetic with it.
  it('refuses an instant that does not parse, naming the column and the value', () => {
    expect(() => toClaimedJob({ ...row, run_at: 'not a timestamp' })).toThrow(
      'jobs.run_at is not a timestamp: "not a timestamp"',
    );
    expect(() => toClaimedJob({ ...row, locked_at: '' })).toThrow(
      expect.objectContaining({ name: 'InvalidJobTimestampError' }),
    );
  });

  it('defaults a missing payload rather than handing a handler undefined', () => {
    expect(toClaimedJob({ ...row, payload: null }).payload).toEqual({});
  });
});
