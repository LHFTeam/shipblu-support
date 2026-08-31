import { t, type Locale } from '@/lib/kb/locale';
import {
  fieldLabel,
  isBlank,
  optionLabel,
  type CustomFieldValues,
  type TicketFieldDef,
} from '@/lib/tickets/custom-fields';
import { elementLabel, type FormElement } from './elements';

/**
 * The answers, written into the ticket somebody will actually read.
 *
 * Without this a form's answers exist only in `conversations.custom_fields`,
 * which lives in the sidebar behind a scroll on a screen an agent reads on a
 * phone. The first message is where the ticket is read, so the answers go there
 * too — the sidebar stays the place they are *edited*, and the message stays the
 * place they are *seen*.
 *
 * **Plain text, deliberately.** `messages.body_text` is what the inbox preview,
 * the search vector and every notification email are built from, and this
 * repo's rule is that attacker-controlled HTML is sanitised once on write
 * through `lib/html/sanitize.ts`. Building this as markup would mean sanitising
 * a string assembled from customer input, and around every value substituted
 * into it, to buy formatting nobody needs on three lines of "Label: value".
 */

const ZONE = 'Africa/Cairo';

/**
 * One stored answer as the words a person reads.
 *
 * Labels rather than values for the choice types: `custom_fields` stores
 * `cod` because that is what a rule compares against, and a ticket that says
 * "Payment: cod" makes the agent go and look up what that meant.
 */
export function answerText(def: TicketFieldDef, value: unknown, locale: Locale): string {
  if (value === null || value === undefined) return '';

  if (def.type === 'checkbox') return t(locale, value === true ? 'yes' : 'no');

  if (Array.isArray(value)) {
    const chosen = new Set(value.map(String));
    return def.options
      .filter((option) => chosen.has(option.value))
      .map((option) => optionLabel(option, locale))
      .join(locale === 'ar' ? '، ' : ', ');
  }

  if (def.type === 'dropdown') {
    const option = def.options.find((entry) => entry.value === String(value));
    return option ? optionLabel(option, locale) : String(value);
  }

  if (def.type === 'datetime') {
    // Stored as an instant, read back as the Cairo wall clock somebody entered.
    // `Intl` carries the timezone database the runtime already has, so this is
    // right across a DST change without pulling luxon into a client bundle —
    // the same trade `formatForInput` makes.
    const at = new Date(String(value));
    if (Number.isNaN(at.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? '';
    const hour = part('hour') === '24' ? '00' : part('hour');
    return `${part('year')}-${part('month')}-${part('day')} ${hour}:${part('minute')}`;
  }

  // `date` falls through here on purpose: it is stored as the calendar date it
  // is, and putting it through a `Date` is how the 30th becomes the 29th for
  // anybody reading from a different offset.
  return String(value);
}

/**
 * Every answered question on the form, in the order it was asked.
 *
 * Driven by the form's elements rather than by the answer map, so the order is
 * the one the customer saw and a field they were never asked cannot appear even
 * if a stale key survives in `custom_fields`. Unanswered questions are left out
 * — a wall of "Label: —" hides the three lines that were filled in — except a
 * checkbox, whose "no" is an answer.
 */
export function renderAnswers(
  elements: FormElement[],
  defs: TicketFieldDef[],
  custom: CustomFieldValues,
  locale: Locale,
): string {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const lines: string[] = [];

  for (const element of elements) {
    if (element.kind !== 'field') continue;

    const def = byKey.get(element.key);
    if (!def) continue;

    const value = custom[element.key];
    if (isBlank(value)) continue;

    const text = answerText(def, value, locale);
    if (!text) continue;

    lines.push(`${elementLabel(element, fieldLabel(def, locale), locale)}: ${text}`);
  }

  return lines.join('\n');
}
