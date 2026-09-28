import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeClock } from './use-now';

/**
 * The shared clock. What it must get right is the thing a timer per component
 * got wrong: subscribers who joined at different moments hear the same tick, at
 * the bucket boundary, and the timer stops when the last one leaves.
 */

const TICK = 30_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T10:00:05Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeClock', () => {
  it('ticks every subscriber together, at the boundary', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeClock(TICK, first);
    vi.advanceTimersByTime(12_000); // 10:00:17, joining mid-bucket
    const stopSecond = subscribeClock(TICK, second);

    vi.advanceTimersByTime(12_999); // 10:00:29.999
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // 10:00:30
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TICK); // 10:01:00
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    stopFirst();
    stopSecond();
  });

  it('runs one timer however many subscribe, and none once all leave', () => {
    const stops = Array.from({ length: 200 }, () => subscribeClock(TICK, () => {}));
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(25_000); // past the first boundary: the interval
    expect(vi.getTimerCount()).toBe(1);

    for (const stop of stops.slice(1)) stop();
    expect(vi.getTimerCount()).toBe(1);
    stops[0]!();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps separate clocks for separate intervals', () => {
    const fast = vi.fn();
    const slow = vi.fn();
    const stopFast = subscribeClock(1_000, fast);
    const stopSlow = subscribeClock(TICK, slow);

    vi.advanceTimersByTime(25_000); // 10:00:30
    expect(fast).toHaveBeenCalledTimes(25);
    expect(slow).toHaveBeenCalledTimes(1);

    stopFast();
    vi.advanceTimersByTime(TICK);
    expect(fast).toHaveBeenCalledTimes(25);
    expect(slow).toHaveBeenCalledTimes(2);
    stopSlow();
  });
});
