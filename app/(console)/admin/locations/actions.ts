'use server';

import { eq, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { locations } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import {
  isValidLocationCode,
  normaliseLocationCode,
  LOCATION_CODE_MAX,
} from '@/lib/locations/format';
import { removeLocation } from '@/lib/locations/remove';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Locations --------------------------------------------------------------

/**
 * ShipBlu's own locations.
 *
 * Both identifiers are normalised before the uniqueness check, so `cai-1` and
 * `CAI-1` collide instead of becoming two hubs — and they are checked here, with
 * a sentence naming the location already using them, rather than left to the
 * unique index. A 23505 reaching the form is a stack trace where an explanation
 * belongs, and "which location has that code?" is the question an admin
 * entering a list of them by hand actually has.
 */
export async function saveLocation(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.locations');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const code = normaliseLocationCode(text(formData, 'code'));
  const email = normaliseEmail(text(formData, 'email'));
  const isActive = formData.get('isActive') === 'on';

  if (!name) return { error: 'Give the location a name' };
  if (!isValidLocationCode(code)) {
    return {
      error: `A code is 2 to ${LOCATION_CODE_MAX} letters, digits or hyphens — for example CAI-1`,
    };
  }
  if (!looksLikeEmail(email)) return { error: "Enter the location's email address" };

  const clash = await db
    .select({
      id: locations.id,
      name: locations.name,
      code: locations.code,
      email: locations.email,
    })
    .from(locations)
    .where(or(eq(locations.code, code), eq(locations.email, email)));

  const other = clash.find((row) => row.id !== id);
  if (other) {
    return {
      error:
        other.code === code
          ? `${other.name} already uses the code ${code}`
          : `${other.name} already uses ${email}`,
    };
  }

  if (id) {
    await db
      .update(locations)
      .set({ name, code, email, isActive, updatedAt: new Date() })
      .where(eq(locations.id, id));
  } else {
    await db.insert(locations).values({ name, code, email, isActive });
  }

  refresh('/admin/locations');
  return ok();
}

/**
 * Deletes a location, unless a side conversation has gone to it — then it is
 * marked not operating instead, and `removeLocation` says why the delete itself
 * would have been silent damage.
 *
 * The retirement comes back on the error line because that is the one line
 * `DangerAction` shows, the same channel `deleteInternalRecipient` uses for the
 * same outcome: the admin pressed Delete and the row is still in the table, so
 * the page owes them a sentence saying what happened instead.
 */
export async function deleteLocation(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.locations');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const removal = await removeLocation(id);
  refresh('/admin/locations');

  if (removal.outcome === 'retired') {
    const one = removal.threads === 1;
    const threads = one ? 'a side conversation' : `${removal.threads} side conversations`;
    const record = one ? 'that thread still says' : 'those threads still say';
    const instead = removal.wasActive
      ? 'so it was marked not operating rather than deleted. It is gone from the picker'
      : 'so it stays, marked not operating, rather than being deleted. It is already gone from the picker';

    return {
      error: `${removal.name} (${removal.code}) has ${threads}, ${instead}, and ${record} which location was asked.`,
    };
  }

  return ok();
}
