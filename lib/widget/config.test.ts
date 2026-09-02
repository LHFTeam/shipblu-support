import { describe, expect, it } from 'vitest';
import { offerableFaqFolders, parseWidgetConfig, resolveFaqFolders } from './config';

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

/**
 * The rule that keeps the staff handbook out of a panel embedded on a customer's
 * website. Production has four `agents_only` folders whose articles are each
 * marked `published`/`public`, so the pairing these cases describe is real data.
 */
describe('resolveFaqFolders', () => {
  const folders = [
    {
      id: 'c6fb7f9f-97f6-488b-827d-091a72738c67',
      name: 'الأسئلة الشائعة',
      categoryName: 'شركاء شيب بلو',
      categoryLocale: 'ar',
      visibility: 'public',
    },
    {
      id: '6c75acee-febe-4ee9-8f26-56b298517ced',
      name: 'FAQs',
      categoryName: 'ShipBlu Partners',
      categoryLocale: 'en',
      visibility: 'public',
    },
    {
      id: '11111111-2222-4333-8444-555555555555',
      name: 'ساعات العمل',
      categoryName: 'دليل الموظف',
      categoryLocale: 'ar',
      visibility: 'agents_only',
    },
  ];

  it('accepts a public folder in the locale it was offered under', () => {
    expect(resolveFaqFolders({ ar: folders[0]!.id, en: folders[1]!.id }, folders)).toEqual({
      folders: { ar: folders[0]!.id, en: folders[1]!.id },
    });
  });

  it('refuses the staff handbook rather than saving a choice that shows nothing', () => {
    const result = resolveFaqFolders({ ar: folders[2]!.id }, folders);
    expect(result).toEqual({ error: expect.stringContaining('not public') });
  });

  it('never offers the staff handbook in the first place', () => {
    expect(offerableFaqFolders(folders).map((folder) => folder.name)).toEqual([
      'الأسئلة الشائعة',
      'FAQs',
    ]);
  });

  it('refuses an Arabic folder chosen for the English slot', () => {
    // A folder has no locale of its own, so the slot is the only thing tying it
    // to a language — and `getArticle` does filter on locale, so every article
    // in a crossed-over list would 404 when tapped.
    expect(resolveFaqFolders({ en: folders[0]!.id }, folders)).toEqual({
      error: expect.stringContaining('not in a en category'),
    });
  });

  it('refuses an id that matches no folder', () => {
    expect(resolveFaqFolders({ ar: '99999999-9999-4999-8999-999999999999' }, folders)).toEqual({
      error: expect.stringContaining('no longer exists'),
    });
  });

  it('treats an unset slot as "use the fallback", not as an error', () => {
    expect(resolveFaqFolders({ ar: '', en: undefined }, folders)).toEqual({ folders: {} });
  });
});
