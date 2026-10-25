import { describe, expect, it } from 'vitest';
import { encodeInboxCursor, parseFilters, parseInboxCursor, queryParams } from './inbox-filters';

const ROW_ID = '3f1c9a4e-6b2d-4c8f-9a71-2e5d8c0b7f43';
const ROW_TIME = '2026-08-19 23:24:51.640649+00';

describe('inbox cursors', () => {
  it('round-trips a row without losing timestamp precision', () => {
    // The microseconds are the point: a cursor that dropped them would compare
    // against an instant slightly before the row it names, and the tuple
    // comparison would then repeat or skip a row at the page boundary.
    const encoded = encodeInboxCursor({ time: ROW_TIME, id: ROW_ID });

    expect(parseInboxCursor(encoded)).toEqual({ time: ROW_TIME, id: ROW_ID });
  });

  it('survives a query string, which is the only way it travels', () => {
    const encoded = encodeInboxCursor({ time: ROW_TIME, id: ROW_ID });

    // The raw form contains a space and a '+', and '+' decodes to a space in a
    // query string — so the encoding has to be URL-safe rather than merely
    // readable.
    const params = new URLSearchParams(`cursor=${encoded}`);
    expect(parseInboxCursor(params.get('cursor'))).toEqual({ time: ROW_TIME, id: ROW_ID });
  });

  it('rejects a cursor it cannot trust', () => {
    expect(parseInboxCursor(null)).toBeNull();
    expect(parseInboxCursor(undefined)).toBeNull();
    expect(parseInboxCursor('')).toBeNull();
    // Decodes, but carries no separator.
    expect(parseInboxCursor(Buffer.from('nonsense').toString('base64url'))).toBeNull();
    // A separator with nothing before it is not a timestamp.
    expect(parseInboxCursor(Buffer.from(`|${ROW_ID}`).toString('base64url'))).toBeNull();
    // The id has to be an id: it is interpolated into the query as a uuid.
    expect(
      parseInboxCursor(Buffer.from(`${ROW_TIME}|not-a-uuid`).toString('base64url')),
    ).toBeNull();
    expect(
      parseInboxCursor(
        Buffer.from(`${ROW_TIME}|1; DROP TABLE conversations`).toString('base64url'),
      ),
    ).toBeNull();
  });

  it('keeps a timestamp that itself contains the separator out of the id', () => {
    // Defensive: splitting on the last separator instead of the first would
    // corrupt the id here.
    const encoded = Buffer.from(`${ROW_TIME}|${ROW_ID}`).toString('base64url');
    expect(parseInboxCursor(encoded)?.id).toBe(ROW_ID);
  });
});

describe('parseFilters', () => {
  it('defaults to the unresolved working queue', () => {
    const filters = parseFilters({});

    expect(filters).toEqual({
      view: 'all',
      statusCategory: 'unresolved',
      channel: 'all',
      rating: 'any',
      group: null,
      category: null,
      q: '',
    });
  });

  it('reads a comment channel apart from its platform', () => {
    expect(parseFilters({ channel: 'facebook_comment' }).channel).toBe('facebook_comment');
    expect(parseFilters({ channel: 'facebook' }).channel).toBe('facebook');
    // Not a channel at all: every channel, rather than an empty list.
    expect(parseFilters({ channel: 'facebook_comments' }).channel).toBe('all');
  });

  it('reads the groups view and a group by id, and refuses an id that is not one', () => {
    const id = '0861A48B-8BD8-4EA0-B288-54460A63DEEE';
    expect(parseFilters({ view: 'groups', group: id })).toMatchObject({
      view: 'groups',
      group: id.toLowerCase(),
    });
    // Postgres answers a malformed uuid with 22P02, which would fail the page
    // rather than answer with an empty list.
    expect(parseFilters({ group: 'Merchant Care' }).group).toBeNull();
  });

  it('reads a category by id, and refuses anything that is not one', () => {
    const id = 'C3E1F0A2-7B4D-4E8A-9F21-6D5C4B3A2E10';
    expect(parseFilters({ category: id }).category).toBe(id.toLowerCase());
    // The key is not the address: the column holds the id, and a key would
    // reach Postgres as a malformed uuid (22P02) rather than as no match.
    expect(parseFilters({ category: 'sales' }).category).toBeNull();
    expect(parseFilters({ category: '' }).category).toBeNull();
    expect(parseFilters({ category: `${id}' or true --` }).category).toBeNull();
    // Its own axis: a group's id is not read as a category, nor the reverse.
    expect(parseFilters({ group: id })).toMatchObject({ group: id.toLowerCase(), category: null });
  });

  it('no longer carries a page number', () => {
    // Pagination moved to a cursor the client holds, so a leftover ?page= from
    // an old bookmark must not reach the query.
    expect(parseFilters({ page: '4' })).not.toHaveProperty('page');
  });

  it('reads the filters the list offers', () => {
    expect(
      parseFilters({
        view: 'mine',
        status: 'resolved',
        channel: 'whatsapp',
        rating: 'low',
        category: '5a0d6c1e-2f3b-4a4c-8d5e-6f7a8b9c0d1e',
        q: '  #42  ',
      }),
    ).toEqual({
      view: 'mine',
      statusCategory: 'resolved',
      channel: 'whatsapp',
      rating: 'low',
      group: null,
      category: '5a0d6c1e-2f3b-4a4c-8d5e-6f7a8b9c0d1e',
      q: '#42',
    });
  });

  it('falls back rather than passing an unknown value to the query', () => {
    const filters = parseFilters({
      view: 'everyone',
      status: 'sideways',
      channel: 'telegram',
      rating: 'terrible',
    });

    expect(filters.view).toBe('all');
    expect(filters.statusCategory).toBe('unresolved');
    expect(filters.channel).toBe('all');
    expect(filters.rating).toBe('any');
  });

  it('takes the first value when a param is repeated', () => {
    expect(parseFilters({ channel: ['email', 'whatsapp'] }).channel).toBe('email');
  });

  // `/api/inbox` reads the query string, the page Next's `searchParams`; the
  // two must agree on a repeated key, or scrolling appends another filter's rows.
  it('reads a repeated param from a query string as the page reads it', () => {
    const sales = '3f1c9a4e-6b2d-4c8f-9a71-2e5d8c0b7f43';
    const merchant = '9b2e7d10-4a5c-4e3f-8d21-6c0f1a2b3c4d';
    const search = new URLSearchParams(
      `category=${sales}&category=${merchant}&channel=email&channel=whatsapp&cursor=x`,
    );
    const fromQuery = parseFilters(queryParams(search));
    expect(fromQuery.category).toBe(sales);
    expect(fromQuery.channel).toBe('email');
    expect(fromQuery).toEqual(
      parseFilters({ category: [sales, merchant], channel: ['email', 'whatsapp'], cursor: 'x' }),
    );
  });

  it('reads a key named after an object member as any other stray key', () => {
    const search = new URLSearchParams('constructor=1&__proto__=x&toString=1&hasOwnProperty=1');
    expect(parseFilters(queryParams(search))).toEqual(parseFilters({}));
  });
});
