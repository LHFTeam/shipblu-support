/**
 * Which population a ticket came from, decided from records rather than words.
 *
 * Pure and tiny, but separated from `apply.ts` for the same reason the detector
 * is: this is a rule about what may be concluded from what, and it belongs
 * somewhere a test can reach without a database.
 *
 * **Records only.** The original design also sniffed vocabulary — a merchant
 * says `شحناتي` and "price list", a recipient says `المندوب` — and that half is
 * deliberately dropped. `requester_kind` is a dimension reports slice by, so a
 * value guessed from one sentence is an unfalsifiable number sitting beside
 * measured ones, which is the same argument that keeps the root cause off the
 * detector. A recipient complaining about a courier's conduct uses the merchant
 * vocabulary; a merchant chasing their own return uses the recipient's.
 *
 * The inputs are already maintained: `refreshContactRoles()` sets
 * `is_shipper` / `is_recipient` from the relationship tables, and
 * `contact_shipping_accounts` says who may speak for an account.
 */

export type RequesterKind = 'merchant' | 'recipient';

export type RequesterFacts = {
  isShipper: boolean;
  isRecipient: boolean;
  hasShippingAccount: boolean;
};

/**
 * `merchant`, `recipient`, or **null when the records do not say**.
 *
 * Three things this deliberately does not do:
 *
 * - **Both flags true resolves to `merchant`.** It is the common case rather
 *   than a contradiction — `db/schema/customers.ts` says so: anyone who ships
 *   also receives their own returns. Holding a shipping account is the stronger
 *   fact, and it is the one that decides which half of the taxonomy they are
 *   likely to be asking about.
 * - **Neither flag resolves to null, never `prospect`.** Role maintenance is
 *   additive — it turns a flag on when it can prove it and never off — so an
 *   absent flag is an absence of evidence. A recipient whose parcel has not
 *   synced yet looks exactly like a stranger.
 * - **It never downgrades.** The caller writes only when the column is null, so
 *   a value an agent or a later account link established is never overwritten
 *   by a message arriving from a contact whose records have since been merged.
 */
export function requesterKindFrom(facts: RequesterFacts): RequesterKind | null {
  if (facts.hasShippingAccount || facts.isShipper) return 'merchant';
  if (facts.isRecipient) return 'recipient';
  return null;
}
