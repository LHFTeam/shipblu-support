/**
 * Locales for the public knowledge base.
 *
 * English and Arabic from the start rather than "English now, translations
 * later": RTL is not a stylesheet toggle, it changes layout, iconography and
 * URL structure, and retrofitting it means revisiting every page.
 */

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string | undefined): value is Locale {
  return LOCALES.includes(value as Locale);
}

export function direction(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
};

/** The handful of strings the public site needs, kept inline rather than in a i18n framework. */
const STRINGS = {
  en: {
    title: 'ShipBlu Support',
    searchPlaceholder: 'Search for an answer…',
    search: 'Search',
    home: 'Help centre',
    noResults: 'No articles matched that search.',
    resultsFor: 'Results for',
    articles: 'articles',
    wasHelpful: 'Was this article helpful?',
    yes: 'Yes',
    no: 'No',
    thanks: 'Thanks for the feedback.',
    updated: 'Last updated',
    relatedArticles: 'Related articles',
    backToHelp: 'Back to help centre',
    emptyCategory: 'Nothing published here yet.',
    contactPrompt: 'Still need help?',
    contactAction: 'Contact support',
    send: 'Send',
    feedbackPlaceholder: 'What were you looking for?',
    notFound: 'That page does not exist.',
    notFoundHint: 'It may have moved. Try searching for it.',
  },
  ar: {
    title: 'مركز مساعدة شيب بلو',
    searchPlaceholder: 'ابحث عن إجابة…',
    search: 'بحث',
    home: 'مركز المساعدة',
    noResults: 'لا توجد مقالات مطابقة لهذا البحث.',
    resultsFor: 'نتائج البحث عن',
    articles: 'مقالات',
    wasHelpful: 'هل كان هذا المقال مفيدًا؟',
    yes: 'نعم',
    no: 'لا',
    thanks: 'شكرًا لملاحظاتك.',
    updated: 'آخر تحديث',
    relatedArticles: 'مقالات ذات صلة',
    backToHelp: 'العودة إلى مركز المساعدة',
    emptyCategory: 'لا يوجد محتوى منشور هنا بعد.',
    contactPrompt: 'ما زلت بحاجة إلى مساعدة؟',
    contactAction: 'تواصل مع الدعم',
    send: 'إرسال',
    feedbackPlaceholder: 'عمّ كنت تبحث؟',
    notFound: 'هذه الصفحة غير موجودة.',
    notFoundHint: 'ربما تم نقلها. جرّب البحث عنها.',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['en'];

export function t(locale: Locale, key: StringKey): string {
  return STRINGS[locale][key];
}

/** Dates render in the reader's locale but always in ShipBlu's timezone. */
export function formatArticleDate(locale: Locale, value: Date | string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Africa/Cairo',
  }).format(new Date(value));
}
