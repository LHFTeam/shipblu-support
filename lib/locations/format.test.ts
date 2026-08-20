import { describe, expect, it } from 'vitest';
import { isValidLocationCode, normaliseLocationCode } from './format';

describe('normaliseLocationCode', () => {
  it('uppercases and trims', () => {
    expect(normaliseLocationCode(' cai-1 ')).toBe('CAI-1');
  });

  it('collapses spaces and underscores onto one hyphen', () => {
    // The point of the whole function: one hub, however somebody typed it.
    const variants = ['CAI-1', 'cai 1', 'CAI_1', 'cai   1', 'CAI--1', ' cai-1'];
    expect(new Set(variants.map(normaliseLocationCode)).size).toBe(1);
  });

  it('drops leading and trailing separators', () => {
    expect(normaliseLocationCode('-alex-')).toBe('ALEX');
    expect(normaliseLocationCode('_ALEX_')).toBe('ALEX');
  });

  it('keeps internal hyphens, which carry meaning', () => {
    // NEW-CAIRO and NEWCAIRO are different codes, and only the operator knows
    // which one is theirs.
    expect(normaliseLocationCode('new cairo')).toBe('NEW-CAIRO');
  });
});

describe('isValidLocationCode', () => {
  it('accepts an alphanumeric code with hyphens', () => {
    expect(isValidLocationCode('CAI-1')).toBe(true);
    expect(isValidLocationCode('alex')).toBe(true);
    expect(isValidLocationCode('6OCT-2')).toBe(true);
  });

  it('validates what would be stored, not what was typed', () => {
    // Normalisation runs first, so a value that only looks invalid passes and —
    // more importantly — a caller cannot check one string and store another.
    expect(isValidLocationCode(' cai_1 ')).toBe(true);
  });

  it('rejects an empty or punctuation-only code', () => {
    expect(isValidLocationCode('')).toBe(false);
    expect(isValidLocationCode('   ')).toBe(false);
    expect(isValidLocationCode('---')).toBe(false);
  });

  it('rejects one character, which is not an identifier anyone can use', () => {
    expect(isValidLocationCode('A')).toBe(false);
  });

  it('rejects characters that do not survive being read aloud or typed', () => {
    expect(isValidLocationCode('CAI/1')).toBe(false);
    expect(isValidLocationCode('CAI.1')).toBe(false);
    expect(isValidLocationCode('القاهرة')).toBe(false);
  });

  it('rejects a code long enough to be a name', () => {
    expect(isValidLocationCode('CAIRO-NASR-CITY-HUB-ONE')).toBe(false);
  });
});
