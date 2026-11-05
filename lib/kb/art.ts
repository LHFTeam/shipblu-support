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
 * parcel), and its subjects are the folders under them — Financials,
 * Integrations, FAQs. The front page draws a card per folder, so the folders'
 * names are matched here as well as the audiences' and the design's own.
 *
 * An unrecognised name gets no drawing at all rather than a near miss. This is
 * decoration, and decoration that misleads is worse than none.
 *
 * Pure and client-safe, and apart from the component that draws the images
 * (`app/help/[locale]/art.tsx`) so the matching can be tested without a bundler
 * that understands `.webp`.
 */

export type TopicArt =
  'store' | 'shipping' | 'account' | 'returns' | 'payments' | 'claims' | 'questions';

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
 * (`WHOLE`): "account" is a topic, "accountability" is not, "RTO" is a
 * return while "carton" is a box, and "app" is not "apply". `cod` is left out
 * altogether, since "COD" reads as the payment and as part of every "code".
 */
const TOPIC_KEYWORDS: ReadonlyArray<readonly [TopicArt, ReadonlyArray<string>]> = [
  [
    'claims',
    [
      'lost',
      'damage',
      'claim',
      'compensation',
      'polic',
      'regulation',
      'مفقود',
      'فقد',
      'تالف',
      'تلف',
      'مطالب',
      'تعويض',
      'سياس',
      'لائح',
      'لوائح',
    ],
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
  // The design's account-settings drawing, a person and a gear. The design put
  // it on "Pickups & deliveries"; production's "ShipBlu Unique Products" (the
  // dashboard, analytics, sub-accounts) and "myBlu Support" (the app) are the
  // account and its features, and it fits them better than it fits a pickup.
  [
    'account',
    [
      'pickup',
      'pick-up',
      'deliver',
      'courier',
      'account',
      'product',
      'dashboard',
      'myblu',
      'app',
      'استلام',
      'تسليم',
      'توصيل',
      'مندوب',
      'الكابتن',
      'حساب',
      'منتج',
      'تطبيق',
      'ماي بلو',
    ],
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
      'connect',
      'store',
      'شركاء',
      'شريك',
      'تاجر',
      'تجار',
      'البدء',
      'بداية',
      'ربط',
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
  // Last, as the most general subject there is: "Shipping FAQs" is about
  // shipping before it is a list of questions.
  ['questions', ['faq', 'question', 'أسئلة', 'سؤال', 'استفسار']],
];

const WHOLE = new Set(['account', 'rto', 'app']);

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
