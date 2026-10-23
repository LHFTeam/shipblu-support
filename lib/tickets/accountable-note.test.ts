import { describe, expect, it } from 'vitest';
import { accountableNote, type AccountablePerson } from './accountable-note';

const nayera: AccountablePerson = { id: 'a1', name: 'Nayera Mohamed', active: true };
const ali: AccountablePerson = { id: 'a2', name: 'Ali Nasser', active: true };
// Production has two active agents of this name; only the id tells them apart.
const otherAli: AccountablePerson = { id: 'a3', name: 'Ali Nasser', active: true };

describe('accountableNote', () => {
  it('says nothing off our WhatsApp numbers', () => {
    expect(accountableNote(null, null)).toBeNull();
    expect(accountableNote(ali, null)).toBeNull();
  });

  it('says nothing when the ticket and the number agree', () => {
    expect(accountableNote(nayera, { owner: nayera })).toBeNull();
    expect(accountableNote(null, { owner: null })).toBeNull();
  });

  it('names the current owner of a ticket that was not handed to them', () => {
    expect(accountableNote(null, { owner: nayera })).toBe(
      'Nayera Mohamed owns this number now, but this ticket was not handed to them.',
    );
    expect(accountableNote(ali, { owner: nayera })).toBe(
      'Nayera Mohamed owns this number now, but this ticket was not handed to them.',
    );
  });

  it('compares people by id, not by name', () => {
    expect(accountableNote(ali, { owner: otherAli })).toBe(
      'Ali Nasser owns this number now, but this ticket was not handed to them.',
    );
  });

  it('says a ticket stays with its deactivated owner until the number is handed on', () => {
    const away = { ...nayera, active: false };
    expect(accountableNote(away, { owner: away })).toBe(
      'This ticket counts against them until an admin hands the number to someone else.',
    );
  });

  it('does not offer a deactivated owner as the one a ticket counts against', () => {
    const away = { ...nayera, active: false };
    expect(accountableNote(null, { owner: away })).toBe(
      'Nayera Mohamed owns this number but is deactivated, so it counts as a team number.',
    );
  });

  it('says a team number is a team number when the ticket still names a former owner', () => {
    expect(accountableNote(ali, { owner: null })).toBe('Nobody owns this number now.');
  });
});
