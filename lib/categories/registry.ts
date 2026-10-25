/**
 * The starter set of ticket categories: which team's work a ticket is.
 *
 * In code so the wording goes through review, and seeded by
 * `seed_ticket_categories` (and `db/baseline.ts`), which puts in what is
 * missing and leaves what is there alone — from then on the labels,
 * descriptions, order and route groups are an admin's, on `/admin/categories`.
 *
 * A category is a routing label, not a statement about the requester: it says
 * which line of the business answers a message, which the message's words are
 * evidence of, and never who the person writing it is, which they are not
 * (`requester_kind` is that). So each description below speaks about what a
 * message asks for, and none of them says "a merchant" where it means "a
 * message about a merchant's account".
 *
 * The descriptions are written for Jev (Stage 4 shows each one beside its
 * option) as much as for the admin page, which is why each says where its
 * edges are: a model given four labels and no edges files a greeting under
 * whichever sounds friendliest. A message that is only a greeting, or names
 * nothing a team could act on, belongs to none of them — Jev answers
 * `unknown`, which no category may be called (`ticket_categories_key_format`).
 *
 * No route groups. Those are set on the admin page when Stage 5 turns routing
 * on (`plans/ticket-category-routing.md`, Q5), and `courier_jobs` has none even
 * then: it stays in its channel's default group.
 */
export type StarterCategory = {
  /** Lowercase words joined by underscores; never `unknown`. Immutable once seeded. */
  key: string;
  labelEn: string;
  labelAr: string;
  description: string;
};

export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  {
    key: 'sales',
    labelEn: 'Sales',
    labelAr: 'المبيعات',
    description:
      'Asking to start shipping with ShipBlu: prices and rates, how to sign up or open an ' +
      'account, which areas are covered, how pickup and cash collection would work, or ' +
      'asking to be called by the sales team. Not a question about an order that already ' +
      'exists.',
  },
  {
    key: 'customer_support',
    labelEn: 'Customer support',
    labelAr: 'دعم العملاء',
    description:
      'About a parcel on its way to the person writing: where it is, when it will arrive, ' +
      'rescheduling the delivery, changing the address or phone number, a courier who did ' +
      'not call or come, refusing the parcel, or the amount to pay on delivery.',
  },
  {
    key: 'merchant_support',
    labelEn: 'Merchant support',
    labelAr: 'دعم التجار',
    description:
      'About a shipping account that already exists and the orders sent from it: creating ' +
      'orders, pickups, cash-on-delivery transfers and payouts, invoices and fees, parcels ' +
      'returned to the sender, the dashboard, and store or API integrations.',
  },
  {
    key: 'courier_jobs',
    labelEn: 'Courier jobs',
    labelAr: 'وظائف المناديب',
    description:
      'A courier, driver or delivery company asking to work with or for ShipBlu: joining ' +
      'as a courier, delivery jobs, or supplying drivers or vehicles. Only when the message ' +
      'names delivery or courier work — a greeting, or "I want a job" that names no ' +
      'delivery work, is not this category.',
  },
];
