'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { textToHtml } from '@/lib/html/sanitize';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
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

  // Stored as both forms: email sends HTML, WhatsApp and the social channels
  // send text, and deriving one from the other at send time would mean every
  // channel guessing at line breaks. An unwritten language stays empty in both
  // — `textToHtml('')` would otherwise leave markup that reads as a body.
  const bodyHtmlAr = bodyTextAr ? textToHtml(bodyTextAr) : '';
  const bodyHtmlEn = bodyTextEn ? textToHtml(bodyTextEn) : '';

  const values = {
    title,
    folder,
    bodyTextAr,
    bodyHtmlAr,
    bodyTextEn,
    bodyHtmlEn,
    /*
      The superseded pair, written for as long as it still exists.

      `db/schema/config.ts` keeps these columns through one release because the
      worker and the four crons deploy separately from the service that runs the
      migration, and the old `sendCannedReply` selects them. That only buys
      anything if they still say something: a response created after the
      migration and never written here is `''` to the old code, which sends a
      customer an empty automated reply rather than falling back to anything.
      Arabic first, for the reason `DEFAULT_LOCALE` is — a single body can only
      answer one half of the queue, and this is the larger half.

      Goes when the columns do; `docs/PROJECT-STATE.md` §5.5 carries the removal.
    */
    bodyText: bodyTextAr || bodyTextEn,
    bodyHtml: bodyHtmlAr || bodyHtmlEn,
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
