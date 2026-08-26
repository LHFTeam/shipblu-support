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

/** How the badge and the header read. `unknown` gets the neutral treatment. */
export type StageTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

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
  tone: StageTone;
  /** Index into `TRACKING_STEPS`, or null when the stage is off that line. */
  step: number | null;
  /** True once nothing more will happen without somebody intervening. */
  terminal: boolean;
};

const DISPLAY: Record<ShipmentStage, Omit<StageDisplay, 'stage'>> = {
  created: { tone: 'neutral', step: 0, terminal: false },
  in_transit: { tone: 'progress', step: 1, terminal: false },
  out_for_delivery: { tone: 'progress', step: 2, terminal: false },
  // Still on the line, and still at the same step: an attempt that failed did
  // not move the parcel backwards, it used one of the tries at the last step.
  attempted: { tone: 'warning', step: 2, terminal: false },
  delivered: { tone: 'success', step: 3, terminal: true },
  returned: { tone: 'warning', step: null, terminal: true },
  exception: { tone: 'danger', step: null, terminal: false },
  unknown: { tone: 'neutral', step: null, terminal: false },
};

/**
 * Keywords per stage, most specific first.
 *
 * Order matters: the list is walked top-down and the first stage with a hit
 * wins, so `failed delivery attempt` reaches `attempted` before `in_transit`
 * could claim it, and `returned to sender` never reads as `delivered`. Terminal
 * and exceptional states are therefore listed first.
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
