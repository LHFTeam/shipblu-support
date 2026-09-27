'use server';

import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketForms, groups, conversations } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { int, text, uuidField } from '@/lib/http/form-data';
import { parseFormElements } from '@/lib/forms/elements';
import { slugify } from '@/lib/kb/slug';
import { isPriority } from '@/lib/tickets/vocabulary';
import { type TicketFieldDef } from '@/lib/tickets/custom-fields';
import { listAllTicketFields } from '@/lib/tickets/lookups';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Ticket forms -----------------------------------------------------------

/**
 * Which entries `parseFormElements` threw away, by position.
 *
 * "1 of 8 questions could not be saved" tells an admin that something is wrong
 * and nothing about where, on a screen where the offending row often renders
 * blank precisely because it is the broken one. Re-parsing each prefix is O(n²)
 * on an array of a dozen, and it is exact — including for a duplicate, which is
 * only droppable in the context of the entries before it.
 */
function droppedPositions(document: unknown[], fields: TicketFieldDef[]): number[] {
  const dropped: number[] = [];
  let kept = 0;

  for (let index = 0; index < document.length; index += 1) {
    const size = parseFormElements(document.slice(0, index + 1), fields).length;
    if (size === kept) dropped.push(index + 1);
    kept = size;
  }

  return dropped;
}

/** "3", "3 and 5", "3, 5 and 9". */
function listPositions(positions: number[]): string {
  if (positions.length <= 1) return positions.join('');
  return `${positions.slice(0, -1).join(', ')} and ${positions[positions.length - 1]}`;
}

/**
 * Saves a form, storing the layout **as parsed** rather than as submitted.
 *
 * The builder posts the whole document in one hidden input so the server
 * validates exactly what will be stored — the same shape the condition and
 * action builders use. Writing back the parsed value rather than the raw one
 * closes the last gap in that: what is in the column is then literally what
 * `parseFormElements` will hand the renderer, with visibility defaulted and
 * blank overrides normalised, so the form on screen and the form in the
 * database cannot be two different documents.
 */
export async function saveTicketForm(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.forms');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const nameEn = text(formData, 'nameEn');
  const nameAr = text(formData, 'nameAr');

  // One language is enough, deliberately: a team that works in Arabic should not
  // have to invent an English name to publish a form. `localised` shows whichever
  // exists to everybody.
  if (!nameEn && !nameAr) return { error: 'Give the form a name in at least one language' };

  // Through `lib/kb/slug.ts`, never an ASCII slugify — Arabic is the default
  // locale and the front door, and an ASCII slugify erases an Arabic name
  // entirely, leaving every form called the same empty string.
  const slug = slugify(text(formData, 'slug') || nameEn || nameAr, '');
  if (!slug) return { error: 'That name has no characters a web address can carry — set a slug' };

  let document: unknown;
  try {
    document = JSON.parse(text(formData, 'elements') || '[]');
  } catch {
    return { error: 'The form layout is not valid JSON' };
  }
  if (!Array.isArray(document)) return { error: 'The form layout has to be a list of questions' };

  // Every field, not just the active ones. A deactivated field is one an admin
  // retired, and parsing against the active list here would make every form that
  // still places it refuse to save — including a save that only fixed a typo in
  // the intro, with a message about a question the admin could no longer see.
  const fields = await listAllTicketFields();
  const elements = parseFormElements(document, fields);

  // Loud rather than lossy. `parseFormElements` drops what it cannot understand
  // because a live form must keep rendering, but a save that silently discards
  // three questions is how an admin finds out weeks later that the form stopped
  // asking about the warehouse.
  if (elements.length !== document.length) {
    const dropped = droppedPositions(document, fields);
    return {
      error: `Could not save question ${listPositions(dropped)} — a question with nothing chosen, with no text, naming a field that no longer exists, repeating one already on the form, or with a condition that cannot be read.`,
    };
  }

  const requiresSignIn = formData.get('requiresSignIn') === 'on';
  const asksEmail = elements.some(
    (element) => element.kind === 'system' && element.key === 'requester_email',
  );
  if (!requiresSignIn && !asksEmail) {
    return {
      error:
        'A form anybody can submit has to ask for an email address, or nothing can be replied to. Add the email question, or require signing in.',
    };
  }

  const defaultGroupId = text(formData, 'defaultGroupId') || null;
  if (defaultGroupId) {
    const exists = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, defaultGroupId))
      .limit(1);
    // Surfaces as a sentence rather than as a foreign-key violation, which is
    // what an admin gets if the group was deleted while this screen was open.
    if (!exists.length) return { error: 'That group no longer exists' };
  }

  const priority = text(formData, 'defaultPriority');
  const values = {
    slug,
    nameAr,
    nameEn,
    descriptionAr: text(formData, 'descriptionAr'),
    descriptionEn: text(formData, 'descriptionEn'),
    elements,
    requiresSignIn,
    showOnHelpCentre: formData.get('showOnHelpCentre') === 'on',
    showInConsole: formData.get('showInConsole') === 'on',
    defaultGroupId,
    defaultPriority: isPriority(priority) ? priority : null,
    defaultType: text(formData, 'defaultType') || null,
    defaultTags: text(formData, 'defaultTags')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    subjectTemplate: text(formData, 'subjectTemplate') || null,
    confirmationAr: text(formData, 'confirmationAr'),
    confirmationEn: text(formData, 'confirmationEn'),
    position: int(formData, 'position'),
    isActive: formData.get('isActive') !== 'off',
    updatedAt: new Date(),
  };

  const clash = await db
    .select({ id: ticketForms.id })
    .from(ticketForms)
    .where(
      id ? and(eq(ticketForms.slug, slug), ne(ticketForms.id, id)) : eq(ticketForms.slug, slug),
    )
    .limit(1);
  if (clash.length) return { error: `Another form already lives at /${slug}` };

  if (id) await db.update(ticketForms).set(values).where(eq(ticketForms.id, id));
  else await db.insert(ticketForms).values(values);

  refresh('/admin/forms');
  return ok();
}

/**
 * Deleting a form is refused while a ticket points at it.
 *
 * The column is `on delete set null`, so the delete would succeed and quietly
 * erase where every one of those tickets came from — which is the one thing
 * `conversations.form_id` exists to remember. Deactivating takes the form off
 * the help centre and keeps the history, which is what "delete" almost always
 * meant.
 */
export async function deleteTicketForm(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.forms');

  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const used = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.formId, id))
    .limit(1);

  if (used.length) {
    return {
      error:
        'Tickets were opened through this form. Deactivate it instead — that takes it off the help centre and keeps the record of where those tickets came from.',
    };
  }

  await db.delete(ticketForms).where(eq(ticketForms.id, id));
  refresh('/admin/forms');
  return ok();
}
