import { anchored, normaliseForMatch } from './normalise';

/**
 * What words mean which category.
 *
 * Compiled, in code, with tests — deliberately not rows in the registry table an
 * admin edits. A regular expression typed into a form is a production incident
 * with no review: `(a+)+$` over every inbound message is a denial of service and
 * a stray `.*` files the archive under one label. The table owns what a category
 * is *called*; this owns what it *means*, and the two join on the key.
 *
 * ## Grades, not probabilities
 *
 * A rules engine has no posterior, so `grade` is not a chance of being right. It
 * says how directly the matched thing names the category, and it exists to be
 * thresholded on:
 *
 * - **0.90 — quoted.** The whole message, normalised, equals a known phrase.
 *   There is no room for it to be about something else.
 * - **0.70 — anchored.** Two or more content words in a fixed order, inside a
 *   longer message.
 * - **0.55 — keyword.** One content word. Enough to raise the question, not to
 *   answer it — everything at this grade lands in the review queue.
 *
 * ## The asymmetry these are written for
 *
 * A missed category shows up as `meta.unclassified`, which has its own section
 * on the review page, and a re-run repairs it. A wrong one silently moves a number a
 * manager staffs a team from, and nobody goes looking for a label that should
 * not be there. So every pattern here is written to under-match: no rule on a
 * bare noun that could belong to any area, no rule short enough to appear inside
 * a longer word, and no rule that fires on a word the whole corpus uses.
 *
 * Patterns are written in **normalised** form — `ة` as `ه`, `أ` as `ا`, `ى` as
 * `ي` — because `normaliseForMatch` has already folded the message that way. A
 * pattern written with unfolded letters matches nothing, which is the one
 * mistake to look for first when a rule appears dead.
 */

export type Grade = 0.9 | 0.7 | 0.55;

/**
 * The anchored grade, named rather than written as `0.7` at the one place that
 * reasons about it.
 *
 * `combine()` branches here: evidence below this grade is a single content word,
 * and a pile of single words is held short of the auto-apply band no matter how
 * many of them agree. Anything at or above it is two or more words in a fixed
 * order, which is allowed to accumulate past that line.
 */
export const ANCHORED_GRADE = 0.7;

export type PatternRule = {
  /** Written to `rule_key`; reports group on it to find a rule that over-fires. */
  key: string;
  category: string;
  grade: Grade;
  pattern: RegExp;
};

export type PhraseRule = {
  key: string;
  category: string;
  /** Already normalised. Compared for equality against the whole message. */
  phrase: string;
};

/**
 * Arabic proclitics — و ف ب ل ك and the definite article — made optional.
 *
 * Arabic writes these joined to the word, so `والاوردر` is one token and a rule
 * for `اوردر` will not see it: `anchored()` correctly refuses to match inside a
 * word, and this is what gives the word its real boundaries back.
 */
function ar(stem: string): string {
  return `(?:[وفبلك]?(?:ال)?)${stem}`;
}

/** Any of these stems, with proclitics allowed on each. */
function arAny(...stems: string[]): string {
  return `(?:${stems.map(ar).join('|')})`;
}

/** The parcel, however the customer names it. */
const PARCEL = arAny('شحنه', 'شحنتي', 'اوردر', 'اوردري', 'طلب', 'طلبي', 'باكدج', 'باكيدج');
const COURIER = arAny('مندوب', 'كابتن', 'الدليفري', 'دليفري');

/**
 * Whole-message phrases.
 *
 * Only for messages that are *entirely* the phrase, so there is no room for the
 * rest of a sentence to change the meaning. This is where the short, unambiguous
 * openers land — the ones that would be far too dangerous as substring rules.
 */
export const PHRASES: readonly PhraseRule[] = [
  { key: 'phrase.greeting.salam', category: 'service.request_human', phrase: 'السلام عليكم' },
  { key: 'phrase.greeting.salam2', category: 'service.request_human', phrase: 'سلام عليكم' },
  { key: 'phrase.greeting.morning', category: 'service.request_human', phrase: 'صباح الخير' },
  { key: 'phrase.greeting.evening', category: 'service.request_human', phrase: 'مساء الخير' },
  { key: 'phrase.thanks.ar', category: 'service.praise', phrase: 'شكرا' },
  { key: 'phrase.thanks.ar2', category: 'service.praise', phrase: 'شكرا جزيلا' },
  { key: 'phrase.thanks.en', category: 'service.praise', phrase: 'thank you' },
  { key: 'phrase.thanks.en2', category: 'service.praise', phrase: 'thanks' },
  { key: 'phrase.where.bare', category: 'delivery.where_is_it', phrase: 'فين شحنتي' },
  { key: 'phrase.where.bare2', category: 'delivery.where_is_it', phrase: 'فين الاوردر' },
  { key: 'phrase.where.bare3', category: 'delivery.where_is_it', phrase: 'فين الشحنه' },
  { key: 'phrase.where.bare4', category: 'delivery.where_is_it', phrase: 'الاوردر فين' },
  { key: 'phrase.cancel.bare', category: 'return.request', phrase: 'الغاء' },
  { key: 'phrase.cancel.bare2', category: 'return.request', phrase: 'cancel' },
  { key: 'phrase.pricelist.en', category: 'commercial.pricing_enquiry', phrase: 'price list' },

  // The most common free-text message in the whole archive, and four of its
  // neighbours. `تمام` alone appears 61 times in a 769-message sample.
  { key: 'phrase.ack.tamam', category: 'service.acknowledgement', phrase: 'تمام' },
  { key: 'phrase.ack.tamam2', category: 'service.acknowledgement', phrase: 'تمم' },
  { key: 'phrase.ack.ok', category: 'service.acknowledgement', phrase: 'اوك' },
  { key: 'phrase.ack.ok_en', category: 'service.acknowledgement', phrase: 'ok' },
  { key: 'phrase.ack.aywa', category: 'service.acknowledgement', phrase: 'ايوه' },
  { key: 'phrase.ack.received', category: 'service.acknowledgement', phrase: 'تم الاستلام' },
  { key: 'phrase.ack.arrived', category: 'service.acknowledgement', phrase: 'الشحنه وصلت' },
  { key: 'phrase.ack.correct', category: 'service.acknowledgement', phrase: 'مظبوط' },

  // Somebody expecting a person on the other end, with nothing else said.
  { key: 'phrase.hello.alo', category: 'service.request_human', phrase: 'الو' },
  { key: 'phrase.hello.en', category: 'service.request_human', phrase: 'hello' },
  { key: 'phrase.hello.hi', category: 'service.request_human', phrase: 'hi' },
  { key: 'phrase.please.ar', category: 'service.request_human', phrase: 'لو سمحت' },
  { key: 'phrase.cs.ar', category: 'service.request_human', phrase: 'خدمه عملاء' },
  { key: 'phrase.cs.en', category: 'service.request_human', phrase: 'customer service' },

  { key: 'phrase.eta.date', category: 'delivery.eta_request', phrase: 'تاريخ التوصيل' },
  { key: 'phrase.eta.when', category: 'delivery.eta_request', phrase: 'امتي' },
  { key: 'phrase.pay.cash', category: 'payment.method', phrase: 'كاش' },
  { key: 'phrase.pay.cod_en', category: 'payment.method', phrase: 'cash on delivery' },
  {
    key: 'phrase.greeting.salam_long',
    category: 'service.request_human',
    phrase: 'السلام عليكم ورحمه الله وبركاته',
  },
  { key: 'phrase.ack.tamam_thanks', category: 'service.acknowledgement', phrase: 'تمام شكرا' },
  { key: 'phrase.no_contact.closed', category: 'delivery.no_contact', phrase: 'مغلق' },
  { key: 'phrase.no_contact.closed2', category: 'delivery.no_contact', phrase: 'مقفول' },
  { key: 'phrase.chasing.updates', category: 'service.chasing', phrase: 'any updates' },
  { key: 'phrase.chasing.update', category: 'service.chasing', phrase: 'any update' },
];

/**
 * Anchored patterns, in the order they are declared.
 *
 * Order does not decide the winner — every rule that matches contributes — but
 * it does decide which `rule_key` is recorded when two rules award the same
 * category, so the more specific rule is declared first.
 */
export const PATTERNS: readonly PatternRule[] = [
  // -- delivery ------------------------------------------------------------
  {
    // "it says delivered and I never got it". The most serious thing in the
    // list, so it is matched on the *conjunction* rather than either half: on
    // its own, "التتبع" is a tracking question and "مستلمتش" is a plain
    // non-delivery, and only together do they accuse a scan of being false.
    key: 'ar.delivery.false_scan',
    category: 'delivery.not_received_marked_delivered',
    grade: 0.7,
    pattern: anchored(
      `(?:${arAny('تتبع')}|مكتوب|مسجل|بيقول)[^.!?]{0,40}(?:استلمت|تم التسليم|delivered)`,
    ),
  },
  {
    key: 'en.delivery.false_scan',
    category: 'delivery.not_received_marked_delivered',
    grade: 0.7,
    pattern: anchored(`(?:says|marked|shows)[^.!?]{0,30}delivered`),
  },
  {
    key: 'ar.delivery.not_received',
    category: 'delivery.where_is_it',
    grade: 0.7,
    pattern: anchored(`(?:وانا|بس انا|و انا)?\\s*(?:م(?:ست|تس)لمت?ي?ش|لم ا(?:ست|تس)لم)`),
  },
  {
    key: 'ar.delivery.nothing_arrived',
    category: 'delivery.where_is_it',
    grade: 0.7,
    pattern: anchored(`(?:مفيش حاجه|محدش جه|موصل[يى]?ش|مج[اي]ش|مجتش|لسه موصل[يى]?ش)`),
  },
  {
    key: 'ar.delivery.where',
    category: 'delivery.where_is_it',
    grade: 0.7,
    pattern: anchored(
      `(?:فين|وين|اين)\\s*(?:${PARCEL}|${COURIER})|(?:${PARCEL}|${COURIER})\\s*(?:فين|وين|اين)`,
    ),
  },
  {
    key: 'en.delivery.where',
    category: 'delivery.where_is_it',
    grade: 0.7,
    pattern: anchored(`where(?:'?s| is)\\s+(?:my\\s+)?(?:order|parcel|package|shipment)`),
  },
  {
    key: 'ar.delivery.tracking',
    category: 'delivery.where_is_it',
    grade: 0.55,
    pattern: anchored(arAny('تتبع')),
  },
  {
    key: 'ar.delivery.when',
    category: 'delivery.eta_request',
    grade: 0.7,
    pattern: anchored(
      `(?:ه?[يت]وصل|ه?[يت]جي|ه?ستلم|هستلمه)\\s*(?:امتي|امته|امتا|متي)|(?:امتي|امته|امتا|متي)\\s*(?:ه?[يت]وصل|ه?[يت]جي|ه?ستلم)`,
    ),
  },
  {
    key: 'ar.delivery.what_time',
    category: 'delivery.eta_request',
    grade: 0.7,
    pattern: anchored(`${arAny('ساعه')}\\s*كام`),
  },
  {
    key: 'ar.delivery.late',
    category: 'delivery.late',
    grade: 0.7,
    pattern: anchored(`(?:ا?تاخر[تهوي]{0,2}|تاخير)`),
  },
  {
    key: 'en.delivery.late',
    category: 'delivery.late',
    grade: 0.7,
    pattern: anchored(`(?:is |been )?(?:late|delayed|overdue)`),
  },
  {
    key: 'ar.delivery.no_contact',
    category: 'delivery.no_contact',
    grade: 0.7,
    pattern: anchored(
      `(?:محدش (?:كلمني|اتصل|تواصل|اتواصل)|مكلمنيش|متواصلش معايا|لم يتم التواصل|مفيش حد اتصل)`,
    ),
  },
  {
    key: 'ar.delivery.phone_off',
    category: 'delivery.no_contact',
    grade: 0.7,
    pattern: anchored(`${arAny('تليفون', 'موبايل')}\\s*(?:مغلق|مقفول)`),
  },
  {
    key: 'ar.delivery.attempt_disputed',
    category: 'delivery.failed_attempt',
    grade: 0.7,
    pattern: anchored(
      `${arAny('محاوله')}[^.!?]{0,20}(?:متت|تمت|حصلت|غير ناجحه)|محدش حاول|${arAny('محاوله')}\\s*${arAny('فاشله')}`,
    ),
  },
  {
    key: 'ar.delivery.reschedule',
    category: 'delivery.reschedule',
    grade: 0.7,
    pattern: anchored(
      `(?:تاجيل|اجل|ارجاء|تغيير|غير|اغير)\\s*(?:${arAny('موعد', 'ميعاد', 'تاريخ', 'يوم')})`,
    ),
  },
  {
    key: 'ar.delivery.not_available',
    category: 'delivery.reschedule',
    grade: 0.7,
    pattern: anchored(`(?:مش|مش هكون|لن اكون|مانا مش)\\s*(?:متواجد|متواجده|موجود|موجوده)`),
  },
  {
    key: 'en.delivery.reschedule',
    category: 'delivery.reschedule',
    grade: 0.7,
    pattern: anchored(`reschedul\\w*|change the (?:date|day)`),
  },
  {
    key: 'ar.delivery.address_change',
    category: 'delivery.address_change',
    grade: 0.7,
    pattern: anchored(`(?:تغيير|اغير|غير|عايز اغير|تعديل)\\s*${arAny('عنوان')}`),
  },
  {
    key: 'ar.delivery.location_share',
    category: 'delivery.address_change',
    grade: 0.55,
    pattern: anchored(`${arAny('لوكيشن')}`),
  },
  {
    key: 'ar.delivery.access',
    category: 'delivery.access_constraint',
    grade: 0.7,
    pattern: anchored(
      `${arAny('عنوان')}\\s*${arAny('مكتب')}|${arAny('ايام')}\\s*${arAny('عمل')}|${arAny('بوابه')}\\s*${arAny('مغلقه')}`,
    ),
  },
  {
    key: 'ar.delivery.refuse',
    category: 'delivery.refused',
    grade: 0.7,
    pattern: anchored(`(?:مش هستلم|لن استلم|مش عايز استلم|ارفض الاستلام)`),
  },

  // -- condition -----------------------------------------------------------
  {
    key: 'ar.condition.damaged',
    category: 'condition.damaged',
    grade: 0.7,
    pattern: anchored(`(?:تالف|تالفه|مكسور|مكسوره|اتكسر|اتكسرت|مضروب|مضروبه)`),
  },
  {
    key: 'en.condition.damaged',
    category: 'condition.damaged',
    grade: 0.7,
    pattern: anchored(`damaged|broken`),
  },
  {
    key: 'ar.condition.wrong_item',
    category: 'condition.wrong_item',
    grade: 0.7,
    pattern: anchored(`(?:منتج|حاجه|صنف)\\s*(?:غلط|تاني|مختلف)|مش اللي طلبت\\w*`),
  },
  {
    key: 'ar.condition.missing',
    category: 'condition.missing_items',
    grade: 0.7,
    pattern: anchored(`(?:ناقص|ناقصه|ناقصين|مش كامل|مش كامله)`),
  },
  {
    key: 'ar.condition.packaging',
    category: 'condition.packaging',
    grade: 0.7,
    pattern: anchored(`${arAny('تغليف')}|${arAny('باكينج')}`),
  },

  // -- pickup --------------------------------------------------------------
  {
    key: 'ar.pickup.not_collected',
    category: 'pickup.not_collected',
    grade: 0.7,
    pattern: anchored(
      `(?:محدش (?:جه|استلم|خد)|مفيش حد (?:جه|استلم))[^.!?]{0,30}(?:شحن|اوردر|بضاعه)?`,
    ),
  },
  {
    key: 'ar.pickup.schedule',
    category: 'pickup.schedule',
    grade: 0.7,
    pattern: anchored(`(?:موعد|ميعاد|تاريخ)\\s*${arAny('استلام', 'بيك')}|${arAny('بيك اب')}`),
  },
  {
    key: 'ar.pickup.point_change',
    category: 'pickup.point_change',
    grade: 0.7,
    pattern: anchored(`(?:تغيير|غير)\\s*${arAny('نقطه')}`),
  },
  {
    key: 'ar.pickup.supplies',
    category: 'pickup.supplies',
    grade: 0.7,
    pattern: anchored(`${arAny('فلايرز', 'اكياس')}|مستلزمات|${arAny('كرتون')}`),
  },
  {
    key: 'en.pickup.supplies',
    category: 'pickup.supplies',
    grade: 0.7,
    pattern: anchored(`(?:packaging |shipping )?(?:supplies|flyers|white bag)`),
  },

  // -- return --------------------------------------------------------------
  {
    key: 'ar.return.cancel',
    category: 'return.request',
    grade: 0.7,
    pattern: anchored(
      `(?:الغاء|الغي|هلغي|بلغي|لغيت|كنسل|كنسلت|${ar('استرجاع')})\\s*(?:${PARCEL}|الشحن)?`,
    ),
  },
  {
    key: 'en.return.cancel',
    category: 'return.request',
    grade: 0.7,
    pattern: anchored(`cancel(?:led|lation)?\\s*(?:the\\s*)?(?:order|shipment|parcel)?`),
  },
  {
    key: 'ar.return.request',
    category: 'return.request',
    grade: 0.7,
    pattern: anchored(`(?:عايز|عاوز|عايزه|اريد|حابب)\\s*(?:ارجع|استرجع|ارجعه)`),
  },
  {
    key: 'ar.return.status',
    category: 'return.status',
    grade: 0.7,
    pattern: anchored(`${arAny('مرتجع', 'المرتجعات')}`),
  },
  {
    key: 'ar.return.exchange',
    category: 'return.exchange',
    grade: 0.7,
    pattern: anchored(`${arAny('استبدال', 'تبديل')}|exchange`),
  },

  // -- payment -------------------------------------------------------------
  {
    key: 'ar.payment.cod_dispute',
    category: 'payment.cod_dispute',
    grade: 0.7,
    pattern: anchored(`${arAny('مبلغ')}\\s*(?:غلط|خطا|مختلف|زياده|اكتر)|${arAny('سعر')}\\s*غلط`),
  },
  {
    key: 'ar.payment.paid_not_delivered',
    category: 'payment.cod_dispute',
    grade: 0.7,
    pattern: anchored(`تم الدفع[^.!?]{0,40}(?:مسلمنيش|لم يسلمني|مستلمتش)`),
  },
  {
    key: 'ar.payment.fod',
    category: 'payment.fod',
    grade: 0.7,
    pattern: anchored(`${arAny('رسوم')}\\s*${arAny('توصيل', 'شحن')}|fees on delivery|\\bfod\\b`),
  },
  {
    key: 'ar.payment.refund',
    category: 'payment.refund',
    grade: 0.7,
    pattern: anchored(`${arAny('استرداد')}|فلوسي فين|رجعوا فلوسي|refund`),
  },

  // -- billing -------------------------------------------------------------
  {
    key: 'ar.billing.payout',
    category: 'billing.payout',
    grade: 0.7,
    pattern: anchored(`${arAny('مستحقات', 'تحويلات')}|${arAny('تحويل')}\\s*${arAny('اسبوعي')}`),
  },
  {
    key: 'en.billing.payout',
    category: 'billing.payout',
    grade: 0.7,
    pattern: anchored(`payout|instant payout|weekly transfer`),
  },
  {
    key: 'ar.billing.wallet',
    category: 'billing.wallet',
    grade: 0.7,
    pattern: anchored(`${arAny('محفظه')}|wallet`),
  },
  {
    key: 'ar.billing.invoice',
    category: 'billing.invoice',
    grade: 0.7,
    pattern: anchored(`${arAny('فاتوره', 'فواتير')}|invoice`),
  },
  {
    key: 'ar.billing.pricing_mine',
    category: 'billing.pricing',
    grade: 0.7,
    pattern: anchored(`${arAny('اسعار')}\\s*${arAny('حسابي')}|${arAny('تسعير')}`),
  },
  {
    key: 'ar.billing.discrepancy',
    category: 'billing.discrepancy',
    grade: 0.7,
    pattern: anchored(
      `${arAny('خصم')}\\s*(?:غلط|زياده)|اتخصم مني|${arAny('رسوم')}\\s*(?:غلط|زياده)`,
    ),
  },

  // -- account -------------------------------------------------------------
  {
    key: 'ar.account.signup',
    category: 'account.signup',
    grade: 0.7,
    pattern: anchored(`(?:ا?فتح|انشاء|ا?عمل)\\s*${arAny('حساب', 'اكونت')}|عايز اشترك`),
  },
  {
    key: 'en.account.signup',
    category: 'account.signup',
    grade: 0.7,
    pattern: anchored(`(?:create|open|sign ?up for)\\s*(?:an?\\s*)?account`),
  },
  {
    key: 'ar.account.access',
    category: 'account.access',
    grade: 0.7,
    pattern: anchored(
      `${arAny('باسورد')}|كلمه المرور|مش عارف ادخل|${arAny('حسابات')}\\s*${arAny('فرعيه')}`,
    ),
  },
  {
    key: 'en.account.access',
    category: 'account.access',
    grade: 0.7,
    pattern: anchored(`(?:reset |forgot )?password|can'?t log ?in|sub-?accounts?`),
  },

  // -- integration ---------------------------------------------------------
  {
    key: 'en.integration.platform',
    category: 'integration.setup',
    grade: 0.7,
    pattern: anchored(`shopify|magento|woo ?commerce|zammit|salla|wix`),
  },
  {
    key: 'ar.integration.link',
    category: 'integration.setup',
    grade: 0.7,
    pattern: anchored(`${arAny('ربط')}\\s*${arAny('متجر', 'موقع', 'نظام')}`),
  },
  {
    key: 'en.integration.api',
    category: 'integration.api',
    grade: 0.7,
    pattern: anchored(`\\bapi\\b|webhook|integration (?:tool|doc)`),
  },
  {
    key: 'ar.integration.sync',
    category: 'integration.sync_issue',
    grade: 0.7,
    pattern: anchored(`${arAny('اوردرات')}\\s*(?:مش بتيجي|مش ظاهره|مش بتنزل)`),
  },

  // -- commercial ----------------------------------------------------------
  {
    key: 'ar.commercial.pricing',
    category: 'commercial.pricing_enquiry',
    grade: 0.7,
    pattern: anchored(`${arAny('اسعار')}|${arAny('سعر')}\\s*${arAny('شحن')}|قائمه الاسعار`),
  },
  {
    key: 'en.commercial.pricing',
    category: 'commercial.pricing_enquiry',
    grade: 0.7,
    pattern: anchored(`price ?list|pricing|rates|how much do you charge`),
  },
  {
    key: 'ar.commercial.coverage',
    category: 'commercial.coverage',
    grade: 0.7,
    pattern: anchored(
      `${arAny('مناطق')}\\s*${arAny('تغطيه', 'خدمه')}|بتشحنوا (?:ل|في)|${arAny('تغطيه')}`,
    ),
  },
  {
    key: 'ar.commercial.capability',
    category: 'commercial.capability',
    grade: 0.7,
    pattern: anchored(`قابل للكسر|${arAny('ممنوعات')}|بتشحنوا (?:منتجات|حاجات)|${arAny('مسموح')}`),
  },
  {
    key: 'en.commercial.capability',
    category: 'commercial.capability',
    grade: 0.7,
    pattern: anchored(`fragile|forbidden|prohibited items|do you ship`),
  },
  {
    key: 'ar.commercial.contract',
    category: 'commercial.contract',
    grade: 0.7,
    pattern: anchored(`${arAny('تعاقد', 'تعاقدات')}|${arAny('عقد')}\\s*${arAny('جديد')}`),
  },
  {
    key: 'ar.commercial.product',
    category: 'commercial.product_info',
    grade: 0.7,
    pattern: anchored(`${arAny('شيلد')}|ماي بلو|myblu|shipblu shield|try ?(?:&|and) ?buy`),
  },
  {
    key: 'ar.commercial.claim',
    category: 'commercial.claim',
    grade: 0.7,
    pattern: anchored(`${arAny('تعويض')}|${arAny('مطالبه')}|claim`),
  },

  // -- service -------------------------------------------------------------
  {
    key: 'ar.service.request_human',
    category: 'service.request_human',
    grade: 0.7,
    pattern: anchored(
      `${arAny('رقم')}\\s*(?:للتواصل|تواصل|خدمه)|${arAny('خدمه')}\\s*${arAny('عملاء')}|(?:عايز|عايزه|محتاج|محتاجه)\\s*(?:اكلم\\s*)?حد|حد\\s*(?:يتواصل|يكلمني|يرد)`,
    ),
  },
  {
    key: 'ar.service.courier_number',
    category: 'service.request_human',
    grade: 0.7,
    pattern: anchored(`${arAny('رقم')}\\s*${COURIER}`),
  },
  {
    key: 'ar.service.chasing',
    category: 'service.chasing',
    grade: 0.7,
    pattern: anchored(
      `(?:ممكن رد|ارجو الرد|برجاء الرد|مفيش رد|لسه مفيش رد|برجاء التواصل|ارجو التواصل|ارجو المتابعه|في انتظار)`,
    ),
  },
  {
    key: 'ar.service.complaint',
    category: 'service.complaint',
    grade: 0.7,
    pattern: anchored(`${arAny('شكوي', 'شكوه')}|اشتكي`),
  },
  {
    key: 'en.service.complaint',
    category: 'service.complaint',
    grade: 0.7,
    pattern: anchored(`complaint|complain`),
  },

  // -- payment method ------------------------------------------------------
  {
    key: 'ar.payment.method',
    category: 'payment.method',
    grade: 0.7,
    pattern: anchored(
      `(?:هدفع|ادفع|بدفع)\\s*${arAny('كاش', 'فيزا')}|${arAny('طرق')}\\s*${arAny('دفع')}`,
    ),
  },
  {
    key: 'en.payment.method',
    category: 'payment.method',
    grade: 0.7,
    pattern: anchored(`cash on deliv\\w*|pay (?:by|with) (?:card|cash|visa)`),
  },

  // -- a bare date or day name ---------------------------------------------
  //
  // Anchored to the *whole* message, not a substring: on its own, `يوم السبت`
  // or `24/8` is somebody answering "when suits you", which is a reschedule.
  // The same words inside a sentence mean nothing on their own, which is why
  // this cannot be a substring rule.
  {
    key: 'ar.reschedule.bare_date',
    category: 'delivery.reschedule',
    grade: 0.55,
    pattern:
      /^(?:يوم\s*)?(?:السبت|الاحد|الحد|الاتنين|الاثنين|الثلاثاء|التلات|الاربعاء|الاربع|الخميس|الجمعه|بكره|النهارده|انهارده|غدا|بعد بكره|\d{1,2}\s*[/\-]\s*\d{1,2}(?:\s*[/\-]\s*\d{2,4})?|يوم\s*\d{1,2})$/u,
  },

  // -- Franco-Arab, and why it is here -------------------------------------
  //
  // Egyptians write Arabic in Latin script constantly, and a 400-row sample of
  // the real free-text corpus is full of it: `Fen el order???`,
  // `El order ha eegy emta`, `Ana msh ayza el order daaa`,
  // `Momken tego badry el s3a 9 el sob7`. An Arabic-script-only lexicon is
  // blind to all of it, which is the single largest recall gap the corpus
  // showed — and it would have been invisible without reading the corpus,
  // because none of it appears in a dictionary or a phrasebook.
  //
  // Kept to the handful of intents that actually show up, at keyword grade, so
  // everything lands in the review queue: transliteration has no spelling, so
  // these will need tuning against corrections rather than reasoning.
  {
    key: 'fr.delivery.where',
    category: 'delivery.where_is_it',
    grade: 0.55,
    pattern: anchored(`fe?[ei]n\\s+(?:el\\s*)?(?:order|shipment|shi?[pb]na)`),
  },
  {
    key: 'fr.delivery.when',
    category: 'delivery.eta_request',
    grade: 0.55,
    pattern: anchored(`(?:emta+|emtaa+|el wa'?t emta+)|ha\\s*[ei]e?gy\\s*emta+`),
  },
  {
    key: 'fr.return.cancel',
    category: 'return.request',
    grade: 0.55,
    pattern: anchored(`(?:msh|mesh)\\s+(?:ayza|3ayez|aiza|awz)\\s+(?:el\\s*)?order`),
  },

  // -- English, written naturally ------------------------------------------
  //
  // A real gap the corpus exposed. Merchants and a fair number of recipients
  // write full English sentences, and the first pass of this lexicon only
  // matched English in the terse forms an Arabic speaker would use. Everything
  // below is lifted from messages actually received.
  {
    key: 'en.delivery.eta',
    category: 'delivery.eta_request',
    grade: 0.7,
    pattern: anchored(
      `when (?:is|will|can|do) (?:it|the order|my order|i)[^.!?]{0,30}(?:arrive|come|coming|receive|get)|when will i receive`,
    ),
  },
  {
    key: 'en.delivery.tomorrow',
    category: 'delivery.reschedule',
    grade: 0.7,
    pattern: anchored(
      `can (?:i|it|you)[^.!?]{0,25}(?:tomorrow|today|sunday|monday|tuesday|wednesday|thursday|saturday)`,
    ),
  },
  {
    key: 'en.delivery.address_change',
    category: 'delivery.address_change',
    grade: 0.7,
    pattern: anchored(`(?:edit|change|update)[^.!?]{0,15}(?:location|address)`),
  },
  {
    key: 'en.service.request_human',
    category: 'service.request_human',
    grade: 0.7,
    pattern: anchored(
      `(?:can|could) (?:someone|somebody|anyone)[^.!?]{0,20}(?:contact|call|help)|speak to (?:someone|an agent)|customer (?:service|support)`,
    ),
  },
  {
    key: 'en.service.chasing',
    category: 'service.chasing',
    grade: 0.7,
    pattern: anchored(`any (?:update|news)s?|still waiting|no (?:one|body) (?:has )?repl`),
  },
  {
    key: 'en.delivery.unrecognised',
    category: 'delivery.unrecognised',
    grade: 0.7,
    pattern: anchored(`what(?:'?s| is) this (?:order|shipment|parcel)|(?:da|dah) order eh`),
  },
  {
    key: 'fr.payment.cash',
    category: 'payment.method',
    grade: 0.55,
    pattern: anchored(`ha?\\s*(?:a)?dfa3?\\s*cash|hadfaa? cash`),
  },

  // -- A dropped pin or a pasted address -----------------------------------
  //
  // Dominant in the corpus, because it is what the bot asks for and what a
  // customer sends an agent when told the address is wrong. A maps link is
  // unambiguous, so it is graded above the address-shaped guess.
  {
    key: 'any.address.maps_link',
    category: 'delivery.address_change',
    grade: 0.7,
    pattern: /(?:maps\.app\.goo\.gl|maps\.google\.com|goo\.gl\/maps|share\.google)/i,
  },
  {
    key: 'ar.address.shaped',
    category: 'delivery.address_change',
    grade: 0.55,
    pattern: anchored(
      `${arAny('دور')}\\s*${arAny('الاول', 'الثاني', 'الثالث', 'الرابع')}|${arAny('شقه')}\\s*\\d|${arAny('عماره')}\\s*\\d|${arAny('كمبوند', 'كومباوند')}`,
    ),
  },

  // -- "What shipment?" ----------------------------------------------------
  {
    key: 'ar.delivery.unrecognised',
    category: 'delivery.unrecognised',
    grade: 0.7,
    pattern: anchored(
      `${PARCEL}\\s*(?:ايه|اي|عباره عن ايه)|(?:ده|دي|ديه)\\s*${PARCEL}\\s*ايه|ايه\\s*${PARCEL}|انا مطلبتش`,
    ),
  },

  // -- Wrongness, which needs the noun to mean anything --------------------
  //
  // `غلط` on its own could be about any of five areas, so every rule using it
  // is anchored to what is wrong. This is the shape that keeps a very common
  // word from becoming a very common mis-categorisation.
  {
    key: 'ar.condition.wrong_parcel',
    category: 'condition.wrong_item',
    grade: 0.7,
    pattern: anchored(`${PARCEL}\\s*(?:ديه|دي|ده)?\\s*غلط`),
  },
  {
    key: 'ar.address.wrong',
    category: 'delivery.address_change',
    grade: 0.7,
    pattern: anchored(`${arAny('عنوان', 'لوكيشن')}\\s*غلط|غلط\\s*${arAny('عنوان', 'لوكيشن')}`),
  },
  {
    key: 'ar.contact.wrong_number',
    category: 'delivery.no_contact',
    grade: 0.7,
    pattern: anchored(`${arAny('رقم', 'ارقام')}\\s*(?:غلط|مغلق|مقفول|مغلقه)`),
  },
  {
    key: 'ar.payment.surcharge',
    category: 'payment.cod_dispute',
    grade: 0.7,
    pattern: anchored(`${arAny('قيمه')}[^.!?]{0,30}${arAny('زياده')}|جنيه\\s*${arAny('زياده')}`),
  },

  // -- Somebody else's robot, and referral spam ----------------------------
  //
  // Both are abundant in the corpus and neither is a customer. Other
  // merchants' WhatsApp autoresponders arrive on our channels reading exactly
  // like a person, and referral-link spam arrives from real phone numbers.
  {
    key: 'ar.other.autoresponder',
    category: 'other.spam',
    grade: 0.7,
    pattern: anchored(
      `شكرا (?:لك )?(?:علي|على) (?:رسالتك|تواصلك)|شكرا لتواصلك|شكرا لرسالتكم|سنقوم بالرد|سنرد عليك|لسنا متوفرين`,
    ),
  },
  {
    key: 'any.other.referral_spam',
    category: 'other.spam',
    grade: 0.7,
    pattern: /(?:temu\.com|accept my invit|win freebies|احصل عليه الان من هنا)/i,
  },

  // -- other ---------------------------------------------------------------
  {
    key: 'ar.other.job',
    category: 'other.job_application',
    grade: 0.7,
    pattern: anchored(
      `${arAny('وظيفه', 'وظائف', 'توظيف')}|${arAny('فرص')}\\s*${arAny('شغل', 'عمل')}|${arAny('سيره')}\\s*${arAny('ذاتيه')}`,
    ),
  },
  {
    key: 'en.other.job',
    category: 'other.job_application',
    grade: 0.7,
    pattern: anchored(`vacanc(?:y|ies)|job (?:opening|opportunit)|hiring|\\bcv\\b|resume`),
  },
  {
    key: 'ar.other.partnership',
    category: 'other.partnership_offer',
    grade: 0.7,
    pattern: anchored(`${arAny('مناديب')}|(?:اخد|اخذ)\\s*${arAny('شغل')}|${arAny('شراكه')}|موزع`),
  },
  {
    key: 'ar.other.spam_promo',
    category: 'other.spam',
    grade: 0.7,
    pattern: anchored(`${arAny('وجبه')}\\s*${arAny('مجانيه')}|${arAny('عرض')}\\s*${arAny('خاص')}`),
  },
  {
    key: 'en.other.autoresponder',
    category: 'other.spam',
    grade: 0.7,
    pattern: anchored(
      `thank you for contacting|we'?re unavailable right now|we will respond as soon as`,
    ),
  },
];

/**
 * Rules an operator has turned off, read straight from `process.env`.
 *
 * **Not through `env()`**, for the reason `lib/shipments/detect.ts` sets out at
 * length: that validates the whole schema, and this module is reachable from the
 * ingest path and from a page render, so going through it would make a missing
 * unrelated variable break categorisation. The variable is still declared in
 * `lib/env.ts` so that file stays the catalogue of what this system reads.
 *
 * This is the control that matters in an incident. A rule found to be filing
 * half the queue under one label is switched off from the Render dashboard in
 * the time it takes to restart, rather than in the time it takes to ship a
 * deploy. There is deliberately no matching way to *add* a pattern: turning one
 * off is safe and reversible, and adding one is a regex in an env var.
 */
export function disabledRuleKeys(): ReadonlySet<string> {
  const raw = process.env.CATEGORISE_DISABLED_RULES ?? '';
  return new Set(
    raw
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

let phraseCache: ReadonlyMap<string, PhraseRule> | null = null;

/**
 * The phrase table, keyed for one lookup of a whole normalised message.
 *
 * Built once. It normalises every phrase on the way in, and this runs on the
 * ingest path for every message — rebuilding the map each time would normalise
 * the whole table per message for no reason.
 */
export function phraseIndex(): ReadonlyMap<string, PhraseRule> {
  if (phraseCache) return phraseCache;
  const index = new Map<string, PhraseRule>();
  for (const rule of PHRASES) index.set(normaliseForMatch(rule.phrase), rule);
  phraseCache = index;
  return index;
}
