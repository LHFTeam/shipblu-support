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
 * anything back. The label the platform sent stays the label we show — the
 * stage only decides the furniture around it. That is what makes an unrecognised
 * label harmless: `unknown` draws the label on its own, with no stepper and no
 * invented tone, rather than guessing a stage and telling a customer their
 * parcel is somewhere it is not.
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
 * Keywords per stage, most specific first.
 *
 * Order matters: the list is walked top-down and the first stage with a hit
 * wins, so `failed delivery attempt` reaches `attempted` before `in_transit`
 * could claim it, and `returned to sender` never reads as `delivered`. Terminal
 * and exceptional states are therefore listed first.
 *
 * **Eight of these are no longer guesses.** `created`, `pickup_requested`,
 * `out_for_pickup`, `picked_up`, `in_transit`, `en_route`, `out_for_delivery`
 * and `delivered` are the statuses `api.shipblu.com` actually emits, read off a
 * real delivery order. Three of them — `pickup_requested`, `out_for_pickup` and
 * `en_route` — reached `unknown` before that was checked, which on the tracking
 * page means a bare label with no stepper and no tone for a large part of every
 * parcel's life. The rest of the table stays as it was: still a keyword reading
 * of free text, still `unknown` rather than a guess when nothing matches.
 *
 * A keyword matches as a whole word or whole phrase, not as a substring. That is
 * the difference between `new` meaning a freshly created shipment and `new`
 * matching the middle of `renewed`; with separators already flattened to single
 * spaces it still covers `out_for_delivery`, `Out-For-Delivery` and
 * `OUT FOR DELIVERY` from one entry. Word forms that a platform might use
 * interchangeably are listed out rather than stemmed — six extra strings beat a
 * stemmer that has to be right in two languages.
 */
const KEYWORDS: ReadonlyArray<readonly [ShipmentStage, readonly string[]]> = [
  [
    'exception',
    [
      'exception',
      'on hold',
      'held',
      'lost',
      'damaged',
      'cancelled',
      'canceled',
      'investigation',
      'معلق',
      'مفقود',
      'تالف',
      'ملغي',
    ],
  ],
  [
    'returned',
    [
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
  ],
  [
    'delivered',
    ['delivered', 'completed', 'handed over', 'تم التسليم', 'تم التوصيل', 'مسلمة', 'تم الاستلام'],
  ],
  [
    'attempted',
    [
      'attempt',
      'attempts',
      'attempted',
      'failed attempt',
      'unreachable',
      'no answer',
      'not answering',
      'rescheduled',
      'postponed',
      'محاولة',
      'تعذر التسليم',
      'لم يرد',
      'اعادة جدولة',
      'إعادة جدولة',
      'مؤجل',
    ],
  ],
  [
    'out_for_delivery',
    [
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
  ],
  [
    'in_transit',
    [
      'in transit',
      'transit',
      // The platform's own linehaul step. Observed immediately *before*
      // `in_transit` on delivery day rather than as a synonym for the courier
      // being at the door, so it belongs here and not in `out_for_delivery` —
      // which is where the English reading of the words alone would put it.
      'en route',
      'picked up',
      'pickup complete',
      'collected',
      'received at',
      'arrived at',
      'departed',
      'at hub',
      'sorting',
      'sorted',
      'line haul',
      'في الطريق للفرع',
      'تم الاستلام من التاجر',
      'تم الشحن',
      'بالفرع',
      'فرز',
    ],
  ],
  [
    'created',
    [
      'created',
      'draft',
      'new',
      'awaiting pickup',
      'pending pickup',
      'ready for pickup',
      // Both are pre-pickup: the parcel is still the merchant's, and a courier
      // being *sent to collect it* has not moved it. Reading either as transit
      // would tell a recipient their parcel is on its way while it is still on a
      // shelf in the shop.
      'pickup requested',
      'out for pickup',
      'scheduled',
      'booked',
      'تم الإنشاء',
      'تم الانشاء',
      'في انتظار الاستلام',
      'بانتظار الاستلام',
    ],
  ],
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

/** The stage a label names, or `unknown` when nothing in the table matches. */
export function stageFor(label: string | null | undefined): ShipmentStage {
  if (!label) return 'unknown';
  const flat = flatten(label);
  if (!flat) return 'unknown';

  for (const [stage, keywords] of KEYWORDS) {
    if (keywords.some((keyword) => flat.includes(` ${keyword} `))) return stage;
  }
  return 'unknown';
}

/** The stage plus everything the tracking page draws from it. */
export function stageDisplay(label: string | null | undefined): StageDisplay {
  const stage = stageFor(label);
  return { stage, ...DISPLAY[stage] };
}
