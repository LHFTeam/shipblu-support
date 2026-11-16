import { afterEach, describe, expect, it, vi } from 'vitest';
import { admitAddress, admitMint, admitRead, admitServerPlane } from './limits';

/**
 * Which store each of the API's buckets is in. A spray of forged addresses
 * fills the shared store and makes it drop its oldest buckets; the plane, mint
 * and identity buckets must not be among them, or the spray resets the mint
 * cap (`admitVouched` in `lib/http/rate-limit.ts`).
 */

function forged(address: string): Request {
  return new Request('https://support.example/api/v1/config', {
    headers: { 'x-forwarded-for': address },
  });
}

/** Spends `admit` exactly to its limit, every request allowed. */
function spendTo(limit: number, admit: () => { allowed: boolean }): void {
  for (let i = 0; i < limit; i += 1) expect(admit().allowed).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the API’s buckets', () => {
  it('keep counting through a flood of forged addresses', () => {
    spendTo(10, () => admitMint('u_flooded'));
    spendTo(240, () => admitRead('identity-flooded'));
    spendTo(600, () => admitServerPlane('mint'));

    for (let i = 0; i < 25_000; i += 1) admitAddress(forged(`198.51.100.${i % 250}-${i}`));

    // Dropped, each would start a fresh window and let this one through.
    expect(admitMint('u_flooded').allowed).toBe(false);
    expect(admitRead('identity-flooded').allowed).toBe(false);
    expect(admitServerPlane('mint').allowed).toBe(false);
  });

  // A cleanup job revoking a batch of accounts spends the revoke budget, and
  // every app's next session is still minted.
  it('give revokes a budget of their own, apart from the mints', () => {
    // Past every window the case above spent: the buckets live for the module.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    spendTo(600, () => admitServerPlane('revoke'));
    expect(admitServerPlane('revoke').allowed).toBe(false);
    expect(admitServerPlane('mint').allowed).toBe(true);
  });
});
