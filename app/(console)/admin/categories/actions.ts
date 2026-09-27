'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketCategories, ticketRootCauses } from '@/db/schema';
import { text } from '@/lib/http/form-data';
import { requirePermission } from '@/lib/auth/guard';
import { canonicalUuid } from '@/lib/http/uuid';
import { forgetCategoryIds } from '@/lib/categorise/apply';
import type { AdminState } from '../settings-shared';

// --- Categories and root causes ---------------------------------------------

/**
 * Renaming a category, and taking one out of use.
 *
 * The labels are the whole reason this is a table rather than a constant, so
 * they are editable. Three things are not, and each would break something
 * silently:
 *
 * - **`key`.** Every compiled rule in `lib/categorise/rules.ts` awards one,
 *   every stored assignment freezes one, and every report groups by one. Editing
 *   it would leave the rules pointing at nothing *and* strand the value on every
 *   ticket already filed under it, with nothing reporting an error.
 * - **`area`.** A CHECK ties it to the key, so a change here would be rejected
 *   by the database rather than accepted and wrong. Structural, not editorial.
 * - **`owner`** on a cause, for the same reason: the prefix of the key names it,
 *   and a CHECK holds them together.
 *
 * There is no delete. The foreign key from `conversation_categories` is
 * `restrict`, so a category with tickets behind it cannot be removed at all —
 * deactivating takes it out of the picker and leaves every report ever drawn
 * from it still readable.
 */
export async function saveCategory(_state: AdminState, formData: FormData): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = canonicalUuid(formData.get('id'));
  const labelEn = text(formData, 'labelEn');
  const labelAr = text(formData, 'labelAr');

  if (!id) return { error: 'Unknown category' };
  if (!labelEn || !labelAr) {
    // Both, always. Arabic is the default locale and the labels are what a
    // report shown to an Egyptian operations lead is read in, so a blank Arabic
    // label is a broken report rather than a cosmetic gap.
    return { error: 'Both the English and the Arabic label are required' };
  }

  const updated = await db
    .update(ticketCategories)
    .set({ labelEn, labelAr, updatedAt: new Date() })
    .where(eq(ticketCategories.id, id))
    .returning({ id: ticketCategories.id });
  if (!updated.length) return { error: 'Unknown category' };

  forgetCategoryIds();
  revalidatePath('/admin/categories');
  return { error: null };
}

export async function setCategoryActive(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = canonicalUuid(formData.get('id'));
  const active = formData.get('active') === 'true';
  if (!id) return { error: 'Unknown category' };

  const updated = await db
    .update(ticketCategories)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(ticketCategories.id, id))
    .returning({ id: ticketCategories.id });
  if (!updated.length) return { error: 'Unknown category' };

  // Retiring a category is how somebody stops an over-firing rule filling a
  // report, so the detector has to stop assigning it — not just the picker stop
  // offering it. This clears the registry cache in the web service; the worker,
  // which is where the detector actually runs, picks the change up on its own
  // cache's TTL. See `categoryIds()`.
  forgetCategoryIds();
  revalidatePath('/admin/categories');
  return { error: null };
}

export async function saveRootCause(_state: AdminState, formData: FormData): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = canonicalUuid(formData.get('id'));
  const labelEn = text(formData, 'labelEn');
  const labelAr = text(formData, 'labelAr');

  if (!id) return { error: 'Unknown cause' };
  if (!labelEn || !labelAr) {
    return { error: 'Both the English and the Arabic label are required' };
  }

  const updated = await db
    .update(ticketRootCauses)
    .set({ labelEn, labelAr, updatedAt: new Date() })
    .where(eq(ticketRootCauses.id, id))
    .returning({ id: ticketRootCauses.id });
  if (!updated.length) return { error: 'Unknown cause' };

  revalidatePath('/admin/categories');
  return { error: null };
}

export async function setRootCauseActive(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = canonicalUuid(formData.get('id'));
  const active = formData.get('active') === 'true';
  if (!id) return { error: 'Unknown cause' };

  const updated = await db
    .update(ticketRootCauses)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(ticketRootCauses.id, id))
    .returning({ id: ticketRootCauses.id });
  if (!updated.length) return { error: 'Unknown cause' };

  revalidatePath('/admin/categories');
  return { error: null };
}
