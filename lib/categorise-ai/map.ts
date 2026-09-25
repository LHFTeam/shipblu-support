import { TypeSafeApiError, type ChoiceAnswer } from '@/lib/typesafe/client';

/**
 * Reading TypeSafe's answer back, and refusing one this system did not ask for.
 *
 * Pure, and the half of this module most worth a test: everything downstream
 * stores what comes out of here as a category key, and a key that never existed
 * would be written to a text column that nothing validates. `conversation_categories`
 * has a foreign key standing behind its `category_key`; the shadow table does not,
 * because it records what a model said rather than what the system believes, and
 * a prediction constrained by a foreign key could not record a wrong one at all.
 * That check has to live here instead.
 */

export type AiPrediction = {
  /** One of the keys the request offered. Never anything else — see `predictionFrom`. */
  key: string;
  /**
   * The chosen option's own share of the distribution.
   *
   * Kept separately from `confidence` because they answer different questions and
   * a report will want both: this is how much the model liked the winner, and
   * confidence is how concentrated the distribution was overall.
   */
  probability: number | null;
  confidence: number | null;
  /**
   * Every option's share.
   *
   * Stored whole rather than as a top-N, because the entire point of a shadow run
   * is to sweep a threshold afterwards without paying for the corpus twice. A
   * truncated distribution cannot answer "what would auto-apply at 0.8 have
   * done", which is the question this exists to answer.
   */
  probabilities: Record<string, number>;
};

/**
 * The answer, checked against the options it was offered.
 *
 * TypeSafe's contract is that a `choice` answer is one of the `criteria` keys, so
 * this should never fire — which is exactly why it is here rather than assumed.
 * A permanent failure, not a transient one: a key outside the offered set means
 * the request and the reader disagree about the vocabulary, and no retry settles
 * that.
 */
export function predictionFrom(answer: ChoiceAnswer, offered: ReadonlySet<string>): AiPrediction {
  if (!offered.has(answer.choice)) {
    throw new TypeSafeApiError(
      `TypeSafe chose "${answer.choice}", which was not one of the ${offered.size} categories offered`,
      null,
      false,
    );
  }

  return {
    key: answer.choice,
    probability: answer.probabilities[answer.choice] ?? null,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  };
}
