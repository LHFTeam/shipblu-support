import { describe, expect, it } from 'vitest';
import { MAX_CHOICE_OPTIONS, TypeSafeApiError } from '@/lib/typesafe/client';
import {
  HISTORY_LIMIT,
  MAX_BODY_CHARS,
  MAX_MESSAGE_CHARS,
  NONE_KEY,
  SUGGESTION_QUESTION,
  stateFor,
  suggestionQuestion,
  suggestionRequest,
  type CannedOptionForRequest,
  type HistoryMessage,
  type SuggestionContext,
} from './request';

/**
 * The half of the suggester that goes over the wire. A `choice` question keyed
 * wrongly does not fail — it answers, over options nobody meant — so its shape
 * is asserted here rather than discovered in a report.
 */

const WHERE: CannedOptionForRequest = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Where is my parcel',
  folder: 'Delivery',
  bodyTextAr: 'حضرتك الشحنة في الطريق',
  bodyTextEn: 'Your parcel is on its way.',
};
const ARABIC_ONLY: CannedOptionForRequest = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Greeting',
  folder: null,
  bodyTextAr: 'أهلاً بحضرتك',
  bodyTextEn: '',
};

const CONTEXT: SuggestionContext = {
  channel: 'facebook',
  isPublicComment: false,
  emailSubject: null,
};

function said(from: HistoryMessage['from'], text: string, attachments = 0): HistoryMessage {
  return { from, text, attachments };
}

describe('suggestionQuestion', () => {
  it('keys the options r1…rN in list order and maps each key back to its id', () => {
    const { question, keyToId } = suggestionQuestion([WHERE, ARABIC_ONLY]);
    expect(Object.keys(question.criteria)).toEqual(['r1', 'r2', NONE_KEY]);
    expect(keyToId).toEqual({ r1: WHERE.id, r2: ARABIC_ONLY.id });
  });

  // The categoriser's `meta.unclassified` was offered only because a registry
  // row happened to be active. This one is added in code, every time.
  it('always offers none, and names it in the instructions', () => {
    const { question, keyToId } = suggestionQuestion([WHERE]);
    expect(question.criteria[NONE_KEY]).toMatch(/No saved reply fits/);
    expect(question.instructions).toContain(`Choose ${NONE_KEY}`);
    expect(keyToId).not.toHaveProperty(NONE_KEY);
  });

  it('describes a response by its folder, title and English text', () => {
    const { question } = suggestionQuestion([WHERE]);
    expect(question.criteria.r1).toBe('Delivery › Where is my parcel: Your parcel is on its way.');
  });

  it('falls back to the Arabic when there is no English, and leaves out a missing folder', () => {
    const { question } = suggestionQuestion([ARABIC_ONLY]);
    expect(question.criteria.r1).toBe('Greeting: أهلاً بحضرتك');
  });

  it('cuts a long body on a word boundary and says so', () => {
    const long = { ...WHERE, bodyTextEn: 'word '.repeat(400) };
    const { question } = suggestionQuestion([long]);
    const body = question.criteria.r1!.split(': ')[1]!;
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 1);
    expect(body.endsWith('word…')).toBe(true);
  });

  it('refuses an empty list rather than asking a question with only a way out', () => {
    expect(() => suggestionQuestion([])).toThrow(TypeSafeApiError);
  });

  // `none` takes a slot, so the ceiling for responses is one under TypeSafe's.
  it('fits one fewer response than the option ceiling, and refuses one more', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...WHERE,
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      }));

    expect(
      Object.keys(suggestionQuestion(many(MAX_CHOICE_OPTIONS - 1)).question.criteria),
    ).toHaveLength(MAX_CHOICE_OPTIONS);

    let error: unknown;
    try {
      suggestionQuestion(many(MAX_CHOICE_OPTIONS));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeSafeApiError);
    expect((error as TypeSafeApiError).isTransient).toBe(false);
  });
});

describe('stateFor', () => {
  it('labels who wrote each message and keeps them oldest first', () => {
    const state = stateFor(
      [
        said('customer', 'فين الشحنة'),
        said('automatic_message', 'We received your message'),
        said('support_agent', 'Let me check'),
        said('customer', 'ok?'),
      ],
      CONTEXT,
    );
    expect(state).toEqual({
      channel: 'facebook',
      messages_oldest_first: [
        { from: 'customer', text: 'فين الشحنة' },
        { from: 'automatic_message', text: 'We received your message' },
        { from: 'support_agent', text: 'Let me check' },
        { from: 'customer', text: 'ok?' },
      ],
    });
  });

  it('keeps the newest messages when there are more than the limit', () => {
    const history = Array.from({ length: HISTORY_LIMIT + 3 }, (_, i) => said('customer', `m${i}`));
    const messages = stateFor(history, CONTEXT).messages_oldest_first as { text: string }[];
    expect(messages).toHaveLength(HISTORY_LIMIT);
    expect(messages.at(-1)?.text).toBe(`m${HISTORY_LIMIT + 2}`);
    expect(messages[0]?.text).toBe('m3');
  });

  it('keeps a message that is only a file, and drops one that is nothing', () => {
    const messages = stateFor(
      [said('customer', '', 1), said('customer', '   '), said('customer', 'this one')],
      CONTEXT,
    ).messages_oldest_first;
    expect(messages).toEqual([
      { from: 'customer', text: '', attachments: 1 },
      { from: 'customer', text: 'this one' },
    ]);
  });

  it('cuts a long message', () => {
    const [message] = stateFor([said('customer', 'x'.repeat(5000))], CONTEXT)
      .messages_oldest_first as { text: string }[];
    expect(message!.text.length).toBe(MAX_MESSAGE_CHARS + 1);
  });

  it('says when the reply will be public, and carries an email subject only when given one', () => {
    expect(stateFor([said('customer', 'hi')], { ...CONTEXT, isPublicComment: true })).toMatchObject(
      {
        reply_is_public_comment: true,
      },
    );
    expect(stateFor([said('customer', 'hi')], CONTEXT)).not.toHaveProperty('email_subject');
    expect(
      stateFor([said('customer', 'hi')], {
        channel: 'email',
        isPublicComment: false,
        emailSubject: 'COD missing',
      }),
    ).toMatchObject({ email_subject: 'COD missing' });
  });
});

describe('suggestionRequest', () => {
  it('files the one question under its name, with the model asked for', () => {
    const { request, keyToId } = suggestionRequest(
      [said('customer', 'hi')],
      CONTEXT,
      [WHERE],
      'jev-latest',
    );
    expect(request.model).toBe('jev-latest');
    expect(Object.keys(request.questions)).toEqual([SUGGESTION_QUESTION]);
    expect(keyToId).toEqual({ r1: WHERE.id });
  });
});
