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
 * Substrings, not words. Arabic attaches its article and its prepositions to
 * the noun — الماليات, بالشحن — so a word match would need the same folding the
 * subcategoriser does, and these are names an editor typed, not free text.
 * Short Latin fragments that live inside unrelated words (`cod` in "barcode")
 * are left out for that reason.
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

export function topicArt(name: string, slug = ''): TopicArt | null {
  const haystack = `${name} ${slug}`.toLowerCase();
  for (const [art, keywords] of TOPIC_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return art;
  }
  return null;
}
