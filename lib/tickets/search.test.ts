import { describe, expect, it } from 'vitest';
import { parseSearchTerm } from './search';

describe('ticket numbers', () => {
  it('reads the "#812" the team says out loud', () => {
    expect(parseSearchTerm('#812').number).toBe(812);
    expect(parseSearchTerm('812').number).toBe(812);
  });

  it('leaves anything that is not plainly a number alone', () => {
    for (const query of ['', '#', 'Nada', '812a', '1e3', '12.0', '-4', '0', '#0']) {
      expect(parseSearchTerm(query).number, query).toBeNull();
    }
  });

  it('refuses a number too large to be a bigint the database holds', () => {
    expect(parseSearchTerm('99999999999999999999').number).toBeNull();
  });

  it('still searches the text of a numeric query, so it can hit a phone too', () => {
    expect(parseSearchTerm('#812').pattern).toBe('%#812%');
  });
});

describe('phone numbers', () => {
  // Stored as E.164 digits with no plus: 201014428154.
  it('strips the punctuation agents paste in from other systems', () => {
    expect(parseSearchTerm('+20 101 442 8154').phonePattern).toBe('%201014428154%');
    expect(parseSearchTerm('0101-442-8154').phonePattern).toBe('%01014428154%');
    expect(parseSearchTerm('(0101) 442 8154').phonePattern).toBe('%01014428154%');
  });

  it('leaves bare digits to the ordinary text pattern', () => {
    // '%01014428154%' already matches '201014428154' as a substring.
    expect(parseSearchTerm('01014428154').phonePattern).toBeNull();
    expect(parseSearchTerm('812').phonePattern).toBeNull();
  });

  it('does not treat a short number or a name as a phone', () => {
    expect(parseSearchTerm('1-2').phonePattern).toBeNull();
    expect(parseSearchTerm('Khaled +20').phonePattern).toBeNull();
  });
});

describe('the free-text pattern', () => {
  it('wraps the query for a substring match', () => {
    expect(parseSearchTerm('Nada').pattern).toBe('%Nada%');
  });

  it('trims, so a trailing space from a paste still matches', () => {
    expect(parseSearchTerm('  Nada  ').pattern).toBe('%Nada%');
  });

  it('keeps ILIKE wildcards literal', () => {
    expect(parseSearchTerm('100%').pattern).toBe('%100\\%%');
    expect(parseSearchTerm('a_b').pattern).toBe('%a\\_b%');
    expect(parseSearchTerm('c:\\temp').pattern).toBe('%c:\\\\temp%');
  });

  it('handles Arabic exactly as it handles anything else', () => {
    expect(parseSearchTerm('تأكيد').pattern).toBe('%تأكيد%');
  });
});

describe('parseSearchTerm — shipments', () => {
  it('narrows to the shipment clause on a track: prefix', () => {
    const term = parseSearchTerm('track:SB123456789');
    expect(term.trackingNumber).toBe('SB123456789');
    expect(term.scope).toBe('tracking');
    // The residual pattern is built from the rest, not the whole string, or the
    // literal "track:" gets searched in message bodies and matches nothing.
    expect(term.pattern).toBe('%SB123456789%');
  });

  it('accepts the prefix in any case, and its aliases', () => {
    for (const query of ['TRACK:SB123456789', 'Tracking:SB123456789', 'awb: SB123456789']) {
      expect(parseSearchTerm(query).trackingNumber).toBe('SB123456789');
    }
  });

  it('narrows to the account clause on an sbid: prefix', () => {
    const term = parseSearchTerm('sbid:4471');
    expect(term.sbid).toBe('4471');
    expect(term.scope).toBe('sbid');
  });

  it('degrades to an ordinary search when a prefix has nothing after it', () => {
    // Someone mid-typing should see their old results, not an empty inbox.
    const term = parseSearchTerm('track:');
    expect(term.trackingNumber).toBeNull();
    expect(term.scope).toBe('any');
  });

  it('infers a bare tracking number without narrowing the search', () => {
    const term = parseSearchTerm('1755021358719');
    expect(term.trackingNumber).toBe('1755021358719');
    expect(term.scope).toBe('any');
    expect(term.pattern).toBe('%1755021358719%');
  });

  it('does not infer from a sentence that merely contains one', () => {
    expect(parseSearchTerm('where is 1755021358719').trackingNumber).toBeNull();
  });

  it('reads a tracking number an agent pasted with a hash in front of it', () => {
    // A ticket reference is still read as one — the highest number in production
    // is 13,747, so nothing of tracking length competes for the `#` namespace.
    const term = parseSearchTerm('#1195223624566');
    expect(term.trackingNumber).toBe('1195223624566');
  });

  it('leaves a pasted phone number alone', () => {
    const term = parseSearchTerm('+20 101 442 8154');
    expect(term.trackingNumber).toBeNull();
    expect(term.sbid).toBeNull();
    expect(term.phonePattern).toBe('%201014428154%');
  });

  it('still reads a ticket reference as a ticket number', () => {
    const term = parseSearchTerm('#812');
    expect(term.number).toBe(812);
    expect(term.trackingNumber).toBeNull();
    expect(term.sbid).toBeNull();
  });

  it('escapes ILIKE wildcards in the residual pattern', () => {
    expect(parseSearchTerm('track:50%').pattern).toBe('%50\\%%');
  });
});
