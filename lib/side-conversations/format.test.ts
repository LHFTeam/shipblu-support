import { describe, expect, it } from 'vitest';
import { blankSideSubject, isQuotableAnchor, sideSubject, subjectPrefill } from './format';

describe('sideSubject', () => {
  it('sends an untouched prefill as the tracking number alone', () => {
    expect(sideSubject('1212121212121 || ', 'Where is my order')).toBe('1212121212121');
    expect(sideSubject('1212121212121||', 'Where is my order')).toBe('1212121212121');
  });

  it('keeps what the agent wrote after the separator', () => {
    expect(sideSubject('1212121212121 || not delivered', 'x')).toBe(
      '1212121212121 || not delivered',
    );
  });

  it("falls back to the ticket's subject only when nothing is left", () => {
    expect(sideSubject('', 'Where is my order')).toBe('Where is my order');
    expect(sideSubject(' || ', 'Where is my order')).toBe('Where is my order');
    expect(sideSubject('', null)).toBe('(no subject)');
  });

  it('leaves a separator in the middle alone', () => {
    expect(sideSubject('a || b', null)).toBe('a || b');
  });
});

describe('blankSideSubject', () => {
  it("is the ticket's own subject", () => {
    expect(blankSideSubject('Where is my order')).toBe('Where is my order');
  });

  it('says there is none rather than sending nothing, or whitespace', () => {
    expect(blankSideSubject(null)).toBe('(no subject)');
    expect(blankSideSubject('   ')).toBe('(no subject)');
  });

  it('trims what it keeps', () => {
    expect(blankSideSubject('  Where is my order \n')).toBe('Where is my order');
  });
});

describe('subjectPrefill', () => {
  it('leads with the one tracking number and leaves the rest to the agent', () => {
    expect(subjectPrefill(['1212121212121'])).toBe('1212121212121 || ');
  });

  it('stays empty when the ticket has no parcel', () => {
    expect(subjectPrefill([])).toBe('');
  });

  it('stays empty when the ticket has several, rather than picking one', () => {
    expect(subjectPrefill(['1212121212121', '3434343434343'])).toBe('');
  });

  it('counts one parcel linked twice as one', () => {
    expect(subjectPrefill(['1212121212121', '1212121212121'])).toBe('1212121212121 || ');
  });

  it('ignores an empty number rather than leading with nothing', () => {
    expect(subjectPrefill([''])).toBe('');
    expect(subjectPrefill(['', '1212121212121'])).toBe('1212121212121 || ');
  });
});

describe('isQuotableAnchor', () => {
  const said = { direction: 'inbound', kind: 'reply', meta: {} };

  it('takes what the customer said', () => {
    expect(isQuotableAnchor(said)).toBe(true);
    expect(isQuotableAnchor({ ...said, meta: { whatsappType: 'text' } })).toBe(true);
  });

  // Each of these would reach the hub under "the customer wrote".
  it('refuses everything else on the ticket', () => {
    // Our own reply, and our private note.
    expect(isQuotableAnchor({ ...said, direction: 'outbound' })).toBe(false);
    expect(isQuotableAnchor({ ...said, kind: 'note' })).toBe(false);
    // The notice a form writes, inbound, when it could not keep a file.
    expect(isQuotableAnchor({ ...said, kind: 'system' })).toBe(false);
    // A reaction, and one stored before reactions had a kind.
    expect(isQuotableAnchor({ ...said, kind: 'reaction' })).toBe(false);
    expect(isQuotableAnchor({ ...said, meta: { whatsappType: 'reaction' } })).toBe(false);
  });
});
