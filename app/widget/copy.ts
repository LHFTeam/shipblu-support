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
    /*
     * Shown whenever `page.tsx` finds the schedule open — not whenever an agent
     * is present, which nothing here knows. So it says we are open and nothing
     * more: never a response time, which is a promise the schedule cannot keep.
     */
    online: 'Online now',
    offline: 'We are away right now',
    opensAt: 'We reply from',
    placeholder: 'Type your message…',
    send: 'Send',
    starter: 'Ask us anything about your shipments.',
    suggested: 'These might help',
    automated: 'Automated reply',

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

    surveyClosed: 'This survey has closed.',
    surveyFailed: 'That did not go through. Try again.',
  },
  ar: {
    heading: 'دعم شيب بلو',
    online: 'متاحون الآن',
    offline: 'لسنا متاحين الآن',
    opensAt: 'نرد ابتداءً من',
    placeholder: 'اكتب رسالتك…',
    send: 'إرسال',
    starter: 'نحن هنا لأي سؤال عن شحنات حضرتك.',
    suggested: 'قد تساعدك هذه المقالات',
    automated: 'رد آلي',

    faqHeading: 'الأسئلة الشائعة',
    searchResults: 'نتائج البحث',
    back: 'رجوع',
    close: 'إغلاق',
    readMore: 'فتح المقال في مركز المساعدة',
    talkToAgent: 'تحدث معنا',
    leaveMessage: 'اترك لنا رسالة',

    detailsPrompt: 'لا يوجد أحد متاح الآن. يمكن لحضرتك ترك البيانات وسنعاود التواصل.',
    namePlaceholder: 'الاسم',
    emailPlaceholder: 'you@example.com',
    phonePlaceholder: 'رقم الهاتف',
    detailsHint: 'بريد إلكتروني أو رقم هاتف — أيهما يكفي.',
    detailsSaved: 'شكرًا — سنعاود التواصل مع حضرتك.',
    detailsMissing: 'البريد الإلكتروني أو رقم الهاتف مطلوب حتى نتمكن من الرد.',
    detailsInvalid: 'هذا لا يبدو بريدًا إلكترونيًا أو رقم هاتف صحيحًا.',

    surveyClosed: 'تم إغلاق هذا الاستطلاع.',
    surveyFailed: 'لم يتم الإرسال. يمكن لحضرتك المحاولة مرة أخرى.',
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
