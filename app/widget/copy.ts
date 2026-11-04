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

    /*
     * The composer's two buttons are named by these, and the sentences under
     * it say what went wrong with a file. `{name}` is the visitor's own file
     * name, drawn isolated from the sentence round it (`fillName`), since a
     * Latin name inside Arabic would otherwise reorder its neighbours.
     */
    attach: 'Attach a photo, video, voice recording or PDF',
    emoji: 'Add an emoji',
    emojiPanel: 'Emoji',
    removeFile: 'Remove {name}',
    sendFailed: 'That did not go through. Try again.',
    fileType: '{name} cannot be sent here. Photos, videos, voice recordings and PDFs can.',
    fileTooLarge: '{name} is larger than {limit}.',
    fileEmpty: '{name} is empty, so there is nothing in it to send.',
    filesTooLarge: 'These files add up to more than {limit}.',
    filesTooMany: 'Up to {count} files can go in one message.',
    filesSlowDown: 'That is a lot of files for now. Try again in a little while.',
    fileSending: 'Sending…',
    megabytes: 'MB',
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

    attach: 'إرفاق صورة أو فيديو أو تسجيل صوتي أو ملف PDF',
    emoji: 'إضافة رمز تعبيري',
    emojiPanel: 'الرموز التعبيرية',
    removeFile: 'إزالة {name}',
    sendFailed: 'لم يتم الإرسال. يمكن لحضرتك المحاولة مرة أخرى.',
    fileType:
      'لا يمكن إرسال {name} هنا. يمكن إرسال الصور والفيديوهات والتسجيلات الصوتية وملفات PDF.',
    fileTooLarge: 'حجم {name} أكبر من {limit}.',
    fileEmpty: 'الملف {name} فارغ ولا يحتوي على شيء لإرساله.',
    filesTooLarge: 'حجم الملفات معًا أكبر من {limit}.',
    filesTooMany: 'يمكن إرسال {count} ملفات بحد أقصى في الرسالة الواحدة.',
    filesSlowDown: 'تم إرسال ملفات كثيرة الآن. يمكن لحضرتك المحاولة بعد قليل.',
    fileSending: 'جارٍ الإرسال…',
    megabytes: 'ميجابايت',
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
