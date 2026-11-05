/**
 * Which illustration goes with a help-centre topic.
 *
 * The drawings come from the help-centre design, one per kind of question a
 * merchant or a recipient arrives with. Nothing in the database says what a
 * category or a folder is *about* — `kb_categories` has a name, a slug and a
 * description, and an artwork column would ask an editor a question they never
 * think about — so the topic is read off its own name, in either language.
 *
 * Production's top level is two audiences rather than six subjects ("ShipBlu
 * Partners", the merchants, and "ShipBlu Customers", the people waiting on a
 * parcel), so the audiences are named here as well as the subjects the design
 * drew its cards for.
 *
 * An unrecognised name gets no drawing at all rather than a near miss. This is
 * decoration, and decoration that misleads is worse than none.
 *
 * Pure and client-safe, and apart from the component that draws the images
 * (`app/help/[locale]/art.tsx`) so the matching can be tested without a bundler
 * that understands `.webp`.
 */

export type TopicArt = 'store' | 'shipping' | 'pickups' | 'returns' | 'payments' | 'claims';

/**
 * First match wins, so the order is from the most particular subject to the
 * most general: "Lost shipments" is a claim before it is a shipment, a "Return
 * shipments" folder is about returns, and only a name that says nothing more
 * specific than "shipping" falls through to the parcel.
 *
 * Each keyword has to start a word, or the drawing lands on names that only
 * contain one: `claim` inside "disclaimer", `store` inside "restore", تلف inside
 * مختلف ("different"), مالي inside إجمالي ("total"). In Arabic a word starts
 * after the letters the language attaches to its nouns — و, ف, then ب, ك or ل,
 * then the article — so الماليات, بالشحن and للتجار still match their stems
 * (`startsWord`). A few Latin keywords are whole words rather than stems
 * (`WHOLE`): "account" is a topic, "accountability" is not, and "RTO" is a
 * return while "carton" is a box. `cod` is left out altogether, since "COD"
 * reads as the payment and as part of every "code".
 */
const TOPIC_KEYWORDS: ReadonlyArray<readonly [TopicArt, ReadonlyArray<string>]> = [
  [
    'claims',
    ['lost', 'damage', 'claim', 'compensation', 'مفقود', 'فقد', 'تالف', 'تلف', 'مطالب', 'تعويض'],
  ],
  ['returns', ['return', 'exchange', 'rto', 'مرتجع', 'ارتجاع', 'استبدال', 'إرجاع']],
  [
    'payments',
    [
      'payment',
      'settlement',
      'financ',
      'invoice',
      'billing',
      'cash',
      'transfer',
      'مالي',
      'مدفوع',
      'تسوي',
      'تحصيل',
      'فواتير',
      'فاتورة',
      'تحويل',
    ],
  ],
  [
    'pickups',
    ['pickup', 'pick-up', 'deliver', 'courier', 'استلام', 'تسليم', 'توصيل', 'مندوب', 'الكابتن'],
  ],
  [
    'store',
    [
      'partner',
      'merchant',
      'getting-started',
      'getting started',
      'onboard',
      'integration',
      'account',
      'store',
      'شركاء',
      'شريك',
      'تاجر',
      'تجار',
      'البدء',
      'بداية',
      'الربط',
      'حساب',
      'متجر',
    ],
  ],
  [
    'shipping',
    [
      'shipping',
      'shipment',
      'track',
      'parcel',
      'customer',
      'recipient',
      'شحن',
      'شحنات',
      'شحنة',
      'تتبع',
      'تتبّع',
      'عملاء',
      'مستلم',
    ],
  ],
];

const WHOLE = new Set(['account', 'rto']);

function startsWord(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/\p{Script=Arabic}/u.test(keyword)) {
    return new RegExp(`(?<!\\p{Script=Arabic})[وف]?[بكل]?(?:ال|ل)?${escaped}`, 'u');
  }
  const end = WHOLE.has(keyword) ? 's?(?![a-z])' : '';
  return new RegExp(`(?<![a-z])${escaped}${end}`, 'u');
}

const TOPIC_PATTERNS: ReadonlyArray<readonly [TopicArt, ReadonlyArray<RegExp>]> =
  TOPIC_KEYWORDS.map(([art, keywords]) => [art, keywords.map(startsWord)] as const);

export function topicArt(name: string, slug = ''): TopicArt | null {
  const haystack = `${name} ${slug}`.toLowerCase();
  for (const [art, patterns] of TOPIC_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(haystack))) return art;
  }
  return null;
}
