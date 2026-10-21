import { describe, expect, it } from 'vitest';
import { effectiveOwnerId, ownerStamp } from './number-owner';

describe('effectiveOwnerId', () => {
  it('is the owner while they are active, and nobody otherwise', () => {
    expect(effectiveOwnerId({ id: 'nayera', active: true })).toBe('nayera');
    // Still recorded on the number, so reactivating restores it — but no new
    // work is stamped on somebody who cannot sign in.
    expect(effectiveOwnerId({ id: 'nayera', active: false })).toBeNull();
    expect(effectiveOwnerId(null)).toBeNull();
  });
});

describe('ownerStamp', () => {
  const at = new Date('2026-10-21T09:00:00Z');

  it('makes a new ticket the owner’s to answer and to answer for', () => {
    expect(ownerStamp('nayera', at)).toEqual({
      accountableAgentId: 'nayera',
      assigneeAgentId: 'nayera',
      assignedAt: at,
    });
  });

  // Spread into an insert, so "nobody" must be explicit nulls rather than
  // missing keys a later spread could leave holding something else.
  it('leaves a team number’s ticket unassigned and accountable to nobody', () => {
    expect(ownerStamp(null, at)).toEqual({
      accountableAgentId: null,
      assigneeAgentId: null,
      assignedAt: null,
    });
  });
});
