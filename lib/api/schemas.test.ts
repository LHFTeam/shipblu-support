import { describe, expect, it } from 'vitest';
import { invalidBody } from './errors';
import {
  AnswerSurveyRequest,
  CreateSessionRequest,
  CreateTicketRequest,
  ErrorBody,
  ListMessagesQuery,
  SendMessageRequest,
} from './schemas';

/**
 * What a schema refuses that the document cannot say, or that the database
 * would otherwise refuse later, as a `500`. The document is
 * `openapi.test.ts`'s, which builds it from these schemas and holds the
 * published side of each rule — the `pattern` a generated client enforces; a
 * rule `z.toJSONSchema` drops, such as a refinement across two fields, is held
 * here, since the route parses with the schema and not with the document.
 */

const AFTER = 'MjAyNi0xMS0xMiAwOTo0MTowNy4wMDQyMTMrMDB8YQ';
const BEFORE = 'MjAyNi0xMS0xMiAwOToyOTo1OC4xMjMrMDB8Yg';

describe('ListMessagesQuery', () => {
  it('takes no cursor, or either one alone', () => {
    expect(ListMessagesQuery.parse({})).toEqual({ limit: 30 });
    expect(ListMessagesQuery.parse({ after: AFTER })).toEqual({ after: AFTER, limit: 30 });
    expect(ListMessagesQuery.parse({ before: BEFORE, limit: '50' })).toEqual({
      before: BEFORE,
      limit: 50,
    });
  });

  it('refuses `after` and `before` together, naming neither as the field to blame', () => {
    const result = ListMessagesQuery.safeParse({ after: AFTER, before: BEFORE });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: 'custom', path: [] })]);
  });
});

const mint = {
  externalUserId: 'u_1',
  phone: '+201001234567',
  name: 'Nour Adel',
  client: { platform: 'ios', appVersion: '5.4.1' },
};

describe('CreateSessionRequest', () => {
  // Postgres's `text` refuses U+0000 (22021): allowed through here, the mint
  // answered 500 for a value the plan says is a 400 naming the field.
  it.each([
    ['name', { ...mint, name: 'Mu\u0000Null' }],
    ['name', { ...mint, name: '\u0000' }],
    ['client.appVersion', { ...mint, client: { platform: 'ios', appVersion: '5.4\u0000' } }],
  ])('refuses U+0000 in %s, naming the field and not repeating the value', async (field, body) => {
    const parsed = CreateSessionRequest.safeParse(body);
    if (parsed.success) throw new Error('expected a refusal');
    const error = ErrorBody.parse(await invalidBody('r', parsed.error).json()).error;
    expect(error).toMatchObject({ code: 'invalid_request', field });
    expect(error.message).not.toContain('\u0000');
    expect(error.message).not.toContain('Null');
  });

  it('takes every other character, Arabic and emoji and control characters included', () => {
    for (const name of ['نور عادل', 'Nour 🚚', 'tab\there', 'line\nbreak', '\u0001']) {
      expect(CreateSessionRequest.safeParse({ ...mint, name }).success, name).toBe(true);
    }
    expect(
      CreateSessionRequest.safeParse({ ...mint, client: { platform: 'android', appVersion: '5' } })
        .success,
    ).toBe(true);
  });
});

describe('the text the user writes', () => {
  // The same rule as the session's `name`, decided with the stage that first
  // stores a message (stage 4): a `text` column refuses U+0000, and the send
  // answered 500 — which an SDK retries until its entry ages — for a 400.
  it.each([
    ['text', CreateTicketRequest, { text: 'Where\u0000 is it?', locale: 'en' }],
    ['text', SendMessageRequest, { text: '\u0000', locale: 'ar' }],
    ['comment', AnswerSurveyRequest, { rating: 4, comment: 'Fine\u0000' }],
  ] as const)('refuses U+0000 in %s, naming the field', async (field, schema, body) => {
    const parsed = schema.safeParse(body);
    if (parsed.success) throw new Error('expected a refusal');
    const error = ErrorBody.parse(await invalidBody('r', parsed.error).json()).error;
    expect(error).toMatchObject({ code: 'invalid_request', field });
    expect(error.message).not.toContain('\u0000');
  });

  it('takes Arabic, emoji and line breaks', () => {
    for (const text of ['فين شحنتي؟', 'Where is it 🚚', 'line\nbreak']) {
      expect(SendMessageRequest.safeParse({ text, locale: 'ar' }).success, text).toBe(true);
    }
  });
});
