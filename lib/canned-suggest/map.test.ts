import { describe, expect, it } from 'vitest';
import { TypeSafeApiError } from '@/lib/typesafe/client';
import { suggestionFrom } from './map';
import { NONE_KEY } from './request';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const KEYS = { r1: A, r2: B };

describe('suggestionFrom', () => {
  it('translates the positional key back into the canned response it stood for', () => {
    const suggestion = suggestionFrom(
      { choice: 'r2', probabilities: { r1: 0.1, r2: 0.8, [NONE_KEY]: 0.1 }, confidence: 0.7 },
      KEYS,
    );
    expect(suggestion).toEqual({
      choice: B,
      cannedResponseId: B,
      probability: 0.8,
      confidence: 0.7,
      // Never stored by `rN`, which means a different response in every request.
      probabilities: { [A]: 0.1, [B]: 0.8, [NONE_KEY]: 0.1 },
    });
  });

  it('reads none as no suggestion, and keeps it as the choice', () => {
    const suggestion = suggestionFrom(
      { choice: NONE_KEY, probabilities: { [NONE_KEY]: 0.9 }, confidence: null },
      KEYS,
    );
    expect(suggestion.choice).toBe(NONE_KEY);
    expect(suggestion.cannedResponseId).toBeNull();
    expect(suggestion.probability).toBe(0.9);
  });

  it('refuses, permanently, a choice that was never offered', () => {
    let error: unknown;
    try {
      suggestionFrom({ choice: 'r9', probabilities: {}, confidence: null }, KEYS);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeSafeApiError);
    expect((error as TypeSafeApiError).isTransient).toBe(false);
  });

  it('records a missing distribution as empty and a missing share as null', () => {
    const suggestion = suggestionFrom({ choice: 'r1', probabilities: {}, confidence: null }, KEYS);
    expect(suggestion.probabilities).toEqual({});
    expect(suggestion.probability).toBeNull();
  });

  it('drops a share for a key nobody offered rather than failing over it', () => {
    const suggestion = suggestionFrom(
      { choice: 'r1', probabilities: { r1: 0.6, r7: 0.4 }, confidence: null },
      KEYS,
    );
    expect(suggestion.probabilities).toEqual({ [A]: 0.6 });
  });
});
