import { describe, expect, it } from 'vitest';
import { refuseUnlessDisposable } from './db';

/**
 * The guard in front of a truncate of every table. A unit test rather than a
 * database one, because the database tier can only ever show it letting a
 * database through.
 */
describe('refuseUnlessDisposable', () => {
  it('lets through the database the tier was pointed at, on this machine', () => {
    for (const host of ['localhost:5432', '127.0.0.1:55432', '[::1]:5432']) {
      const url = `postgresql://postgres:postgres@${host}/shipblu_ci`;
      expect(() => refuseUnlessDisposable(url, url)).not.toThrow();
    }
  });

  it('refuses when the connection is not the one TEST_DATABASE_URL named', () => {
    const url = 'postgresql://postgres@localhost:5432/shipblu_dev';
    expect(() => refuseUnlessDisposable(url, undefined)).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => refuseUnlessDisposable(undefined, url)).toThrow(/not TEST_DATABASE_URL/);
    expect(() =>
      refuseUnlessDisposable(url, 'postgresql://postgres@localhost:5432/shipblu_test'),
    ).toThrow(/not TEST_DATABASE_URL/);
  });

  it('refuses a database on another machine, even when it was named, without repeating its password', () => {
    const url =
      'postgresql://postgres.abc:hunter2@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
    expect(() => refuseUnlessDisposable(url, url)).toThrow(
      'refusing to truncate a database on aws-0-eu-central-1.pooler.supabase.com',
    );
    expect(() => refuseUnlessDisposable(url, url)).not.toThrow(/hunter2/);
  });
});
