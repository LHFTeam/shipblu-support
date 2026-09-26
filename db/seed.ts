import { seedBaseline } from './baseline';
import { closeDb } from './client';

/**
 * `npm run db:seed`. The seeding itself is `db/baseline.ts`, so the database
 * test tier can put the same configuration back after it truncates.
 */
seedBaseline()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
