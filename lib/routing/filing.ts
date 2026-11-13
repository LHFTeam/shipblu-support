/**
 * Whether a channel row's new tickets can enter routing at all, before its
 * mode and the classifier are asked (`routingStartFor`). Two things stop one
 * whatever the mode says, and both are decided by ingest, not by the row:
 *
 * - **another row files them.** Email, the Meta rows, web chat and the myBlu
 *   app (`apiChannel`) each file under the oldest active row of their type,
 *   so a second one's mode does nothing.
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
 * `webchatChannel`), and `apiChannel` for the myBlu app's.
 */
export function filingRowFor<T extends FilingInput>(channel: T, rows: readonly T[]): T | null {
  if (channel.type === 'whatsapp' || channel.type === 'whatsapp_bot') return channel;
  return filingRowOfType(channel.type, rows);
}

/**
 * The row a type filed by kind rather than by row files under: the oldest
 * active one. The widget's row is this for `webchat` (`lib/widget/rows.ts`),
 * so the panel's "another row files them" and the Chat widget card follow one
 * rule. `rows` as `filingRowFor` takes them.
 */
export function filingRowOfType<T extends Pick<FilingInput, 'type' | 'isActive'>>(
  type: string,
  rows: readonly T[],
): T | null {
  return rows.find((row) => row.type === type && row.isActive) ?? null;
}

/** Only a `whatsapp` row may have an owner (`channels_owner_only_whatsapp`). A deactivated one counts as nobody. */
export function ownedByActiveAgent(channel: FilingInput): boolean {
  return channel.type === 'whatsapp' && channel.ownerActive === true;
}

/**
 * Types a row can be made for before any ingest path files a ticket under it.
 * The myBlu app's row is made ahead of the release that opens its tickets
 * (`plans/myblu-ticket-api.md`, stage 2), and until that path ships its mode
 * routes nothing: the panel said "held and routed" of a row that filed no
 * ticket. Emptied by the stage whose path files under the type.
 */
const NOT_FILED_YET: readonly string[] = ['api'];

/**
 * Whether an ingest path files tickets under a row of this type yet. Asked by
 * `planRouting` as well as by the panel and the report, so the list cannot
 * claim one thing while the router does another: a type left on it after its
 * path ships starts no routing, and that stage's own routing test fails.
 */
export function filedYet(type: string): boolean {
  return !NOT_FILED_YET.includes(type);
}

/**
 * Why a new ticket on `channel` does not reach the question of its mode, or
 * null when it does. One answer, in one order, for the readiness panel and
 * `/reports/routing`, so the two name the same reason for a row:
 *
 * - `not_filed_yet` first, whatever else is true of the row: no ingest path
 *   files under its type, so nothing about it holds a ticket — not its being
 *   off, which would speak of tickets held under it before, nor another row of
 *   its type, which files nothing either.
 * - `inactive`: a row switched off files nothing new.
 * - `another_row`: another row of its type files its tickets.
 * - `owned`: its number's active owner is stamped on each one.
 */
export type FilingGap = 'not_filed_yet' | 'inactive' | 'another_row' | 'owned';

/** `rows` as `filingRowFor` takes them. */
export function filingGap<T extends FilingInput>(channel: T, rows: readonly T[]): FilingGap | null {
  if (!filedYet(channel.type)) return 'not_filed_yet';
  if (!channel.isActive) return 'inactive';
  if (filingRowFor(channel, rows) !== channel) return 'another_row';
  if (ownedByActiveAgent(channel)) return 'owned';
  return null;
}

/** True when a new ticket on `channel` reaches the question of its mode. `rows` as `filingRowFor` takes them. */
export function filesRoutableTickets<T extends FilingInput>(
  channel: T,
  rows: readonly T[],
): boolean {
  return filingGap(channel, rows) === null;
}
