/**
 * The line under the ticket sidebar's "Accountable" field.
 *
 * A module of its own, importing nothing, because the sidebar is a client
 * component and `accountable.ts` beside it reaches the database.
 *
 * The ticket's accountable agent is frozen onto it and the number's owner is
 * read as it is now, so the two can tell different stories: a resolved ticket
 * from before a handover, a ticket opened while the owner was deactivated, the
 * copied history. An agent who sees one name under "Accountable" and knows the
 * number is somebody else's would otherwise take one of the two for a bug. So
 * this says which story it is, and nothing when they agree.
 *
 * Compared by id, never by name: two active agents can share one.
 */

export type AccountablePerson = { id: string; name: string; active: boolean };

export function accountableNote(
  accountable: AccountablePerson | null,
  number: { owner: AccountablePerson | null } | null,
): string | null {
  // Not on one of our WhatsApp numbers: there is no owner to compare with.
  if (!number) return null;
  const { owner } = number;

  if (!owner) return accountable ? 'Nobody owns this number now.' : null;

  if (owner.id === accountable?.id) {
    // A deactivated owner keeps the tickets they had until somebody hands the
    // number on — the field's badge says "Deactivated", and this is what to do.
    return owner.active
      ? null
      : 'This ticket counts against them until an admin hands the number to someone else.';
  }

  // A deactivated owner counts as nobody for new tickets and reopens
  // (`effectiveOwnerId`), so naming them as the owner without that would read
  // as a promise that the ticket is theirs.
  return owner.active
    ? `${owner.name} owns this number now, but this ticket was not handed to them.`
    : `${owner.name} owns this number but is deactivated, so it counts as a team number.`;
}
