import { describe, expect, it } from 'vitest';
import { containing, escapeLike } from './like';

describe('escapeLike', () => {
  it('escapes both wildcards and the escape character itself', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('shipping_label')).toBe('shipping\\_label');
    expect(escapeLike('C:\\path')).toBe('C:\\\\path');
  });

  it('leaves ordinary text, Arabic included, untouched', () => {
    expect(escapeLike('Where is my parcel?')).toBe('Where is my parcel?');
    expect(escapeLike('أين شحنتي')).toBe('أين شحنتي');
  });
});

describe('containing', () => {
  /**
   * The knowledge base admin search built `%${q}%` from the box as typed, so an
   * underscore matched any character and a lone `%` matched every article. The
   * ticket search had escaped both since it was written; this is the one
   * pattern builder all four searches now share.
   */
  it('matches the text as typed anywhere in the column, never as a pattern', () => {
    expect(containing('return_policy')).toBe('%return\\_policy%');
    expect(containing('%')).toBe('%\\%%');
  });
});
