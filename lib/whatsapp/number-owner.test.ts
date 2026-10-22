import { describe, expect, it } from 'vitest';
import { effectiveOwnerId, handoverNotice, ownerStamp } from './number-owner';

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

describe('handoverNotice', () => {
  const done = {
    ok: true as const,
    changed: true,
    channelName: 'Nayera Mohamed',
    displayNumber: '+20 12 78707918',
    to: { id: 'nayera', label: 'Nayera Mohamed' },
    ticketsMoved: 89,
    ticketsReassigned: 89,
  };

  it('says who owns the number and what moved to them', () => {
    expect(handoverNotice(done)).toBe(
      'Nayera Mohamed owns +20 12 78707918 from now. 89 open or pending tickets moved to them.',
    );
    expect(handoverNotice({ ...done, ticketsMoved: 0, ticketsReassigned: 0 })).toBe(
      'Nayera Mohamed owns +20 12 78707918 from now. No open or pending ticket needed moving.',
    );
  });

  // A ticket a supervisor gave to a third person counts against the new owner
  // and stays where it was put: "moved to them" would be half true of it.
  it('separates the breach that moved from the work that did not', () => {
    expect(handoverNotice({ ...done, ticketsMoved: 3, ticketsReassigned: 2 })).toBe(
      'Nayera Mohamed owns +20 12 78707918 from now. 3 open or pending tickets count against ' +
        'them; 2 were reassigned to them, and the rest stay with whoever holds them.',
    );
    expect(handoverNotice({ ...done, ticketsMoved: 1, ticketsReassigned: 0 })).toBe(
      'Nayera Mohamed owns +20 12 78707918 from now. 1 open or pending ticket counts against ' +
        'them, and stays with whoever holds it.',
    );
  });

  // A ticket an agent reopened by hand after an earlier handover can already
  // count against the new owner and sit with nobody: only its work moves, and
  // "no ticket needed moving" would be false of it.
  it('names work that moved without its breach', () => {
    expect(handoverNotice({ ...done, ticketsMoved: 0, ticketsReassigned: 1 })).toBe(
      'Nayera Mohamed owns +20 12 78707918 from now. 1 open or pending ticket was reassigned ' +
        'to them.',
    );
  });

  it('names a plain number by its channel, and a team number by what it now is', () => {
    expect(
      handoverNotice({ ...done, displayNumber: null, channelName: 'WhatsApp Support', to: null }),
    ).toBe(
      'WhatsApp Support is a team number from now: its 89 open or pending tickets count against ' +
        'whoever holds each.',
    );
    expect(handoverNotice({ ...done, to: null, ticketsMoved: 0, ticketsReassigned: 0 })).toBe(
      '+20 12 78707918 is a team number from now.',
    );
  });

  // A second press of the button lands here, and must not read as a second handover.
  it('says nothing changed when nothing did', () => {
    const unchanged = { ...done, changed: false, ticketsMoved: 0, ticketsReassigned: 0 };
    expect(handoverNotice(unchanged)).toBe(
      'Nayera Mohamed already owns +20 12 78707918; nothing changed.',
    );
    expect(handoverNotice({ ...unchanged, to: null })).toBe(
      '+20 12 78707918 is already a team number; nothing changed.',
    );
  });
});
