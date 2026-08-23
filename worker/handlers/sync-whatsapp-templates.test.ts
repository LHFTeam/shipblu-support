import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { whatsappTemplates } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { staleTemplateFilter } from './sync-whatsapp-templates';

/**
 * A guard against re-introducing a bug that only appears against a real
 * database: a `Date` bound as an untyped parameter.
 *
 * postgres.js cannot serialise one — it assumes text and throws
 * ERR_INVALID_ARG_TYPE — and drizzle only maps a Date when it knows the column
 * it is being compared against. A `sql` template does not supply that, a typed
 * operator does. `toSQL()` shows the difference without connecting to anything:
 * the template leaves a Date in `params`, `lt` leaves a string.
 *
 * Worth a test rather than a comment because the hourly cron was the only thing
 * exercising this path, so the cost of getting it wrong is a day of red runs.
 */

// Building a query validates the environment, but never opens a connection:
// `toSQL()` is entirely offline, which is what makes this test cheap.
beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  resetEnvCache();
});

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function paramsFor(now: Date) {
  return db
    .update(whatsappTemplates)
    .set({ status: 'DELETED' })
    .where(staleTemplateFilter(now, ACCOUNT))
    .toSQL().params;
}

function textFor(accountId: string | null) {
  return db
    .update(whatsappTemplates)
    .set({ status: 'DELETED' })
    .where(staleTemplateFilter(new Date('2026-08-20T08:00:00Z'), accountId))
    .toSQL().sql;
}

describe('staleTemplateFilter', () => {
  it('binds the timestamp as a value the driver can serialise', () => {
    const params = paramsFor(new Date('2026-08-20T08:00:00Z'));

    expect(params.some((param) => param instanceof Date)).toBe(false);
    expect(params).toContain('2026-08-20T08:00:00.000Z');
  });

  it('compares against synced_at and spares rows already marked deleted', () => {
    const text = textFor(ACCOUNT);

    // Cheap, but it is the whole intent of the clause: only rows this run did
    // not refresh, and never one that is already gone.
    expect(text).toContain('"synced_at" <');
    expect(text).toContain('"status" <>');
  });

  /**
   * The clause has to be scoped to the account that was just synced. Syncing a
   * second business account would otherwise mark every template of the first
   * as DELETED — its rows were not refreshed by *this* call — and the console
   * would offer the team nothing to send from their main number.
   */
  it('only marks the account that was just synced', () => {
    expect(textFor(ACCOUNT)).toContain('"whatsapp_account_id" =');
  });

  it('marks the pre-account rows when there is no account yet', () => {
    expect(textFor(null)).toContain('"whatsapp_account_id" is null');
  });
});
