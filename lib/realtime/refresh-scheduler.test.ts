import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_REFRESH_COALESCE_MS,
  LIVE_REFRESH_COOLDOWN_MS,
  RefreshScheduler,
} from './refresh-scheduler';

describe('RefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst into one refresh', () => {
    const start = vi.fn();
    const scheduler = new RefreshScheduler({ start });

    scheduler.request();
    scheduler.request();
    scheduler.request();

    vi.advanceTimersByTime(LIVE_REFRESH_COALESCE_MS - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('allows no overlap and keeps only one trailing refresh', () => {
    const start = vi.fn();
    const scheduler = new RefreshScheduler({ start });

    scheduler.request();
    vi.advanceTimersByTime(LIVE_REFRESH_COALESCE_MS);
    expect(start).toHaveBeenCalledTimes(1);

    scheduler.request();
    scheduler.request();
    vi.advanceTimersByTime(LIVE_REFRESH_COOLDOWN_MS * 3);
    expect(start).toHaveBeenCalledTimes(1);

    scheduler.complete();
    vi.advanceTimersByTime(LIVE_REFRESH_COALESCE_MS);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('enforces the cooldown between completed refreshes', () => {
    const start = vi.fn();
    const scheduler = new RefreshScheduler({ start });

    scheduler.request();
    vi.advanceTimersByTime(LIVE_REFRESH_COALESCE_MS);
    scheduler.complete();
    scheduler.request();

    vi.advanceTimersByTime(LIVE_REFRESH_COOLDOWN_MS - 1);
    expect(start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does no work while hidden and refreshes once after becoming visible', () => {
    const start = vi.fn();
    const scheduler = new RefreshScheduler({ start, visible: false });

    scheduler.request();
    scheduler.request();
    vi.advanceTimersByTime(LIVE_REFRESH_COOLDOWN_MS * 3);
    expect(start).not.toHaveBeenCalled();

    scheduler.setVisible(true);
    vi.advanceTimersByTime(LIVE_REFRESH_COALESCE_MS);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cancels pending work when disposed', () => {
    const start = vi.fn();
    const scheduler = new RefreshScheduler({ start });

    scheduler.request();
    scheduler.dispose();
    vi.runAllTimers();

    expect(start).not.toHaveBeenCalled();
  });
});
