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

/**
 * The steps a parcel walks on its way *back* to the merchant.
 *
 * A second line rather than more steps on the first one, because the two end in
 * different places and only one of them is the recipient's. Once a return is
 * under way the outbound bar is not merely paused — its last step, "Delivered",
 * is never going to happen — so continuing to draw it tells the one person
 * reading the page the opposite of the truth. `docs/PROJECT-STATE.md` §6.40
 * records the live parcel that was doing exactly that.
 *
 * The vocabulary is ShipBlu's own, given by the people who run it: a return
 * opens with `return_to_origin`, moves under the same `in_transit` / `en_route`
 * events the outbound leg uses, goes out with the courier as `out_for_return`
 * (or `return_attempted`, which is the same step tried again), and finishes as
 * `returned`.
 */
export const RETURN_STEPS = ['returningToSender', 'onTheWay', 'outForReturn', 'returned'] as const;
export type ReturnStep = (typeof RETURN_STEPS)[number];

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
 * One entry of a phrase table: what it means, how it is recognised, and how it
 * reads in Arabic when nobody has overridden it.
 */
/**
 * Admin-saved wording, keyed by `Phrase.key`. A key with no entry keeps the
 * default compiled into this file.
 */
export type PhraseOverrides = Readonly<Record<string, string>>;

type Phrase = {
  /**
   * The stable name this row is stored and overridden under.
   *
   * It is the row's identity, not its wording: an admin's override in
   * `shipment_phrases` points at this key, so renaming one silently drops that
   * override back to the default. Add a row rather than repurposing a key.
   */
  key: string;
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
   * A *default*, not the last word: `/admin/tracking` overrides any of these
   * without a deploy, because whether a phrase matches ShipBlu's own Arabic is
   * a question for the people who write ShipBlu's Arabic.
   *
   * Each string says only what its keywords establish. Where a row covers
   * several outcomes that a customer would act on differently — cancelled,
   * lost, damaged — they are separate rows rather than one reassuring phrase
   * covering all three.
   */
  ar: string;
  keywords: readonly string[];
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
const VOCABULARY: ReadonlyArray<Phrase & { stage: ShipmentStage }> = [
  {
    key: 'cancelled',
    stage: 'exception',
    ar: 'أُلغيت الشحنة',
    keywords: ['cancelled', 'canceled', 'ملغي', 'ملغاة'],
  },
  { key: 'lost', stage: 'exception', ar: 'الشحنة مفقودة', keywords: ['lost', 'مفقود', 'مفقودة'] },
  {
    key: 'damaged',
    stage: 'exception',
    ar: 'الشحنة تالفة',
    keywords: ['damaged', 'تالف', 'تالفة'],
  },
  {
    key: 'on_hold',
    stage: 'exception',
    ar: 'الشحنة متوقفة مؤقتًا',
    keywords: ['on hold', 'held', 'معلق', 'معلقة'],
  },
  {
    key: 'under_review',
    stage: 'exception',
    ar: 'الشحنة قيد المراجعة',
    keywords: ['exception', 'investigation', 'قيد المراجعة'],
  },
  {
    key: 'returned',
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
    key: 'delivered',
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
    key: 'unreachable',
    stage: 'attempted',
    ar: 'لم يرد المستلم',
    keywords: ['unreachable', 'no answer', 'not answering', 'لم يرد'],
  },
  {
    key: 'rescheduled',
    stage: 'attempted',
    ar: 'تم تأجيل التسليم',
    keywords: ['rescheduled', 'postponed', 'اعادة جدولة', 'إعادة جدولة', 'مؤجل', 'مؤجلة'],
  },
  {
    key: 'attempted',
    stage: 'attempted',
    ar: 'محاولة تسليم غير ناجحة',
    keywords: ['attempt', 'attempts', 'attempted', 'failed attempt', 'محاولة', 'تعذر التسليم'],
  },
  {
    key: 'out_for_delivery',
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
    key: 'en_route',
    stage: 'in_transit',
    // The platform's own linehaul step. Observed immediately *before*
    // `in_transit` on delivery day rather than as a synonym for the courier
    // being at the door, so it belongs here and not in `out_for_delivery` —
    // which is where the English reading of the words alone would put it.
    ar: 'في الطريق إلى الفرع',
    keywords: ['en route', 'line haul', 'في الطريق للفرع'],
  },
  {
    key: 'picked_up',
    stage: 'in_transit',
    ar: 'تم استلام الشحنة من التاجر',
    keywords: ['picked up', 'pickup complete', 'collected', 'تم الاستلام من التاجر', 'تم الشحن'],
  },
  {
    key: 'at_hub',
    stage: 'in_transit',
    ar: 'وصلت إلى الفرع',
    keywords: ['received at', 'arrived at', 'at hub', 'بالفرع'],
  },
  { key: 'departed', stage: 'in_transit', ar: 'غادرت الفرع', keywords: ['departed'] },
  {
    key: 'sorting',
    stage: 'in_transit',
    ar: 'جارٍ الفرز',
    keywords: ['sorting', 'sorted', 'فرز'],
  },
  {
    key: 'in_transit',
    stage: 'in_transit',
    ar: 'الشحنة في الطريق',
    keywords: ['in transit', 'transit'],
  },
  {
    key: 'out_for_pickup',
    stage: 'created',
    // Both this and `pickup_requested` are pre-pickup: the parcel is still the
    // merchant's, and a courier being *sent to collect it* has not moved it.
    // Reading either as transit would tell a recipient their parcel is on its
    // way while it is still on a shelf in the shop.
    ar: 'خرج المندوب لاستلام الشحنة',
    keywords: ['out for pickup'],
  },
  {
    key: 'pickup_requested',
    stage: 'created',
    ar: 'تم طلب استلام الشحنة',
    keywords: ['pickup requested'],
  },
  {
    key: 'awaiting_pickup',
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
    key: 'created',
    stage: 'created',
    ar: 'تم إنشاء الشحنة',
    keywords: ['created', 'draft', 'new', 'scheduled', 'booked', 'تم الإنشاء', 'تم الانشاء'],
  },
];

/**
 * The return leg's vocabulary: one row per step of the journey back.
 *
 * A table of its own rather than more rows in `VOCABULARY`, because the same
 * word means a different thing on each leg. `in_transit` outbound is "your
 * parcel is on its way to you"; the identical event during a return is "on its
 * way back to the shop". One table cannot hold both readings of one keyword, and
 * the reading depends on something no label carries — which leg the parcel is
 * on. `returnProgress` establishes that from `rto_requested` and the event
 * history, then reads the events through this table instead.
 *
 * Same shape as `VOCABULARY` deliberately, so these rows reach `/admin/tracking`
 * through `PHRASE_GROUPS` and an admin can correct the Arabic without a deploy.
 *
 * Order matters, most specific first, and the near-misses are the reason:
 * `return_attempted` must not be read by the bare `returned` keyword, and
 * `rto_completed` must not be read by the bare `rto`.
 */
const RETURN_VOCABULARY: ReadonlyArray<Phrase & { step: number }> = [
  {
    key: 'return_completed',
    step: 3,
    ar: 'تم إرجاع الشحنة إلى الراسل',
    keywords: [
      'returned to sender',
      'return completed',
      'rto completed',
      'returned',
      'تم الإرجاع',
      'تم الارجاع',
    ],
  },
  {
    key: 'out_for_return',
    step: 2,
    // A return attempt that failed is the same step tried again, exactly as a
    // failed delivery attempt does not move a parcel back down the outbound bar.
    ar: 'خرجت لإرجاعها إلى الراسل',
    keywords: [
      'out for return',
      'out for rto',
      'return attempted',
      'return attempt',
      'خرجت للإرجاع',
      'خرجت للارجاع',
    ],
  },
  {
    key: 'return_on_the_way',
    step: 1,
    ar: 'الشحنة في طريق العودة',
    keywords: ['in transit', 'transit', 'en route', 'line haul', 'في الطريق'],
  },
  {
    key: 'return_started',
    step: 0,
    ar: 'جارٍ إرجاع الشحنة إلى الراسل',
    keywords: [
      'return to origin',
      'return to sender',
      'return requested',
      'return initiated',
      'returning',
      'rto',
      'مرتجع',
      'مرتجعة',
    ],
  },
];

/**
 * The reason a courier gave, as it arrives on a `tracking_events` comment.
 *
 * Production writes these as two halves joined by a dash — an English reason
 * code the ops tool offers, then whatever the courier typed, in Arabic:
 * `Customer refused to accept the shipment - الاوردر ناقص`. Under an Arabic
 * status that is the worst line on the page, because on a failed delivery the
 * reason is the part the recipient actually needs.
 *
 * Only the first half is ours to translate. The second is a human being's own
 * words about this one parcel and stays exactly as it was typed — translating
 * free text is how a page starts inventing facts, which is the one thing this
 * module refuses to do.
 *
 * **Two rows, because production has shown two reason codes.** This is a much
 * thinner reading of the platform than `VOCABULARY` above, and it is stated
 * plainly rather than padded out with plausible-looking guesses: an unmatched
 * reason shows verbatim, exactly as an unmatched status does, and the admin
 * screen is where a new one gets added the day somebody sees it.
 */
const REASONS: ReadonlyArray<Phrase> = [
  {
    key: 'reason_refused',
    ar: 'العميل رفض استلام الشحنة',
    keywords: ['refused', 'refused to accept', 'rejected', 'declined'],
  },
  {
    key: 'reason_rescheduled',
    ar: 'العميل طلب تأجيل التسليم',
    keywords: ['rescheduled', 'customer rescheduled', 'postponed', 'reschedule'],
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
 * The row of a phrase table that a piece of free text names, or null when
 * nothing in it matches.
 *
 * One walk shared by `stageFor` and `statusLabel`, so a badge can never show the
 * Arabic of one row while the stepper is drawn from another.
 */
function rowFor<T extends Phrase>(table: readonly T[], text: string | null | undefined): T | null {
  if (!text) return null;
  const flat = flatten(text);
  if (!flat) return null;

  return table.find((row) => row.keywords.some((keyword) => flat.includes(` ${keyword} `))) ?? null;
}

/** The stage a label names, or `unknown` when nothing in the table matches. */
export function stageFor(label: string | null | undefined): ShipmentStage {
  return rowFor(VOCABULARY, label)?.stage ?? 'unknown';
}

/** The stage plus everything the tracking page draws from it. */
export function stageDisplay(label: string | null | undefined): StageDisplay {
  const stage = stageFor(label);
  return { stage, ...DISPLAY[stage] };
}

/** Where a parcel has got to on its way back, once it is going back at all. */
export type ReturnProgress = {
  /** Index into `RETURN_STEPS`. */
  step: number;
  /**
   * When the return leg began — the instant of the event that opened it.
   *
   * Null when the only thing establishing the return is `rto_requested`: the
   * flag says a return is happening but names no event, so there is no moment to
   * point at. Callers use it to tell which half of the history is the way back,
   * because the same `in_transit` event means opposite things either side of it.
   */
  startedAt: Date | null;
  /** When the parcel reached the step it is on, when an event says so. */
  at: Date | null;
};

export type ReturnInput = {
  /** `rto_requested` from the delivery order. The authority, see below. */
  rtoRequested: boolean;
  /** The top-level status, which is *not* the authority. */
  status: string | null | undefined;
  events: readonly { status: string; at: Date }[];
};

/**
 * Whether this parcel is going back to the merchant, and how far it has got.
 *
 * **`rto_requested` is the signal, not the status.** On the parcel this was
 * built against the platform reports `status: "delivery_attempted"` while
 * `rto_requested` is true and a `return_to_origin` event has already fired — so
 * reading the status alone drew the outbound bar with "Out for delivery" lit and
 * "Delivered" still ahead, for a parcel that will never arrive. The flag is the
 * thing that changes the moment the decision is made; the status lags it.
 *
 * The step comes from the events **after the return began**, not from all of
 * them, and that slice is the whole reason this cannot be a keyword lookup on a
 * single label. Every return is preceded by an outbound `in_transit`, and
 * counting those would put a parcel that has only just been turned around at
 * "on the way back". Where no return event has arrived yet, the flag alone
 * establishes the first step and nothing more.
 *
 * The latest matching event wins rather than the furthest, which is the same
 * reading the outbound bar takes from the current status: it answers "where is
 * it now", and a return that has come back to a hub after a failed attempt
 * really is at the hub again.
 */
export function returnProgress(input: ReturnInput): ReturnProgress | null {
  const returning = input.rtoRequested || stageFor(input.status) === 'returned';
  if (!returning) return null;

  const ordered = [...input.events].sort((a, b) => a.at.getTime() - b.at.getTime());

  // Where the return leg starts: the first event this table reads at all. Every
  // outbound event before it is another journey and is not counted.
  const start = ordered.findIndex((event) => rowFor(RETURN_VOCABULARY, event.status)?.step === 0);
  const leg = start === -1 ? [] : ordered.slice(start);

  const startedAt = leg[0]?.at ?? null;

  let latest: ReturnProgress = { step: 0, startedAt, at: null };
  for (const event of leg) {
    const row = rowFor(RETURN_VOCABULARY, event.status);
    if (!row) continue;
    latest = { step: row.step, startedAt, at: event.at };
  }

  return latest;
}

/**
 * A status read as part of the journey *back*.
 *
 * The same event means opposite things on the two legs — `in_transit` outbound
 * is "on its way to you", and during a return it is "on its way back to the
 * shop" — so the history rows after a return began have to be read through the
 * return table or the page contradicts its own progress bar. It was doing
 * exactly that: `return_to_origin` reached an Arabic reader as
 * `مرتجعة إلى الراسل`, the past tense, above a bar whose first step had only
 * just lit.
 *
 * Falls back to the ordinary reading for anything the return table does not
 * recognise, which keeps an unmatched label verbatim exactly as `statusLabel`
 * does rather than inventing a return-flavoured phrase for it.
 */
export function returnStatusLabel(
  locale: Locale,
  label: string | null | undefined,
  overrides: PhraseOverrides = {},
): string {
  if (!label) return '';
  if (locale !== 'ar' || ARABIC_SCRIPT.test(label)) return humaniseStatus(label);

  const row = rowFor(RETURN_VOCABULARY, label);
  return row ? phrase(row, overrides) : statusLabel(locale, label, overrides);
}

/** The Arabic reading of one return step, for the page that draws the bar. */
export function returnStepLabel(
  locale: Locale,
  step: number,
  overrides: PhraseOverrides = {},
): string {
  const row = RETURN_VOCABULARY.find((entry) => entry.step === step);
  if (!row) return '';
  return locale === 'ar' ? phrase(row, overrides) : (RETURN_STEP_EN[step] ?? '');
}

/**
 * The English wording of the return steps.
 *
 * Written out here rather than derived from the platform's tokens, because
 * unlike `VOCABULARY` these are *our* step names — "On the way" covers
 * `in_transit` and `en_route` alike, and no single platform word says it.
 */
const RETURN_STEP_EN: Readonly<Record<number, string>> = {
  0: 'Returning to sender',
  1: 'On the way',
  2: 'Out for return',
  3: 'Returned',
};

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
 *
 * `overrides` is what `/admin/tracking` saved, keyed by `Phrase.key`. Passed in
 * rather than read here on purpose: this module is imported by the worker and
 * tested with no database at all, so the one place that needs the admin's
 * wording — the public page — loads it and hands it over. See
 * `lib/shipments/phrases.ts`.
 */
export function statusLabel(
  locale: Locale,
  label: string | null | undefined,
  overrides: PhraseOverrides = {},
): string {
  if (!label) return '';
  if (locale !== 'ar' || ARABIC_SCRIPT.test(label)) return humaniseStatus(label);

  const row = rowFor(VOCABULARY, label);
  return row ? phrase(row, overrides) : humaniseStatus(label);
}

/**
 * Where the platform's own wording ends and the courier's own words begin.
 *
 * Matched at the *start* of the comment and only there. A dash inside the
 * courier's note is ordinary — `الاوردر ناقص - مش هيستلم` — and splitting on
 * every one of them would scatter a sentence somebody typed.
 */
const REASON_SPLIT = /^([^\-–—]{2,80})\s*[-–—]\s*(.+)$/s;

/**
 * A tracking event's comment, with the half that is ours to translate translated.
 *
 * Production writes a comment as an English reason code, a dash, and whatever
 * the courier typed: `Customer refused to accept the shipment - الاوردر ناقص`.
 * The first half is a fixed vocabulary and the second is one human being's
 * account of one parcel, so exactly one of them can be translated without
 * inventing anything — and on a failed delivery the reason is the line the
 * recipient most needs.
 *
 * A comment with no reason code we recognise is shown exactly as it arrived,
 * dash and all. That is the same refusal `statusLabel` makes: the page would
 * rather be half-English than confidently wrong about why a parcel did not
 * arrive.
 */
export function commentText(
  locale: Locale,
  comment: string | null | undefined,
  overrides: PhraseOverrides = {},
): string {
  if (!comment) return '';
  const text = comment.trim();
  if (locale !== 'ar' || !text) return text;

  const split = REASON_SPLIT.exec(text);
  const head = split ? split[1]!.trim() : text;
  const rest = split ? split[2]!.trim() : '';

  // Already Arabic, so there is no reason code in front of it to translate.
  if (ARABIC_SCRIPT.test(head)) return text;

  const row = rowFor(REASONS, head);
  if (!row) return text;

  const reason = phrase(row, overrides);
  return rest ? `${reason} - ${rest}` : reason;
}

/**
 * The default wording, unless an admin has replaced it.
 *
 * An override that is blank or only whitespace is treated as absent rather than
 * as an empty label: a status badge with nothing in it says less than the
 * English word it replaced, and the admin screen's way to undo an override is
 * to clear the box.
 */
function phrase(row: Phrase, overrides: PhraseOverrides): string {
  return overrides[row.key]?.trim() || row.ar;
}

/**
 * Every phrase the tracking page can show, for the screen that edits them.
 *
 * Exported as data rather than rendered here so `/admin/tracking` can list the
 * defaults, the keywords each row answers to, and whichever of them somebody has
 * overridden — a screen that only showed the overrides would be a list of
 * whatever was already changed, which is no way to find the phrase you want.
 */
export const PHRASE_GROUPS: ReadonlyArray<{
  kind: 'status' | 'return' | 'reason';
  rows: readonly Phrase[];
}> = [
  { kind: 'status', rows: VOCABULARY },
  { kind: 'return', rows: RETURN_VOCABULARY },
  { kind: 'reason', rows: REASONS },
];
