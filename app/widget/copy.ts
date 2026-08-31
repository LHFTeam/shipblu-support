import type { Locale } from '@/lib/kb/locale';

/**
 * The widget's own words.
 *
 * Separate from `STRINGS` in `lib/kb/locale.ts` because that table is the help
 * centre's, and the widget speaks in a different register — shorter, and in the
 * first person. Where a string genuinely already exists there and reads right in
 * a 380px panel, the components call `t()` rather than retranslating it here:
 * `searchPlaceholder`, `noResults` and `contactPrompt` all do.
 *
 * Arabic is not a translation of the English. It is the default locale and the
 * front door, so it is written to read as though nothing else existed.
 */
export const COPY = {
  en: {
    heading: 'ShipBlu Support',
    online: 'We usually reply in a few minutes',
    offline: 'We are away right now',
    opensAt: 'We reply from',
    placeholder: 'Type your message…',
    send: 'Send',
    starter: 'Ask us anything about your shipments.',
    suggested: 'These might help',

    faqHeading: 'Common questions',
    searchResults: 'Search results',
    back: 'Back',
    close: 'Close',
    readMore: 'Open in the help centre',
    talkToAgent: 'Chat with us',
    leaveMessage: 'Leave us a message',

    detailsPrompt: 'Nobody is here right now. Leave your details and we will get back to you.',
    namePlaceholder: 'Your name',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: 'Phone number',
    detailsHint: 'An email address or a phone number — either is enough.',
    detailsSaved: 'Thanks — we will get back to you.',
    detailsMissing: 'Leave an email address or a phone number so we can reply.',
    detailsInvalid: 'That does not look like an email address or a phone number.',
  },
  ar: {
    heading: 'دعم شيب بلو',
    online: 'نرد عادةً خلال دقائق',
    offline: 'لسنا متاحين الآن',
    opensAt: 'نرد ابتداءً من',
    placeholder: 'اكتب رسالتك…',
    send: 'إرسال',
    starter: 'اسألنا أي شيء عن شحناتك.',
    suggested: 'قد تساعدك هذه المقالات',

    faqHeading: 'الأسئلة الشائعة',
    searchResults: 'نتائج البحث',
    back: 'رجوع',
    close: 'إغلاق',
    readMore: 'افتح المقال في مركز المساعدة',
    talkToAgent: 'تحدث معنا',
    leaveMessage: 'اترك لنا رسالة',

    detailsPrompt: 'لا يوجد أحد متاح الآن. اترك بياناتك وسنعاود التواصل معك.',
    namePlaceholder: 'اسمك',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: 'رقم الهاتف',
    detailsHint: 'بريد إلكتروني أو رقم هاتف — أيهما يكفي.',
    detailsSaved: 'شكرًا — سنعاود التواصل معك.',
    detailsMissing: 'اترك بريدًا إلكترونيًا أو رقم هاتف حتى نتمكن من الرد.',
    detailsInvalid: 'هذا لا يبدو بريدًا إلكترونيًا أو رقم هاتف صحيحًا.',
  },
} as const;

/* Widened off the English keys: `as const` gives every string its own literal
   type, so the two locales are otherwise incompatible with each other. Keeping
   the keys exact is the half that matters — a string missing from one language
   is still a compile error. */
export type WidgetCopy = Record<keyof (typeof COPY)['en'], string>;

export function copyFor(locale: Locale): WidgetCopy {
  return COPY[locale];
}
