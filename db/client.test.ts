import { describe, expect, it, vi } from 'vitest';
import { DbTimeout, withDeadline } from './client';

/**
 * The bug these are here to prevent is the one that took the console and the
 * help centre down on 2026-08-25: a database wait with nothing bounding it.
 * Every case below is a way that wait can end, and only one of them used to be
 * survivable.
 */
describe('withDeadline', () => {
  it('resolves with the work when it finishes in time', async () => {
    await expect(withDeadline(Promise.resolve('rows'), 50, 'select 1')).resolves.toBe('rows');
  });

  it('rejects once the deadline passes, naming the wait and the limit', async () => {
    const never = new Promise<string>(() => {});

    await expect(withDeadline(never, 10, 'select 1')).rejects.toThrow(DbTimeout);
    await expect(withDeadline(never, 10, 'select 1')).rejects.toThrow(
      'select 1 did not finish within 10ms',
    );
  });

  it('passes a real failure through instead of reporting it as a timeout', async () => {
    // A connection error must keep its own message. Reporting every failure as a
    // deadline would hide the one case that says which half is broken.
    await expect(
      withDeadline(Promise.reject(new Error('CONNECTION_CLOSED')), 50, 'select 1'),
    ).rejects.toThrow('CONNECTION_CLOSED');
  });

  it('clears the timer when the work wins', async () => {
    // Left behind, a long deadline keeps the event loop alive for its full
    // interval — which a one-shot `npm run job` would sit in before exiting.
    const clear = vi.spyOn(globalThis, 'clearTimeout');

    await withDeadline(Promise.resolve('rows'), 60_000, 'select 1');

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('survives a rejection that arrives after the deadline has fired', async () => {
    // postgres.js rejects in-flight queries when it loses a connection, and that
    // can land long after the deadline gave up. By then nothing is awaiting the
    // promise, so this only stays quiet because `race` subscribed to it up
    // front; the alternative is an unhandled rejection taking down the process.
    let fail: (error: Error) => void = () => {};
    const late = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });

    await expect(withDeadline(late, 10, 'select 1')).rejects.toThrow(DbTimeout);

    fail(new Error('CONNECTION_CLOSED'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
