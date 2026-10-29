/**
 * Whether a channel row's new tickets can enter routing at all, before its
 * mode and the classifier are asked (`routingStartFor`). Two things stop one
 * whatever the mode says, and both are decided by ingest, not by the row:
 *
 * - **another row files them.** Email, the Meta rows and web chat each file
 *   under the oldest active row of their type, so a second one's mode does
 *   nothing.
 * - **an active owner.** An owned number's ticket is stamped with its owner in
 *   the insert, and a ticket with an assignee is never held
 *   (`lib/routing/start.ts`).
 *
 * The readiness panel on `/admin/channels` and the state notice on
 * `/reports/routing` both ask this, so the one saying a channel's tickets are
 * held and the one saying they are its owner's cannot disagree. Pure, so each
 * reads the rows its own way.
 */

/** What filing is judged on. `ownerActive` is null for a row nobody owns. */
export type FilingInput = {
  type: string;
  isActive: boolean;
  ownerActive: boolean | null;
};

/**
 * The row of `channel`'s kind new tickets are filed under, which is not
 * always `channel`. A WhatsApp row is its number, and is its own. A comments
 * row, while none is active, is stood in for by its platform's row — that is
 * not this one. `rows` oldest first, ties by id: the order every ingest path
 * picks "the row of this type" by (`defaultEmailChannel`, `channelFor`,
 * `webchatChannel`).
 */
export function filingRowFor<T extends FilingInput>(channel: T, rows: readonly T[]): T | null {
  if (channel.type === 'whatsapp' || channel.type === 'whatsapp_bot') return channel;
  return rows.find((row) => row.type === channel.type && row.isActive) ?? null;
}

/** Only a `whatsapp` row may have an owner (`channels_owner_only_whatsapp`). A deactivated one counts as nobody. */
export function ownedByActiveAgent(channel: FilingInput): boolean {
  return channel.type === 'whatsapp' && channel.ownerActive === true;
}

/** True when a new ticket on `channel` reaches the question of its mode. `rows` as `filingRowFor` takes them. */
export function filesRoutableTickets<T extends FilingInput>(
  channel: T,
  rows: readonly T[],
): boolean {
  return (
    channel.isActive && filingRowFor(channel, rows) === channel && !ownedByActiveAgent(channel)
  );
}
