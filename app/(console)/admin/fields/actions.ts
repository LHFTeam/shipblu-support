'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketFields } from '@/db/schema';
import type { TicketFieldValidation } from '@/db/schema/config';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { int, optionalNumber, text, uuidField } from '@/lib/http/form-data';
import { formsUsingField } from '@/lib/forms/queries';
import { parseOptionLines } from '@/lib/tickets/custom-fields';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Ticket fields ----------------------------------------------------------

const FIELD_TYPES = [
  'text',
  'paragraph',
  'number',
  'decimal',
  'checkbox',
  'dropdown',
  'multi_select',
  'date',
  'datetime',
] as const;

export async function saveField(_state: SettingsState, formData: FormData): Promise<SettingsState> {
  await requirePermission('admin.fields');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const key = text(formData, 'key');
  const label = text(formData, 'label');
  const type = text(formData, 'type');

  if (!label) return { error: 'Give the field a label' };
  if (!FIELD_TYPES.includes(type as (typeof FIELD_TYPES)[number])) {
    return { error: 'Pick a field type' };
  }

  // The key is what `custom.<key>` refers to in a rule, so it has to be stable
  // and safe to write in a condition.
  if (!id && !/^[a-z][a-z0-9_]*$/.test(key)) {
    return {
      error: 'The key must be lowercase letters, numbers and underscores, starting with a letter',
    };
  }

  const options = parseOptionLines(text(formData, 'options'));

  const validation = readValidation(formData);
  if (!validation.ok) return { error: validation.error };

  const values = {
    label,
    labelAr: text(formData, 'labelAr') || null,
    labelEn: text(formData, 'labelEn') || null,
    type: type as (typeof FIELD_TYPES)[number],
    options,
    validation: validation.rules,
    requiredOnCreate: formData.get('requiredOnCreate') === 'on',
    requiredOnResolve: formData.get('requiredOnResolve') === 'on',
    visibleToCustomer: formData.get('visibleToCustomer') === 'on',
    editableByCustomer: formData.get('editableByCustomer') === 'on',
    position: int(formData, 'position'),
    isActive: formData.get('isActive') !== 'off',
  };

  if (id) {
    // The key is deliberately not editable: every stored rule and every ticket's
    // custom_fields refers to it, and renaming it here would break both silently.
    await db.update(ticketFields).set(values).where(eq(ticketFields.id, id));
  } else {
    const existing = await db
      .select({ id: ticketFields.id })
      .from(ticketFields)
      .where(eq(ticketFields.key, key));
    if (existing.length) return { error: 'A field with that key already exists' };

    await db.insert(ticketFields).values({ ...values, key });
  }

  refresh('/admin/fields');
  return ok();
}

/** An admin's regular expression is compiled here so a broken one never ships. */
const MAX_PATTERN = 200;

function readValidation(
  formData: FormData,
): { ok: true; rules: TicketFieldValidation | null } | { ok: false; error: string } {
  const pattern = text(formData, 'pattern');

  if (pattern.length > MAX_PATTERN) {
    return { ok: false, error: `Keep the pattern under ${MAX_PATTERN} characters` };
  }
  if (pattern) {
    try {
      new RegExp(pattern, 'u');
    } catch {
      // Caught here rather than at submit time, where the parser deliberately
      // skips a pattern it cannot compile: a rule that refuses nothing is worse
      // than one that never saved.
      return { ok: false, error: 'That pattern is not a valid regular expression' };
    }
  }

  const numbers: Record<string, number | null> = {};
  for (const key of ['min', 'max', 'minLength', 'maxLength']) {
    const parsed = optionalNumber(formData, key);
    if (!parsed) return { ok: false, error: `${key} must be a number` };
    numbers[key] = parsed.value;
  }

  if (numbers.min !== null && numbers.max !== null && numbers.min! > numbers.max!) {
    return { ok: false, error: 'The smallest value cannot be larger than the largest' };
  }
  if (
    numbers.minLength !== null &&
    numbers.maxLength !== null &&
    numbers.minLength! > numbers.maxLength!
  ) {
    return { ok: false, error: 'The shortest length cannot be longer than the longest' };
  }

  const rules: TicketFieldValidation = {};
  if (pattern) rules.pattern = pattern;
  const patternMessageAr = text(formData, 'patternMessageAr');
  const patternMessageEn = text(formData, 'patternMessageEn');
  if (patternMessageAr) rules.patternMessageAr = patternMessageAr;
  if (patternMessageEn) rules.patternMessageEn = patternMessageEn;
  for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
    if (numbers[key] !== null) rules[key] = numbers[key]!;
  }

  // Null rather than `{}` so "this field has no extra rules" is one value, not
  // two that read differently in a jsonb dump.
  return { ok: true, rules: Object.keys(rules).length ? rules : null };
}

export async function deleteField(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const rows = await db
    .select({ key: ticketFields.key })
    .from(ticketFields)
    .where(eq(ticketFields.id, id))
    .limit(1);

  // Already gone — another admin deleted it. Still revalidated, because the
  // page this was pressed on lists it, and only a revalidated page comes back
  // with the answer.
  const key = rows[0]?.key;
  if (!key) {
    refresh('/admin/fields');
    return ok();
  }

  // A form naming a field that is gone renders one question fewer, silently.
  // That is the right runtime behaviour — see `parseFormElements` — and the
  // wrong thing to let somebody do by accident from a screen that says nothing.
  const used = await formsUsingField(key);
  if (used.length) {
    return {
      error: `Still asked by ${used.join(', ')}. Remove it from ${
        used.length === 1 ? 'that form' : 'those forms'
      } first, or deactivate the field instead — deactivating keeps every answer already given.`,
    };
  }

  await db.delete(ticketFields).where(eq(ticketFields.id, id));
  refresh('/admin/fields');
  return ok();
}
