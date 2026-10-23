import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH } from '@/lib/subcategorise/normalise';
import { UNCLASSIFIED_KEY } from '@/lib/subcategorise/taxonomy';
import { MAX_CHOICE_OPTIONS } from '@/lib/typesafe/client';
import {
  SUBCATEGORY_QUESTION,
  subcategorisationRequest,
  subcategoryCriteria,
  subcategoryQuestion,
  stateFor,
  type SubcategoryOption,
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

const OPTIONS: SubcategoryOption[] = [
  {
    key: 'delivery.where_is_it',
    labelEn: 'Where is my parcel',
    description: 'Asking where a parcel is, with no complaint about timing',
  },
  { key: 'delivery.late', labelEn: 'Late delivery', description: 'Past the promised date' },
  { key: UNCLASSIFIED_KEY, labelEn: 'Unclassified', description: null },
];

describe('subcategoryCriteria', () => {
  it('keys on the registry key and describes with the label and the description', () => {
    expect(subcategoryCriteria(OPTIONS)).toEqual({
      'delivery.where_is_it':
        'Where is my parcel — Asking where a parcel is, with no complaint about timing',
      'delivery.late': 'Late delivery — Past the promised date',
      [UNCLASSIFIED_KEY]: 'Unclassified',
    });
  });

  it('carries the description, because the labels alone do not discriminate', () => {
    // "late" and "where is it" are near-synonyms read as labels, and they are
    // separate rows in every report drawn off this.
    const criteria = subcategoryCriteria(OPTIONS);
    expect(criteria['delivery.late']).toContain('Past the promised date');
    expect(criteria['delivery.where_is_it']).toContain('no complaint about timing');
  });
});

describe('subcategoryQuestion', () => {
  it('asks one choice over the keys it was given', () => {
    const question = subcategoryQuestion(OPTIONS);
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
    const question = subcategoryQuestion(OPTIONS);
    expect(question.criteria[UNCLASSIFIED_KEY]).toBeDefined();
    expect(question.instructions).toContain(UNCLASSIFIED_KEY);
  });

  it('tells the model which languages it is reading', () => {
    // The corpus is majority Egyptian Arabic with Franco-Arabic a large minority.
    const { instructions } = subcategoryQuestion(OPTIONS);
    expect(instructions).toMatch(/Arabic/);
    expect(instructions).toMatch(/Franco-Arabic/);
  });

  it('refuses an empty registry rather than asking an unanswerable question', () => {
    expect(() => subcategoryQuestion([])).toThrow(/No active subcategories/);
  });

  it('refuses a taxonomy past the provider limit, by name', () => {
    // 55 subcategories today against a documented ceiling of 255. The day the
    // taxonomy passes it, this must fail here and not as a 422 in a worker log.
    const many = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => ({
      key: `area.key_${i}`,
      labelEn: `Label ${i}`,
      description: null,
    }));
    expect(() => subcategoryQuestion(many)).toThrow(/255-option limit/);
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

  // The request a comment ticket sent before comments had channels of their
  // own, byte for byte: the priority request is built here too, and its bytes
  // must not move because the ticket's channel did.
  it('names a comment channel by its platform, so the request does not change', () => {
    for (const [channel, platform] of [
      ['facebook_comment', 'facebook'],
      ['instagram_comment', 'instagram'],
    ] as const) {
      expect(JSON.stringify(stateFor({ ...message, channel }, true))).toBe(
        JSON.stringify(stateFor({ ...message, channel: platform }, true)),
      );
    }
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

describe('subcategorisationRequest', () => {
  it('files the question under the name the reader looks it up by', () => {
    const request = subcategorisationRequest(
      { channel: 'webchat', bodyText: 'where is my order' },
      OPTIONS,
      'jev-latest',
      false,
    );

    expect(Object.keys(request.questions)).toEqual([SUBCATEGORY_QUESTION]);
    expect(request.model).toBe('jev-latest');
    expect(request.state).toEqual({ channel: 'webchat', message: 'where is my order' });
  });

  // Stage 2.A renamed the taxonomy in every place a person reads it and in none
  // that goes over the wire. A shadow run is comparable with an earlier one only
  // when the two sent the same bytes, so the question's name and its
  // instructions keep the word they were first asked in, and the body is pinned
  // here as it was sent before the rename.
  it('sends the same bytes it sent before the rename', () => {
    expect(SUBCATEGORY_QUESTION).toBe('category');

    const request = subcategorisationRequest(
      { channel: 'facebook_comment', bodyText: 'الشحنة فين', earlier: ['السلام عليكم'] },
      OPTIONS,
      'jev-latest',
      true,
    );

    expect(JSON.stringify(request)).toBe(
      JSON.stringify({
        state: {
          channel: 'facebook',
          message: 'الشحنة فين',
          earlier_messages_from_the_same_customer: ['السلام عليكم'],
        },
        model: 'jev-latest',
        questions: {
          category: {
            type: 'choice',
            instructions:
              'This is a message a customer sent to the support team of ShipBlu, a parcel ' +
              'delivery company in Egypt. The sender is either a merchant who ships parcels ' +
              'or a recipient expecting one. ' +
              'Which single category best describes what this message is about? ' +
              'Messages are usually in Egyptian Arabic, sometimes in English, and sometimes ' +
              'in Franco-Arabic — Arabic written in Latin letters and digits. ' +
              'Choose meta.unclassified when the message is too short, too vague or too ' +
              'incomplete to tell what it is about; that is a real answer, not a last resort.',
            criteria: {
              'delivery.where_is_it':
                'Where is my parcel — Asking where a parcel is, with no complaint about timing',
              'delivery.late': 'Late delivery — Past the promised date',
              'meta.unclassified': 'Unclassified',
            },
          },
        },
      }),
    );
  });
});
