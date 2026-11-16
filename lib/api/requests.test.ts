import { describe, expect, it } from 'vitest';
import { withTestEnv } from '@/lib/testing/env';
import { encodeCursor } from './cursor';
import { pageAsked } from './requests';
import { ErrorBody } from './schemas';

/**
 * Which page a `GET /tickets/{id}/messages` asks for, read off its query
 * string before anything touches the database: every refusal here is one the
 * client can read and act on, and none of them is a first page.
 */

withTestEnv();

const ROW = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const at = (query: string) => new URL(`https://support.example/api/v1/tickets/x/messages${query}`);

async function refused(query: string) {
  const asked = pageAsked(at(query), 'req-1');
  if (!('refusal' in asked)) throw new Error(`expected a refusal for ${query}`);
  return { status: asked.refusal.status, ...ErrorBody.parse(await asked.refusal.json()).error };
}

describe('pageAsked', () => {
  it('reads the newest page, or a page either side of a cursor this server minted', () => {
    const cursor = { time: '2026-11-12 09:41:07.004213+00', id: ROW };
    const text = encodeCursor(cursor);
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

  // Both are query parameters and neither is wrong alone (the schema's
  // refinement names no field), so the sentence names the query, not a body.
  it('refuses both cursors at once naming no field, in a sentence about the query', async () => {
    const text = encodeCursor({ time: '2026-11-12 09:41:07+00', id: ROW });
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
