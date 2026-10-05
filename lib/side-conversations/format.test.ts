import { describe, expect, it } from 'vitest';
import { blankSideSubject, subjectPrefill } from './format';

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
