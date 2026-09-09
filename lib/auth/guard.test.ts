import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The latch, and specifically its direction.
 *
 * `needsBootstrap()` gates the one-time first-admin page, and
 * `bootstrapAdmin` in `app/(auth)/actions.ts` re-checks it inside the action so
 * a replayed POST cannot create a second admin. That guard only holds while a
 * `true` is re-derived from the database every time — so latching `false` is a
 * saved query and latching `true` would be a way to create a second admin.
 * These tests exist to keep that asymmetry from being tidied away.
 *
 * No database: the count is stubbed, and what is asserted is how many times it
 * is asked.
 */
const stub = vi.hoisted(() => ({ total: 0, calls: 0 }));

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => {
        stub.calls += 1;
        return Promise.resolve([{ total: stub.total }]);
      },
    }),
  },
}));

const { needsBootstrap, resetBootstrapLatch } = await import('./guard');

beforeEach(() => {
  stub.total = 0;
  stub.calls = 0;
  resetBootstrapLatch();
});

describe('needsBootstrap', () => {
  it('says yes on an empty instance, and keeps asking', async () => {
    expect(await needsBootstrap()).toBe(true);
    expect(await needsBootstrap()).toBe(true);

    // The `true` is never latched. This is the security half: the setup page
    // and the action behind it must both see the moment an agent appears.
    expect(stub.calls).toBe(2);
  });

  it('stops asking once an agent exists', async () => {
    stub.total = 1;

    expect(await needsBootstrap()).toBe(false);
    expect(await needsBootstrap()).toBe(false);
    expect(await needsBootstrap()).toBe(false);

    // One query, then the latch. Every later `/login` render is free, which is
    // the point: it used to run ahead of the cookie check, so a signed-out
    // visitor waited on a pool slot to be told to sign in (§62).
    expect(stub.calls).toBe(1);
  });

  it('latches on the first non-empty answer, not on the first answer', async () => {
    expect(await needsBootstrap()).toBe(true);
    expect(stub.calls).toBe(1);

    // The first admin is created here.
    stub.total = 1;
    expect(await needsBootstrap()).toBe(false);
    expect(stub.calls).toBe(2);

    expect(await needsBootstrap()).toBe(false);
    expect(stub.calls).toBe(2);
  });

  it('cannot be talked back into bootstrap by an empty table', async () => {
    stub.total = 1;
    expect(await needsBootstrap()).toBe(false);

    // Deleting every agent does not reopen the first-admin page. That is the
    // documented behaviour — "stops working permanently the moment the first
    // account is made" — and it is the safer direction to be wrong in: a
    // reachable setup page on a live instance is an unauthenticated admin.
    stub.total = 0;
    expect(await needsBootstrap()).toBe(false);
    expect(stub.calls).toBe(1);
  });
});
