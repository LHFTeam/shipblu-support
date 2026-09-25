import { describe, expect, it } from 'vitest';
import { containing } from './like';

describe('containing', () => {
  /**
   * The knowledge base admin search built `%${q}%` from the box as typed, so an
   * underscore matched any character and a lone `%` matched every article. The
   * ticket search had escaped both since it was written; this is the one
   * pattern builder every search now shares.
   */
  it('matches the text as typed anywhere in the column, never as a pattern', () => {
    expect(containing('return_policy')).toBe('%return\\_policy%');
    expect(containing('%')).toBe('%\\%%');
  });

  it('escapes the escape character itself', () => {
    expect(containing('C:\\path')).toBe('%C:\\\\path%');
  });

  it('leaves ordinary text, Arabic included, untouched', () => {
    expect(containing('Where is my parcel?')).toBe('%Where is my parcel?%');
    expect(containing('أين شحنتي')).toBe('%أين شحنتي%');
  });
});
