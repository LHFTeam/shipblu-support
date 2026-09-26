import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow } from './inbox';
import type { InboxFilters } from './inbox-filters';
import {
  forgetInboxPosition,
  inboxSignature,
  readInboxPosition,
  rememberInboxPages,
  rememberInboxScroll,
} from './inbox-position';

// The store is deliberately inert outside the browser, so the tests have to look
// like one. The last case here takes the window away again to prove it.
vi.stubGlobal('window', {});

beforeEach(forgetInboxPosition);

function filters(overrides: Partial<InboxFilters> = {}): InboxFilters {
  return { view: 'all', statusCategory: 'unresolved', channel: 'all', q: '', ...overrides };
}

function rows(...ids: string[]): InboxRow[] {
  return ids.map((id) => ({ id }) as InboxRow);
}

describe('inboxSignature', () => {
  it('changes with every filter it covers', () => {
    const base = inboxSignature(filters());

    for (const overrides of [
      { view: 'mine' } as const,
      { statusCategory: 'resolved' } as const,
      { channel: 'whatsapp_bot' } as const,
      { q: '#42' },
    ]) {
      expect(inboxSignature(filters(overrides))).not.toBe(base);
    }
  });

  it('is the same for the same filters, whatever order they were built in', () => {
    expect(inboxSignature(filters({ channel: 'whatsapp_bot', q: 'ali' }))).toBe(
      inboxSignature(filters({ q: 'ali', channel: 'whatsapp_bot' })),
    );
  });
});

describe('remembering a position', () => {
  it('gives back the pages and the offset under the same signature', () => {
    rememberInboxPages('a', rows('1', '2'), 'cursor-3');
    rememberInboxScroll('a', 1840);

    const saved = readInboxPosition('a');
    expect(saved?.rows.map((row) => row.id)).toEqual(['1', '2']);
    expect(saved?.cursor).toBe('cursor-3');
    expect(saved?.scrollTop).toBe(1840);
  });

  it('keeps the offset when the pages are written again', () => {
    // The round trip that this exists for: the list mounts, restores its offset,
    // and immediately mirrors the pages it was seeded with straight back. That
    // write must not be what loses the offset.
    rememberInboxScroll('a', 1840);
    rememberInboxPages('a', rows('1'), null);

    expect(readInboxPosition('a')?.scrollTop).toBe(1840);
  });

  it('holds nothing for a different filter — a filter change starts at the top', () => {
    rememberInboxPages('a', rows('1'), 'cursor-2');
    rememberInboxScroll('a', 1840);

    expect(readInboxPosition('b')).toBeNull();
  });

  it('drops the old position rather than patching it when the filters change', () => {
    rememberInboxPages('a', rows('1', '2'), 'cursor-3');
    rememberInboxScroll('a', 1840);

    // Only the offset is written under the new signature, and the pages of the
    // old list must not come with it: they are a different query's rows, and
    // 1840px into them is not 1840px into these.
    rememberInboxScroll('b', 20);

    const saved = readInboxPosition('b');
    expect(saved?.rows).toEqual([]);
    expect(saved?.cursor).toBeUndefined();
    expect(saved?.scrollTop).toBe(20);
    expect(readInboxPosition('a')).toBeNull();
  });

  it('remembers one list, not every list the agent has filtered to', () => {
    rememberInboxScroll('a', 1840);
    rememberInboxScroll('b', 20);

    expect(readInboxPosition('a')).toBeNull();
    expect(readInboxPosition('b')?.scrollTop).toBe(20);
  });

  it('is inert on the server, where the module is shared by every request', () => {
    rememberInboxScroll('a', 1840);

    vi.stubGlobal('window', undefined);
    try {
      expect(readInboxPosition('a')).toBeNull();
      rememberInboxScroll('a', 5);
      rememberInboxPages('a', rows('leaked'), null);
    } finally {
      vi.stubGlobal('window', {});
    }

    const saved = readInboxPosition('a');
    expect(saved?.scrollTop).toBe(1840);
    expect(saved?.rows).toEqual([]);
  });
});
