import { describe, expect, it } from 'vitest';
import { normaliseForMatch } from '@/lib/categorise/normalise';
import { ARABIC_LETTER_VARIANTS, arabicVariantPattern } from './arabic';

/** Runs a pattern the way Postgres's `~*` would, near enough for these cases. */
function matches(pattern: string, text: string): boolean {
  return new RegExp(pattern, 'iu').test(text);
}

describe('arabicVariantPattern', () => {
  it('finds a name whichever way its alef was written', () => {
    const pattern = arabicVariantPattern('احمد')!;
    for (const name of ['احمد', 'أحمد', 'إحمد', 'آحمد']) {
      expect(matches(pattern, name), name).toBe(true);
    }
    expect(matches(pattern, 'محمد')).toBe(false);
  });

  it('widens a variant the agent typed as far as the letter it stands for', () => {
    // Typed with the hamza, the search still finds the bare spelling — the
    // direction an agent copying a name off a WhatsApp profile goes.
    expect(matches(arabicVariantPattern('أحمد')!, 'احمد')).toBe(true);
    expect(matches(arabicVariantPattern('الشحنة')!, 'الغاء الشحنه')).toBe(true);
    expect(matches(arabicVariantPattern('الغى')!, 'الغي')).toBe(true);
    expect(matches(arabicVariantPattern('مسؤول')!, 'مسوول')).toBe(true);
  });

  it('is null when there is nothing to widen, so those queries keep their ILIKE', () => {
    for (const query of ['Nada', '#812', '+20 101 442 8154', 'SB123456789', 'شكر', '']) {
      expect(arabicVariantPattern(query), query).toBeNull();
    }
  });

  it('takes regular expression syntax in the query literally', () => {
    const pattern = arabicVariantPattern('أحمد (1+1)? [x] {2} a.b | c^$ \\')!;
    expect(matches(pattern, 'احمد (1+1)? [x] {2} a.b | c^$ \\')).toBe(true);
    // Unescaped, `.` would match any character here and `(1+1)?` would be an
    // optional group that matches nothing at all.
    expect(matches(arabicVariantPattern('احمد a.b')!, 'احمد axb')).toBe(false);
    expect(matches(arabicVariantPattern('احمد (1)')!, 'احمد ')).toBe(false);
  });

  it('keeps ILIKE wildcards literal too, since this replaces that pattern', () => {
    expect(matches(arabicVariantPattern('احمد_%')!, 'احمد_%')).toBe(true);
    expect(matches(arabicVariantPattern('احمد_%')!, 'احمدxy')).toBe(false);
  });
});

describe('ARABIC_LETTER_VARIANTS', () => {
  // The categoriser folds by this table and the search widens by it, so each
  // letter's search reaches every spelling the categoriser treats as it. Only
  // that direction: the categoriser also strips tatweel and tashkeel from the
  // text it reads, which a search cannot do to a column, so text it calls equal
  // is not always text a search finds.
  it('widens each letter to every spelling the categoriser folds into it', () => {
    for (const { letter, variants } of ARABIC_LETTER_VARIANTS) {
      for (const spelling of [letter, ...variants]) {
        expect(normaliseForMatch(spelling), spelling).toBe(letter);
        expect(matches(arabicVariantPattern(letter)!, spelling), spelling).toBe(true);
      }
    }
  });
});
