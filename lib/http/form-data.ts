import { isUuid } from './uuid';

/**
 * Reading a server action's `FormData` into the values a query can take.
 *
 * Lifted from the admin settings actions, which had grown the full set, so
 * that the other action files can stop spelling `String(formData.get(key) ??
 * '').trim()` out by hand. Pure: nothing here reads a row.
 */

export function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

/**
 * A uuid out of a form field: the value, `null` for "not set", `undefined` for
 * "that is not a uuid".
 *
 * The shape is checked before the value reaches a query because Postgres raises
 * 22P02 on a malformed uuid, and an action that throws returns no state at all —
 * the admin gets a blank crash where the form promises a sentence. The three
 * outcomes are kept distinct on purpose: treating a malformed id as "not set"
 * would quietly widen a rule scoped to one group into one that covers all of
 * them.
 */
export function uuidField(formData: FormData, key: string): string | null | undefined {
  const value = text(formData, key);
  if (!value) return null;
  return isUuid(value) ? value : undefined;
}

export function int(formData: FormData, key: string, fallback = 0): number {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function optionalMinutes(formData: FormData, key: string): number | null {
  const raw = text(formData, key);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * A number the admin typed, or null. Rejects the shapes a number input still
 * lets through — an empty box is "no rule", `abc` is a mistake worth naming.
 */
export function optionalNumber(
  formData: FormData,
  key: string,
): { ok: true; value: number | null } | null {
  const raw = text(formData, key);
  if (!raw) return { ok: true, value: null };
  const value = Number(raw);
  return Number.isFinite(value) ? { ok: true, value } : null;
}
