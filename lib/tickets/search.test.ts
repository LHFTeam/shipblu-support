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
