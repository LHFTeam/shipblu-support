import type { Locale } from '@/lib/kb/locale';
import { normaliseDigits } from './format';

/**
 * Reading a shipment's status label well enough to draw it.
 *
 * `shipments.status_label` is deliberately free text — the delivery vocabulary
 * belongs to the shipping platform, and `plans/shipment-customer-tracking.md`
 * explains why storing it as an enum would turn every ops rename into an
 * `ALTER TYPE`. That decision is unchanged. What the customer-facing tracking
 * page needs is something narrower: not a stored taxonomy, a *display* one.
 * Which of four steps is lit, which tone the badge takes, and nothing else.
 *
 * So this is a presentation mapping, one direction only, and it never writes
 * anything back. That is what makes an unrecognised label harmless: `unknown`
 * draws the label on its own, with no stepper and no invented tone, rather than
 * guessing a stage and telling a customer their parcel is somewhere it is not.
 *
 * The one thing the mapping does say out loud is the status itself, and only in
 * Arabic — `statusLabel` at the foot of this file has the reasoning, and it is
 * the reason the vocabulary table below carries a phrase per row rather than
 * only a stage. An English reader still gets the platform's own word.
 *
 * Matching is by keyword rather than exact string because the real labels are
 * still the open question the plan flags. A keyword table recognises
 * `Out for delivery`, `OUT_FOR_DELIVERY` and `خرجت للتسليم` alike, and the cost
 * of a miss is the honest `unknown` rendering rather than a wrong one.
 */

export type ShipmentStage =
  | 'created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'attempted'
  | 'delivered'
  | 'returned'
  | 'exception'
  | 'unknown';

/**
 * Which entry of the design system's logistics status taxonomy a stage wears.
 *
 * The system ships a canonical set — draft, scheduled, picked-up, in-transit,
 * out-for-delivery, delivered, attempted, on-hold, returned, exception, lost,
 * cancelled — each with its own background, foreground and dot. Only the ones a
 * stage below can reach are named here; the rest describe states this page has
 * no way to be shown.
 *
 * `out-for-delivery` is the reason this is a taxonomy rather than four tones. It
 * gets violet of its own instead of sharing blue with `in-transit`, which is
 * exactly the distinction a recipient checking their phone is looking for.
 */
export type StatusTone =
  | 'in-transit'
  | 'out-for-delivery'
  | 'delivered'
  | 'attempted'
  | 'returned'
  | 'exception'
  | 'unknown';

/**
 * The four steps a parcel walks, and the only ones a recipient cares about.
 *
 * Terminal states that leave the line — returned, held, lost — are not steps.
 * They are drawn as their own thing, because putting "returned to sender" on a
 * progress bar that ends in "delivered" says the parcel is still coming.
 */
export const TRACKING_STEPS = ['pickedUp', 'inTransit', 'outForDelivery', 'delivered'] as const;
export type TrackingStep = (typeof TRACKING_STEPS)[number];

export type StageDisplay = {
  stage: ShipmentStage;
  tone: StatusTone;
  /** Index into `TRACKING_STEPS`, or null when the stage is off that line. */
  step: number | null;
  /** True once nothing more will happen without somebody intervening. */
  terminal: boolean;
};

const DISPLAY: Record<ShipmentStage, Omit<StageDisplay, 'stage'>> = {
  // A parcel that exists and has not moved reads as `unknown` rather than
  // borrowing the system's `scheduled`: "created" is a fact about our record of
  // it, and a neutral badge is the honest way to say nothing has happened yet.
  created: { tone: 'unknown', step: 0, terminal: false },
  in_transit: { tone: 'in-transit', step: 1, terminal: false },
  out_for_delivery: { tone: 'out-for-delivery', step: 2, terminal: false },
  // Still on the line, and still at the same step: an attempt that failed did
  // not move the parcel backwards, it used one of the tries at the last step.
  attempted: { tone: 'attempted', step: 2, terminal: false },
  delivered: { tone: 'delivered', step: 3, terminal: true },
  returned: { tone: 'returned', step: null, terminal: true },
  exception: { tone: 'exception', step: null, terminal: false },
  unknown: { tone: 'unknown', step: null, terminal: false },
};

/**
 * The delivery vocabulary: one row per thing a status can mean.
 *
 * Rows carry three things, and they are in one table rather than three because
 * a row is useless without all of them. The stage decides the stepper and the
 * tone; `ar` is how the same fact reads to a customer on `/ar/track`; the
 * keywords are how a free-text label from the platform is recognised as this
 * row at all. Split across two tables, adding a keyword to one and forgetting
 * the other is a silent regression in exactly one direction — the Arabic page
 * quietly falling back to an English word — which is the bug this table shape
 * makes impossible to write.
 *
 * Order matters: the list is walked top-down and the first row with a hit wins,
 * so `failed delivery attempt` reaches `attempted` before `in_transit` could
 * claim it, and `returned to sender` never reads as `delivered`. Terminal and
 * exceptional states are therefore listed first, and inside a stage the more
 * specific reading comes before the general one.
 *
 * **Ten of these are no longer guesses.** `created`, `pickup_requested`,
 * `out_for_pickup`, `picked_up`, `in_transit`, `en_route`, `out_for_delivery`,
 * `delivery_attempted`, `delivered` and `return_to_origin` are the statuses
 * `api.shipblu.com` actually emits — the first eight read off a real delivery
 * order, the last two off every `tracking_events` entry stored in production.
 * Three of them — `pickup_requested`, `out_for_pickup` and `en_route` — reached
 * `unknown` before that was checked, which on the tracking page means a bare
 * label with no stepper and no tone for a large part of every parcel's life.
 * Reading the stored events rather than one order is what turned up the other
 * two, and it is the check to repeat before trusting this table: the platform's
 * vocabulary is bigger than any single parcel shows. The rest of the table stays
 * a keyword reading of free text, still `unknown` rather than a guess when
 * nothing matches.
 *
 * A keyword matches as a whole word or whole phrase, not as a substring. That is
 * the difference between `new` meaning a freshly created shipment and `new`
 * matching the middle of `renewed`; with separators already flattened to single
 * spaces it still covers `out_for_delivery`, `Out-For-Delivery` and
 * `OUT FOR DELIVERY` from one entry. Word forms that a platform might use
 * interchangeably are listed out rather than stemmed — six extra strings beat a
 * stemmer that has to be right in two languages.
 */
const VOCABULARY: ReadonlyArray<{
  stage: ShipmentStage;
  /**
   * The Arabic reading of this row, and only Arabic.
   *
   * There is no `en` column because there is nothing to put in it: the platform
   * writes its statuses in English, so `humaniseStatus` already shows an English
   * reader the platform's own word — which is the property `/en/track` is meant
   * to have (see `statusLabel`). A column that restated those words in ours
   * would be a second English vocabulary to keep in step with ShipBlu's, for no
   * reader.
   *
   * Each string says only what its keywords establish. Where a row covers
   * several outcomes that a customer would act on differently — cancelled,
   * lost, damaged — they are separate rows rather than one reassuring phrase
   * covering all three.
   */
  ar: string;
  keywords: readonly string[];
}> = [
  { stage: 'exception', ar: 'أُلغيت الشحنة', keywords: ['cancelled', 'canceled', 'ملغي', 'ملغاة'] },
  { stage: 'exception', ar: 'الشحنة مفقودة', keywords: ['lost', 'مفقود', 'مفقودة'] },
  { stage: 'exception', ar: 'الشحنة تالفة', keywords: ['damaged', 'تالف', 'تالفة'] },
  {
    stage: 'exception',
    ar: 'الشحنة متوقفة مؤقتًا',
    keywords: ['on hold', 'held', 'معلق', 'معلقة'],
  },
  {
    stage: 'exception',
    ar: 'الشحنة قيد المراجعة',
    keywords: ['exception', 'investigation', 'قيد المراجعة'],
  },
  {
    stage: 'returned',
    ar: 'مرتجعة إلى الراسل',
    keywords: [
      'return to origin',
      'returned to sender',
      'return',
      'returns',
      'returned',
      'returning',
      'rto',
      'مرتجع',
      'مرتجعة',
      'اعادة للراسل',
      'إعادة للراسل',
    ],
  },
  {
    stage: 'delivered',
    ar: 'تم التسليم',
    keywords: [
      'delivered',
      'completed',
      'handed over',
      'تم التسليم',
      'تم التوصيل',
      'مسلمة',
      'تم الاستلام',
    ],
  },
  {
    stage: 'attempted',
    ar: 'لم يرد المستلم',
    keywords: ['unreachable', 'no answer', 'not answering', 'لم يرد'],
  },
  {
    stage: 'attempted',
    ar: 'تم تأجيل التسليم',
    keywords: ['rescheduled', 'postponed', 'اعادة جدولة', 'إعادة جدولة', 'مؤجل', 'مؤجلة'],
  },
  {
    stage: 'attempted',
    ar: 'تعذّر التسليم',
    keywords: ['attempt', 'attempts', 'attempted', 'failed attempt', 'محاولة', 'تعذر التسليم'],
  },
  {
    stage: 'out_for_delivery',
    ar: 'خرجت للتسليم',
    keywords: [
      'out for delivery',
      'with courier',
      'with the courier',
      'on the way',
      'ofd',
      'خرجت للتسليم',
      'خرج للتسليم',
      'مع المندوب',
      'في الطريق',
    ],
  },
  {
    stage: 'in_transit',
    // The platform's own linehaul step. Observed immediately *before*
    // `in_transit` on delivery day rather than as a synonym for the courier
    // being at the door, so it belongs here and not in `out_for_delivery` —
    // which is where the English reading of the words alone would put it.
    ar: 'في الطريق إلى الفرع',
    keywords: ['en route', 'line haul', 'في الطريق للفرع'],
  },
  {
    stage: 'in_transit',
    ar: 'تم استلام الشحنة من التاجر',
    keywords: ['picked up', 'pickup complete', 'collected', 'تم الاستلام من التاجر', 'تم الشحن'],
  },
  {
    stage: 'in_transit',
    ar: 'وصلت إلى الفرع',
    keywords: ['received at', 'arrived at', 'at hub', 'بالفرع'],
  },
  { stage: 'in_transit', ar: 'غادرت الفرع', keywords: ['departed'] },
  { stage: 'in_transit', ar: 'جارٍ الفرز', keywords: ['sorting', 'sorted', 'فرز'] },
  { stage: 'in_transit', ar: 'الشحنة في الطريق', keywords: ['in transit', 'transit'] },
  {
    stage: 'created',
    // Both are pre-pickup: the parcel is still the merchant's, and a courier
    // being *sent to collect it* has not moved it. Reading either as transit
    // would tell a recipient their parcel is on its way while it is still on a
    // shelf in the shop.
    ar: 'خرج المندوب لاستلام الشحنة',
    keywords: ['out for pickup'],
  },
  { stage: 'created', ar: 'تم طلب استلام الشحنة', keywords: ['pickup requested'] },
  {
    stage: 'created',
    ar: 'بانتظار الاستلام من التاجر',
    keywords: [
      'awaiting pickup',
      'pending pickup',
      'ready for pickup',
      'في انتظار الاستلام',
      'بانتظار الاستلام',
    ],
  },
  {
    stage: 'created',
    ar: 'تم إنشاء الشحنة',
    keywords: ['created', 'draft', 'new', 'scheduled', 'booked', 'تم الإنشاء', 'تم الانشاء'],
  },
];

/**
 * Everything that makes two spellings of the same label look different: case,
 * Arabic-Indic digits, and the separators a platform picks between words.
 *
 * `normaliseDigits` is here rather than in the caller for the same reason it is
 * in `normaliseTrackingNumber` — half the inbound volume is Arabic, and a status
 * label carrying `محاولة ٢` must match the same keyword as `محاولة 2`.
 */
function flatten(label: string): string {
  const flat = normaliseDigits(label)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Padded, so `includes(' delivered ')` is a whole-word test rather than a
  // substring one, at both ends of the string as well as in the middle.
  return flat ? ` ${flat} ` : '';
}

/**
 * The vocabulary row a label names, or null when nothing in the table matches.
 *
 * One walk shared by `stageFor` and `statusLabel`, so a badge can never show the
 * Arabic of one row while the stepper is drawn from another.
 */
function rowFor(label: string | null | undefined): (typeof VOCABULARY)[number] | null {
  if (!label) return null;
  const flat = flatten(label);
  if (!flat) return null;

  return (
    VOCABULARY.find((row) => row.keywords.some((keyword) => flat.includes(` ${keyword} `))) ?? null
  );
}

/** The stage a label names, or `unknown` when nothing in the table matches. */
export function stageFor(label: string | null | undefined): ShipmentStage {
  return rowFor(label)?.stage ?? 'unknown';
}

/** The stage plus everything the tracking page draws from it. */
export function stageDisplay(label: string | null | undefined): StageDisplay {
  const stage = stageFor(label);
  return { stage, ...DISPLAY[stage] };
}

/**
 * A platform status token, made readable — typography, not translation.
 *
 * The platform sends machine tokens: `out_for_delivery`, `pickup_requested`.
 * Printing one raw puts an underscore in front of a reader; replacing the
 * separators and capitalising the first letter changes neither the word nor the
 * language — `out_for_delivery` and `Out for delivery` are the same string to a
 * reader and only one of them looks like a database column.
 *
 * This is what an English reader sees, and what the agent console shows in every
 * language: the platform's own word, so an agent reading a ticket and the ops
 * team reading their own dashboard are looking at the same string. Arabic goes
 * through `statusLabel` below instead.
 *
 * A no-op on Arabic, which carries no separators to replace and has no case for
 * `toUpperCase` to change.
 */
export function humaniseStatus(label: string): string {
  const flat = label.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}

/** True of any string carrying a letter from the Arabic script. */
const ARABIC_SCRIPT = /\p{Script=Arabic}/u;

/**
 * A status as the reader of one locale should see it.
 *
 * `/ar/track` is the front door — Arabic is the default locale, and the people
 * who reach the tracking page are Egyptian recipients holding a parcel number,
 * not merchants with a platform login. Showing them `Out for delivery` in the
 * middle of an Arabic page is not a "the platform's own word" nicety; for a
 * reader with no English it is no word at all, on the one line of the page they
 * came to read.
 *
 * So the Arabic page translates, and the English page does not. The concern that
 * kept the label verbatim — that a customer would read one thing here and
 * another in the SMS ShipBlu sent about the same parcel — is real but it is a
 * concern about *disagreeing*, and an English sentence an Arabic reader cannot
 * decode does not agree with the SMS either. Where our phrase and ShipBlu's own
 * Arabic wording differ, `VOCABULARY` above is the single place to bring them
 * into line.
 *
 * Two things it will not do:
 *
 * - **Translate a label it does not recognise.** No row matched means we never
 *   established what the label says, and inventing an Arabic phrase for it would
 *   put a fact on the page that nothing in the payload supports. It falls back
 *   to the platform's word, which is the same honest gap the `unknown` stage
 *   already leaves in the stepper and the badge tone.
 * - **Rewrite Arabic into Arabic.** A label already in the reader's script is
 *   the platform's own Arabic, and swapping it for our phrasing of the same
 *   thing would be churn with a chance of being wrong — the keyword table
 *   carries Arabic spellings so the *stage* still reads correctly, which is all
 *   that is needed once the words themselves are already legible.
 */
export function statusLabel(locale: Locale, label: string | null | undefined): string {
  if (!label) return '';
  if (locale !== 'ar' || ARABIC_SCRIPT.test(label)) return humaniseStatus(label);
  return rowFor(label)?.ar ?? humaniseStatus(label);
}
