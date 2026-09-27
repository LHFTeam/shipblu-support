'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { shipmentPhrases } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text } from '@/lib/http/form-data';
import { PHRASE_GROUPS } from '@/lib/shipments/status';
import { refresh, type SettingsState } from '../settings-shared';

/**
 * Every key `/admin/tracking` is allowed to write.
 *
 * Built from the catalogue rather than trusted from the form. A `key` arriving
 * in a `FormData` field is attacker-controlled like any other, and without this
 * the action would insert whatever string it was handed — filling
 * `shipment_phrases` with rows no page will ever read, and turning a screen for
 * editing twenty-three phrases into an open key-value store.
 */
const PHRASE_KEYS = new Set(PHRASE_GROUPS.flatMap((group) => group.rows.map((row) => row.key)));

/**
 * Save one Arabic phrase for the public tracking page, or clear it.
 *
 * Clearing deletes the row rather than storing an empty string, so the default
 * compiled into `lib/shipments/status.ts` comes back — an empty override would
 * otherwise render a status badge with nothing in it, which says less to a
 * customer than the English word it replaced.
 *
 * No `revalidatePath` for the public page: `/[locale]/track` is `force-dynamic`
 * and reads `shipment_phrases` on every request, and it is served on a different
 * host from this one. The admin table is revalidated so the editor sees its own
 * change.
 */
export async function saveTrackingPhrase(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const agent = await requirePermission('admin.fields');

  const key = text(formData, 'key');
  if (!PHRASE_KEYS.has(key)) return { error: 'Unknown phrase' };

  const ar = text(formData, 'ar');

  if (!ar) {
    await db.delete(shipmentPhrases).where(eq(shipmentPhrases.key, key));
    refresh('/admin/tracking');
    return ok();
  }

  await db
    .insert(shipmentPhrases)
    .values({ key, ar, updatedBy: agent.id })
    .onConflictDoUpdate({
      target: shipmentPhrases.key,
      set: { ar, updatedAt: new Date(), updatedBy: agent.id },
    });

  refresh('/admin/tracking');
  return ok();
}
