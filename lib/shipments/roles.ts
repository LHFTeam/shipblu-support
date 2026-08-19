/**
 * Which end of a parcel the person who opened a ticket is on.
 *
 * This is derived, never stored on the conversation↔shipment link, and that is
 * the load-bearing decision in the whole feature.
 *
 * The role is a fact about *(contact, shipment)*, which the shipment already
 * holds in `shipper_contact_id` / `recipient_contact_id`. Copying it onto the
 * link would create a pair that disagree the first time a platform sync corrects
 * the shipment — the link saying "recipient" while the shipment names somebody
 * else as the recipient, and nothing in the system able to say which to believe.
 *
 * Five values, not two, and the two extra ones are why deriving is correct where
 * a stored column would not be:
 *
 * - `unknown` covers the ordinary case. A shipment is created the moment its
 *   number appears in a message, so nearly every link starts against a stub with
 *   no parties on it at all. Saying "we have not asked" is different from saying
 *   "they are neither", and only one of those is true at that point.
 * - `other` is what a *synced* shipment says when the requester is neither
 *   party, and it happens for real: the merchant's ops person writing about a
 *   colleague's shipment, a 3PL, a family member collecting a parcel, or an
 *   agent who linked the wrong number. Folding that into "recipient" would print
 *   a confident falsehood on exactly the tickets where an agent most needs to
 *   slow down.
 * - `both` is not a curiosity either. Every return has the merchant on both
 *   ends, and so does anyone shipping to themselves.
 */

export type RequesterRole = 'shipper' | 'recipient' | 'both' | 'other' | 'unknown';

export type ShipmentParties = {
  syncState: 'stub' | 'synced' | 'not_found';
  shipperContactId: string | null;
  recipientContactId: string | null;
};

export function deriveRequesterRole(
  requesterContactId: string,
  shipment: ShipmentParties,
): RequesterRole {
  // Nothing has confirmed this shipment exists, so its empty party columns are
  // an absence of knowledge rather than a statement about anyone.
  if (shipment.syncState !== 'synced') return 'unknown';
  if (!shipment.shipperContactId && !shipment.recipientContactId) return 'unknown';

  const isShipper = shipment.shipperContactId === requesterContactId;
  const isRecipient = shipment.recipientContactId === requesterContactId;

  if (isShipper && isRecipient) return 'both';
  if (isShipper) return 'shipper';
  if (isRecipient) return 'recipient';

  return 'other';
}

/** What an agent reads in the sidebar. Deliberately a sentence, not a label. */
export function describeRequesterRole(role: RequesterRole): string {
  switch (role) {
    case 'shipper':
      return 'Requester is the shipper';
    case 'recipient':
      return 'Requester is the recipient';
    case 'both':
      return 'Requester is both shipper and recipient';
    case 'other':
      return 'Requester is not a party to this shipment';
    case 'unknown':
      return 'Role unknown until this shipment is synced';
  }
}
