import { describe, expect, it } from 'vitest';
import {
  arabicRatio,
  countLetters,
  detectCategoryLocale,
  detectLocale,
  looksUntranslated,
} from './language';

describe('countLetters', () => {
  it('ignores digits, punctuation and whitespace', () => {
    expect(countLetters('ab 12, ٣٤ — !')).toEqual({ arabic: 0, latin: 2 });
  });

  it('counts Arabic-Indic digits as neither script', () => {
    // A tracking number is not evidence of a language, and counting it would
    // skew short titles that are mostly reference codes.
    expect(countLetters('٠١٢٣٤٥٦٧٨٩')).toEqual({ arabic: 0, latin: 0 });
  });
});

describe('detectLocale', () => {
  it('reads plain Arabic and plain English', () => {
    expect(detectLocale('كيف أتتبع شحنتي')).toBe('ar');
    expect(detectLocale('How do I track my shipment')).toBe('en');
  });

  it('keeps an Arabic article Arabic despite heavy Latin content', () => {
    // The case a majority threshold gets wrong. Real ShipBlu articles are full
    // of brand names, tracking codes and English jargon.
    const mixed =
      'كيفية تتبع شحنة باستخدام رقم التتبع ShipBlu shipment tracking number ' +
      'COD-2026-00184 merchant dashboard delivery status support.shipblu.com';

    // Latin letters outnumber Arabic ones here, and it is still an Arabic
    // article. A majority threshold would file it as English.
    expect(arabicRatio(mixed)).toBeLessThan(0.5);
    expect(arabicRatio(mixed)).toBeGreaterThan(0.2);
    expect(detectLocale(mixed)).toBe('ar');
  });

  it('does not turn an English article Arabic over one borrowed word', () => {
    expect(
      detectLocale(
        'Cash on delivery, known locally as نقدا, is supported on every ShipBlu shipment and is settled weekly to the merchant account without any further paperwork.',
      ),
    ).toBe('en');
  });

  it('combines the samples it is given', () => {
    // A short English-looking title with an Arabic body is an Arabic article.
    expect(detectLocale('COD FAQ', 'الدفع عند الاستلام متاح لجميع الشحنات داخل مصر')).toBe('ar');
  });

  it('falls back to the default when there are no letters to read', () => {
    expect(detectLocale('')).toBe('en');
    expect(detectLocale('2026-08-18 — 12345')).toBe('en');
    expect(detectLocale(null, undefined)).toBe('en');
  });
});

describe('detectCategoryLocale', () => {
  it('follows the articles, not the category name', () => {
    // "FAQ" reads as English whatever language the articles are in.
    const result = detectCategoryLocale('FAQ', [
      'كيف أتتبع شحنتي',
      'متى تصل الشحنة',
      'كيفية إرجاع طلب',
    ]);

    expect(result.locale).toBe('ar');
    expect(result.disagreements).toBe(0);
  });

  it('reports articles that disagree with the category', () => {
    const result = detectCategoryLocale('شركاء شيب بلو', [
      'كيف أتتبع شحنتي',
      'متى تصل الشحنة',
      'How do I contact support',
    ]);

    expect(result.locale).toBe('ar');
    // Surfaced rather than silently filed: a genuinely mixed category needs a
    // person to split it, and this is how they find out.
    expect(result.disagreements).toBe(1);
  });

  it('uses the category name to break an exact tie', () => {
    expect(
      detectCategoryLocale('دليل الموظف', ['كيف أتتبع شحنتي', 'How do I track my shipment']).locale,
    ).toBe('ar');

    expect(
      detectCategoryLocale('Employee handbook', ['كيف أتتبع شحنتي', 'How do I track my shipment'])
        .locale,
    ).toBe('en');
  });

  it('falls back to the name when a category has no articles', () => {
    expect(detectCategoryLocale('عملاء شيب بلو', []).locale).toBe('ar');
    expect(detectCategoryLocale('ShipBlu partners', []).locale).toBe('en');
  });
});

describe('looksUntranslated', () => {
  it('catches a translation saved with the body left alone', () => {
    // The real one: Freshdesk article 154000223977, whose Arabic version has
    // the title ماجنتو and 2619 characters of the English Magento guide. Script
    // detection called it English and suggested it was in the wrong category; it
    // was in the right category and had never been translated.
    const body =
      'INSTALL PLUGIN\n\nClick Magento Plugin to download.\n\nRequirements\n * PHP >= 7.0';
    expect(looksUntranslated(body, body)).toBe(true);
  });

  it('ignores whitespace the editor rewrites on save', () => {
    expect(looksUntranslated('one  two\r\nthree', 'one two\nthree ')).toBe(true);
  });

  it('accepts a real translation', () => {
    expect(looksUntranslated('Track your shipment', 'تتبع شحنتك')).toBe(false);
  });

  it('does not flag a technical Arabic article that is mostly Latin', () => {
    // The case that makes body comparison the right test rather than script
    // counting: this is genuinely translated, and a script check would not
    // believe it.
    expect(
      looksUntranslated(
        'Set PHP >= 7.0 then run composer install',
        'اضبط PHP >= 7.0 ثم شغّل composer install',
      ),
    ).toBe(false);
  });

  it('says nothing about an empty original, having nothing to compare', () => {
    expect(looksUntranslated('', '')).toBe(false);
    expect(looksUntranslated(null, undefined)).toBe(false);
  });
});
