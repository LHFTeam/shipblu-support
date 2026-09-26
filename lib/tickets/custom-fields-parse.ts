import { DateTime } from 'luxon';
import { isBlank, type CustomFieldValues, type TicketFieldDef } from './custom-fields';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';

/**
 * Turning what somebody typed into the value a rule will later compare against.
 *
 * Server only, and that is the reason it is not in `./custom-fields.ts`: reading
 * a wall clock as an instant needs the timezone database, and the console's
 * sidebar is a client component — see the header of that file.
 *
 * Both forms call this. The console and the portal must agree, because a ticket
 * where the agent's dropdown stored the option's label and the customer's stored
 * its value is a ticket no single rule can match, and nothing would report the
 * disagreement.
 */

/** Ceilings on what one field can hold, so a ticket's jsonb cannot grow without bound. */
const MAX_TEXT = 500;
const MAX_PARAGRAPH = 5_000;
const MAX_SELECTIONS = 50;

export type ParsedValue = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * An admin's regular expression, compiled and anchored.
 *
 * Anchored here rather than by whoever typed it, because an unanchored pattern
 * that happens to match a substring is the classic way a validation rule
 * silently accepts everything: `[0-9]{6}` written to demand a six-digit
 * reference also accepts "please call me on 0123456 thanks". A pattern that
 * already anchors itself is unharmed by the wrapper.
 *
 * A pattern that will not compile yields null and the check is skipped, rather
 * than refusing every answer: the admin screen validates the expression when it
 * is saved, so reaching here with a broken one means the rule changed underneath
 * a form somebody had open, and losing their answer is the worse outcome.
 */
function anchored(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return null;
  }
}

/**
 * The admin's extra constraints, applied after the type's own parsing.
 *
 * After, not instead: `min`/`max` on a number are only meaningful once the text
 * is a number, and a length rule on a paragraph is only reached once the hard
 * `MAX_PARAGRAPH` ceiling has already refused the pathological case. The ceilings
 * bound what one ticket's jsonb can hold and are not an admin's to raise.
 */
function checkValidation(def: TicketFieldDef, value: unknown): string | null {
  const rules = def.validation;
  if (!rules) return null;

  if (typeof value === 'number') {
    if (typeof rules.min === 'number' && value < rules.min) {
      return `${def.label} must be ${rules.min} or more`;
    }
    if (typeof rules.max === 'number' && value > rules.max) {
      return `${def.label} must be ${rules.max} or less`;
    }
    return null;
  }

  if (typeof value !== 'string' || value === '') return null;

  if (typeof rules.minLength === 'number' && value.length < rules.minLength) {
    return `${def.label} must be at least ${rules.minLength} characters`;
  }
  if (typeof rules.maxLength === 'number' && value.length > rules.maxLength) {
    return `${def.label} must be at most ${rules.maxLength} characters`;
  }

  if (rules.pattern) {
    const expression = anchored(rules.pattern);
    if (expression && !expression.test(value)) {
      // The generic sentence. The wording an admin actually wrote is per-locale
      // and lives on the field, so the surface that has a reader — the help
      // centre form — renders it beside the input rather than taking this one.
      return `${def.label} is not in the expected format`;
    }
  }

  return null;
}

/**
 * Every branch returns a JSON primitive, an array of strings, or a blank —
 * nothing that `normaliseCustom` in `lib/rules/facts.ts` would have to stringify
 * to compare, because a number stored as "12" answers `custom.weight gt 5` with
 * a string comparison and gets it wrong.
 */
export function parseFieldValue(def: TicketFieldDef, raw: string | string[]): ParsedValue {
  const parsed = parseByType(def, raw);
  if (!parsed.ok) return parsed;

  const invalid = checkValidation(def, parsed.value);
  return invalid ? { ok: false, error: invalid } : parsed;
}

function parseByType(def: TicketFieldDef, raw: string | string[]): ParsedValue {
  if (def.type === 'multi_select') {
    const submitted = (Array.isArray(raw) ? raw : [raw])
      .map((entry) => entry.trim())
      .filter(Boolean);

    const unknown = submitted.find((entry) => !def.options.some((o) => o.value === entry));
    if (unknown) return { ok: false, error: `"${unknown}" is not an option for ${def.label}` };

    if (submitted.length > MAX_SELECTIONS) {
      return { ok: false, error: `${def.label} takes at most ${MAX_SELECTIONS} selections` };
    }

    // Stored in the field's own option order rather than the order the boxes
    // were ticked, so two tickets with the same answers hold the same array and
    // an `eq` against a stored list is not decided by click order.
    const chosen = new Set(submitted);
    return { ok: true, value: def.options.filter((o) => chosen.has(o.value)).map((o) => o.value) };
  }

  const text = (Array.isArray(raw) ? (raw[0] ?? '') : raw).trim();

  switch (def.type) {
    case 'checkbox':
      // An unchecked box is absent from the FormData entirely, so the caller
      // passes '' and this reads it as the "no" it is.
      return { ok: true, value: text === 'on' || text === 'true' || text === '1' };

    case 'text':
      if (text.length > MAX_TEXT) {
        return { ok: false, error: `${def.label} is limited to ${MAX_TEXT} characters` };
      }
      return { ok: true, value: text };

    case 'paragraph':
      if (text.length > MAX_PARAGRAPH) {
        return { ok: false, error: `${def.label} is limited to ${MAX_PARAGRAPH} characters` };
      }
      return { ok: true, value: text };

    case 'number':
    case 'decimal': {
      if (!text) return { ok: true, value: '' };

      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return { ok: false, error: `${def.label} must be a number` };
      if (def.type === 'number' && !Number.isInteger(parsed)) {
        return { ok: false, error: `${def.label} must be a whole number` };
      }
      return { ok: true, value: parsed };
    }

    case 'dropdown': {
      if (!text) return { ok: true, value: '' };
      if (!def.options.some((o) => o.value === text)) {
        return { ok: false, error: `"${text}" is not an option for ${def.label}` };
      }
      return { ok: true, value: text };
    }

    case 'date': {
      if (!text) return { ok: true, value: '' };
      if (!DateTime.fromFormat(text, 'yyyy-MM-dd').isValid) {
        return { ok: false, error: `${def.label} must be a date` };
      }
      // Kept as the calendar date it is, not converted to an instant. A due date
      // of the 30th is the 30th; giving it a midnight and a zone is how it
      // becomes the 29th for anybody reading from a different offset.
      return { ok: true, value: text };
    }

    case 'datetime': {
      if (!text) return { ok: true, value: '' };

      // `datetime-local` submits a wall clock with no zone. Cairo observes DST
      // again, so the offset is not a constant to add — luxon resolves it from
      // the date, and what gets stored is an unambiguous instant that a rule can
      // order against `now`.
      const parsed = DateTime.fromISO(text, { zone: TEAM_TIME_ZONE });
      if (!parsed.isValid) return { ok: false, error: `${def.label} must be a date and time` };
      return { ok: true, value: parsed.toISO() };
    }
  }
}

/**
 * Writes one field's value into a ticket's `custom_fields`, or clears it.
 *
 * A cleared field has its key deleted rather than set to null. The two read
 * identically to the condition language — an absent fact and a null one are both
 * `is_empty` — so the choice is only about what accumulates, and a ticket should
 * not carry keys for fields that were emptied years ago or deleted outright.
 */
export function applyFieldValue(
  values: CustomFieldValues,
  def: TicketFieldDef,
  raw: string | string[],
): { ok: true; values: CustomFieldValues } | { ok: false; error: string } {
  const parsed = parseFieldValue(def, raw);
  if (!parsed.ok) return parsed;

  const next = { ...values };
  if (isBlank(parsed.value)) delete next[def.key];
  else next[def.key] = parsed.value;

  return { ok: true, values: next };
}
