import { parseCondition, type Condition } from '@/lib/rules/conditions';
import { localised, type TicketFieldDef } from '@/lib/tickets/custom-fields';

/**
 * What a ticket form is made of.
 *
 * A form is a list of elements stored as one jsonb document on
 * `ticket_forms.elements` — see the table's comment for why that is a document
 * and not a join table. This module is the only thing that turns that untyped
 * column into something the renderers and the submit path can walk, and it is
 * deliberately client-safe: the help centre shows and hides inputs live as
 * somebody types, so the same parse has to run in the browser.
 *
 * The parser follows the house shape — `parseX(input: unknown): X | null`,
 * hand-written, never throwing — that `parseCondition` and `parseAction`
 * already use. Not zod: zod is for payloads arriving from outside (the
 * environment, the delivery platform), and every admin-configurable structure
 * here is parsed by hand so the admin screen and the engine can call the same
 * function and agree by construction.
 */

/**
 * The questions every ticket has, which are not `ticket_fields` rows and should
 * not become them.
 *
 * A subject and a message exist on `conversations` and `messages` as columns;
 * making them custom fields to get them onto a form would store the subject
 * twice and leave every existing query reading the copy that is not filled in.
 * So a form places them by name, and `lib/forms/submit.ts` knows where each one
 * goes.
 */
export const SYSTEM_KEYS = [
  'subject',
  'description',
  'attachments',
  'requester_name',
  'requester_email',
  'priority',
] as const;

export type SystemKey = (typeof SYSTEM_KEYS)[number];

/**
 * What each system question means when the form does not say.
 *
 * A message is the ticket; a form that does not ask for one is asking somebody
 * to file an empty ticket. A subject is *not* required by default because a
 * form with a subject template does not need the customer to write one — and a
 * form with neither falls back to the form's own name, so the inbox never shows
 * a blank row either way.
 */
const SYSTEM_REQUIRED: Record<SystemKey, boolean> = {
  subject: false,
  description: true,
  attachments: false,
  requester_name: false,
  requester_email: true,
  priority: false,
};

/**
 * Which system questions only make sense on one side.
 *
 * `requester_*` are how an anonymous form learns who is writing, and a signed-in
 * form already knows — showing them would ask a customer to retype what the
 * session says and let a typo file the ticket against somebody else. `priority`
 * is the mirror image: customers grading their own urgency is a queue that is
 * entirely urgent, so it is offered to agents only.
 */
export const CUSTOMER_ONLY_SYSTEM: readonly SystemKey[] = ['requester_name', 'requester_email'];
export const AGENT_ONLY_SYSTEM: readonly SystemKey[] = ['priority'];

export type ElementOverrides = {
  /** Blank falls back to the field's own customer wording, then to its label. */
  labelAr: string | null;
  labelEn: string | null;
  /** The sentence under the input. Always on screen, unlike an InfoTip. */
  helpAr: string | null;
  helpEn: string | null;
  /** Null inherits: the field's `requiredOnCreate`, or the system default above. */
  required: boolean | null;
};

export type FieldElement = { kind: 'field'; key: string; visibility: Condition } & ElementOverrides;
export type SystemElement = {
  kind: 'system';
  key: SystemKey;
  visibility: Condition;
} & ElementOverrides;
export type HeadingElement = {
  kind: 'heading';
  textAr: string;
  textEn: string;
  visibility: Condition;
};
export type NoteElement = { kind: 'note'; textAr: string; textEn: string; visibility: Condition };

export type FormElement = FieldElement | SystemElement | HeadingElement | NoteElement;

/** The two kinds that collect an answer, as opposed to the two that explain one. */
export type InputElement = FieldElement | SystemElement;

export function isInput(element: FormElement): element is InputElement {
  return element.kind === 'field' || element.kind === 'system';
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optional(value: unknown): string | null {
  const text = trimmed(value);
  return text === '' ? null : text;
}

function overrides(node: Record<string, unknown>): ElementOverrides {
  return {
    labelAr: optional(node.labelAr),
    labelEn: optional(node.labelEn),
    helpAr: optional(node.helpAr),
    helpEn: optional(node.helpEn),
    required: typeof node.required === 'boolean' ? node.required : null,
  };
}

/**
 * Validates the stored document against the fields that actually exist.
 *
 * Three things get dropped rather than raising, and each has a reason:
 *
 * - **An element naming a field that is gone or deactivated.** The same answer
 *   `lib/rules/conditions.ts` gives for a rule pointing at a deleted field: it
 *   quietly stops applying rather than breaking the page for every other
 *   question on the form. Deactivating a field is how an admin retires it, and
 *   it should not have to be un-placed from six forms first.
 * - **A second element for the same field.** Two inputs writing one key store
 *   one answer and the customer cannot tell which of the two was kept.
 * - **An element whose visibility will not parse.** A malformed condition is
 *   treated as "does not match", which is the rule the condition language
 *   already states — and for a form that means the question is not asked,
 *   never that it is asked unconditionally.
 */
export function parseFormElements(input: unknown, defs: TicketFieldDef[]): FormElement[] {
  if (!Array.isArray(input)) return [];

  const known = new Set(defs.map((def) => def.key));
  const seen = new Set<string>();
  const parsed: FormElement[] = [];

  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const node = entry as Record<string, unknown>;

    const visibility = parseCondition(node.visibility ?? {});
    if (!visibility) continue;

    if (node.kind === 'heading' || node.kind === 'note') {
      const textAr = trimmed(node.textAr);
      const textEn = trimmed(node.textEn);
      // Neither language written is an element that renders as nothing, which
      // reads on screen as a gap somebody forgot to fill in.
      if (!textAr && !textEn) continue;
      parsed.push({ kind: node.kind, textAr, textEn, visibility });
      continue;
    }

    const key = trimmed(node.key);
    if (!key) continue;

    if (node.kind === 'field') {
      if (!known.has(key) || seen.has(`field:${key}`)) continue;
      seen.add(`field:${key}`);
      parsed.push({ kind: 'field', key, visibility, ...overrides(node) });
      continue;
    }

    if (node.kind === 'system') {
      if (!SYSTEM_KEYS.includes(key as SystemKey) || seen.has(`system:${key}`)) continue;
      seen.add(`system:${key}`);
      parsed.push({ kind: 'system', key: key as SystemKey, visibility, ...overrides(node) });
    }
  }

  return parsed;
}

/**
 * Whether this question must be answered before the form will submit.
 *
 * The element's own answer wins, then the definition's. A form saying "required
 * here" about a field that is optional elsewhere is the point of the override:
 * the same "Order number" field is optional on a general enquiry and mandatory
 * on a refund claim, and duplicating the field to say so would split its answers
 * across two keys and two sets of rules.
 */
export function isRequired(element: InputElement, def: TicketFieldDef | null): boolean {
  if (element.required !== null) return element.required;
  if (element.kind === 'system') return SYSTEM_REQUIRED[element.key];
  return def?.requiredOnCreate ?? false;
}

/** The wording this element shows, falling back through the caller's default. */
export function elementLabel(element: InputElement, fallback: string, locale: 'ar' | 'en'): string {
  return localised(element.labelAr, element.labelEn, locale, fallback);
}

/** The sentence under the input, or null when the element does not carry one. */
export function elementHelp(element: InputElement, locale: 'ar' | 'en'): string | null {
  const own = (locale === 'ar' ? element.helpAr : element.helpEn)?.trim();
  if (own) return own;
  const other = (locale === 'ar' ? element.helpEn : element.helpAr)?.trim();
  return other || null;
}

/** The text a heading or a note shows. */
export function elementText(element: HeadingElement | NoteElement, locale: 'ar' | 'en'): string {
  const own = (locale === 'ar' ? element.textAr : element.textEn).trim();
  if (own) return own;
  return (locale === 'ar' ? element.textEn : element.textAr).trim();
}
