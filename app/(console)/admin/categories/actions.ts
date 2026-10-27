'use server';

import { requirePermission } from '@/lib/auth/guard';
import {
  createCategory,
  ROUTE_GROUP_GONE,
  setCategoryActive,
  updateCategory,
} from '@/lib/categories/admin';
import { isCategoryAiMode, ROUTING_WINDOW_MINUTES } from '@/lib/category-ai/modes';
import { saveCategoryAiSettings } from '@/lib/category-ai/settings';
import { ok } from '@/lib/http/action-state';
import { int, optionalNumber, text, uuidField } from '@/lib/http/form-data';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Ticket categories ------------------------------------------------------

/*
 * Each success refreshes this page, which the answer redraws, and the inbox,
 * whose ticket select and filter offer the registry: a category added, renamed
 * or retired here changes what an agent can pick there.
 */

/**
 * Adding a category, or saving one: an empty `id` creates, a uuid edits.
 *
 * The key is read only on the create branch. An edit never looks at it, so a
 * form posting one — hand-built, or an editor that grew the field by mistake —
 * cannot rename a key every `category_changed` event has frozen
 * (`lib/categories/admin.ts`).
 *
 * The route group's id arrives in a form field, so `lib/` re-reads the group
 * before writing it; a malformed one is refused here, before any query, for the
 * reason `uuidField` gives.
 */
export async function saveCategory(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.categories');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const routeGroupId = uuidField(formData, 'routeGroupId');
  if (routeGroupId === undefined) return { error: ROUTE_GROUP_GONE };

  const edit = {
    labelEn: text(formData, 'labelEn'),
    labelAr: text(formData, 'labelAr'),
    description: text(formData, 'description'),
    position: int(formData, 'position'),
    routeGroupId,
  };
  const refusal = id
    ? await updateCategory(id, edit)
    : await createCategory({ ...edit, key: text(formData, 'key') });
  if (refusal) return { error: refusal };

  refresh('/admin/categories');
  refresh('/inbox');
  return ok();
}

/** Retiring a category, behind `ConfirmSubmit`'s second click. Never a delete. */
export async function retireCategory(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.categories');

  const id = uuidField(formData, 'id');
  if (!id) return { error: GONE };
  const refusal = await setCategoryActive(id, false);
  if (refusal) return { error: refusal };

  refresh('/admin/categories');
  refresh('/inbox');
  return ok();
}

/** Putting a retired category back in every picker. One click: nothing is lost by it. */
export async function restoreCategory(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.categories');

  const id = uuidField(formData, 'id');
  if (!id) return { error: GONE };
  const refusal = await setCategoryActive(id, true);
  if (refusal) return { error: refusal };

  refresh('/admin/categories');
  refresh('/inbox');
  return ok();
}

// --- Jev's category classifier ---------------------------------------------

/**
 * The classifier's switch, the share below which an answer never settles a
 * ticket, and the routing window Stage 5 will read — one form, one row.
 *
 * `admin.categories`, the page's own gate: whoever decides what the categories
 * are decides whether Jev files tickets under them. Saving is allowed with no
 * TypeSafe key, for the canned suggestions' reason: the switch's state should
 * not depend on a secret the admin cannot see from here, and the form says
 * nothing happens there. Each value is checked here, before the CHECKs in
 * `db/sql/003_constraints.sql` would refuse it with a sentence about a
 * constraint; a blank threshold is refused rather than read as 0, which would
 * let every answer through.
 */
export async function saveClassifierSettings(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const agent = await requirePermission('admin.categories');

  const mode = text(formData, 'mode');
  if (!isCategoryAiMode(mode)) return { error: 'Choose off, shadow or apply' };

  const threshold = optionalNumber(formData, 'minProbability');
  if (!threshold || threshold.value === null || threshold.value < 0 || threshold.value > 1) {
    return { error: 'The threshold is a share between 0 and 1, such as 0.6' };
  }

  const { min, max } = ROUTING_WINDOW_MINUTES;
  const window = optionalNumber(formData, 'routingWindowMinutes');
  if (
    !window ||
    window.value === null ||
    !Number.isInteger(window.value) ||
    window.value < min ||
    window.value > max
  ) {
    return { error: `The routing window is a whole number of minutes from ${min} to ${max}` };
  }

  await saveCategoryAiSettings(
    { mode, minProbability: threshold.value, routingWindowMinutes: window.value },
    agent.id,
  );
  refresh('/admin/categories');
  return ok();
}
