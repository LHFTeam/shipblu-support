import { MAX_TEXT_LENGTH } from '@/lib/subcategorise/normalise';
import { isMetaChannel, metaPlatformOf } from '@/lib/tickets/channel-policy';
import { UNCLASSIFIED_KEY } from '@/lib/subcategorise/taxonomy';
import {
  MAX_CHOICE_OPTIONS,
  TypeSafeApiError,
  type ChoiceQuestion,
  type SystemOneRequest,
} from '@/lib/typesafe/client';

/**
 * What this system asks TypeSafe about a message, written down in one place.
 *
 * Pure, and tested, for the reason `lib/meta/send.ts` gives about Graph: a wrong
 * request shape is invisible in the response. A `choice` question with a
 * mis-keyed `criteria` map does not fail — it answers, over the wrong
 * vocabulary, and the answer looks exactly like a right one.
 *
 * The question this module builds is the *same question the rules answer*: which
 * of the taxonomy's subcategories does this inbound message belong to. That is
 * what makes the shadow run a comparison rather than two unrelated numbers.
 */

/**
 * The name this system files its one question under, and reads the answer back by.
 *
 * Still `'category'`, the name it was filed under before Stage 2.A renamed the
 * taxonomy: it is part of the request body, and a shadow run is comparable with
 * an earlier one only when the two sent the same bytes.
 */
export const SUBCATEGORY_QUESTION = 'category';

/**
 * One option the model may choose, as the registry holds it.
 *
 * Deliberately the registry's row and not `TAXONOMY`'s entry. A subcategory
 * retired in the console disappears from the rules path immediately — `apply.ts`
 * resolves keys against `is_active` rows — so it has to disappear from here too,
 * or the two detectors are answering over different vocabularies and every
 * disagreement between them is uninterpretable.
 */
export type SubcategoryOption = {
  key: string;
  labelEn: string;
  description: string | null;
};

/** A message as this module needs it. Whatever else the row carries is not sent. */
export type MessageForState = {
  channel: string;
  bodyText: string;
  /**
   * Earlier inbound messages on the same ticket, oldest first.
   *
   * Non-bot traffic averages 22 to 39 characters a message, which is often not a
   * sentence, let alone a question — so a classifier handed one in isolation is
   * frequently being asked to read something that only means anything after the
   * message before it. Sent as their own field rather than concatenated: the
   * model must be able to tell which text it is classifying.
   */
  earlier?: readonly string[];
};

/**
 * The instruction the model judges against.
 *
 * Written out rather than assembled, because every clause in it is answering
 * something the corpus actually contains. The language sentence is not padding:
 * this archive is majority Egyptian Arabic, with Franco-Arabic (Arabic written in
 * Latin letters and digits — "3ayez", "msh") common enough that a classifier
 * treating it as English would misread a large minority of real messages.
 *
 * The last sentence is the important one. Given 55 options and no way out, a
 * model asked about "؟" will name something, and a forced guess that lands at a
 * low probability is exactly the over-detection `plans/ticket-categorisation.md`
 * warns about — the failure mode that silently moves a number somebody staffs a
 * team from. `meta.unclassified` is offered as a real answer so that it has one.
 *
 * It still asks for a "category", the word it used before Stage 2.A. These are
 * request bytes, and a changed word would make every later run incomparable with
 * every earlier one; `request.test.ts` pins the text.
 */
const INSTRUCTIONS = [
  'This is a message a customer sent to the support team of ShipBlu, a parcel',
  'delivery company in Egypt. The sender is either a merchant who ships parcels',
  'or a recipient expecting one.',
  'Which single category best describes what this message is about?',
  'Messages are usually in Egyptian Arabic, sometimes in English, and sometimes',
  'in Franco-Arabic — Arabic written in Latin letters and digits.',
  `Choose ${UNCLASSIFIED_KEY} when the message is too short, too vague or too`,
  'incomplete to tell what it is about; that is a real answer, not a last resort.',
].join(' ');

/**
 * The option list, as `criteria`.
 *
 * The description carries the discrimination and the label alone frequently does
 * not — "late" and "where is it" are the same English word to anything reading
 * only the labels, and they are separate rows in every report drawn off this.
 */
export function subcategoryCriteria(options: readonly SubcategoryOption[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const option of options) {
    criteria[option.key] = option.description
      ? `${option.labelEn} — ${option.description}`
      : option.labelEn;
  }
  return criteria;
}

/**
 * The question, checked against the one limit that can invalidate it.
 *
 * 55 subcategories against a documented ceiling of 255 means the whole taxonomy
 * fits one request, so there is no hierarchical walk here and no beam search —
 * those exist for trees that do not fit, and this one does. The assertion is what
 * makes that a checked fact rather than a comment that ages.
 */
export function subcategoryQuestion(options: readonly SubcategoryOption[]): ChoiceQuestion {
  if (options.length === 0) {
    throw new TypeSafeApiError('No active subcategories to offer', null, false);
  }
  if (options.length > MAX_CHOICE_OPTIONS) {
    throw new TypeSafeApiError(
      `The taxonomy has ${options.length} detectable subcategories, past TypeSafe's ${MAX_CHOICE_OPTIONS}-option limit for one choice question`,
      null,
      false,
    );
  }

  return {
    type: 'choice',
    instructions: INSTRUCTIONS,
    criteria: subcategoryCriteria(options),
  };
}

/**
 * The `state` the question is asked about.
 *
 * An object rather than a string. The endpoint accepts either, and flattening
 * these three fields into prose would leave the model inferring where the message
 * ends and its context begins — from text that is itself frequently punctuation-
 * free. `message` is always present and always the subject.
 *
 * Truncated at `MAX_TEXT_LENGTH`, the rules detector's own cutoff, so neither
 * detector is judged on text the other never saw.
 */
export function stateFor(message: MessageForState, withContext: boolean): Record<string, unknown> {
  const state: Record<string, unknown> = {
    // The platform for a comment channel, which is what this field said for a
    // comment before comments had channels of their own: the request is the
    // same bytes for the same message whichever value the ticket carries, and
    // this one function builds the priority request too.
    channel: isMetaChannel(message.channel) ? metaPlatformOf(message.channel) : message.channel,
    message: message.bodyText.slice(0, MAX_TEXT_LENGTH),
  };

  if (withContext && message.earlier && message.earlier.length > 0) {
    state.earlier_messages_from_the_same_customer = message.earlier.map((text) =>
      text.slice(0, MAX_TEXT_LENGTH),
    );
  }

  return state;
}

/** The whole body, so one function owns everything that goes over the wire. */
export function subcategorisationRequest(
  message: MessageForState,
  options: readonly SubcategoryOption[],
  model: string,
  withContext: boolean,
): SystemOneRequest {
  return {
    state: stateFor(message, withContext),
    model,
    questions: { [SUBCATEGORY_QUESTION]: subcategoryQuestion(options) },
  };
}
