import { createHash } from 'node:crypto';
import { UNKNOWN_CATEGORY_KEY } from '@/lib/categories/registry';
import { stateFor, type MessageForState } from '@/lib/subcategorise-ai/request';
import {
  MAX_CHOICE_OPTIONS,
  TypeSafeApiError,
  type ChoiceQuestion,
  type SystemOneRequest,
} from '@/lib/typesafe/client';

/**
 * What this system asks Jev about which team's work a message is, written down
 * in one place (`plans/ticket-category-routing.md`, decision 4).
 *
 * Pure and tested for the reason the other two questions are: a `choice`
 * question with a wrong `criteria` map does not fail, it answers over the wrong
 * vocabulary, and that answer looks exactly like a right one.
 *
 * The options are the registry's active rows keyed by their own keys, which
 * `ticket_categories_key_format` holds to lowercase words — so `JSON.stringify`
 * keeps them in the order given, and an answer comes back as a key the column
 * can be written from. `unknown` is added here, on every request, rather than
 * kept as a row: the CHECK forbids the row, and a "none of these" that existed
 * only while somebody remembered to keep it active would leave the model a
 * forced guess the day nobody did.
 *
 * The state is priority's, built by the same `stateFor` over the same earlier
 * messages, so the two questions asked about one message are asked about the
 * same text — plus `is_public_comment`, added here and only here: priority's
 * request is pinned byte for byte, and a field added to the shared state would
 * change what the live priority classifier is asked.
 */

/** The name this question is filed under, and the answer read back by. Not `category`, the subcategoriser's pinned name. */
export const CATEGORY_QUESTION = 'ticket_category';

/**
 * The shape of the state, as a number the fingerprint carries. Bumped by hand
 * whenever `categoryState` gains, loses or renames a field — the request test
 * pins the field list so that cannot happen unnoticed.
 */
export const STATE_VERSION = 1;

/** A category as this module needs it; whatever else the row carries is not sent. */
export type CategoryOption = {
  id: string;
  key: string;
  labelEn: string;
  description: string | null;
};

/** A message as this module needs it: priority's, and whether it is a public comment. */
export type CategoryMessage = MessageForState & { isPublicComment: boolean };

/**
 * The instruction, written out rather than assembled, for the reason the other
 * two are.
 *
 * Deliberately not priority's opening, "The sender is either a merchant who
 * ships parcels or a recipient expecting one": it is false for somebody asking
 * to start shipping and for a courier asking for work, which are two of the
 * four teams, and a category is a routing label about what a message asks for,
 * never a claim about who wrote it (`lib/categories/registry.ts`).
 */
const INSTRUCTIONS = [
  'This is a message sent to ShipBlu, a parcel delivery company in Egypt.',
  'Which team should handle it? Each option is a team, described by the',
  'requests it handles. Judge what the message asks for, not who seems to be',
  'writing it.',
  'is_public_comment is true when the message is a comment under one of',
  'ShipBlu’s public posts rather than a private message.',
  'Messages are usually in Egyptian Arabic, sometimes in English, and sometimes',
  'in Franco-Arabic — Arabic written in Latin letters and digits.',
  `Choose ${UNKNOWN_CATEGORY_KEY} when the message is only a greeting, thanks or`,
  'an acknowledgement, is too short or vague to tell what it asks for, or is not',
  'about ShipBlu’s services at all; that is a real answer, not a last resort.',
].join(' ');

const UNKNOWN_CRITERION =
  'None of these teams: a greeting, thanks or an acknowledgement on its own, a message too short or vague to tell what it asks for, or anything not about ShipBlu’s services.';

export type CategoryQuestion = {
  question: ChoiceQuestion;
  /** Category key → id. `unknown` is deliberately absent: it is not a category. */
  keyToId: Record<string, string>;
  /** Every key offered, `unknown` included, for `predictionFrom` to check the answer against. */
  offered: ReadonlySet<string>;
};

/**
 * The question, checked against what would make it wrong.
 *
 * Refused, permanently, with no registry to offer, with a registry row named
 * `unknown` — the third reservation of that key, since a collision would merge
 * the escape hatch into a real category silently — and past the options one
 * question can hold beside `unknown`.
 */
export function categoryQuestion(options: readonly CategoryOption[]): CategoryQuestion {
  if (options.length === 0) {
    throw new TypeSafeApiError('No active categories to offer', null, false);
  }
  if (options.some((option) => option.key === UNKNOWN_CATEGORY_KEY)) {
    throw new TypeSafeApiError(
      `A category is keyed "${UNKNOWN_CATEGORY_KEY}", the answer kept for none of them`,
      null,
      false,
    );
  }
  if (options.length > MAX_CHOICE_OPTIONS - 1) {
    throw new TypeSafeApiError(
      `${options.length} active categories, past the ${MAX_CHOICE_OPTIONS - 1} one question can offer beside "${UNKNOWN_CATEGORY_KEY}"`,
      null,
      false,
    );
  }

  const criteria: Record<string, string> = {};
  const keyToId: Record<string, string> = {};
  for (const option of options) {
    const description = option.description?.trim();
    criteria[option.key] = description ? `${option.labelEn} — ${description}` : option.labelEn;
    keyToId[option.key] = option.id;
  }
  criteria[UNKNOWN_CATEGORY_KEY] = UNKNOWN_CRITERION;

  return {
    question: { type: 'choice', instructions: INSTRUCTIONS, criteria },
    keyToId,
    offered: new Set(Object.keys(criteria)),
  };
}

/**
 * Priority's state, and whether the message is a public comment — always
 * present, as a boolean, so the state has one shape that `STATE_VERSION` names.
 */
export function categoryState(
  message: CategoryMessage,
  withContext: boolean,
): Record<string, unknown> {
  return { ...stateFor(message, withContext), is_public_comment: message.isPublicComment };
}

/**
 * A short hash of the question exactly as sent, prefixed by the state's
 * version: `s1-0123456789abcdef`.
 *
 * Over the serialised `questions` object — the name, the instructions, every
 * key and criterion in order, `unknown` included — so an admin editing a label,
 * a description or the order, or retiring a category, is a new fingerprint
 * from the next message on, and the report never averages two questions. Not
 * the message, the model or the context switch, which have columns of their own.
 */
export function requestFingerprint(questions: SystemOneRequest['questions']): string {
  const hex = createHash('sha256')
    .update(`state:${STATE_VERSION}\n`)
    .update(JSON.stringify(questions))
    .digest('hex');
  return `s${STATE_VERSION}-${hex.slice(0, 16)}`;
}

/**
 * The fingerprint every request over `options` carries, with no message to ask
 * about — how a backfill tells whether a label's rows answered today's
 * question before it adds to them or acts on them.
 */
export function questionFingerprint(options: readonly CategoryOption[]): string {
  return requestFingerprint({ [CATEGORY_QUESTION]: categoryQuestion(options).question });
}

/** The whole body and what reading the answer needs, so one function owns everything that goes over the wire. */
export function categoryRequest(
  message: CategoryMessage,
  options: readonly CategoryOption[],
  model: string,
  withContext: boolean,
): CategoryQuestion & { request: SystemOneRequest; fingerprint: string } {
  const built = categoryQuestion(options);
  const questions = { [CATEGORY_QUESTION]: built.question };
  return {
    ...built,
    request: { state: categoryState(message, withContext), model, questions },
    fingerprint: requestFingerprint(questions),
  };
}
