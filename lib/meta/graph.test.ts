import { describe, expect, it } from 'vitest';
import { STALLED_AFTER_MS } from '@/lib/queue';
import { graphTimeout } from './graph';

/**
 * A Graph write is usually a message to a customer, so its deadline sits in a
 * window with two edges. Below sixty seconds, a send Meta was still accepting
 * is given up on and retried — a duplicate message. Past the stalled-job
 * window, a send whose lock stopped being refreshed — the worker's heartbeat
 * failing that whole time — can be reclaimed while it is still waiting and run
 * again: the same duplicate by another route.
 */
describe('graphTimeout', () => {
  it('gives a write long enough that giving up rarely means Meta had it', () => {
    expect(graphTimeout('POST')).toBeGreaterThanOrEqual(60_000);
    expect(graphTimeout('DELETE')).toBe(graphTimeout('POST'));
  });

  it('keeps a write inside the window after which the queue runs a job again', () => {
    expect(graphTimeout('POST')).toBeLessThan(STALLED_AFTER_MS);
  });

  it('gives a read the shorter deadline of a lookup somebody is waiting on', () => {
    expect(graphTimeout('GET')).toBe(15_000);
  });
});
