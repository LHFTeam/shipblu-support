import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '@/lib/queue';

const queue = vi.hoisted(() => ({
  completeJob: vi.fn<(job: ClaimedJob) => Promise<boolean>>(),
  failJob: vi.fn<(job: ClaimedJob, error: unknown) => Promise<boolean>>(),
}));
const handler = vi.hoisted(() => vi.fn<(job: ClaimedJob) => Promise<void>>());

vi.mock('@/lib/queue', () => queue);
vi.mock('./handlers', () => ({ resolveHandler: () => handler }));

const { executeJob } = await import('./execute');

function job(): ClaimedJob {
  return {
    id: 'job-1',
    type: 'send_email',
    payload: { messageId: 'm1' },
    status: 'processing',
    priority: 10,
    runAt: new Date(),
    attempts: 1,
    maxAttempts: 5,
    lastError: null,
    dedupeKey: null,
    lockedAt: new Date(),
    lockedBy: 'worker-a',
    completedAt: null,
    createdAt: new Date(),
  };
}

let logged: { error: unknown[][]; warn: unknown[][] };

beforeEach(() => {
  queue.completeJob.mockReset().mockResolvedValue(true);
  queue.failJob.mockReset().mockResolvedValue(true);
  handler.mockReset().mockResolvedValue(undefined);
  logged = { error: [], warn: [] };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args) => logged.error.push(args));
  vi.spyOn(console, 'warn').mockImplementation((...args) => logged.warn.push(args));
});

afterEach(() => vi.restoreAllMocks());

describe('executeJob', () => {
  it('records a success', async () => {
    await executeJob(job());

    expect(queue.completeJob).toHaveBeenCalledOnce();
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it('records a handler’s failure', async () => {
    const error = new Error('Postmark answered 503');
    handler.mockRejectedValue(error);

    await executeJob(job());

    expect(queue.failJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), error);
    expect(queue.completeJob).not.toHaveBeenCalled();
  });

  // The duplicate send: a success that could not be written used to be failed,
  // and a failed job is retried.
  it('never fails a job that succeeded because its success could not be written', async () => {
    queue.completeJob.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(executeJob(job())).resolves.toBeUndefined();

    expect(queue.failJob).not.toHaveBeenCalled();
    expect(String(logged.error[0]?.[0])).toMatch(/succeeded but the outcome was not recorded/);
  });

  it('resolves when the failure cannot be written either', async () => {
    handler.mockRejectedValue(new Error('boom'));
    queue.failJob.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(executeJob(job())).resolves.toBeUndefined();
    expect(String(logged.error[0]?.[0])).toMatch(/failed but the outcome was not recorded/);
  });

  it('says so when another run had taken the job by the time this one finished', async () => {
    queue.completeJob.mockResolvedValue(false);

    await executeJob(job());

    expect(String(logged.warn[0]?.[0])).toMatch(/taken by another run/);
  });
});
