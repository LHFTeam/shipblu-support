'use server';

import { requirePermission } from '@/lib/auth/guard';
import {
  createCategory,
  ROUTE_GROUP_GONE,
  setCategoryActive,
  updateCategory,
} from '@/lib/categories/admin';
import { ok } from '@/lib/http/action-state';
import { int, text, uuidField } from '@/lib/http/form-data';
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
