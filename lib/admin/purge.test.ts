import { describe, expect, it } from 'vitest';
import {
  confirmationMatches,
  contactConfirmation,
  contactLabel,
  describePurgeCounts,
  type PurgeCounts,
} from './purge-summary';

/**
 * The pure half of the purge: what an admin has to type, and what they are told
 * they are about to destroy.
 *
 * These are exactly the parts worth testing without a database. The deletes
 * themselves are one `delete from conversations` and a cascade Postgres owns —
 * a mock would only assert that Drizzle was called, which proves nothing the
 * type checker did not. What can genuinely be wrong here is the confirmation
 * being satisfied by something it should not be, or the panel understating what
 * is about to go.
 */

const NONE: PurgeCounts = {
  conversations: 0,
  messages: 0,
  attachments: 0,
  events: 0,
  sideConversations: 0,
  sideMessages: 0,
  csatSurveys: 0,
  identities: 0,
  tombstones: 0,
  shippingAccountLinks: 0,
  shipmentsDetached: 0,
};

describe('confirmationMatches', () => {
  it('accepts the exact value', () => {
    expect(confirmationMatches('482', '482')).toBe(true);
  });

  it('forgives surrounding whitespace and case', () => {
    expect(confirmationMatches('ali@example.com', '  Ali@Example.com ')).toBe(true);
  });

  it('collapses runs of whitespace inside a name', () => {
    expect(confirmationMatches('Ali  Hassan', 'Ali Hassan')).toBe(true);
  });

  it('rejects a near miss', () => {
    expect(confirmationMatches('482', '48')).toBe(false);
    expect(confirmationMatches('482', '4820')).toBe(false);
    expect(confirmationMatches('ali@example.com', 'ali@example.co')).toBe(false);
  });

  /**
   * The one that matters. An empty expectation must never be satisfiable — a
   * contact whose confirmation somehow came back blank has to be undeletable
   * rather than deletable by pressing Enter on an empty box.
   */
  it('never matches an empty expectation', () => {
    expect(confirmationMatches('', '')).toBe(false);
    expect(confirmationMatches('   ', '')).toBe(false);
    expect(confirmationMatches('', 'anything')).toBe(false);
  });
});

describe('contactConfirmation', () => {
  const base = {
    id: 'c3d9f8a1-0000-0000-0000-000000000000',
    name: null,
    primaryEmail: null,
    primaryPhone: null,
  };

  it('prefers the email, which is unique', () => {
    expect(
      contactConfirmation({
        ...base,
        name: 'Ali',
        primaryEmail: 'ali@x.com',
        primaryPhone: '+201',
      }),
    ).toBe('ali@x.com');
  });

  it('falls back to the phone before the name', () => {
    expect(contactConfirmation({ ...base, name: 'Ali', primaryPhone: '+201234567890' })).toBe(
      '+201234567890',
    );
  });

  it('uses the name when there is no address or number', () => {
    expect(contactConfirmation({ ...base, name: 'Ali Hassan' })).toBe('Ali Hassan');
  });

  // A whitespace-only column is not a value. Treating it as one would produce a
  // confirmation nobody can type and a contact nobody can delete.
  it('skips blank strings rather than asking for them', () => {
    expect(contactConfirmation({ ...base, name: 'Ali', primaryEmail: '   ' })).toBe('Ali');
  });

  it('falls back to the id when the record is entirely anonymous', () => {
    expect(contactConfirmation(base)).toBe('c3d9f8a1');
  });
});

describe('contactLabel', () => {
  const id = 'c3d9f8a1-0000-0000-0000-000000000000';

  it('names the person and how they reach us', () => {
    expect(contactLabel({ id, name: 'Ali', primaryEmail: 'ali@x.com', primaryPhone: '+201' })).toBe(
      'Ali (ali@x.com · +201)',
    );
  });

  it('drops the parenthetical when there is no handle', () => {
    expect(contactLabel({ id, name: 'Ali', primaryEmail: null, primaryPhone: null })).toBe('Ali');
  });

  it('stands on the handle alone when there is no name', () => {
    expect(contactLabel({ id, name: null, primaryEmail: 'ali@x.com', primaryPhone: null })).toBe(
      'ali@x.com',
    );
  });

  // The audit row is read after the contact is gone, so "Unnamed contact" on its
  // own would name nothing at all.
  it('still identifies an anonymous contact', () => {
    expect(contactLabel({ id, name: null, primaryEmail: null, primaryPhone: null })).toBe(
      'Unnamed contact c3d9f8a1',
    );
  });
});

describe('describePurgeCounts', () => {
  it('says nothing about tables with nothing in them', () => {
    expect(describePurgeCounts({ ...NONE, conversations: 1, messages: 4 })).toEqual([
      '1 ticket',
      '4 messages',
    ]);
  });

  it('singularises one of each', () => {
    expect(
      describePurgeCounts({ ...NONE, conversations: 1, messages: 1, attachments: 1, events: 1 }),
    ).toEqual(['1 ticket', '1 message', '1 attachment', '1 timeline entry']);
  });

  it('is empty for an empty ticket, so the panel can say so in its own words', () => {
    expect(describePurgeCounts(NONE)).toEqual([]);
  });

  /**
   * Shipments are detached, not destroyed. If they ever appear in this list the
   * panel starts telling an admin their parcel records are about to be deleted,
   * which is both false and the kind of false that stops a real deletion.
   */
  it('never lists detached shipments among the destroyed', () => {
    expect(describePurgeCounts({ ...NONE, shipmentsDetached: 9 })).toEqual([]);
  });

  it('reports a contact purge across all its tables', () => {
    expect(
      describePurgeCounts({
        ...NONE,
        conversations: 3,
        messages: 41,
        identities: 2,
        tombstones: 1,
        shippingAccountLinks: 1,
      }),
    ).toEqual([
      '3 tickets',
      '41 messages',
      '2 addresses and numbers',
      '1 merged-away record',
      '1 account membership',
    ]);
  });
});
