import { describe, expect, it } from 'vitest';
import { STARTER_CATEGORIES } from '@/lib/categories/registry';
import { MAX_CHOICE_OPTIONS } from '@/lib/typesafe/client';
import {
  CATEGORY_QUESTION,
  categoryQuestion,
  categoryRequest,
  categoryState,
  questionFingerprint,
  requestFingerprint,
  type CategoryOption,
} from './request';

/**
 * The category question as it goes over the wire. A `choice` question keyed
 * wrongly does not fail — it answers over a vocabulary nobody meant — and the
 * fingerprint is what keeps a report from averaging two questions, so both are
 * pinned.
 */

const STARTERS: CategoryOption[] = STARTER_CATEGORIES.map((category, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  key: category.key,
  labelEn: category.labelEn,
  description: category.description,
}));

const message = {
  channel: 'facebook_comment',
  bodyText: 'بكام الشحن للقاهرة؟',
  earlier: ['السلام عليكم'],
  isPublicComment: true,
};

describe('categoryQuestion', () => {
  it('offers the active keys in the order given, and unknown last', () => {
    const { question, keyToId, offered } = categoryQuestion(STARTERS);
    expect(Object.keys(question.criteria)).toEqual([
      'sales',
      'customer_support',
      'merchant_support',
      'courier_jobs',
      'unknown',
    ]);
    expect(Object.keys(keyToId)).toEqual([
      'sales',
      'customer_support',
      'merchant_support',
      'courier_jobs',
    ]);
    expect(keyToId.sales).toBe(STARTERS[0]!.id);
    expect([...offered]).toEqual(Object.keys(question.criteria));
  });

  it('judges a category by its label and description, or its label alone', () => {
    const { question } = categoryQuestion([
      { id: STARTERS[0]!.id, key: 'sales', labelEn: 'Sales', description: 'Prices and rates.' },
      { id: STARTERS[1]!.id, key: 'courier_jobs', labelEn: 'Courier jobs', description: '  ' },
    ]);
    expect(question.criteria.sales).toBe('Sales — Prices and rates.');
    expect(question.criteria.courier_jobs).toBe('Courier jobs');
  });

  it('names unknown and the public-comment flag in the instructions', () => {
    const { question } = categoryQuestion(STARTERS);
    expect(question.instructions).toMatch(/Choose unknown when the message is only a greeting/);
    expect(question.instructions).toMatch(/is_public_comment is true when/);
    // Not priority's opening, which is false for two of the four teams.
    expect(question.instructions).not.toMatch(/merchant who ships parcels or a recipient/);
  });

  // `unknown` is reserved three times; this is the third.
  it('refuses an empty registry, a category named unknown, and one too many', () => {
    expect(() => categoryQuestion([])).toThrow(/No active categories/);
    expect(() => categoryQuestion([{ ...STARTERS[0]!, key: 'unknown' }])).toThrow(
      /keyed "unknown"/,
    );

    const many = (n: number): CategoryOption[] =>
      Array.from({ length: n }, (_, i) => ({
        id: STARTERS[0]!.id,
        key: `team_${String.fromCharCode(97 + (i % 26))}${'x'.repeat(Math.floor(i / 26))}`,
        labelEn: `Team ${i}`,
        description: null,
      }));
    expect(() => categoryQuestion(many(MAX_CHOICE_OPTIONS - 1))).not.toThrow();
    expect(() => categoryQuestion(many(MAX_CHOICE_OPTIONS))).toThrow(/past the 254/);
  });
});

describe('categoryState', () => {
  it('sends a comment as its platform, and says it is a public comment', () => {
    expect(categoryState(message, true)).toEqual({
      channel: 'facebook',
      message: message.bodyText,
      earlier_messages_from_the_same_customer: message.earlier,
      is_public_comment: true,
    });
  });

  it('says false on a private message, and drops the earlier messages without context', () => {
    expect(
      categoryState({ ...message, channel: 'whatsapp', isPublicComment: false }, false),
    ).toEqual({ channel: 'whatsapp', message: message.bodyText, is_public_comment: false });
  });

  // Bump `STATE_VERSION` in `request.ts` when this list changes: the
  // fingerprint carries it, and two state shapes must not share one.
  it('has the field list STATE_VERSION 1 names', () => {
    expect(Object.keys(categoryState(message, true))).toEqual([
      'channel',
      'message',
      'earlier_messages_from_the_same_customer',
      'is_public_comment',
    ]);
  });
});

describe('categoryRequest', () => {
  // Typed out, not built by calling the code, for the reason priority's pin
  // gives: the question is what every shadow row measures.
  it('sends exactly these bytes for the starter categories', () => {
    const { request } = categoryRequest(message, STARTERS, 'jev-latest', true);
    expect(JSON.stringify(request)).toBe(
      JSON.stringify({
        state: {
          channel: 'facebook',
          message: 'بكام الشحن للقاهرة؟',
          earlier_messages_from_the_same_customer: ['السلام عليكم'],
          is_public_comment: true,
        },
        model: 'jev-latest',
        questions: {
          ticket_category: {
            type: 'choice',
            instructions:
              'This is a message sent to ShipBlu, a parcel delivery company in Egypt. Which team should handle it? Each option is a team, described by the requests it handles. Judge what the message asks for, not who seems to be writing it. is_public_comment is true when the message is a comment under one of ShipBlu’s public posts rather than a private message. Messages are usually in Egyptian Arabic, sometimes in English, and sometimes in Franco-Arabic — Arabic written in Latin letters and digits. Choose unknown when the message is only a greeting, thanks or an acknowledgement, is too short or vague to tell what it asks for, or is not about ShipBlu’s services at all; that is a real answer, not a last resort.',
            criteria: {
              sales:
                'Sales — Asking to start shipping with ShipBlu: prices and rates, how to sign up or open an account, which areas are covered, how pickup and cash collection would work, or asking to be called by the sales team. Not a question about an order that already exists.',
              customer_support:
                'Customer support — About a parcel on its way to the person writing: where it is, when it will arrive, rescheduling the delivery, changing the address or phone number, a courier who did not call or come, refusing the parcel, or the amount to pay on delivery.',
              merchant_support:
                'Merchant support — About a shipping account that already exists and the orders sent from it: creating orders, pickups, cash-on-delivery transfers and payouts, invoices and fees, parcels returned to the sender, the dashboard, and store or API integrations.',
              courier_jobs:
                'Courier jobs — A courier, driver or delivery company asking to work with or for ShipBlu: joining as a courier, delivery jobs, or supplying drivers or vehicles. Only when the message names delivery or courier work — a greeting, or "I want a job" that names no delivery work, is not this category.',
              unknown:
                'None of these teams: a greeting, thanks or an acknowledgement on its own, a message too short or vague to tell what it asks for, or anything not about ShipBlu’s services.',
            },
          },
        },
      }),
    );
  });

  it('files one question under the name the answer is read back by', () => {
    const { request } = categoryRequest(message, STARTERS, 'jev-latest', true);
    expect(Object.keys(request.questions)).toEqual([CATEGORY_QUESTION]);
    expect(CATEGORY_QUESTION).toBe('ticket_category');
  });
});

describe('requestFingerprint', () => {
  const fingerprint = (options: CategoryOption[], over: Partial<typeof message> = {}) =>
    categoryRequest({ ...message, ...over }, options, 'jev-latest', true).fingerprint;

  it('names the state version and is stable for the same question', () => {
    expect(fingerprint(STARTERS)).toMatch(/^s1-[0-9a-f]{16}$/);
    expect(fingerprint(STARTERS)).toBe(fingerprint(STARTERS));
  });

  // What an admin can change on /admin/categories is the question itself.
  it('changes with a label, a description, the order or a retired category', () => {
    const base = fingerprint(STARTERS);
    expect(
      fingerprint([{ ...STARTERS[0]!, labelEn: 'New business' }, ...STARTERS.slice(1)]),
    ).not.toBe(base);
    expect(
      fingerprint([{ ...STARTERS[0]!, description: 'Prices.' }, ...STARTERS.slice(1)]),
    ).not.toBe(base);
    expect(fingerprint([STARTERS[1]!, STARTERS[0]!, ...STARTERS.slice(2)])).not.toBe(base);
    expect(fingerprint(STARTERS.slice(0, 3))).not.toBe(base);
  });

  // Those have columns of their own, or are the message being asked about.
  it('does not change with the message, its context, the model or the comment flag', () => {
    const base = fingerprint(STARTERS);
    expect(
      fingerprint(STARTERS, { bodyText: 'فين الشحنة', earlier: [], isPublicComment: false }),
    ).toBe(base);
    expect(categoryRequest(message, STARTERS, 'jev-1.13.0', false).fingerprint).toBe(base);
  });

  it('hashes the questions object as sent', () => {
    const { request, fingerprint: built } = categoryRequest(message, STARTERS, 'jev-latest', true);
    expect(requestFingerprint(request.questions)).toBe(built);
    expect(questionFingerprint(STARTERS)).toBe(built);
  });
});
