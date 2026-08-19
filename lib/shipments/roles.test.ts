import { describe, expect, it } from 'vitest';
import { deriveRequesterRole, type ShipmentParties } from './roles';

const REQUESTER = 'contact-1';
const SOMEBODY_ELSE = 'contact-2';

function shipment(overrides: Partial<ShipmentParties> = {}): ShipmentParties {
  return {
    syncState: 'synced',
    shipperContactId: null,
    recipientContactId: null,
    ...overrides,
  };
}

describe('deriveRequesterRole', () => {
  it('says unknown for a stub, which is nearly every freshly detected link', () => {
    const parties = shipment({ syncState: 'stub', recipientContactId: REQUESTER });
    expect(deriveRequesterRole(REQUESTER, parties)).toBe('unknown');
  });

  it('says unknown when the platform said the number is not a shipment', () => {
    expect(deriveRequesterRole(REQUESTER, shipment({ syncState: 'not_found' }))).toBe('unknown');
  });

  it('says unknown when a synced shipment names neither party', () => {
    // Not `other`. Nobody has been named, so nobody has been excluded.
    expect(deriveRequesterRole(REQUESTER, shipment())).toBe('unknown');
  });

  it('recognises the shipper', () => {
    const parties = shipment({ shipperContactId: REQUESTER, recipientContactId: SOMEBODY_ELSE });
    expect(deriveRequesterRole(REQUESTER, parties)).toBe('shipper');
  });

  it('recognises the recipient', () => {
    const parties = shipment({ shipperContactId: SOMEBODY_ELSE, recipientContactId: REQUESTER });
    expect(deriveRequesterRole(REQUESTER, parties)).toBe('recipient');
  });

  it('recognises both, which every return looks like', () => {
    const parties = shipment({ shipperContactId: REQUESTER, recipientContactId: REQUESTER });
    expect(deriveRequesterRole(REQUESTER, parties)).toBe('both');
  });

  it('says other when a synced shipment names two people and neither is the requester', () => {
    // A colleague, a 3PL, a family member collecting — or a mislinked ticket.
    const parties = shipment({ shipperContactId: SOMEBODY_ELSE, recipientContactId: 'contact-3' });
    expect(deriveRequesterRole(REQUESTER, parties)).toBe('other');
  });

  it('says other when only the far party is known', () => {
    const parties = shipment({ shipperContactId: SOMEBODY_ELSE });
    expect(deriveRequesterRole(REQUESTER, parties)).toBe('other');
  });
});
