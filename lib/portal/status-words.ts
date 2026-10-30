import type { Locale } from '@/lib/kb/locale';
import { isStatusCategory, type StatusCategory } from '@/lib/tickets/vocabulary';

/**
 * What a customer reads for a ticket's status, decided once for every place
 * that draws or describes it: the portal's badge, and the statuses page saying
 * what a customer sees.
 *
 * Here rather than beside the portal's badge because the console states it
 * too, and a console that restated the rule for itself would describe a portal
 * that no longer exists the day one of them changed — "the category word"
 * beside a Pending badge already read as "Pending" where the portal says "In
 * progress".
 */

const CATEGORY_WORDS: Record<StatusCategory, Record<Locale, string>> = {
  open: { en: 'Open', ar: 'مفتوحة' },
  pending: { en: 'In progress', ar: 'قيد المعالجة' },
  resolved: { en: 'Resolved', ar: 'تم الحل' },
  closed: { en: 'Closed', ar: 'مغلقة' },
};

/**
 * The plain word for a category, in the reader's language — what a customer
 * reads when the status has no label to show.
 *
 * Takes a string rather than a `StatusCategory` because the value comes off
 * the database enum, which a deploy can widen before this list knows the new
 * value: an unknown category reads as itself rather than throwing, which would
 * take the customer's whole list of tickets down with one badge.
 */
export function categoryWord(category: string, locale: Locale): string {
  return isStatusCategory(category) ? CATEGORY_WORDS[category][locale] : category;
}

/**
 * The label the portal sends for a status: its customer label while the status
 * is shown to customers, and none otherwise — never the status's own name.
 *
 * `listTickets` and `getTicket` decide the same thing in SQL, where the row is
 * read (`shownLabelSql` in `lib/portal/tickets.ts`), and `tickets.db.test.ts`
 * holds the two to one answer on every combination. A blank label is null by
 * the time it is stored (`saveStatus`), so `''` reaches neither.
 */
export function shownLabel(status: {
  visibleToCustomer: boolean;
  customerLabel: string | null;
}): string | null {
  return status.visibleToCustomer ? status.customerLabel : null;
}
