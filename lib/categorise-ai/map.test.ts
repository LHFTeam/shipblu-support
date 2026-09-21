import { describe, expect, it } from 'vitest';
import { TypeSafeApiError, type ChoiceAnswer } from '@/lib/typesafe/client';
import { predictionFrom } from './map';

/**
 * Reading the answer, and refusing one nobody asked for.
 *
 * `ai_category_runs.predicted_key` has no foreign key behind it — recording a
 * wrong prediction is the entire point of a shadow run — so this is the only
 * thing standing between a model's answer and a category key that never existed.
 */

const OFFERED = new Set(['delivery.where_is_it', 'delivery.late', 'meta.unclassified']);

function answer(partial: Partial<ChoiceAnswer>): ChoiceAnswer {
  return { choice: 'delivery.late', probabilities: {}, confidence: null, ...partial };
}

describe('predictionFrom', () => {
  it('reads the winner, its own share, and the whole distribution', () => {
    const prediction = predictionFrom(
      answer({
        choice: 'delivery.late',
        probabilities: { 'delivery.late': 0.74, 'delivery.where_is_it': 0.26 },
        confidence: 0.61,
      }),
      OFFERED,
    );

    expect(prediction).toEqual({
      key: 'delivery.late',
      probability: 0.74,
      confidence: 0.61,
      probabilities: { 'delivery.late': 0.74, 'delivery.where_is_it': 0.26 },
    });
  });

  it('keeps the whole distribution, not the winner alone', () => {
    // A threshold sweep after the fact reads this. Truncating it would mean
    // paying for the corpus again to ask where an auto-apply line should sit.
    const prediction = predictionFrom(
      answer({
        choice: 'delivery.late',
        probabilities: {
          'delivery.late': 0.4,
          'delivery.where_is_it': 0.35,
          'meta.unclassified': 0.25,
        },
      }),
      OFFERED,
    );
    expect(Object.keys(prediction.probabilities)).toHaveLength(3);
  });

  it('separates the winner from an unreported probability', () => {
    // No distribution is not a probability of zero, and storing it as one would
    // make an unreported answer indistinguishable from a rejected category.
    const prediction = predictionFrom(answer({ choice: 'delivery.late' }), OFFERED);
    expect(prediction.probability).toBeNull();
  });

  it('takes meta.unclassified as a real answer', () => {
    // An admission, not a failure — the row is written like any other.
    const prediction = predictionFrom(
      answer({ choice: 'meta.unclassified', probabilities: { 'meta.unclassified': 0.9 } }),
      OFFERED,
    );
    expect(prediction.key).toBe('meta.unclassified');
  });

  it('refuses a category that was never offered', () => {
    // Should never fire — TypeSafe answers with one of the criteria keys — which
    // is exactly why it is checked rather than assumed. Permanent, not transient:
    // the request and the reader disagree about the vocabulary.
    const thrown = () => predictionFrom(answer({ choice: 'delivery.invented' }), OFFERED);
    expect(thrown).toThrow(TypeSafeApiError);
    expect(thrown).toThrow(/not one of the 3 categories offered/);
    try {
      thrown();
    } catch (error) {
      expect((error as TypeSafeApiError).isTransient).toBe(false);
    }
  });
});
