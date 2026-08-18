import { describe, expect, it } from 'vitest';
import { backoffMs, classifyFailure } from './backoff';

/** No jitter, so the exponential curve is asserted exactly. */
const noJitter = () => 0.5;

describe('classifyFailure', () => {
  it('detects Supavisor circuit breaker from the message', () => {
    // This is the one that blocks *other* services, so it must back off hardest.
    const err = new Error('Failed query');
    (err as { cause?: unknown }).cause = new Error(
      '(ECIRCUITBREAKER) too many authentication failures, new connections are temporarily blocked',
    );
    expect(classifyFailure(err)).toBe('circuit_breaker');
  });

  it('detects a bad password from the message', () => {
    const err = new Error('Failed query');
    (err as { cause?: unknown }).cause = new Error(
      'password authentication failed for user "postgres"',
    );
    expect(classifyFailure(err)).toBe('auth');
  });

  it('detects auth from a SQLSTATE on the cause', () => {
    const err = new Error('Failed query');
    (err as { cause?: unknown }).cause = Object.assign(new Error('nope'), { code: '28P01' });
    expect(classifyFailure(err)).toBe('auth');
  });

  it('treats a wrong database name as auth, not transient', () => {
    const err = Object.assign(new Error('nope'), { code: '3D000' });
    expect(classifyFailure(err)).toBe('auth');
  });

  it('treats network errors as transient', () => {
    expect(
      classifyFailure(Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' })),
    ).toBe('transient');
    expect(classifyFailure(new Error('connection terminated unexpectedly'))).toBe('transient');
  });

  it('defaults to transient for anything unrecognised', () => {
    expect(classifyFailure(new Error('something odd'))).toBe('transient');
    expect(classifyFailure('a string')).toBe('transient');
    expect(classifyFailure(undefined)).toBe('transient');
  });
});

describe('backoffMs', () => {
  it('grows exponentially and caps, for transient failures', () => {
    const seq = [1, 2, 3, 4, 5, 6].map((n) => backoffMs('transient', n, noJitter));
    expect(seq).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('starts much higher for auth failures, which will not self-heal', () => {
    const seq = [1, 2, 3, 4, 5].map((n) => backoffMs('auth', n, noJitter));
    expect(seq).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
  });

  it('backs off hardest for the circuit breaker', () => {
    const seq = [1, 2, 3, 4, 5].map((n) => backoffMs('circuit_breaker', n, noJitter));
    expect(seq).toEqual([60_000, 120_000, 240_000, 480_000, 600_000]);
  });

  it('orders the profiles: transient < auth < circuit_breaker', () => {
    // The property that actually matters: a credential problem must never be
    // retried as aggressively as a dropped connection.
    for (const attempt of [1, 2, 3, 4, 5]) {
      const t = backoffMs('transient', attempt, noJitter);
      const a = backoffMs('auth', attempt, noJitter);
      const c = backoffMs('circuit_breaker', attempt, noJitter);
      expect(t).toBeLessThan(a);
      expect(a).toBeLessThan(c);
    }
  });

  it('never exceeds the cap even at extreme attempt counts', () => {
    expect(backoffMs('transient', 999, () => 1)).toBeLessThanOrEqual(60_000);
    expect(backoffMs('auth', 999, () => 1)).toBeLessThanOrEqual(300_000);
    expect(backoffMs('circuit_breaker', 999, () => 1)).toBeLessThanOrEqual(600_000);
  });

  it('applies jitter within +/-20% so instances do not retry in lockstep', () => {
    const low = backoffMs('transient', 1, () => 0);
    const high = backoffMs('transient', 1, () => 1);
    expect(low).toBe(4_000);
    expect(high).toBe(6_000);
  });

  it('handles attempt 0 or negative without going below the base', () => {
    expect(backoffMs('transient', 0, noJitter)).toBe(5_000);
    expect(backoffMs('transient', -3, noJitter)).toBe(5_000);
  });
});
