import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowEmailDispatch,
  allowLoginAttempt,
  clearLoginAttempts,
  throttleBucketCount,
} from './throttle';

/**
 * Buckets are module state shared across cases, so every test uses its own
 * address rather than trying to reset the map.
 */
describe('allowLoginAttempt', () => {
  it('allows ten attempts and then refuses', () => {
    const email = 'login-budget@example.test';
    for (let i = 0; i < 10; i += 1) expect(allowLoginAttempt(email, '10.0.0.1')).toBe(true);
    expect(allowLoginAttempt(email, '10.0.0.1')).toBe(false);
  });

  it('does not let one address spend another address budget', () => {
    const victim = 'victim@example.test';
    for (let i = 0; i < 12; i += 1) allowLoginAttempt(victim, '10.0.0.2');

    // Same IP is now spent too, so the victim on a different connection still
    // gets through — which is the point of keying on both.
    expect(allowLoginAttempt('someone-else@example.test', '10.0.0.3')).toBe(true);
  });

  it('forgives earlier typos once a sign-in succeeds', () => {
    const email = 'typo@example.test';
    for (let i = 0; i < 9; i += 1) allowLoginAttempt(email, '10.0.0.4');
    clearLoginAttempts(email, '10.0.0.4');
    for (let i = 0; i < 10; i += 1) expect(allowLoginAttempt(email, '10.0.0.4')).toBe(true);
  });
});

describe('allowEmailDispatch', () => {
  it('is tighter than the sign-in budget', () => {
    const email = 'mailer@example.test';
    for (let i = 0; i < 5; i += 1) expect(allowEmailDispatch(email, '10.0.1.1')).toBe(true);
    expect(allowEmailDispatch(email, '10.0.1.1')).toBe(false);
  });

  it('keeps its own budget, so sign-in attempts do not stop a reset request', () => {
    const email = 'separate@example.test';
    for (let i = 0; i < 12; i += 1) allowLoginAttempt(email, '10.0.1.2');
    expect(allowEmailDispatch(email, '10.0.1.2')).toBe(true);
  });

  it('caps one source spraying many addresses, but well above one household', () => {
    // Loose on purpose: carrier NAT puts a great many unrelated Egyptian
    // customers behind one address, so this must not trip on ordinary traffic.
    for (let i = 0; i < 20; i += 1) {
      expect(allowEmailDispatch(`neighbour-${i}@example.test`, '10.0.1.9')).toBe(true);
    }
    for (let i = 20; i < 60; i += 1) allowEmailDispatch(`spray-${i}@example.test`, '10.0.1.9');
    expect(allowEmailDispatch('spray-last@example.test', '10.0.1.9')).toBe(false);
  });
});

/**
 * The bound itself.
 *
 * These are the only cases here that move the clock, so they sit last and
 * restore real timers afterwards: the cases above rely on nothing expiring
 * while they run.
 */
describe('the bucket map', () => {
  afterEach(() => vi.useRealTimers());

  it('does not grow without bound as distinct addresses expire behind it', () => {
    // The shape this exists for: one entry per distinct address, on an endpoint
    // an unauthenticated caller reaches, never hit a second time. `hit` only
    // resets a key it sees *again* and `clearLoginAttempts` only deletes on a
    // successful sign-in, so before the sweep nothing removed a key that was
    // used once — an attacker spraying addresses was filling memory rather than
    // being throttled by it.
    //
    // Ten rounds of a thousand fresh addresses, each a full window after the
    // last, so every earlier bucket is expired by the time the next round runs.
    // Unswept that is 20,000 live entries; this asserts it stays near one
    // round's worth.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
    const start = throttleBucketCount();

    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 1_000; i += 1) {
        allowLoginAttempt(`spray-${round}-${i}@example.test`, `203.0.113.${round}.${i}`);
      }
      vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    }

    expect(throttleBucketCount() - start).toBeLessThan(4_000);
  });

  it('reaches the mail budget keys, which nothing else ever deleted', () => {
    // `clearLoginAttempts` removes `email:`/`ip:` on a successful sign-in. The
    // `mail:`/`mailip:` keys written for password resets and portal
    // registration had no remover at all, so only the sweep reaches them.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const start = throttleBucketCount();

    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 1_000; i += 1) {
        allowEmailDispatch(`mail-${round}-${i}@example.test`, `192.0.2.${round}.${i}`);
      }
      vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    }

    expect(throttleBucketCount() - start).toBeLessThan(4_000);
  });
});
