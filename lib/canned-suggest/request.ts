import { resolveLocale, type BilingualBody } from '@/lib/tickets/canned';
import {
  MAX_CHOICE_OPTIONS,
  TypeSafeApiError,
  type ChoiceQuestion,
  type SystemOneRequest,
} from '@/lib/typesafe/client';

/**
 * What the reply composer asks TypeSafe, written down in one place.
 *
 * Pure, and tested, for the reason `lib/categorise-ai/request.ts` gives: a wrong
 * request shape is invisible in the response. A `choice` question keyed wrongly
 * still answers — over the wrong options — and the answer looks exactly like a
 * right one.
 *
 * The question is the one an agent answers by hand every time they open the
 * picker: given this conversation so far, which of the team's saved replies
 * would they send next? Jev answers it by choosing a key the request offered, so
 * it can name a stored response or `none` and nothing else. It never writes a
 * word of the reply; the text that lands in the box is the stored body.
 */

/** The name the one question is filed under, and read back by. */
export const SUGGESTION_QUESTION = 'canned_response';

/**
 * The way out, and an option in its own right.
 *
 * Added here, in code, on every request — not left to a registry row that
 * happens to exist. The categoriser's `meta.unclassified` is offered only
 * because its `ticket_categories` row is active, and nothing stops an admin
 * retiring it; a suggester without this key would put a confident-looking
 * guess in front of an agent for "ok thanks", which is the over-suggestion that
 * teaches people to ignore the feature.
 */
export const NONE_KEY = 'none';

/**
 * Which wording of the question a row was produced by, stored on every row.
 * Change it whenever the instructions, the criteria or the state change shape,
 * so the report can tell a better model from a better question.
 */
export const REQUEST_VERSION = 'v1';

/**
 * How many messages of the conversation go with the question.
 *
 * Ten replies, both directions. Social messages here average 30 to 45
 * characters, so ten of them is a few lines; what decides the next reply is the
 * last exchange, and a long ticket's opening complaint is context rather than
 * the question. The instructions say to weigh the most recent messages most.
 */
export const HISTORY_LIMIT = 10;

/**
 * Per-message cut. Only email is ever this long — inbound p90 is about 670
 * characters — and the tail of an email past this is quoted history or a
 * signature far more often than it is the question.
 */
export const MAX_MESSAGE_CHARS = 1000;

/**
 * Per-option cut on a canned body. Every starter response but one fits; the
 * ceiling is for what the team writes later, since 62 options times an
 * unbounded body is the whole cost of the call.
 */
export const MAX_BODY_CHARS = 600;

/** A canned response as this module needs it — the composer's own list row. */
export type CannedOptionForRequest = {
  id: string;
  title: string;
  folder: string | null;
  bodyTextAr: string;
  bodyTextEn: string;
};

/**
 * Who wrote a message, in words a model reads without a legend.
 *
 * `automatic_message` is an outbound reply with no author: an automation rule's
 * canned reply or the out-of-hours acknowledgement. Calling those
 * `support_agent` would tell Jev a person had already answered — and an
 * acknowledgement is precisely the message that has *not* answered anything.
 */
export type HistoryAuthor = 'customer' | 'support_agent' | 'automatic_message';

export type HistoryMessage = {
  from: HistoryAuthor;
  text: string;
  /** How many files came with it; a photo with no caption is still a message. */
  attachments: number;
};

export type SuggestionContext = {
  channel: string;
  /** A public reply under a Facebook or Instagram comment, where everyone can read it. */
  isPublicComment: boolean;
  /** Only for channels that reply by email, where the subject often carries the question. */
  emailSubject: string | null;
};

/**
 * The instruction the model judges against.
 *
 * Written out rather than assembled, like the categoriser's, because each clause
 * answers something real: the language sentence because most of this traffic is
 * Egyptian Arabic and a fair share Franco-Arabic; the English sentence because
 * the criteria are shown in English while the reply will go out in Arabic, and
 * a model not told that might mark every option a poor fit for an Arabic
 * customer; and the last sentence because `none` is the answer to "ok thanks"
 * and to a question no saved reply covers, and a model given no way out names
 * something.
 */
const INSTRUCTIONS = [
  'This is a conversation between a customer and the support team of ShipBlu, a',
  'parcel delivery company in Egypt. The customer is either a merchant who ships',
  'parcels or a recipient expecting one. A support agent is about to write the',
  "team's next reply.",
  "Each option is one of the team's saved replies: its folder and title, then its",
  'text. Which saved reply would the agent send next, as it stands or with small',
  'edits? Judge by the most recent messages; earlier ones are context.',
  'Messages are usually in Egyptian Arabic, sometimes in English, and sometimes in',
  'Franco-Arabic — Arabic written in Latin letters and digits. The saved replies',
  "are shown in English but are sent in the customer's language.",
  `Choose ${NONE_KEY} when none of them answers what the customer needs now, or`,
  'when the last message needs no reply; that is a real answer, not a last resort.',
].join(' ');

const NONE_CRITERION =
  'No saved reply fits what the customer needs now; the agent should write this reply themselves.';

/** Cut on a word boundary where there is one near the end, and say so with an ellipsis. */
function cut(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max);
  const space = head.search(/\s\S*$/);
  return `${space > max * 0.6 ? head.slice(0, space) : head}…`;
}

/**
 * The body Jev judges a response by: the English, or the Arabic where there is
 * no English.
 *
 * English because the library is translation pairs, so the meaning is the same
 * either way; English tokenises cheaper; and the criteria then stay identical
 * from one conversation to the next, which keeps requests comparable. The
 * categoriser already pairs English criteria with Arabic messages.
 */
function judgedBody(option: CannedOptionForRequest): string {
  const bodies: BilingualBody = { ar: option.bodyTextAr, en: option.bodyTextEn };
  const locale = resolveLocale(bodies, 'en');
  return locale ? bodies[locale] : '';
}

/**
 * The option keys: `r1`, `r2`, … in the order the agent's list is in.
 *
 * Positional rather than the canned response's uuid. Sixty-odd uuids would ride
 * along twice — in the criteria and back in the answer's distribution — for
 * nothing, and a key that means a different response in every request is fine
 * as long as nothing stores it: `keyToId` translates back before anything is
 * written, and the row keeps `offered_ids` in key order.
 */
function keyFor(index: number): string {
  return `r${index + 1}`;
}

export type SuggestionQuestion = {
  question: ChoiceQuestion;
  /** `rN` → canned response id. `none` is deliberately absent: it is not a response. */
  keyToId: Record<string, string>;
};

/**
 * The question, checked against the one limit that can invalidate it.
 *
 * The ceiling is one lower than TypeSafe's, because `none` takes a slot. Past it
 * this refuses rather than trimming the list to the most-used responses: a
 * suggester that silently stopped offering a third of the library would change
 * what the report measures without anybody seeing it change.
 */
export function suggestionQuestion(options: readonly CannedOptionForRequest[]): SuggestionQuestion {
  if (options.length === 0) {
    throw new TypeSafeApiError('No canned responses to offer', null, false);
  }
  if (options.length > MAX_CHOICE_OPTIONS - 1) {
    throw new TypeSafeApiError(
      `This agent can see ${options.length} canned responses, past the ${MAX_CHOICE_OPTIONS - 1} one question can offer beside "${NONE_KEY}"`,
      null,
      false,
    );
  }

  const criteria: Record<string, string> = {};
  const keyToId: Record<string, string> = {};
  options.forEach((option, index) => {
    const key = keyFor(index);
    const where = option.folder ? `${option.folder} › ${option.title}` : option.title;
    criteria[key] = `${where}: ${cut(judgedBody(option), MAX_BODY_CHARS)}`;
    keyToId[key] = option.id;
  });
  criteria[NONE_KEY] = NONE_CRITERION;

  return { question: { type: 'choice', instructions: INSTRUCTIONS, criteria }, keyToId };
}

/**
 * The `state` the question is asked about: the conversation, as an object.
 *
 * Not flattened into prose, for the categoriser's reason — the model must be able
 * to tell where one message ends and who wrote the next. Oldest first, so the
 * last element is the message being answered, which is how a person reads a
 * thread too.
 *
 * A message with neither text nor a file says nothing and is left out. One with
 * only a file stays, with an empty text: "the customer sent a photo" is often
 * exactly what the next reply is about.
 */
export function stateFor(
  history: readonly HistoryMessage[],
  context: SuggestionContext,
): Record<string, unknown> {
  const messages = history
    .filter((message) => message.text.trim() || message.attachments > 0)
    .slice(-HISTORY_LIMIT)
    .map((message) => ({
      from: message.from,
      text: cut(message.text, MAX_MESSAGE_CHARS),
      ...(message.attachments > 0 ? { attachments: message.attachments } : {}),
    }));

  return {
    channel: context.channel,
    ...(context.isPublicComment ? { reply_is_public_comment: true } : {}),
    ...(context.emailSubject?.trim() ? { email_subject: cut(context.emailSubject, 200) } : {}),
    messages_oldest_first: messages,
  };
}

/** The whole body, so one function owns everything that goes over the wire. */
export function suggestionRequest(
  history: readonly HistoryMessage[],
  context: SuggestionContext,
  options: readonly CannedOptionForRequest[],
  model: string,
): { request: SystemOneRequest; keyToId: Record<string, string> } {
  const { question, keyToId } = suggestionQuestion(options);
  return {
    request: {
      state: stateFor(history, context),
      model,
      questions: { [SUGGESTION_QUESTION]: question },
    },
    keyToId,
  };
}
