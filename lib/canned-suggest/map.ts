import { TypeSafeApiError, type ChoiceAnswer } from '@/lib/typesafe/client';
import { NONE_KEY } from './request';

/**
 * Reading Jev's answer back into canned response ids, and refusing one this
 * system did not ask for.
 *
 * Pure, and worth its test for the categoriser's reason: the request keyed its
 * options `r1…rN`, and those keys mean a different response in every request.
 * Everything downstream stores ids, so the translation has to happen once,
 * here, before anything is written — a positional key reaching a row would be
 * a pointer to whichever response happened to sit in that slot that day.
 */

export type Suggestion = {
  /** A canned response's id, or `none`. Never a positional key. */
  choice: string;
  /** The suggested response, or null when Jev said `none`. */
  cannedResponseId: string | null;
  /** The chosen option's own share. */
  probability: number | null;
  confidence: number | null;
  /** Every option's share, re-keyed by canned response id (and `none`). */
  probabilities: Record<string, number>;
};

/**
 * The answer, checked against the options it was offered and translated.
 *
 * TypeSafe's contract is that a choice is one of the criteria keys, so the throw
 * should never fire — which is why it is a check rather than an assumption. A
 * permanent failure: a key outside the offered set means the request and the
 * reader disagree about the vocabulary, and asking again settles nothing.
 *
 * A share for a key the request did not offer is dropped rather than refused.
 * The choice is what gets acted on; the distribution is evidence kept for later,
 * and a stray entry in it is not worth failing the suggestion over.
 */
export function suggestionFrom(answer: ChoiceAnswer, keyToId: Record<string, string>): Suggestion {
  const isNone = answer.choice === NONE_KEY;
  const id = isNone ? null : (keyToId[answer.choice] ?? null);

  if (!isNone && !id) {
    throw new TypeSafeApiError(
      `TypeSafe chose "${answer.choice}", which was not one of the ${Object.keys(keyToId).length + 1} options offered`,
      null,
      false,
    );
  }

  const probabilities: Record<string, number> = {};
  for (const [key, share] of Object.entries(answer.probabilities)) {
    if (key === NONE_KEY) probabilities[NONE_KEY] = share;
    else if (keyToId[key]) probabilities[keyToId[key]] = share;
  }

  return {
    choice: id ?? NONE_KEY,
    cannedResponseId: id,
    probability: answer.probabilities[answer.choice] ?? null,
    confidence: answer.confidence,
    probabilities,
  };
}
