import { describe, expect, it } from 'vitest';
import { withCleanDatabase } from '@/lib/testing/db';
import { appliedThrough, readJournal, waitForSchema } from './schema-gate';

/**
 * The gate against a database `db:migrate` has brought up to this build, as the
 * web service's preDeploy leaves production: the read Drizzle's migrator makes
 * agrees with the journal, so the worker and the crons start without waiting.
 */

withCleanDatabase();

describe('the schema gate on a migrated database', () => {
  it('reads the newest migration as Drizzle recorded it', async () => {
    const journal = await readJournal();

    expect(await appliedThrough()).toBe(journal.at(-1)?.when);
  });

  it('lets the worker and the crons start at once', async () => {
    const started = Date.now();
    await waitForSchema('worker');
    await waitForSchema('job');

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
