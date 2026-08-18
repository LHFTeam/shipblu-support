import { describe, expect, it } from 'vitest';
import { allowedSendKind, formatRemaining, windowState, WINDOW_DURATION_MS } from './window';

const NOW = new Date('2026-08-18T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

describe('windowState', () => {
  it('is open just after a customer message', () => {
    const s = windowState(ago(HOUR), NOW);
    expect(s.isOpen).toBe(true);
    expect(s.reason).toBe('open');
    expect(s.remainingMs).toBe(23 * HOUR);
  });

  it('is closed once 24 hours have passed', () => {
    const s = windowState(ago(25 * HOUR), NOW);
    expect(s.isOpen).toBe(false);
    expect(s.reason).toBe('expired');
    expect(s.remainingMs).toBe(0);
  });

  it('closes exactly at the boundary, not a moment after', () => {
    // Meta rejects at exactly 24h, so the boundary must not be inclusive.
    expect(windowState(ago(WINDOW_DURATION_MS), NOW).isOpen).toBe(false);
    expect(windowState(ago(WINDOW_DURATION_MS - 1000), NOW).isOpen).toBe(true);
  });

  it('reports never_opened when the customer has never written', () => {
    // An agent-initiated conversation: template only, and the UI must say why.
    const s = windowState(null, NOW);
    expect(s).toEqual({ isOpen: false, expiresAt: null, remainingMs: 0, reason: 'never_opened' });
  });

  it('computes the expiry as 24h after the last customer message', () => {
    const s = windowState(ago(2 * HOUR), NOW);
    expect(s.expiresAt?.toISOString()).toBe('2026-08-19T10:00:00.000Z');
  });
});

describe('allowedSendKind', () => {
  it('permits free form only while open', () => {
    expect(allowedSendKind(windowState(ago(HOUR), NOW))).toBe('free_form');
    expect(allowedSendKind(windowState(ago(30 * HOUR), NOW))).toBe('template_only');
    expect(allowedSendKind(windowState(null, NOW))).toBe('template_only');
  });
});

describe('formatRemaining', () => {
  it('formats hours and minutes', () => {
    expect(formatRemaining(3 * HOUR + 12 * 60_000)).toBe('3h 12m left');
    expect(formatRemaining(45 * 60_000)).toBe('45m left');
    expect(formatRemaining(30_000)).toBe('under a minute left');
    expect(formatRemaining(0)).toBe('closed');
    expect(formatRemaining(-5)).toBe('closed');
  });
});
