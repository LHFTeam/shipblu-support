/**
 * Locales for the public knowledge base.
 *
 * English and Arabic from the start rather than "English now, translations
 * later": RTL is not a stylesheet toggle, it changes layout, iconography and
 * URL structure, and retrofitting it means revisiting every page.
 */

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Arabic. ShipBlu's customers are Egyptian merchants and their recipients, and
 * the overwhelming majority of them read Arabic — so the front door of the help
 * centre opens in Arabic, and English is one click away rather than the other
 * way round. Every URL keeps its explicit locale segment; this only decides
 * where an unprefixed request lands.
 */
export const DEFAULT_LOCALE: Locale = 'ar';

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
    knowledgeBase: 'Knowledge base',
    mainNavLabel: 'Help centre navigation',
    breadcrumb: 'Breadcrumb',
    skipToContent: 'Skip to main content',
    language: 'Language',
    noticeLabel: 'Service notice',
    noticeMore: 'Read the update',
    heroEyebrow: 'Help centre',
    heroHeading: 'How can we help?',
    heroIntro:
      'Search for answers on shipments, pickups, returns and settlement. Most questions are answered here in under a minute.',
    searchPlaceholderHero: 'Search for an answer — e.g. “change a pickup address”',
    commonSearches: 'Common searches',
    browseTopics: 'Browse by topic',
    allArticles: 'All articles ({n})',
    mostRead: 'Most read',
    recentlyUpdated: 'Recently updated',
    inThisFolder: 'Articles in this folder',
    viewAll: 'View all',
    print: 'Print',
    footerRights: 'All rights reserved.',
    noResults: 'No articles matched that search.',
    resultsFor: 'Results for',
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
    contactIntro:
      'Have your tracking number or shipping account number to hand — it gets you to an answer faster.',
    supportOpen: 'Support is answering now.',
    supportClosed: 'Support is closed right now. Send it anyway — it is answered when we open.',
    supportOpensAt: 'Support opens again {when}.',
    channelTicketDetail: 'Describe the problem and attach photos.',
    channelTicketSla: 'Tracked, with a reference number',
    channelEmailSla: 'Answered within one business day',
    channelTicketsDetail: 'Follow up on something you have already sent.',
    channelTicketsSla: 'Every ticket you have raised, on any channel',

    // --- Tracking a shipment ---------------------------------------------
    trackTitle: 'Track a shipment',
    trackIntro: 'Expecting a parcel? Enter its tracking number for the latest status.',
    trackNumber: 'Tracking number',
    trackAction: 'Track shipment',
    trackHint: 'The tracking number is on your label, and in the SMS and email ShipBlu sent you.',
    trackAnother: 'Track another shipment',
    trackPrompt: 'Enter a tracking number to see where a parcel has got to.',
    trackNoStatusTitle: 'No delivery status for this number yet',
    trackNoStatus:
      'Check the tracking number and try again. If it is right, ShipBlu support can look the shipment up on the shipping platform and tell you where it has got to.',
    trackThrottled: 'Too many lookups from this connection. Try again in a minute.',
    trackLastUpdate: 'Last update',
    trackNoTimestamp: 'No time recorded for this update',
    trackAnswers: 'Answers for this status',
    trackAskSupport: 'Ask support about this shipment',
    trackPrivacyNote:
      'Anyone with this tracking number can see its status, so this page never shows a name, an address or a phone number.',
    trackHistory: 'History',
    trackEstimated: 'Estimated delivery',
    trackLive: 'Checked with the shipping platform just now',
    trackReturning:
      'This parcel is on its way back to the sender, so it will not be delivered to you. The merchant you ordered from can tell you what happens next.',
    trackStepPickedUp: 'Picked up',
    trackStepInTransit: 'In transit',
    trackStepOutForDelivery: 'Out for delivery',
    trackStepDelivered: 'Delivered',
    send: 'Send',
    feedbackPlaceholder: 'What were you looking for?',
    notFound: 'That page does not exist.',
    notFoundHint: 'It may have moved. Try searching for it.',
    csatQuestion: 'How did we do?',
    csatCommentPrompt: 'Anything you would like to add? (optional)',
    csatThanks: 'Thank you.',
    csatRecorded: 'Your feedback has been passed to the team.',
    csatAlreadyAnswered: 'You have already answered this survey.',

    // --- Sign-in and the customer portal ---------------------------------
    signIn: 'Sign in',
    signOut: 'Sign out',
    signingIn: 'Signing in…',
    signInTitle: 'Sign in',
    signInIntro: 'Customers and ShipBlu staff sign in here with the same form.',
    email: 'Email',
    password: 'Password',
    name: 'Name',
    forgotPassword: 'Forgotten your password?',
    createAccount: 'Create an account',
    createAccountTitle: 'Create an account',
    createAccountIntro:
      'Use the email address you contact ShipBlu support from, so your existing tickets appear.',
    noAccount: 'New here?',
    haveAccount: 'Already have an account?',
    submitting: 'Please wait…',

    checkYourEmail: 'Check your email',
    verificationSent:
      'If that address can be registered, we have sent it a link to confirm it. The link is valid for 24 hours.',
    verifySuccessTitle: 'Your email is confirmed',
    verifySuccess: 'You can sign in now.',
    verifyInvalidTitle: 'That link is no longer valid',
    verifyInvalid:
      'Confirmation links expire after 24 hours. Ask for a new one by signing up again.',

    forgotTitle: 'Reset your password',
    forgotIntro: 'We will email you a link to set a new password.',
    resetSent:
      'If that address has an account, we have sent it a link to set a new password. The link is valid for one hour.',
    resetTitle: 'Choose a new password',
    resetInvalidTitle: 'That link is no longer valid',
    resetInvalid: 'Password links expire after one hour. Ask for a new one.',
    resetSuccess: 'Your password has been changed. Sign in with it now.',
    newPassword: 'New password',
    savePassword: 'Save password',

    myTickets: 'My tickets',
    myTicketsIntro: 'Everything you have raised with ShipBlu support, on any channel.',
    noTickets: 'You have not contacted support yet.',
    ticketStatus: 'Status',
    ticketUpdated: 'Updated',
    openTicket: 'Contact support',
    newTicketTitle: 'Contact support',
    newTicketIntro: 'Tell us what you need and we will reply by email and here.',
    subject: 'Subject',
    message: 'Message',
    createTicket: 'Send',
    ticketCreated: 'Thanks — your request is with the team.',
    backToTickets: 'Back to my tickets',
    replyPlaceholder: 'Add to this conversation…',
    reply: 'Reply',
    replySent: 'Your reply has been added.',
    you: 'You',
    supportTeam: 'ShipBlu Support',
    searchKb: 'Search the help centre first — most answers are already there.',

    formsTitle: 'Contact support',
    formsIntro: 'Pick what this is about so we ask the right questions.',
    noForms: 'There is nothing to fill in yet. Write to us and we will pick it up.',
    formSignInNeeded: 'Sign in to use this form',
    formSubmitted: 'Thanks — your request is with us.',
    formTicketNumber: 'Your ticket number is #{n}.',
    formAnonymousNext: 'We will reply to the email address you gave.',
    formAttachmentFailed:
      'One of your files did not upload. Reply to this ticket to send it again.',
    yourName: 'Your name',
    yourEmail: 'Your email address',
    attachments: 'Attachments',
    attachmentsHint: 'Up to {n} files.',
    priority: 'Priority',
    priorityLow: 'Low',
    priorityMedium: 'Normal',
    priorityHigh: 'High',
    priorityUrgent: 'Urgent',
    optional: 'optional',

    errorCredentials: 'Email or password is incorrect',
    errorInvalidFields: 'Check the answers marked below',
    errorTooManyFiles: 'Too many files — attach {n} at most',
    errorFileTooLarge: 'That file is too big',
    errorFilesTooLarge: 'Those files are too big altogether',
    errorFileType: 'That kind of file cannot be attached',
    errorMissingFields: 'Fill in every field',
    errorThrottled: 'Too many attempts. Try again in a few minutes.',
    errorUnverified: 'Confirm your email address first — check your inbox for the link we sent.',
    errorPasswordShort: 'Password must be at least 12 characters',
    errorPasswordLong: 'Password must be at most 200 characters',
    errorInvalidEmail: 'Enter a valid email address',
    errorSubjectRequired: 'Give your request a subject',
    errorMessageRequired: 'Write your message',
    errorGeneric: 'Something went wrong. Try again.',
  },
  ar: {
    title: 'مركز مساعدة شيب بلو',
    searchPlaceholder: 'ابحث عن إجابة…',
    search: 'بحث',
    home: 'مركز المساعدة',
    knowledgeBase: 'قاعدة المعرفة',
    mainNavLabel: 'تنقّل مركز المساعدة',
    breadcrumb: 'مسار التنقل',
    skipToContent: 'الانتقال إلى المحتوى الرئيسي',
    language: 'اللغة',
    noticeLabel: 'إشعار خدمة',
    noticeMore: 'اقرأ التفاصيل',
    heroEyebrow: 'مركز المساعدة',
    heroHeading: 'كيف يمكننا مساعدتك؟',
    heroIntro:
      'ابحث عن إجابات حول الشحنات والاستلام والمرتجعات والتحصيل. أغلب الأسئلة تجد إجابتها هنا في أقل من دقيقة.',
    searchPlaceholderHero: 'ابحث عن إجابة — مثل «تغيير عنوان الاستلام»',
    commonSearches: 'الأكثر بحثًا',
    browseTopics: 'تصفّح حسب الموضوع',
    allArticles: 'كل المقالات ({n})',
    mostRead: 'الأكثر قراءة',
    recentlyUpdated: 'آخر ما تم تحديثه',
    inThisFolder: 'مقالات في هذا المجلد',
    viewAll: 'عرض الكل',
    print: 'طباعة',
    footerRights: 'جميع الحقوق محفوظة.',
    noResults: 'لا توجد مقالات مطابقة لهذا البحث.',
    resultsFor: 'نتائج البحث عن',
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
    contactIntro: 'جهّز رقم تتبّع الشحنة أو رقم حساب الشحن — يوصلك ذلك إلى إجابة أسرع.',
    supportOpen: 'الدعم يرد على الرسائل الآن.',
    supportClosed: 'الدعم مغلق الآن. أرسل طلبك على أي حال — سيُرد عليه فور فتحنا.',
    supportOpensAt: 'يفتح الدعم مرة أخرى {when}.',
    channelTicketDetail: 'اشرح المشكلة وأرفق الصور.',
    channelTicketSla: 'يُتابَع برقم مرجعي',
    channelEmailSla: 'الرد خلال يوم عمل واحد',
    channelTicketsDetail: 'تابع طلبًا سبق أن أرسلته.',
    channelTicketsSla: 'كل ما راسلت به الدعم، من أي قناة',

    // --- Tracking a shipment ---------------------------------------------
    trackTitle: 'تتبّع شحنة',
    trackIntro: 'تنتظر شحنة؟ أدخل رقم التتبّع لمعرفة آخر حالة لها.',
    trackNumber: 'رقم التتبّع',
    trackAction: 'تتبّع الشحنة',
    trackHint:
      'ستجد رقم التتبّع على البوليصة، وفي الرسالة النصية والبريد المرسلين إليك من شيب بلو.',
    trackAnother: 'تتبّع شحنة أخرى',
    trackPrompt: 'أدخل رقم التتبّع لمعرفة أين وصلت الشحنة.',
    trackNoStatusTitle: 'لا توجد حالة تسليم لهذا الرقم بعد',
    trackNoStatus:
      'راجع رقم التتبّع وحاول مرة أخرى. إذا كان الرقم صحيحًا فيستطيع دعم شيب بلو البحث عن الشحنة على منصة الشحن وإخبارك بمكانها.',
    trackThrottled: 'محاولات بحث كثيرة من هذا الاتصال. حاول مرة أخرى بعد دقيقة.',
    trackLastUpdate: 'آخر تحديث',
    trackNoTimestamp: 'لم يُسجَّل وقت لهذا التحديث',
    trackAnswers: 'إجابات لهذه الحالة',
    trackAskSupport: 'اسأل الدعم عن هذه الشحنة',
    trackPrivacyNote:
      'أي شخص يملك رقم التتبّع يستطيع رؤية حالة الشحنة، لذلك لا تعرض هذه الصفحة اسمًا أو عنوانًا أو رقم هاتف.',
    trackHistory: 'السجل',
    trackEstimated: 'موعد التسليم المتوقع',
    trackLive: 'تم التحقق من منصة الشحن الآن',
    trackReturning:
      'هذه الشحنة في طريقها للرجوع إلى الراسل، ولن يتم تسليمها لك. تواصل مع التاجر الذي طلبت منه لمعرفة الخطوة التالية.',
    trackStepPickedUp: 'تم الاستلام',
    trackStepInTransit: 'في الطريق',
    trackStepOutForDelivery: 'خرجت للتسليم',
    trackStepDelivered: 'تم التسليم',
    send: 'إرسال',
    feedbackPlaceholder: 'عمّ كنت تبحث؟',
    notFound: 'هذه الصفحة غير موجودة.',
    notFoundHint: 'ربما تم نقلها. جرّب البحث عنها.',
    csatQuestion: 'كيف كان تعاملنا معك؟',
    csatCommentPrompt: 'هل تود إضافة شيء؟ (اختياري)',
    csatThanks: 'شكرًا لك.',
    csatRecorded: 'تم إرسال رأيك إلى الفريق.',
    csatAlreadyAnswered: 'لقد أجبت على هذا الاستطلاع بالفعل.',

    // --- Sign-in and the customer portal ---------------------------------
    signIn: 'تسجيل الدخول',
    signOut: 'تسجيل الخروج',
    signingIn: 'جارٍ تسجيل الدخول…',
    signInTitle: 'تسجيل الدخول',
    signInIntro: 'يسجّل العملاء وفريق شيب بلو الدخول من هنا بالنموذج نفسه.',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    name: 'الاسم',
    forgotPassword: 'نسيت كلمة المرور؟',
    createAccount: 'إنشاء حساب',
    createAccountTitle: 'إنشاء حساب',
    createAccountIntro:
      'استخدم البريد الإلكتروني الذي تراسل منه دعم شيب بلو، حتى تظهر تذاكرك السابقة.',
    noAccount: 'أول مرة هنا؟',
    haveAccount: 'لديك حساب بالفعل؟',
    submitting: 'برجاء الانتظار…',

    checkYourEmail: 'راجع بريدك الإلكتروني',
    verificationSent:
      'إذا كان هذا البريد صالحًا للتسجيل فقد أرسلنا إليه رابطًا لتأكيده. الرابط صالح لمدة ٢٤ ساعة.',
    verifySuccessTitle: 'تم تأكيد بريدك الإلكتروني',
    verifySuccess: 'يمكنك تسجيل الدخول الآن.',
    verifyInvalidTitle: 'هذا الرابط لم يعد صالحًا',
    verifyInvalid:
      'تنتهي صلاحية روابط التأكيد بعد ٢٤ ساعة. اطلب رابطًا جديدًا بإنشاء الحساب مرة أخرى.',

    forgotTitle: 'إعادة تعيين كلمة المرور',
    forgotIntro: 'سنرسل إليك رابطًا لتعيين كلمة مرور جديدة.',
    resetSent:
      'إذا كان لهذا البريد حساب فقد أرسلنا إليه رابطًا لتعيين كلمة مرور جديدة. الرابط صالح لمدة ساعة.',
    resetTitle: 'اختر كلمة مرور جديدة',
    resetInvalidTitle: 'هذا الرابط لم يعد صالحًا',
    resetInvalid: 'تنتهي صلاحية روابط كلمة المرور بعد ساعة. اطلب رابطًا جديدًا.',
    resetSuccess: 'تم تغيير كلمة المرور. سجّل الدخول بها الآن.',
    newPassword: 'كلمة المرور الجديدة',
    savePassword: 'حفظ كلمة المرور',

    myTickets: 'تذاكري',
    myTicketsIntro: 'كل ما راسلت به دعم شيب بلو، من أي قناة.',
    noTickets: 'لم تتواصل مع الدعم بعد.',
    ticketStatus: 'الحالة',
    ticketUpdated: 'آخر تحديث',
    openTicket: 'تواصل مع الدعم',
    newTicketTitle: 'تواصل مع الدعم',
    newTicketIntro: 'اكتب لنا ما تحتاجه وسنرد عليك بالبريد الإلكتروني وهنا.',
    subject: 'الموضوع',
    message: 'الرسالة',
    createTicket: 'إرسال',
    ticketCreated: 'شكرًا لك — طلبك الآن لدى الفريق.',
    backToTickets: 'العودة إلى تذاكري',
    replyPlaceholder: 'أضف إلى هذه المحادثة…',
    reply: 'رد',
    replySent: 'تمت إضافة ردك.',
    you: 'أنت',
    supportTeam: 'دعم شيب بلو',
    searchKb: 'ابحث في مركز المساعدة أولًا — أغلب الإجابات موجودة بالفعل.',

    formsTitle: 'تواصل مع الدعم',
    formsIntro: 'اختر موضوع طلبك حتى نسألك الأسئلة المناسبة.',
    noForms: 'لا توجد نماذج بعد. راسلنا وسنتابع طلبك.',
    formSignInNeeded: 'سجّل الدخول لاستخدام هذا النموذج',
    formSubmitted: 'شكرًا — وصلنا طلبك.',
    formTicketNumber: 'رقم تذكرتك هو ‏#{n}‏.',
    formAnonymousNext: 'سنرد على البريد الإلكتروني الذي أدخلته.',
    formAttachmentFailed: 'تعذّر رفع أحد الملفات. رُدّ على هذه التذكرة لإرساله مرة أخرى.',
    yourName: 'اسمك',
    yourEmail: 'بريدك الإلكتروني',
    attachments: 'المرفقات',
    attachmentsHint: 'حتى {n} ملفات.',
    priority: 'الأولوية',
    priorityLow: 'منخفضة',
    priorityMedium: 'عادية',
    priorityHigh: 'مرتفعة',
    priorityUrgent: 'عاجلة',
    optional: 'اختياري',

    errorCredentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
    errorInvalidFields: 'راجع الإجابات المحددة بالأسفل',
    errorTooManyFiles: 'عدد الملفات كبير — أرفق {n} على الأكثر',
    errorFileTooLarge: 'حجم هذا الملف كبير',
    errorFilesTooLarge: 'حجم الملفات معًا كبير',
    errorFileType: 'لا يمكن إرفاق هذا النوع من الملفات',
    errorMissingFields: 'أكمل جميع الحقول',
    errorThrottled: 'محاولات كثيرة. حاول مرة أخرى بعد دقائق.',
    errorUnverified: 'أكّد بريدك الإلكتروني أولًا — ستجد الرابط في بريدك.',
    errorPasswordShort: 'يجب ألا تقل كلمة المرور عن ١٢ حرفًا',
    errorPasswordLong: 'يجب ألا تزيد كلمة المرور عن ٢٠٠ حرف',
    errorInvalidEmail: 'أدخل بريدًا إلكترونيًا صحيحًا',
    errorSubjectRequired: 'اكتب موضوعًا لطلبك',
    errorMessageRequired: 'اكتب رسالتك',
    errorGeneric: 'حدث خطأ ما. حاول مرة أخرى.',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['en'];

export function t(locale: Locale, key: StringKey): string {
  return STRINGS[locale][key];
}

/**
 * A string with a `{n}` in it, filled in with the reader's own numerals.
 *
 * Only for counts whose noun does not have to agree with the number — the
 * parenthesised form in `allArticles` is written that way precisely so it does
 * not. Anything where Arabic would need `مقالان` rather than `مقالات` goes
 * through `articleCount` and its plural rules instead.
 */
export function tCount(locale: Locale, key: StringKey, count: number): string {
  return t(locale, key).replace('{n}', formatCount(locale, count));
}

/**
 * Digits in the reader's own numerals.
 *
 * Arabic-Indic digits in Arabic, Latin in English. A count rendered with
 * `${n}` gets Latin digits either way, which in an otherwise Arabic sentence
 * reads as a placeholder somebody forgot to translate.
 */
export function formatCount(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-GB').format(value);
}

/**
 * "1 article", "4 articles", "مقال واحد", "٤ مقالات".
 *
 * Through `Intl.PluralRules` rather than a ternary on `n === 1`, because Arabic
 * has six plural categories and gets a different noun form for two, for three
 * to ten, and for eleven upwards. A hand-rolled English rule would have been
 * "1 articles" in Arabic dress.
 */
const ARTICLE_COUNT: Record<Locale, Partial<Record<Intl.LDMLPluralRule, string>>> = {
  en: { one: '{n} article', other: '{n} articles' },
  ar: {
    zero: 'لا مقالات',
    one: 'مقال واحد',
    two: 'مقالان',
    few: '{n} مقالات',
    many: '{n} مقالًا',
    other: '{n} مقال',
  },
};

export function articleCount(locale: Locale, count: number): string {
  const forms = ARTICLE_COUNT[locale];
  const rule = new Intl.PluralRules(locale === 'ar' ? 'ar-EG' : 'en-GB').select(count);
  const template = forms[rule] ?? forms.other!;
  return template.replace('{n}', formatCount(locale, count));
}

/**
 * A date *and* a clock time, for a delivery update.
 *
 * Latin digits even in Arabic, unlike `formatArticleDate` above and for the same
 * reason `formatOpening` forces them: this timestamp is printed beside a tracking
 * number, which is a Latin identifier whatever the page's language. `٢٤ أغسطس ·
 * ١٦:٠٤` next to `SB4820119` reads as two alphabets for the same idea, and
 * Egyptian screens — prices, phone numbers, the parcel numbers themselves — are
 * written in Latin digits.
 */
export function formatTimestamp(locale: Locale, value: Date | string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Cairo',
  }).format(new Date(value));
}

/**
 * A bare `YYYY-MM-DD` from the shipping platform, formatted as the day it names.
 *
 * **`timeZone: 'UTC'`, and that is the opposite of every other formatter here on
 * purpose.** A calendar date carries no time and no offset, so `new Date()`
 * fixes it to midnight UTC; formatting *that* instant in Africa/Cairo would move
 * it to 02:00 the same day, which is harmless — but the same code west of
 * Greenwich renders the day before, and the platform's estimated delivery date
 * would read as a day early for anyone reading from Europe or the Americas.
 * Formatting in the zone the parse implied is what makes the output the date the
 * platform actually sent, in every reader's location.
 *
 * Only for the platform's calendar dates. Anything that is a real instant —
 * every tracking event, every message — goes through `formatTimestamp`, which is
 * correct precisely because it converts to Cairo.
 */
export function formatCalendarDate(locale: Locale, value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;

  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(parsed);
}

/** Dates render in the reader's locale but always in ShipBlu's timezone. */
export function formatArticleDate(locale: Locale, value: Date | string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Africa/Cairo',
  }).format(new Date(value));
}
