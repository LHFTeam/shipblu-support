import { describe, expect, it } from 'vitest';
import { allLimited } from './concurrency';

/** A task that resolves to `value` when `release()` is called, recording when it ran. */
function gated<T>(value: T, running: { now: number; peak: number }) {
  let release = () => {};
  const task = () => {
    running.now += 1;
    running.peak = Math.max(running.peak, running.now);
    return new Promise<T>((resolve) => {
      release = () => {
        running.now -= 1;
        resolve(value);
      };
    });
  };
  return { task, release: () => release() };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('allLimited', () => {
  it('answers in the order given, whatever order the work finishes in', async () => {
    const running = { now: 0, peak: 0 };
    const tasks = [gated('a', running), gated(2, running), gated(true, running)];
    const all = allLimited(
      3,
      tasks.map((entry) => entry.task),
    );

    await tick();
    tasks[2]!.release();
    tasks[0]!.release();
    tasks[1]!.release();

    await expect(all).resolves.toEqual(['a', 2, true]);
  });

  it('never runs more than the limit at once', async () => {
    const running = { now: 0, peak: 0 };
    const tasks = Array.from({ length: 7 }, (_, index) => gated(index, running));
    const all = allLimited(
      3,
      tasks.map((entry) => entry.task),
    );

    for (const entry of tasks) {
      await tick();
      expect(running.now).toBeLessThanOrEqual(3);
      entry.release();
    }

    await expect(all).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(running.peak).toBe(3);
  });

  it('rejects with the first failure and starts nothing after it', async () => {
    let started = 0;
    const fail = () => {
      started += 1;
      return Promise.reject(new Error('the read failed'));
    };
    const later = () => {
      started += 1;
      return Promise.resolve('never asked for');
    };

    await expect(allLimited(1, [fail, later, later])).rejects.toThrow('the read failed');
    expect(started).toBe(1);
  });

  it('keeps each answer its own type', async () => {
    const [text, count] = await allLimited(2, [
      () => Promise.resolve('text'),
      () => Promise.resolve(3),
    ]);

    // Type-level as much as runtime: these would not compile as anything else.
    const upper: string = text.toUpperCase();
    const doubled: number = count * 2;
    expect([upper, doubled]).toEqual(['TEXT', 6]);
  });
});
