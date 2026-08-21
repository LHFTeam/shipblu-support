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
    heroHeading: 'Hi, how can we help you?',
    browseTopics: 'Browse by topic',
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

    errorCredentials: 'Email or password is incorrect',
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
    heroHeading: 'مرحبًا، كيف يمكننا مساعدتك؟',
    browseTopics: 'تصفّح حسب الموضوع',
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

    errorCredentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
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

/** Dates render in the reader's locale but always in ShipBlu's timezone. */
export function formatArticleDate(locale: Locale, value: Date | string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Africa/Cairo',
  }).format(new Date(value));
}
