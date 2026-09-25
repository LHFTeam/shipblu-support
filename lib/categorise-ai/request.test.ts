import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH } from '@/lib/categorise/normalise';
import { UNCLASSIFIED_KEY } from '@/lib/categorise/taxonomy';
import { MAX_CHOICE_OPTIONS } from '@/lib/typesafe/client';
import {
  CATEGORY_QUESTION,
  categorisationRequest,
  categoryCriteria,
  categoryQuestion,
  stateFor,
  type CategoryOption,
} from './request';

/**
 * The half of this module that goes over the wire.
 *
 * The same argument `lib/meta/send.ts` makes about Graph applies here for a
 * different reason: a `choice` question with the wrong `criteria` does not fail,
 * it answers — over a vocabulary nobody meant — and the answer is shaped exactly
 * like a right one. Nothing downstream can tell the difference, so the shape is
 * asserted here.
 */

const OPTIONS: CategoryOption[] = [
  {
    key: 'delivery.where_is_it',
    labelEn: 'Where is my parcel',
    description: 'Asking where a parcel is, with no complaint about timing',
  },
  { key: 'delivery.late', labelEn: 'Late delivery', description: 'Past the promised date' },
  { key: UNCLASSIFIED_KEY, labelEn: 'Unclassified', description: null },
];

describe('categoryCriteria', () => {
  it('keys on the registry key and describes with the label and the description', () => {
    expect(categoryCriteria(OPTIONS)).toEqual({
      'delivery.where_is_it':
        'Where is my parcel — Asking where a parcel is, with no complaint about timing',
      'delivery.late': 'Late delivery — Past the promised date',
      [UNCLASSIFIED_KEY]: 'Unclassified',
    });
  });

  it('carries the description, because the labels alone do not discriminate', () => {
    // "late" and "where is it" are near-synonyms read as labels, and they are
    // separate rows in every report drawn off this.
    const criteria = categoryCriteria(OPTIONS);
    expect(criteria['delivery.late']).toContain('Past the promised date');
    expect(criteria['delivery.where_is_it']).toContain('no complaint about timing');
  });
});

describe('categoryQuestion', () => {
  it('asks one choice over the keys it was given', () => {
    const question = categoryQuestion(OPTIONS);
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria)).toEqual([
      'delivery.where_is_it',
      'delivery.late',
      UNCLASSIFIED_KEY,
    ]);
  });

  it('offers the escape, and names it in the instructions', () => {
    // Given no way out, a model asked about "؟" will name something — and a
    // forced guess is the over-detection this taxonomy's own plan warns about.
    const question = categoryQuestion(OPTIONS);
    expect(question.criteria[UNCLASSIFIED_KEY]).toBeDefined();
    expect(question.instructions).toContain(UNCLASSIFIED_KEY);
  });

  it('tells the model which languages it is reading', () => {
    // The corpus is majority Egyptian Arabic with Franco-Arabic a large minority.
    const { instructions } = categoryQuestion(OPTIONS);
    expect(instructions).toMatch(/Arabic/);
    expect(instructions).toMatch(/Franco-Arabic/);
  });

  it('refuses an empty registry rather than asking an unanswerable question', () => {
    expect(() => categoryQuestion([])).toThrow(/No active categories/);
  });

  it('refuses a taxonomy past the provider limit, by name', () => {
    // 55 categories today against a documented ceiling of 255. The day the
    // taxonomy passes it, this must fail here and not as a 422 in a worker log.
    const many = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => ({
      key: `area.key_${i}`,
      labelEn: `Label ${i}`,
      description: null,
    }));
    expect(() => categoryQuestion(many)).toThrow(/255-option limit/);
  });
});

describe('stateFor', () => {
  const message = {
    channel: 'facebook',
    bodyText: 'الشحنة فين بقى',
    earlier: ['السلام عليكم', 'عندي مشكلة'],
  };

  it('keeps the message the subject, and the channel beside it', () => {
    expect(stateFor(message, false)).toEqual({
      channel: 'facebook',
      message: 'الشحنة فين بقى',
    });
  });

  it('leaves Arabic exactly as it arrived', () => {
    // The opposite of the rules path, which folds text before matching. Folding
    // here would hand the model a string no human wrote.
    expect(stateFor(message, false).message).toBe('الشحنة فين بقى');
  });

  it('adds earlier messages only when asked, and keeps them separate', () => {
    const state = stateFor(message, true);
    expect(state.earlier_messages_from_the_same_customer).toEqual(['السلام عليكم', 'عندي مشكلة']);
    // Still distinguishable from the message being classified.
    expect(state.message).toBe('الشحنة فين بقى');
  });

  it('omits the context field entirely when there is none', () => {
    const state = stateFor({ channel: 'email', bodyText: 'hello', earlier: [] }, true);
    expect(state).not.toHaveProperty('earlier_messages_from_the_same_customer');
  });

  it('truncates at the cutoff the rules detector uses', () => {
    // Neither detector may be judged on text the other never saw.
    const long = 'ا'.repeat(MAX_TEXT_LENGTH + 500);
    const state = stateFor({ channel: 'email', bodyText: long }, false);
    expect(String(state.message)).toHaveLength(MAX_TEXT_LENGTH);
  });
});

describe('categorisationRequest', () => {
  it('files the question under the name the reader looks it up by', () => {
    const request = categorisationRequest(
      { channel: 'webchat', bodyText: 'where is my order' },
      OPTIONS,
      'jev-latest',
      false,
    );

    expect(Object.keys(request.questions)).toEqual([CATEGORY_QUESTION]);
    expect(request.model).toBe('jev-latest');
    expect(request.state).toEqual({ channel: 'webchat', message: 'where is my order' });
  });
});
