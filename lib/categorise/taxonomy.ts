/**
 * What ShipBlu's customers write in about, and why it happened.
 *
 * This file is the domain, not the mechanism. It says which categories and
 * causes exist and what they are called in both languages; `rules.ts` says how
 * text is matched onto them, and `db/schema/config.ts` holds the registries this
 * seeds. Splitting it that way is what lets an admin rename a category without a
 * deploy while a rule change still goes through review with tests.
 *
 * ## Where these came from
 *
 * Not from guesswork, and deliberately not from the `whatsapp_bot` archive. That
 * archive is 99.6% of the message volume and almost none of the support demand:
 * it is a self-service button flow, a third of it is a customer pressing
 * "confirm my details" and asking for nothing, and a taxonomy mined from its
 * menu labels would report the bot's funnel as though it were the queue.
 *
 * The sources that were used:
 *
 * - **The help centre**, which already splits the domain by persona: 47 articles
 *   for merchants across Financials, Integrations, Policies, Shipping Services
 *   and Products, and 7 for recipients about where a parcel is. That split is
 *   ShipBlu's own statement of what it gets asked, and it is why `audience`
 *   exists.
 * - **`lib/shipments/status.ts`**, whose 27 status and reason keys are the
 *   operational lifecycle. The `delivery`, `pickup` and `return` areas below
 *   deliberately track it, because `conversation_shipments` joins a ticket to a
 *   parcel — so a report can ask what the parcel was *actually* doing while the
 *   customer was asking about it. That join is the whole point of aligning them.
 * - **Real inbound on the human channels**, which is dominated by merchant and
 *   pre-sales traffic the bot archive contains none of: price lists before
 *   signing up, Shopify integration, contract enquiries, pickups nobody
 *   collected — plus job applications and couriers offering to distribute, which
 *   is why `other` is a first-class area rather than a bin.
 *
 * ## Two dimensions, and why they are not one list
 *
 * A **category** is the customer's account of their problem, detected on
 * arrival, several per ticket. A **root cause** is why it happened, recorded by
 * the agent on resolve, one per ticket.
 *
 * They are kept apart because the customer does not know the cause. "Where is my
 * order" has at least six behind it, and each points at a different team. A
 * taxonomy that mixes them forces a choice between a label the detector can
 * actually assign and a label worth acting on; keeping them separate gets both.
 */

import type { ticketCategories, ticketRootCauses } from '@/db/schema';

type CategoryRow = typeof ticketCategories.$inferInsert;
type RootCauseRow = typeof ticketRootCauses.$inferInsert;

export type CategoryDef = {
  key: string;
  labelEn: string;
  labelAr: string;
  audience: NonNullable<CategoryRow['audience']>;
  /**
   * How much this needs a person, used only to pick the primary category.
   *
   * A ticket that says both "I confirmed my address" and "nobody called me" is
   * about the second, and this is the rung of the ladder that says so instead of
   * a hand-ordered precedence list. An earlier draft of this work used one of
   * those and it collapsed a category from 2,718 conversations to 18, because
   * whichever entry sat higher swallowed everything it co-occurred with.
   *
   * `high` is anything where somebody is out of money, out of a parcel, or has
   * been told something untrue. Default is `normal`; `low` is for rows that are
   * real but are never the point of the ticket.
   */
  severity?: 'high' | 'normal' | 'low';
  /** Why this is its own category rather than folded into a neighbour. */
  note?: string;
  /** No rule can award it; an agent files it by hand. */
  manualOnly?: boolean;
};

export type AreaDef = {
  area: string;
  labelEn: string;
  labelAr: string;
  categories: readonly CategoryDef[];
};

/**
 * The topic taxonomy: 12 areas, 52 categories.
 *
 * Two levels rather than flat because 52 entries in one dropdown is a list
 * nobody reads to the end — an agent picks the first plausible row and moves on,
 * which is the failure mode that makes a taxonomy's numbers meaningless. Twelve
 * areas is a chart that fits on a screen, and the drill-down is the same table.
 *
 * The count is at the top of the range the literature recommends, and that is a
 * deliberate trade: ShipBlu takes well over a thousand tickets a day, which is
 * the volume at which granularity starts paying for itself in root-cause work
 * rather than costing accuracy at the point of filing.
 */
export const TAXONOMY: readonly AreaDef[] = [
  {
    area: 'delivery',
    labelEn: 'Delivery',
    labelAr: 'التوصيل',
    categories: [
      {
        key: 'delivery.where_is_it',
        labelEn: 'Where is my parcel',
        labelAr: 'فين شحنتي',
        audience: 'any',
        note: 'The plain WISMO with no complaint attached. Separate from `late` because it is answerable from the tracking page and `late` is not — merging them would hide how much of the queue is a self-service gap.',
      },
      {
        key: 'delivery.late',
        labelEn: 'Delivery is late',
        labelAr: 'تأخر التوصيل',
        severity: 'high',
        audience: 'any',
        note: 'Past the promised date. The customer is asserting a breach, not asking a question.',
      },
      {
        key: 'delivery.eta_request',
        labelEn: 'Asking for a delivery time',
        labelAr: 'موعد التوصيل المتوقع',
        audience: 'recipient',
        note: 'Which day, or what time on the day. Distinct from `where_is_it` because the answer is a window rather than a status, and because a recipient planning their day is not a complaint.',
      },
      {
        key: 'delivery.not_received_marked_delivered',
        labelEn: 'Marked delivered but never received',
        labelAr: 'مسجّلة كمستلمة ولم تُستلم',
        severity: 'high',
        audience: 'any',
        note: 'A false delivered scan. Its own category despite low volume because it is the most serious thing a courier network can get wrong and it must never be averaged into `late`.',
      },
      {
        key: 'delivery.failed_attempt',
        labelEn: 'Delivery attempt disputed',
        labelAr: 'محاولة توصيل محل خلاف',
        severity: 'high',
        audience: 'any',
        note: 'The platform recorded an attempt and the customer says it did not happen. Draws on the same words as the `attempted` phrase in lib/shipments/status.ts.',
      },
      {
        key: 'delivery.no_contact',
        labelEn: 'Courier never made contact',
        labelAr: 'المندوب لم يتواصل',
        severity: 'high',
        audience: 'recipient',
      },
      {
        key: 'delivery.reschedule',
        labelEn: 'Reschedule the delivery',
        labelAr: 'تغيير موعد التوصيل',
        audience: 'recipient',
      },
      {
        key: 'delivery.address_change',
        labelEn: 'Change the delivery address',
        labelAr: 'تغيير عنوان التوصيل',
        audience: 'recipient',
      },
      {
        key: 'delivery.access_constraint',
        labelEn: 'Address is hard to reach',
        labelAr: 'قيود الوصول للعنوان',
        audience: 'recipient',
        note: 'Office hours only, a gated compound, no lift. Not a reschedule and not an address change — the address is right and the window is the problem, which is a different fix.',
      },
      {
        key: 'delivery.refused',
        labelEn: 'Refusing the parcel',
        labelAr: 'رفض استلام الشحنة',
        audience: 'recipient',
      },
      {
        key: 'delivery.unrecognised',
        labelEn: "Doesn't recognise the parcel",
        labelAr: 'لا يعرف هذه الشحنة',
        audience: 'recipient',
        severity: 'high',
        note: 'شحنه ايه — "what shipment?". Added because it is one of the most frequent free-text messages in the archive, and it is high severity rather than a curiosity: somebody who does not recognise a parcel addressed to them is either a mis-delivery, a merchant sending without consent, or a card being tested.',
      },
    ],
  },
  {
    area: 'condition',
    labelEn: 'Parcel condition',
    labelAr: 'حالة الشحنة',
    categories: [
      {
        key: 'condition.damaged',
        labelEn: 'Damaged',
        labelAr: 'شحنة تالفة',
        severity: 'high',
        audience: 'any',
      },
      {
        key: 'condition.wrong_item',
        labelEn: 'Wrong item',
        labelAr: 'منتج خاطئ',
        severity: 'high',
        audience: 'any',
      },
      {
        key: 'condition.missing_items',
        labelEn: 'Items missing',
        labelAr: 'عناصر ناقصة',
        severity: 'high',
        audience: 'any',
      },
      {
        key: 'condition.packaging',
        labelEn: 'Packaging problem',
        labelAr: 'مشكلة في التغليف',
        audience: 'any',
        note: 'Separate from `damaged` because the parcel may have arrived intact and still be evidence the packaging guidelines are not working — which is a merchant conversation, not a claim.',
      },
    ],
  },
  {
    area: 'pickup',
    labelEn: 'Pickup',
    labelAr: 'الاستلام من التاجر',
    categories: [
      {
        key: 'pickup.not_collected',
        labelEn: 'Nobody collected the shipments',
        labelAr: 'لم يتم استلام الشحنات',
        severity: 'high',
        audience: 'merchant',
      },
      {
        key: 'pickup.schedule',
        labelEn: 'Arrange or move a pickup',
        labelAr: 'موعد الاستلام',
        audience: 'merchant',
      },
      {
        key: 'pickup.point_change',
        labelEn: 'Change pickup or return point',
        labelAr: 'تغيير نقطة الاستلام أو الإرجاع',
        audience: 'merchant',
      },
      {
        key: 'pickup.supplies',
        labelEn: 'Packaging supplies',
        labelAr: 'مستلزمات التغليف',
        audience: 'merchant',
        note: 'Flyers, bags, the White Bag. A logistics request rather than a shipment problem, and high enough volume in the help centre to earn a row.',
      },
    ],
  },
  {
    area: 'return',
    labelEn: 'Returns and exchanges',
    labelAr: 'المرتجعات والاستبدال',
    categories: [
      {
        key: 'return.status',
        labelEn: 'Where is the return',
        labelAr: 'حالة الشحنة المرتجعة',
        audience: 'any',
        note: 'Its own category rather than `delivery.where_is_it` on the return leg, because `in_transit` means opposite things on the two legs — the same trap lib/shipments/status.ts documents for the tracking page.',
      },
      {
        key: 'return.request',
        labelEn: 'Wants to return or cancel',
        labelAr: 'طلب إرجاع أو إلغاء',
        audience: 'any',
      },
      {
        key: 'return.exchange',
        labelEn: 'Exchange request',
        labelAr: 'طلب استبدال',
        audience: 'any',
      },
      {
        key: 'return.not_received_by_merchant',
        labelEn: 'Return never came back',
        labelAr: 'المرتجع لم يصل التاجر',
        severity: 'high',
        audience: 'merchant',
      },
    ],
  },
  {
    area: 'payment',
    labelEn: 'Payment at the door',
    labelAr: 'الدفع عند الاستلام',
    categories: [
      {
        key: 'payment.cod_dispute',
        labelEn: 'COD amount disputed',
        labelAr: 'خلاف على المبلغ المحصّل',
        severity: 'high',
        audience: 'any',
      },
      {
        key: 'payment.cod_not_collected',
        labelEn: 'COD not collected',
        labelAr: 'لم يتم تحصيل المبلغ',
        severity: 'high',
        audience: 'merchant',
      },
      {
        key: 'payment.fod',
        labelEn: 'Fees on Delivery',
        labelAr: 'رسوم التوصيل',
        audience: 'any',
        note: "ShipBlu's FOD product, where the delivery fee is collected from the recipient. Its own category because a recipient refusing the fee is a commercial decision the merchant needs to see, not a delivery failure.",
      },
      {
        key: 'payment.method',
        labelEn: 'How can I pay',
        labelAr: 'طرق الدفع',
        audience: 'recipient',
        note: 'Cash, card, wallet — asked before the courier arrives. Distinct from `fod`, which is a dispute about a fee rather than a question about how to settle one.',
      },
      {
        key: 'payment.refund',
        labelEn: 'Refund request',
        labelAr: 'طلب استرداد',
        severity: 'high',
        audience: 'recipient',
      },
    ],
  },
  {
    area: 'billing',
    labelEn: 'Merchant finance',
    labelAr: 'الحسابات المالية',
    categories: [
      {
        key: 'billing.payout',
        labelEn: 'Payouts and transfers',
        labelAr: 'التحويلات والمستحقات',
        audience: 'merchant',
      },
      {
        key: 'billing.wallet',
        labelEn: 'ShipBlu Wallet',
        labelAr: 'محفظة شيب بلو',
        audience: 'merchant',
      },
      {
        key: 'billing.invoice',
        labelEn: 'Invoices',
        labelAr: 'الفواتير الضريبية',
        audience: 'merchant',
      },
      {
        key: 'billing.pricing',
        labelEn: 'Pricing on my account',
        labelAr: 'الأسعار على حسابي',
        audience: 'merchant',
        note: 'An existing merchant asking what they are charged. Distinct from `commercial.pricing_enquiry`, which is a prospect who has not signed up — the second is a sales lead and counting them together hides how many are being answered as support.',
      },
      {
        key: 'billing.discrepancy',
        labelEn: 'Charged incorrectly',
        labelAr: 'خطأ في الرسوم',
        severity: 'high',
        audience: 'merchant',
      },
    ],
  },
  {
    area: 'account',
    labelEn: 'Account',
    labelAr: 'الحساب',
    categories: [
      {
        key: 'account.signup',
        labelEn: 'Creating an account',
        labelAr: 'إنشاء حساب',
        audience: 'merchant',
      },
      {
        key: 'account.access',
        labelEn: 'Access and sub-accounts',
        labelAr: 'الدخول والحسابات الفرعية',
        audience: 'merchant',
      },
      {
        key: 'account.settings',
        labelEn: 'Account settings',
        labelAr: 'إعدادات الحساب',
        audience: 'merchant',
      },
    ],
  },
  {
    area: 'integration',
    labelEn: 'Integrations',
    labelAr: 'الربط الإلكتروني',
    categories: [
      {
        key: 'integration.setup',
        labelEn: 'Connecting a store',
        labelAr: 'ربط المتجر الإلكتروني',
        audience: 'merchant',
        note: 'Shopify, Magento, WooCommerce, Zammit — the four the help centre documents.',
      },
      { key: 'integration.api', labelEn: 'API', labelAr: 'واجهة البرمجة', audience: 'merchant' },
      {
        key: 'integration.sync_issue',
        labelEn: 'Orders not syncing',
        labelAr: 'الأوردرات لا تُنقل',
        severity: 'high',
        audience: 'merchant',
        note: 'Separate from `setup`: a connection that worked and stopped is an incident, and one that was never configured is onboarding.',
      },
    ],
  },
  {
    area: 'commercial',
    labelEn: 'Commercial and pre-sales',
    labelAr: 'الاستفسارات التجارية',
    categories: [
      {
        key: 'commercial.pricing_enquiry',
        labelEn: 'Rates before signing up',
        labelAr: 'استفسار عن الأسعار',
        audience: 'merchant',
        note: 'The single most common thing real merchants write on Facebook. A sales lead sitting in a support queue, and until it is counted nobody knows how many there are.',
      },
      {
        key: 'commercial.coverage',
        labelEn: 'Serviced zones',
        labelAr: 'مناطق التغطية',
        audience: 'merchant',
      },
      {
        key: 'commercial.capability',
        labelEn: 'What can be shipped',
        labelAr: 'المنتجات المسموح بشحنها',
        audience: 'merchant',
        note: 'Fragile goods, and the forbidden-products list.',
      },
      {
        key: 'commercial.contract',
        labelEn: 'Contracts and terms',
        labelAr: 'التعاقدات والشروط',
        audience: 'merchant',
      },
      {
        key: 'commercial.product_info',
        labelEn: 'ShipBlu products',
        labelAr: 'خدمات ومنتجات شيب بلو',
        audience: 'merchant',
        note: 'Shield, Try & Buy, myBlu, Instant Payout, Action Center, Analytics — ten help-centre articles between them.',
      },
      {
        key: 'commercial.claim',
        labelEn: 'Claims and compensation',
        labelAr: 'تعويضات ومطالبات',
        severity: 'high',
        audience: 'merchant',
        note: 'The formal claims procedure, which is a process with its own paperwork rather than a description of what went wrong — the cause dimension carries that.',
      },
    ],
  },
  {
    area: 'service',
    labelEn: 'About our service',
    labelAr: 'عن خدمتنا',
    categories: [
      {
        key: 'service.request_human',
        labelEn: 'Asking for a person',
        labelAr: 'طلب التحدث مع موظف',
        severity: 'low',
        audience: 'any',
        note: 'Very common on Facebook, and the most under-rated row here: high volume means people cannot find a way to reach us, which is a product finding rather than a support one.',
      },
      {
        key: 'service.chasing',
        labelEn: 'Chasing a reply',
        labelAr: 'متابعة بدون رد',
        audience: 'any',
        note: 'Measures us, not the parcel. Rising volume here means first-response time is slipping, whatever the SLA report says.',
      },
      {
        key: 'service.complaint',
        labelEn: 'Complaint about our service',
        labelAr: 'شكوى على الخدمة',
        severity: 'high',
        audience: 'any',
      },
      {
        key: 'service.praise',
        labelEn: 'Thanks or praise',
        labelAr: 'شكر وثناء',
        severity: 'low',
        audience: 'any',
      },
      {
        key: 'service.acknowledgement',
        labelEn: 'Acknowledgement',
        labelAr: 'رد بالموافقة',
        severity: 'low',
        audience: 'any',
        note: '`تمام`, `اوك`, `تم الاستلام` — the customer agreeing or confirming, with no request in it. The highest-volume single free-text message in the archive, and worth a row rather than a shrug: the share of inbound that is conversational filler rather than demand is what makes a volume forecast honest.',
      },
    ],
  },
  {
    area: 'other',
    labelEn: 'Not support',
    labelAr: 'ليست خدمة عملاء',
    categories: [
      {
        key: 'other.job_application',
        labelEn: 'Job application',
        labelAr: 'طلب توظيف',
        audience: 'any',
        note: 'Real, recurring inbound on Facebook. Filed as a customer it distorts every other number; filed here it is a number the recruiting side can be handed.',
      },
      {
        key: 'other.partnership_offer',
        labelEn: 'Partnership or courier offer',
        labelAr: 'عرض شراكة أو مناديب',
        audience: 'any',
      },
      {
        key: 'other.vendor_sales',
        labelEn: 'Somebody selling to us',
        labelAr: 'عرض بيع أو خدمة',
        severity: 'low',
        audience: 'any',
      },
      {
        key: 'other.spam',
        labelEn: 'Spam',
        labelAr: 'رسائل غير مرغوبة',
        severity: 'low',
        audience: 'any',
        note: "Includes other merchants' own autoresponders, which arrive on our channels and read like customer messages.",
      },
    ],
  },
  {
    area: 'meta',
    labelEn: 'Unclassified',
    labelAr: 'غير مصنّف',
    categories: [
      {
        key: 'meta.unclassified',
        labelEn: 'Not classified',
        labelAr: 'غير مصنّف',
        severity: 'low',
        audience: 'any',
        note: 'Free text no rule matched. The only category here meant to shrink, and the one the review queue is built on. It is a real row rather than an absence so that it can be counted — an absence cannot be a target.',
      },
    ],
  },
] as const;

export type RootCauseDef = {
  key: string;
  labelEn: string;
  labelAr: string;
  owner: RootCauseRow['owner'];
  note?: string;
};

/**
 * Why tickets happen: 27 causes, each naming exactly one accountable party.
 *
 * The key's prefix **is** the owner, so a mis-filed cause is visible by reading
 * it, and the owner column can be checked against it.
 *
 * Set by the agent on resolve, never by the detector. This is the dimension the
 * business acts on: a category report says what the queue is full of, and only
 * this says what to go and fix.
 */
export const ROOT_CAUSES: readonly RootCauseDef[] = [
  {
    key: 'courier.no_attempt',
    labelEn: 'Courier did not attempt delivery',
    labelAr: 'المندوب لم يحاول التوصيل',
    owner: 'courier',
  },
  {
    key: 'courier.no_contact',
    labelEn: 'Courier did not call',
    labelAr: 'المندوب لم يتصل بالعميل',
    owner: 'courier',
  },
  {
    key: 'courier.false_scan',
    labelEn: 'Courier recorded a status that did not happen',
    labelAr: 'تسجيل حالة غير صحيحة',
    owner: 'courier',
    note: "The gap between what the platform says and what happened. lib/shipments/status.ts's `attempted` and `delivered` are the courier's claim; this is the finding that the claim was wrong, and the two must never be merged.",
  },
  {
    key: 'courier.conduct',
    labelEn: 'Courier conduct',
    labelAr: 'سلوك المندوب',
    owner: 'courier',
  },
  {
    key: 'courier.late',
    labelEn: 'Courier ran late',
    labelAr: 'تأخير من المندوب',
    owner: 'courier',
  },

  {
    key: 'hub.missort',
    labelEn: 'Mis-sorted at the hub',
    labelAr: 'فرز خاطئ في الفرع',
    owner: 'hub',
  },
  { key: 'hub.backlog', labelEn: 'Hub backlog', labelAr: 'تكدس في الفرع', owner: 'hub' },
  { key: 'hub.damage', labelEn: 'Damaged in our care', labelAr: 'تلف داخل الفرع', owner: 'hub' },
  { key: 'hub.lost', labelEn: 'Lost in our care', labelAr: 'فقدان داخل الفرع', owner: 'hub' },

  {
    key: 'merchant.late_handover',
    labelEn: 'Merchant handed over late',
    labelAr: 'تأخر التاجر في تسليم الشحنة',
    owner: 'merchant',
  },
  {
    key: 'merchant.wrong_item',
    labelEn: 'Merchant sent the wrong item',
    labelAr: 'التاجر أرسل منتجًا خاطئًا',
    owner: 'merchant',
  },
  {
    key: 'merchant.packaging',
    labelEn: 'Merchant packaging inadequate',
    labelAr: 'تغليف غير كافٍ من التاجر',
    owner: 'merchant',
  },
  {
    key: 'merchant.bad_address',
    labelEn: 'Merchant supplied a bad address',
    labelAr: 'عنوان غير صحيح من التاجر',
    owner: 'merchant',
  },
  {
    key: 'merchant.bad_contact_data',
    labelEn: 'Merchant supplied bad contact details',
    labelAr: 'بيانات تواصل خاطئة من التاجر',
    owner: 'merchant',
  },
  {
    key: 'merchant.cod_error',
    labelEn: 'Merchant set the wrong COD amount',
    labelAr: 'مبلغ تحصيل خاطئ من التاجر',
    owner: 'merchant',
  },

  {
    key: 'recipient.unavailable',
    labelEn: 'Recipient was not there',
    labelAr: 'المستلم غير متواجد',
    owner: 'recipient',
  },
  {
    key: 'recipient.refused',
    labelEn: 'Recipient refused the parcel',
    labelAr: 'المستلم رفض الاستلام',
    owner: 'recipient',
  },
  {
    key: 'recipient.unreachable',
    labelEn: 'Recipient could not be reached',
    labelAr: 'تعذر الوصول للمستلم',
    owner: 'recipient',
  },
  {
    key: 'recipient.address_error',
    labelEn: 'Recipient gave a wrong address',
    labelAr: 'عنوان غير صحيح من المستلم',
    owner: 'recipient',
  },

  {
    key: 'platform.bug',
    labelEn: 'A bug in our software',
    labelAr: 'خطأ في النظام',
    owner: 'platform',
  },
  {
    key: 'platform.sync_failure',
    labelEn: 'Integration or sync failure',
    labelAr: 'فشل في الربط أو المزامنة',
    owner: 'platform',
  },
  {
    key: 'platform.self_service_gap',
    labelEn: 'Customer could not do it themselves',
    labelAr: 'العميل لم يستطع إنجازها بنفسه',
    owner: 'platform',
    note: 'The most actionable row in this table. Every ticket with this cause is one the product could have prevented — the customer tried, the app did not let them, and they had to write to a person. Earned its place from a real message: somebody trying to cancel a shipment in the portal and being unable to.',
  },

  {
    key: 'external.weather_traffic',
    labelEn: 'Weather or traffic',
    labelAr: 'طقس أو مرور',
    owner: 'external',
  },
  {
    key: 'external.zone_unserviced',
    labelEn: 'Outside the serviced area',
    labelAr: 'منطقة خارج نطاق الخدمة',
    owner: 'external',
  },
  { key: 'external.holiday', labelEn: 'Public holiday', labelAr: 'عطلة رسمية', owner: 'external' },

  {
    key: 'none.working_as_designed',
    labelEn: 'Working as designed',
    labelAr: 'الخدمة تعمل كما هو مصمم',
    owner: 'none',
    note: 'Nothing failed and the customer expected something else. A real and useful answer: a lot of it in one category is a promise being set wrong upstream, not an operations problem.',
  },
  {
    key: 'none.enquiry',
    labelEn: 'An enquiry, nothing failed',
    labelAr: 'استفسار بدون مشكلة',
    owner: 'none',
    note: 'The right cause for most of `commercial` and `account`. Without it an agent resolving a price-list question is forced to name a failure that did not occur.',
  },
] as const;

/** Every category, flattened, in seed order. */
export function allCategories(): readonly (CategoryDef & { area: string; position: number })[] {
  const rows: (CategoryDef & { area: string; position: number })[] = [];
  let position = 0;
  for (const area of TAXONOMY) {
    for (const category of area.categories) {
      rows.push({ ...category, area: area.area, position: position++ });
    }
  }
  return rows;
}

/** The area a key belongs to — always the part before the dot. */
export function areaOf(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * What an area is called, for a report grouping on the stored `area` column.
 *
 * Falls back to the key, which is the same answer the category join in
 * `lib/reports/category-queries.ts` gives: a rollup row keeps the area it was
 * counted under, so a report drawn last quarter still renders after somebody
 * tidies the taxonomy — it just renders the raw key rather than pretending the
 * area no longer exists. Areas have no registry table and are never renamed by
 * an admin, so this is the only place a label for one can come from.
 */
export function areaLabel(area: string): string {
  return TAXONOMY.find((one) => one.area === area)?.labelEn ?? area;
}

export function categoryKeys(): readonly string[] {
  return allCategories().map((c) => c.key);
}

export function rootCauseKeys(): readonly string[] {
  return ROOT_CAUSES.map((c) => c.key);
}

/** The fallback every uncategorised ticket gets, so an absence is countable. */
export const UNCLASSIFIED_KEY = 'meta.unclassified';

/**
 * The areas where a ticket owes a root cause before anybody may call it done.
 *
 * Only where something actually failed. A price-list question or an integration
 * walkthrough has no cause, and demanding one would teach agents to pick
 * whatever clears the dialogue — which is how a dimension fills up with noise
 * and stops being worth reporting on.
 *
 * One definition, read by three places that would otherwise drift: the resolve
 * gate in `lib/tickets/console-guards.ts`, and the coverage figure on
 * `/reports/categories`, which has to measure the population the gate demands.
 * A coverage line whose denominator is every resolved ticket reports a
 * permanent two-thirds gap made mostly of enquiries that never owed a cause,
 * and a number that can never reach 100% is one people stop reading.
 */
export const CAUSE_REQUIRED_AREAS: readonly string[] = [
  'delivery',
  'condition',
  'pickup',
  'return',
  'payment',
];

/**
 * The one category the detector treats as exclusive, named because three
 * modules branch on it.
 *
 * A promotional message mentioning `توصيل` must not also be filed as a delivery
 * question, so a spam hit suppresses every other hit rather than joining them.
 */
export const SPAM_KEY = 'other.spam';
