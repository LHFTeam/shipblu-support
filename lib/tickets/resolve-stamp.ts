import type { conversations } from '@/db/schema';
import type { StatusCategory } from './vocabulary';

/**
 * What a move into a status of `category` writes to `resolved_at`, for every
 * writer of a ticket's status — the console's `changeStatus`, an automation's
 * `set_status` and a customer's reopen (`reopenResolved`) — so they cannot
 * disagree about it again.
 *
 * The column means when the ticket was last resolved, if it has not been back
 * to Open or Pending since. A resolve stamps it, a move back to Open or
 * Pending clears it, and a close leaves it as it is: a resolved ticket that
 * closes keeps the resolve it follows, and one closed straight from Open keeps
 * the null its last move into Open or Pending left — closing is not resolving,
 * which `conversations.root_cause_set_at` explains.
 *
 * The console and the automation used to clear it on any status but Resolved,
 * and the seeded rule closes every resolved ticket after 72 hours. So the
 * resolution vanished from the rollups, which count a day's resolutions and
 * their SLA from this column, the first time its day was recomputed after the
 * close (docs/PROJECT-STATE.md §6.98).
 *
 * The close leaves the column out of the update rather than writing back a
 * value it read, because the rule's sweep reads its tickets before it writes:
 * a value carried from that read would put an old resolve back onto a ticket
 * the customer reopened in between. Nor does a close stamp a missing one. A
 * conversation the business started from the WhatsApp Business app, or a copied
 * history, is resolved with no `resolved_at` because nobody resolved it, and
 * closing it does not make somebody have.
 */
export function resolveStamp(
  category: StatusCategory,
): Partial<Pick<typeof conversations.$inferInsert, 'resolvedAt'>> {
  // No default arm: a category added to the enum is a compile error here
  // rather than a move that silently clears the stamp.
  switch (category) {
    case 'resolved':
      return { resolvedAt: new Date() };
    case 'closed':
      return {};
    case 'open':
    case 'pending':
      return { resolvedAt: null };
  }
}
