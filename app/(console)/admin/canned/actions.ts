'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { cannedBodyColumns } from '@/lib/tickets/canned-write';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Canned responses -------------------------------------------------------

export async function saveCannedResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const title = text(formData, 'title');
  const bodyTextAr = text(formData, 'bodyTextAr');
  const bodyTextEn = text(formData, 'bodyTextEn');
  const folder = text(formData, 'folder') || null;

  if (!title) return { error: 'Give the response a title' };

  // One language is a complete response; neither is a row nothing can send. The
  // form asks for both and requires neither, so this is where the real rule is.
  if (!bodyTextAr && !bodyTextEn) return { error: 'Write the response in at least one language' };

  // The body columns come from the one function the starter-library seed also
  // writes through, so a response saved here and a seeded one are stored alike.
  const values = {
    title,
    folder,
    ...cannedBodyColumns({ ar: bodyTextAr, en: bodyTextEn }),
  };

  if (id) {
    await db.update(cannedResponses).set(values).where(eq(cannedResponses.id, id));
  } else {
    await db.insert(cannedResponses).values(values);
  }

  refresh('/admin/canned');
  return ok();
}

export async function deleteCannedResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };
  await db.delete(cannedResponses).where(eq(cannedResponses.id, id));
  refresh('/admin/canned');
  return ok();
}
