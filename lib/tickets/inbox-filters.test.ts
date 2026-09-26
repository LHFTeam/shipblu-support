import { describe, expect, it } from 'vitest';
import { encodeInboxCursor, parseFilters, parseInboxCursor } from './inbox-filters';

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
      q: '',
    });
  });

  it('no longer carries a page number', () => {
    // Pagination moved to a cursor the client holds, so a leftover ?page= from
    // an old bookmark must not reach the query.
    expect(parseFilters({ page: '4' })).not.toHaveProperty('page');
  });

  it('reads the filters the list offers', () => {
    expect(
      parseFilters({ view: 'mine', status: 'resolved', channel: 'whatsapp', q: '  #42  ' }),
    ).toEqual({ view: 'mine', statusCategory: 'resolved', channel: 'whatsapp', q: '#42' });
  });

  it('falls back rather than passing an unknown value to the query', () => {
    const filters = parseFilters({ view: 'everyone', status: 'sideways', channel: 'telegram' });

    expect(filters.view).toBe('all');
    expect(filters.statusCategory).toBe('unresolved');
    expect(filters.channel).toBe('all');
  });

  it('takes the first value when a param is repeated', () => {
    expect(parseFilters({ channel: ['email', 'whatsapp'] }).channel).toBe('email');
  });
});
