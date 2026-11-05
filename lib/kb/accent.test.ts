import { describe, expect, it } from 'vitest';
import { accentSplit } from './accent';

describe('accentSplit', () => {
  it('accents the last word of an English title', () => {
    expect(accentSplit('ShipBlu Partners', 'last')).toEqual({
      accent: 'last',
      rest: 'ShipBlu',
      word: 'Partners',
    });
    expect(accentSplit('Shipments & tracking', 'last')?.word).toBe('tracking');
  });

  it('accents the head of an Arabic title, never half the brand name', () => {
    expect(accentSplit('شركاء شيب بلو', 'first')).toEqual({
      accent: 'first',
      word: 'شركاء',
      rest: 'شيب بلو',
    });
    expect(accentSplit('عملاء شيب بلو', 'first')?.word).toBe('عملاء');
    expect(accentSplit('دعم تطبيق ماي بلو', 'first')?.word).toBe('دعم');
  });

  it("keeps the front page's last-word accent in Arabic", () => {
    expect(accentSplit('كيف يمكننا مساعدتك؟', 'last')?.word).toBe('مساعدتك؟');
  });

  it('draws a one-word title plain', () => {
    expect(accentSplit('FAQs', 'last')).toBeNull();
    expect(accentSplit('الماليات', 'first')).toBeNull();
    expect(accentSplit('  ', 'last')).toBeNull();
  });
});
