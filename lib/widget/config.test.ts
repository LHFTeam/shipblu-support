import { describe, expect, it } from 'vitest';
import { parseWidgetConfig } from './config';

/**
 * The column this reads is untyped jsonb that predates the setting, so the
 * cases that matter are the malformed ones — production's own row is one of
 * them.
 */
describe('parseWidgetConfig', () => {
  const folder = '3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8';

  it("reads production's existing webchat row as nothing configured", () => {
    // The row was written by the channel form's catch-all branch, which stored
    // an address for every type that was not WhatsApp or Meta.
    expect(parseWidgetConfig({ address: '' })).toEqual({ faqFolders: {} });
  });

  it('keeps a folder per locale', () => {
    const other = '11111111-2222-4333-8444-555555555555';
    expect(parseWidgetConfig({ faqFolders: { ar: folder, en: other } })).toEqual({
      faqFolders: { ar: folder, en: other },
    });
  });

  it('keeps one locale when only one is set', () => {
    expect(parseWidgetConfig({ faqFolders: { ar: folder } })).toEqual({
      faqFolders: { ar: folder },
    });
  });

  it('drops a value that is not a uuid', () => {
    // It would otherwise reach a `where` clause, where Postgres raises rather
    // than returning no rows — a 500 in the widget instead of the FAQ fallback.
    expect(parseWidgetConfig({ faqFolders: { ar: 'the-faqs-folder' } })).toEqual({
      faqFolders: {},
    });
  });

  it('ignores a locale it does not serve', () => {
    expect(parseWidgetConfig({ faqFolders: { fr: folder } })).toEqual({ faqFolders: {} });
  });

  it.each([[null], [undefined], ['{}'], [[]], [{ faqFolders: null }], [{ faqFolders: [] }]])(
    'survives %o',
    (value) => {
      expect(parseWidgetConfig(value)).toEqual({ faqFolders: {} });
    },
  );
});
