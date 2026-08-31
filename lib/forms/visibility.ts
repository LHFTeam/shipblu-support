import { evaluate, normaliseCustom, type Facts } from '@/lib/rules/conditions';
import type { CustomFieldValues } from '@/lib/tickets/custom-fields';
import { isInput, SYSTEM_KEYS, type FormElement, type SystemKey } from './elements';

/**
 * Which questions a form is actually asking, given the answers so far.
 *
 * Conditional fields are the feature every helpdesk's form builder is judged on,
 * and they are two problems wearing one name. In the browser it is a rendering
 * question: show the input when the condition holds. On the server it is a
 * security question, because the browser's answer arrives as a POST anybody can
 * write by hand — so the server computes visibility again, from the answers
 * rather than from the request, and that second computation is what this module
 * is for.
 *
 * Both sides run this same function. It is pure, imports no database and no
 * luxon, and the condition language it evaluates is the one SLA policies and
 * automations already use — an admin who has learned to write "priority is
 * urgent" for a rule writes the identical thing to reveal a field.
 */

/** The answers to the questions that are not `ticket_fields` rows. */
export type SystemValues = Partial<Record<SystemKey, string>>;

/**
 * The vocabulary a form's conditions are written against.
 *
 * Custom fields are namespaced `custom.<key>` — the same names
 * `lib/rules/facts.ts` gives them on a saved ticket, so an admin learns one
 * vocabulary and a condition written on a form reads the same as the automation
 * that later routes it. The system questions keep their bare names for the same
 * reason: `subject` and `priority` are already facts on a ticket.
 *
 * `attachments` is a count rather than a string, so `attachments gt 0` is
 * expressible; there is nothing useful to compare the files themselves against.
 */
export function formFacts(custom: CustomFieldValues, system: SystemValues): Facts {
  const facts: Facts = {};

  for (const key of SYSTEM_KEYS) {
    facts[key] = key === 'attachments' ? Number(system[key] ?? 0) : (system[key] ?? null);
  }

  for (const [key, value] of Object.entries(custom)) {
    facts[`custom.${key}`] = normaliseCustom(value);
  }

  return facts;
}

export type Resolution = {
  /** The elements to render, in the form's own order. */
  visible: FormElement[];
  /** The answers that survived — everything else was never asked for. */
  custom: CustomFieldValues;
  system: SystemValues;
};

/**
 * A form's conditions can chain — question A reveals B, whose answer reveals C —
 * so one pass is not enough, and the passes have to stop somewhere. Twelve is
 * well past any form a person will build by hand and low enough that a pair of
 * conditions that contradict each other settles instead of spinning.
 */
const MAX_PASSES = 12;

function token(kind: 'field' | 'system', key: string): string {
  return `${kind}:${key}`;
}

function granted(elements: FormElement[]): Set<string> {
  return new Set(elements.filter(isInput).map((element) => token(element.kind, element.key)));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const entry of a) if (!b.has(entry)) return false;
  return true;
}

function restrict(
  custom: CustomFieldValues,
  system: SystemValues,
  allowed: Set<string>,
): { custom: CustomFieldValues; system: SystemValues } {
  const keptCustom: CustomFieldValues = {};
  for (const [key, value] of Object.entries(custom)) {
    if (allowed.has(token('field', key))) keptCustom[key] = value;
  }

  const keptSystem: SystemValues = {};
  for (const key of SYSTEM_KEYS) {
    const value = system[key];
    if (value !== undefined && allowed.has(token('system', key))) keptSystem[key] = value;
  }

  return { custom: keptCustom, system: keptSystem };
}

/**
 * The questions this submission actually asked, and the answers it was entitled
 * to give.
 *
 * **It builds up rather than paring down**, and the direction is the whole
 * security argument. Starting from every element visible and removing the ones
 * whose conditions fail would let an answer to a question that was never asked
 * sit in the facts for a pass and reveal a second question — the crafted POST
 * getting one free move. Starting from nothing means an element is visible only
 * when the answers justifying it come from elements that are themselves visible,
 * which is exactly the order a person fills the form in: answer one, the next
 * appears.
 *
 * Two consequences the callers rely on:
 *
 * - An answer submitted for a hidden field is **discarded**, so a hand-made
 *   request cannot write to a field the form never showed — including the ones
 *   an automation routes on.
 * - A required field behind a condition that never fired is **not required**, so
 *   a valid submission is not refused over a question nobody was asked.
 */
export function resolveVisibility(
  elements: FormElement[],
  custom: CustomFieldValues,
  system: SystemValues,
): Resolution {
  let allowed = new Set<string>();

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const scoped = restrict(custom, system, allowed);
    const facts = formFacts(scoped.custom, scoped.system);
    const next = granted(elements.filter((element) => evaluate(element.visibility, facts)));

    if (sameSet(next, allowed)) break;
    allowed = next;
  }

  // Recomputed rather than carried out of the loop: on the rare form whose
  // conditions never settle, the loop exits on the cap with `allowed` one step
  // ahead of the elements it was derived from, and the two must agree or a
  // question could be rendered whose answer has already been thrown away.
  const scoped = restrict(custom, system, allowed);
  const facts = formFacts(scoped.custom, scoped.system);

  return {
    visible: elements.filter((element) => evaluate(element.visibility, facts)),
    custom: scoped.custom,
    system: scoped.system,
  };
}
