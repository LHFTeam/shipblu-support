import { syncCategories } from '@/lib/categories/seed';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

const log = logger('seed_ticket_categories');

/**
 * Puts the starter ticket categories (`lib/categories/registry.ts`) into the
 * registry. The work and its rules are `syncCategories`; this is the entry
 * point production runs by hand, since a deploy runs only `db:migrate`.
 *
 * Idempotent, and enqueued without a `dedupeKey`, for the reason
 * `seed_console_handbook` gives: a key is spent for good, so a second run would
 * silently do nothing.
 */
export async function seedTicketCategories(job: ClaimedJob): Promise<void> {
  parseJobPayload(job, 'seed_ticket_categories');

  const outcome = await syncCategories();
  log.info('done', {
    created: outcome.created.length ? outcome.created.join(',') : 'none',
    present: outcome.present,
  });
  // A seeded category the code no longer has is retired by an admin or kept on
  // purpose; either way a person decides, so it is said and left alone.
  if (outcome.orphaned.length) {
    log.warn(`seeded but no longer in the starter set: ${outcome.orphaned.join(', ')}`);
  }
}
