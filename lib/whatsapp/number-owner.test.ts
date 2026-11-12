import { describe, expect, it } from 'vitest';
import { effectiveOwnerId, handoverNotice } from './number-owner';

describe('effectiveOwnerId', () => {
  it('is the owner while they are active, and nobody otherwise', () => {
    expect(effectiveOwnerId({ id: 'nayera', active: true })).toBe('nayera');
    // Still recorded on the number, so reactivating restores it — but no new
    // work is stamped on somebody who cannot sign in.
    expect(effectiveOwnerId({ id: 'nayera', active: false })).toBeNull();
    expect(effectiveOwnerId(null)).toBeNull();
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
    ticketsUnassigned: 0,
    ownerOnly: false,
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
      'Nayera Mohamed owns +20 12 78707918 from now. 3 open or pending tickets now count ' +
        'against them; 2 tickets were reassigned to them.',
    );
    // Counted apart, so reassigned can exceed moved: one ticket already
    // accountable to the new owner, held by the previous one, is reassigned
    // without being moved. Neither count is read as a part of the other, and
    // one ticket is one ticket.
    expect(handoverNotice({ ...done, ticketsMoved: 1, ticketsReassigned: 2 })).toBe(
      'Nayera Mohamed owns +20 12 78707918 from now. 1 open or pending ticket now counts ' +
        'against them; 2 tickets were reassigned to them.',
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

  // A coexistence number with no owner is nobody's queue but the supervisors':
  // "a team number" would send the team to look for tickets hidden from them.
  it('says who can still see a coexistence number handed to nobody', () => {
    const nobody = { ...done, to: null, ownerOnly: true };
    expect(handoverNotice({ ...nobody, ticketsUnassigned: 2 })).toBe(
      '+20 12 78707918 has no owner from now: 2 open or pending tickets were unassigned, and ' +
        'only agents who can see every ticket can see its tickets until it has one.',
    );
    expect(handoverNotice({ ...nobody, ticketsMoved: 0, ticketsReassigned: 0 })).toBe(
      '+20 12 78707918 has no owner from now: only agents who can see every ticket can see its ' +
        'tickets until it has one.',
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
