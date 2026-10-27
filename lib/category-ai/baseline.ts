import { bandFor, detectSubcategories } from '@/lib/subcategorise/detect';

/**
 * The free baseline each category answer is recorded beside: what the rules
 * detector finds in the same text, put through a reviewed map from
 * subcategory to category. Computed in the same call and never sent to Jev, so
 * the 4.2 report can read a disagreement as being about the text rather than
 * about which rows agents have since curated — the rule `AGENTS.md` sets the
 * shadow subcategoriser.
 *
 * Pure. Reads the message's own text, as the subcategoriser's baseline does
 * and as the rules run in production: the difference context makes is part of
 * what the comparison measures.
 */

/**
 * Every subcategory, by its taxonomy key, to the category its message is
 * evidence of — or null where a subcategory says nothing about which team.
 *
 * Written out rather than derived from the area or the audience: audience is
 * per subcategory, no area is wholly about a recipient, and twenty-three
 * subcategories are raised by both populations. A test holds this to exactly
 * the taxonomy's keys, so a subcategory added later cannot land without a
 * decision here.
 *
 * From the plan's rule (decision 4): `commercial.*` and `account.signup` to
 * sales, the other merchant-audience subcategories to merchant support,
 * recipient ones to customer support, and `service.*`, `meta.*` and `other.*`
 * to nothing. Where the rule is silent or wrong:
 *
 * - **The `any` subcategories go to customer support.** Customer support's
 *   description is exactly these topics — where a parcel is, when it arrives,
 *   its condition, a return, the amount to pay — and each has a merchant twin
 *   of its own (`return.not_received_by_merchant`, `payment.cod_not_collected`,
 *   `pickup.*`) where the merchant is meant.
 * - **`commercial.claim` goes to merchant support, not sales.** It is the
 *   claims and compensation process for a parcel already shipped, and sales is
 *   "not a question about an order that already exists".
 * - **`other.partnership_offer` goes to courier jobs.** Its rule matches
 *   مناديب and شراكه, which is the courier jobs description nearly word for
 *   word; without it one of the four classes has no baseline at all.
 *   `other.job_application` stays null, since courier jobs excludes "I want a
 *   job" that names no delivery work.
 *
 * The last two depart from the plan and are recorded there for the support
 * lead to confirm; the baseline routes nothing, so either is cheap to change.
 */
export const SUBCATEGORY_CATEGORY: Readonly<Record<string, string | null>> = {
  'delivery.where_is_it': 'customer_support',
  'delivery.late': 'customer_support',
  'delivery.eta_request': 'customer_support',
  'delivery.not_received_marked_delivered': 'customer_support',
  'delivery.failed_attempt': 'customer_support',
  'delivery.no_contact': 'customer_support',
  'delivery.reschedule': 'customer_support',
  'delivery.address_change': 'customer_support',
  'delivery.access_constraint': 'customer_support',
  'delivery.refused': 'customer_support',
  'delivery.unrecognised': 'customer_support',
  'condition.damaged': 'customer_support',
  'condition.wrong_item': 'customer_support',
  'condition.missing_items': 'customer_support',
  'condition.packaging': 'customer_support',
  'pickup.not_collected': 'merchant_support',
  'pickup.schedule': 'merchant_support',
  'pickup.point_change': 'merchant_support',
  'pickup.supplies': 'merchant_support',
  'return.status': 'customer_support',
  'return.request': 'customer_support',
  'return.exchange': 'customer_support',
  'return.not_received_by_merchant': 'merchant_support',
  'payment.cod_dispute': 'customer_support',
  'payment.cod_not_collected': 'merchant_support',
  'payment.fod': 'customer_support',
  'payment.method': 'customer_support',
  'payment.refund': 'customer_support',
  'billing.payout': 'merchant_support',
  'billing.wallet': 'merchant_support',
  'billing.invoice': 'merchant_support',
  'billing.pricing': 'merchant_support',
  'billing.discrepancy': 'merchant_support',
  'account.signup': 'sales',
  'account.access': 'merchant_support',
  'account.settings': 'merchant_support',
  'integration.setup': 'merchant_support',
  'integration.api': 'merchant_support',
  'integration.sync_issue': 'merchant_support',
  'commercial.pricing_enquiry': 'sales',
  'commercial.coverage': 'sales',
  'commercial.capability': 'sales',
  'commercial.contract': 'sales',
  'commercial.product_info': 'sales',
  'commercial.claim': 'merchant_support',
  'service.request_human': null,
  'service.chasing': null,
  'service.complaint': null,
  'service.praise': null,
  'service.acknowledgement': null,
  'other.job_application': null,
  'other.partnership_offer': 'courier_jobs',
  'other.vendor_sales': null,
  'other.spam': null,
  'meta.unclassified': null,
};

export type CategoryBaseline = {
  /** The first kept hit, in the detector's rank order, that maps to a category. */
  categoryKey: string | null;
  /** Every kept hit's key, in rank order, so the map can be reviewed again. */
  subcategoryKeys: string[];
};

/**
 * What the rules would say about this text.
 *
 * Hits filtered as the subcategoriser's baseline filters them
 * (`rulesBaseline` in `lib/subcategorise-ai/run.ts`): below the record band is
 * not something the rules would have stored. Then the first hit that names a
 * category, so a greeting followed by "rates?" reads as sales rather than as
 * nothing; every key is kept, so a stricter reading stays computable.
 */
export function categoryBaseline(bodyText: string): CategoryBaseline {
  const subcategoryKeys = detectSubcategories({ bodyText })
    .filter((hit) => bandFor(hit) !== 'ignored')
    .map((hit) => hit.key);
  const categoryKey =
    subcategoryKeys.map((key) => SUBCATEGORY_CATEGORY[key] ?? null).find((key) => key !== null) ??
    null;
  return { categoryKey, subcategoryKeys };
}
