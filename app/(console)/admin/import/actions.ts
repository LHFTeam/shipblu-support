'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/guard';
import { enqueue, hasActiveJob } from '@/lib/queue';
import type { AdminState } from '../settings-shared';

/**
 * Queues a Freshdesk knowledge base import.
 *
 * The job runs on the worker, which is where the Freshdesk credentials live —
 * the web service cannot see them, so this deliberately does not try to
 * pre-validate the configuration. An unconfigured worker fails the job with a
 * clear message, which the run list below the button shows.
 */
export async function startFreshdeskImport(
  _state: AdminState,
  _formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  // A second import running against the same rows would not corrupt anything —
  // every write is idempotent — but it would double the API calls against
  // Freshdesk's per-minute rate limit and make the logs unreadable.
  if (await hasActiveJob('import_freshdesk_kb')) {
    return { error: 'An import is already queued or running.' };
  }

  await enqueue(
    'import_freshdesk_kb',
    {},
    {
      priority: 50,
      // Bucketed to the minute rather than a fixed key: a fixed one would be
      // taken forever by the first run, since completed jobs keep their dedupe
      // key for seven days. This swallows a double-click and still allows a
      // re-run a minute later.
      dedupeKey: `import_freshdesk_kb:${Math.floor(Date.now() / 60_000)}`,
      // The importer is idempotent, so a retry resumes rather than duplicates —
      // but three is enough to ride out a rate limit without hammering
      // Freshdesk for an hour on a bad API key.
      maxAttempts: 3,
    },
  );

  revalidatePath('/admin/import');
  return { error: null };
}

/**
 * Recovers the map pins already sitting in the archive.
 *
 * The live path keeps a pin's coordinates as they arrive, so this is for
 * everything that came before — messages where the pin only ever reached us as
 * text inside `body_text`, which an agent cannot open on a map.
 *
 * Guarded the same way as the shipment backfill and for the same reason: it is
 * idempotent and re-running it costs nothing but a pass over the archive, so the
 * only thing worth preventing is two of them at once.
 */
export async function startLocationBackfill(
  _state: AdminState,
  _formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  if (await hasActiveJob('backfill_message_locations')) {
    return { error: 'A location backfill is already queued or running.' };
  }

  await enqueue(
    'backfill_message_locations',
    {},
    {
      // Behind anything a customer is waiting on.
      priority: 80,
      dedupeKey: `backfill_message_locations:${Math.floor(Date.now() / 60_000)}`,
      maxAttempts: 2,
    },
  );

  revalidatePath('/admin/import');
  return { error: null };
}

/**
 * Scans the archive for tracking numbers and SBIDs nobody has linked yet.
 *
 * Also the way a corrected detection pattern reaches history: the live path only
 * ever sees new messages, so widening the pattern without re-running this leaves
 * every ticket that arrived before the change unlinked.
 *
 * Whether a re-run finds anything new is the point, and it costs nothing when it
 * does not — every write underneath is idempotent — so this is not guarded as
 * tightly as the Freshdesk import, which spends someone else's rate limit.
 */
export async function startShipmentBackfill(
  _state: AdminState,
  _formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  if (await hasActiveJob('backfill_shipment_links')) {
    return { error: 'A backfill is already queued or running.' };
  }

  await enqueue(
    'backfill_shipment_links',
    {},
    {
      // Behind anything a customer is waiting on. This reads the whole message
      // archive and there is no hurry about it.
      priority: 80,
      dedupeKey: `backfill_shipment_links:${Math.floor(Date.now() / 60_000)}`,
      // It resumes from the start rather than from where it stopped, and every
      // write is idempotent, so a retry is cheap — but a third attempt against a
      // genuine bug is just three passes over the archive.
      maxAttempts: 2,
    },
  );

  revalidatePath('/admin/import');
  return { error: null };
}
