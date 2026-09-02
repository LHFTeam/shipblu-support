import type { Locale } from '@/lib/kb/locale';
import type { CustomFieldValues, TicketFieldDef } from '@/lib/tickets/custom-fields';
import type { SystemValues } from './visibility';
import { answerText } from './summary';

/**
 * The subject line a form gives the ticket it opens.
 *
 * Without one, forty submissions of "Report a damaged parcel" arrive in the
 * inbox as forty identical rows and the only way to tell them apart is to open
 * each. `Damaged parcel — {{tracking_number}}` makes the list readable, which is
 * the difference between a queue an agent can triage and a queue they have to
 * excavate.
 *
 * `{{key}}` names a custom field, plus `{{subject}}` for what the customer typed
 * when the form asks for one. **When a template is set it always wins**, even
 * over a subject the customer wrote — one rule rather than "the template unless
 * there is also a subject field", which nobody could predict from the admin
 * screen. A form that wants the customer's words keeps `{{subject}}` in its
 * template.
 */

/** Matches `{{ key }}`; keys are the same shape `ticket_fields.key` is. */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

/** `conversations.subject` is unbounded text, but the portal's own input is not. */
const MAX_SUBJECT = 200;

/**
 * Whitespace and the separators around a placeholder that came back empty.
 *
 * The template is written for the case where every answer is present; an
 * unanswered optional field otherwise leaves `Damaged parcel — ` with the dash
 * dangling, which reads as a truncated subject rather than a short one.
 */
function tidy(subject: string): string {
  return subject
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([-–—:,])\s*(?=$|[-–—:,])/g, '')
    .replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '')
    .trim();
}

export function renderSubject(
  template: string | null,
  elements: { key: string }[],
  defs: TicketFieldDef[],
  custom: CustomFieldValues,
  system: SystemValues,
  locale: Locale,
  fallback: string,
  /**
   * A subject the *link* supplied, not the customer.
   *
   * The tracking page sends `?subject=SB123 — …` so a ticket about a parcel
   * arrives named after it, and the shipment detector links the two. It used to
   * reach `conversations.subject` unconditionally; once forms owned the subject
   * it was silently lost on every form that asks no subject question — which is
   * every form with a template, the documented normal case. It is a fallback and
   * never an answer, so it cannot override a template or what a customer typed.
   */
  seed = '',
): string {
  const typed = (system.subject ?? '').trim() || seed.trim();

  if (!template || !template.trim()) {
    return (typed || fallback).slice(0, MAX_SUBJECT);
  }

  const byKey = new Map(defs.map((def) => [def.key, def]));
  // Only fields the form actually placed. A template naming a key the form does
  // not ask for would otherwise read whatever a stale `custom_fields` entry
  // happened to hold — the answer to a question this submission never saw.
  const placed = new Set(elements.map((element) => element.key));

  const filled = template.replace(PLACEHOLDER, (_match, key: string) => {
    if (key === 'subject') return typed;

    const def = byKey.get(key);
    if (!def || !placed.has(key)) return '';

    return answerText(def, custom[key], locale);
  });

  return (tidy(filled) || typed || fallback).slice(0, MAX_SUBJECT);
}
