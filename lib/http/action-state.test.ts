import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from './action-state';

afterEach(() => {
  vi.useRealTimers();
});

describe('ok', () => {
  it('answers a new nonce for each success, so a form keyed on it resets every time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T09:00:00Z'));
    const first = ok();
    vi.advanceTimersByTime(1500);
    const second = ok();

    expect(first).toEqual({ error: null, ok: true, nonce: Date.parse('2026-09-27T09:00:00Z') });
    expect(second.nonce).not.toBe(first.nonce);
  });
});
