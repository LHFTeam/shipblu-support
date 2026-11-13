import { describe, expect, it } from 'vitest';
import { withTestEnv } from '@/lib/testing/env';
import { encodeCursor } from './cursor';
import { answerRead, answerSend, listAsked, markBody, pageAsked } from './requests';
import { ErrorBody, ReadResult } from './schemas';

/**
 * What the ticket routes read off a request, and how the marker's outcome is
 * answered, short of the database: which page of a thread or of the list a
 * query asks for, and the read marker's body. Every refusal here is one the
 * client can read and act on, and none of them is a first page: a refusal that
 * names the wrong field, or reads a cursor this server never minted as a first
 * page, is a bug the app's developers meet before anybody here does.
 */

withTestEnv();

const ROW = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

async function refusedAnswer(answer: unknown) {
  expect(answer).toHaveProperty('refusal');
  const response = (answer as { refusal: Response }).refusal;
  const body = ErrorBody.parse(await response.json());
  return { status: response.status, ...body.error };
}

describe('pageAsked', () => {
  const at = (query: string) =>
    new URL(`https://support.example/api/v1/tickets/x/messages${query}`);

  async function refused(query: string) {
    const asked = pageAsked(at(query), 'req-1');
    if (!('refusal' in asked)) throw new Error(`expected a refusal for ${query}`);
    return { status: asked.refusal.status, ...ErrorBody.parse(await asked.refusal.json()).error };
  }

  it('reads the newest page, or a page either side of a cursor this server minted', () => {
    const cursor = { time: '2026-11-12 09:41:07.004213+00', id: ROW };
    const text = encodeCursor('messages', cursor);
    expect(pageAsked(at(''), 'r')).toEqual({ kind: 'newest', limit: 30 });
    expect(pageAsked(at(`?after=${text}`), 'r')).toEqual({
      kind: 'after',
      cursor,
      text,
      limit: 30,
    });
    expect(pageAsked(at(`?before=${text}&limit=5`), 'r')).toEqual({
      kind: 'before',
      cursor,
      text,
      limit: 5,
    });
  });

  // The end-to-end pass read this one as a page from 2026-01-01: base64url of
  // a timestamp and a uuid, spelled as this server spells them, never signed.
  it('refuses a cursor in this server’s spelling that it never minted', async () => {
    const forged = Buffer.from(
      '2026-01-01 00:00:00+00|11111111-1111-4111-8111-111111111111',
      'utf8',
    ).toString('base64url');
    for (const query of [`?after=${forged}`, `?before=${forged}`]) {
      expect(await refused(query)).toMatchObject({ status: 400, code: 'invalid_cursor' });
    }
  });

  // The list's cursor is a ticket's `(last_message_at, id)`: read on a thread
  // it would page messages from an instant that says nothing about them.
  it('refuses the tickets list’s cursor, either way round', async () => {
    const list = encodeCursor('tickets', { time: '2026-11-12 09:41:07.004213+00', id: ROW });
    for (const query of [`?after=${list}`, `?before=${list}`]) {
      expect(await refused(query)).toMatchObject({ status: 400, code: 'invalid_cursor' });
    }
  });

  // Both are query parameters and neither is wrong alone (the schema's
  // refinement names no field), so the sentence names the query, not a body.
  it('refuses both cursors at once naming no field, in a sentence about the query', async () => {
    const text = encodeCursor('messages', { time: '2026-11-12 09:41:07+00', id: ROW });
    const error = await refused(`?after=${text}&before=${text}`);
    expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(error.field).toBeUndefined();
    expect(error.message).toBe('The query: `after` and `before` cannot be sent together.');
  });

  it('names the limit when the limit is wrong', async () => {
    for (const query of ['?limit=0', '?limit=101', '?limit=ten']) {
      const error = await refused(query);
      expect(error).toMatchObject({ status: 400, code: 'invalid_request', field: 'limit' });
      expect(error.message.startsWith('limit: ')).toBe(true);
    }
  });
});

describe('listAsked', () => {
  const asked = (query: string) =>
    listAsked(new URL(`https://support.shipblu.com/api/v1/tickets${query}`), 'req-1');
  const minted = () => encodeCursor('tickets', { time: '2026-11-12 09:41:07.004213+00', id: ROW });

  it('reads no parameters as the first page of thirty, unfiltered', () => {
    expect(asked('')).toEqual({ cursor: null, limit: 30, trackingNumber: null });
  });

  it('reads a page size, a tracking number and a cursor this server minted', () => {
    expect(asked(`?limit=20&trackingNumber=AB-12&before=${minted()}`)).toEqual({
      cursor: { time: '2026-11-12 09:41:07.004213+00', id: ROW },
      limit: 20,
      trackingNumber: 'AB-12',
    });
  });

  it('refuses a cursor it did not mint as invalid_cursor, never reading it as a first page', async () => {
    const forged = Buffer.from(`2026-01-01 00:00:00+00|${ROW}`, 'utf8').toString('base64url');
    for (const before of [
      '',
      'abc!',
      'AAAA',
      forged,
      // Signed as this server signs, but not a timestamp Postgres printed.
      encodeCursor('tickets', { time: '2026-02-30 09:41:07+00', id: ROW }),
      encodeCursor('tickets', { time: 'yesterday', id: ROW }),
      // Signed for the list, under a secret this server does not hold.
      encodeCursor('tickets', { time: '2026-11-12 09:41:07+00', id: ROW }, 'x'.repeat(64)),
      'x'.repeat(257),
    ]) {
      expect(await refusedAnswer(asked(`?before=${encodeURIComponent(before)}`))).toMatchObject({
        status: 400,
        code: 'invalid_cursor',
      });
    }
  });

  // A thread's cursor is a message's `(created_at, id)`: read on the list it
  // would page tickets from an instant that says nothing about them.
  it('refuses a thread’s cursor, which signs under a purpose of its own', async () => {
    const thread = encodeCursor('messages', { time: '2026-11-12 09:41:07.004213+00', id: ROW });
    expect(await refusedAnswer(asked(`?before=${thread}`))).toMatchObject({
      status: 400,
      code: 'invalid_cursor',
    });
  });

  it('refuses a page size outside 1 to 100, naming limit, in a sentence about the query', async () => {
    for (const limit of ['', '0', '101', '1.5', 'abc', '-3']) {
      const answer = await refusedAnswer(asked(`?limit=${limit}`));
      expect(answer).toMatchObject({ status: 400, code: 'invalid_request', field: 'limit' });
      expect(answer.message.startsWith('limit: ')).toBe(true);
      expect(answer.message).not.toContain('body');
    }
  });

  it('refuses a tracking number outside the contract, naming it and never repeating it', async () => {
    for (const number of ['', 'a b', 'a/b', 'X'.repeat(65), 'SB\u00004821']) {
      const answer = await refusedAnswer(asked(`?trackingNumber=${encodeURIComponent(number)}`));
      expect(answer).toMatchObject({
        status: 400,
        code: 'invalid_request',
        field: 'trackingNumber',
      });
      expect(answer.message).not.toContain('body');
      if (number.length > 1) expect(answer.message).not.toContain(number);
    }
  });

  it('ignores parameters the list does not take', () => {
    expect(asked(`?after=${minted()}&status=closed&limit=5`)).toEqual({
      cursor: null,
      limit: 5,
      trackingNumber: null,
    });
  });
});

describe('markBody', () => {
  const marking = (body: string) =>
    markBody(
      new Request('https://support.shipblu.com/api/v1/tickets/x/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      'req-1',
    );

  it('reads upTo, lower-cased, and drops a key it does not know', async () => {
    expect(await marking(JSON.stringify({ upTo: ROW.toUpperCase(), also: 1 }))).toEqual({
      upTo: ROW,
    });
  });

  it('refuses a body with no upTo, or one that is not a UUID, naming upTo', async () => {
    for (const body of [{}, { upTo: 'x' }, { upTo: null }, { upTo: 42 }]) {
      expect(await refusedAnswer(await marking(JSON.stringify(body)))).toMatchObject({
        status: 400,
        code: 'invalid_request',
        field: 'upTo',
      });
    }
  });

  // The guide promises this split (docs/myblu-api.md, _Read receipts and
  // unread_): a port asserting `field === 'upTo'` on every malformed body would
  // be wrong for these, which fail at the root and so have no field to name.
  it('refuses a body that is not a JSON object, naming no field', async () => {
    for (const body of ['upTo=', '[]', '"x"', 'null', '5']) {
      const answer = await refusedAnswer(await marking(body));
      expect(answer).toMatchObject({ status: 400, code: 'invalid_request' });
      expect(answer.field).toBeUndefined();
    }
  });
});

describe('answerRead', () => {
  const ticket = {
    id: ROW,
    number: 4812,
    subject: 'Where is my parcel?',
    trackingNumber: null,
    status: 'open' as const,
    statusLabel: null,
    canReply: true,
    createdAt: '2026-11-12T09:29:58.123Z',
    lastMessageAt: '2026-11-12T09:41:07.004Z',
    unreadCount: 0,
    preview: { from: 'agent' as const, text: 'We have asked the courier.', hasAttachments: false },
    survey: null,
  };

  it('answers a marking 200 with the ticket and the badge, and nothing else', async () => {
    const response = answerRead({ kind: 'read', ticket, unreadTotal: 3, marked: 2 }, 'req-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(ReadResult.parse(body)).toEqual({ ticket, unreadTotal: 3 });
    expect(Object.keys(body).sort()).toEqual(['ticket', 'unreadTotal']);
  });

  it('answers each refusal under its own code', async () => {
    expect(
      await refusedAnswer({ refusal: answerRead({ kind: 'not_found' }, 'req-1') }),
    ).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(
      await refusedAnswer({ refusal: answerRead({ kind: 'not_on_ticket' }, 'req-1') }),
    ).toMatchObject({ status: 400, code: 'invalid_request', field: 'upTo' });
  });

  it('answers a session ended while it waited as the sends do', async () => {
    const marker = await refusedAnswer({ refusal: answerRead({ kind: 'revoked' }, 'req-1') });
    const send = await refusedAnswer({ refusal: answerSend({ kind: 'revoked' }, 'req-1') });
    expect(marker).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(marker.message).toBe(send.message);
  });
});
