-- Post-migration SQL: a description for each of production's help-centre folders.
--
-- The help centre's front page draws a card per folder (`listTopicFolders` in
-- lib/kb/queries.ts), and the design gives every card a line saying what is in
-- it. Production's folders came over from Freshdesk with none, and the console
-- cannot write one: it creates a folder but has no folder editor. So the lines
-- arrive here, written from what each folder holds on 2026-11-05, in both of
-- the help centre's languages.
--
-- A folder is named by its audience's locale and slug and by its own slug,
-- because the two audiences each have a folder called `faqs`. A row with a
-- description already is never touched, so a line somebody writes into the
-- database later wins over this one, and a replay — on every deploy — writes
-- nothing once these are in. The cost of filling only blanks: a description
-- cleared to empty comes back on the next deploy. On a database without these
-- folders (every one but production's) it matches nothing.
--
-- Kept short enough for the four lines the card gives a description beside its
-- drawing, in the narrowest column the grid draws.
update kb_folders f
set description = v.description
from (
  values
    ('en', 'shipblu-partners', 'faqs',
      'Accounts, pickups, delivery attempts, pricing, and what merchants ask most.'),
    ('en', 'shipblu-partners', 'financials',
      'Transfer cycles and fees, your ShipBlu wallet, payout methods and tax invoices.'),
    ('en', 'shipblu-partners', 'integrations',
      'Connecting a Shopify, WooCommerce, Magento or Zammit store to ShipBlu.'),
    ('en', 'shipblu-partners', 'policies-and-regulations',
      'Packaging rules, items ShipBlu can''t ship, claims and Shield plan terms.'),
    ('en', 'shipblu-partners', 'shipblu-unique-products',
      'The analytics dashboard, Instant Payout, Shield plans, sub-accounts and more.'),
    ('en', 'shipblu-partners', 'shipping-services',
      'Creating delivery, return, exchange and cash-collection orders, in bulk too.'),
    ('en', 'shipblu-customers', 'faqs',
      'Where a parcel is, when it will arrive, and how to reach the support team.'),
    ('en', 'shipblu-customers', 'myblu-support',
      'The myBlu app, and how to ask for a refund.'),
    ('ar', 'شركاء-شيب-بلو', 'الأسئلة-الشائعة',
      'فتح الحساب والاستلام ومحاولات التوصيل والتسعير، وأكثر ما يسأل عنه التجّار.'),
    ('ar', 'شركاء-شيب-بلو', 'الماليات',
      'دورة تحويل التحصيلات والرسوم، ومحفظة شيب بلو، والفواتير الضريبية.'),
    ('ar', 'شركاء-شيب-بلو', 'أدوات-الربط',
      'ربط المتجر الإلكتروني بشيب بلو عبر شوبيفاي أو ووكومرس أو ماجنتو أو زامت.'),
    ('ar', 'شركاء-شيب-بلو', 'السياسات-واللوائح',
      'إرشادات التغليف، والمنتجات غير المتاح شحنها، والمطالبات وشروط باقات التأمين.'),
    ('ar', 'شركاء-شيب-بلو', 'منتجات-شيب-بلو-المميزة',
      'الواجهة التحليلية والسحب الفوري وباقات التأمين والحسابات الفرعية وغيرها.'),
    ('ar', 'شركاء-شيب-بلو', 'خدمات-الشحن',
      'إنشاء أوردرات التوصيل والإرجاع والاستبدال والتحصيل النقدي، فرديًا أو بالجملة.'),
    ('ar', 'عملاء-شيب-بلو', 'الأسئلة-الشائعة',
      'مكان الشحنة وموعد وصولها، وطريقة التواصل مع فريق الدعم.'),
    ('ar', 'عملاء-شيب-بلو', 'دعم-تطبيق-ماي-بلو',
      'تطبيق ماي بلو، وطريقة طلب استرداد المبلغ.')
) as v(locale, category_slug, folder_slug, description)
join kb_categories c on c.locale = v.locale and c.slug = v.category_slug
where f.category_id = c.id
  and f.slug = v.folder_slug
  and coalesce(btrim(f.description), '') = '';
