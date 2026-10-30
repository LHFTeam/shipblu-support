import type { Locale } from '@/lib/kb/locale';
import type { StatusCategory } from '@/lib/tickets/vocabulary';

/**
 * The word a customer reads for a ticket whose status has no customer label to
 * show — none set, or the status not shown to customers — in each language the
 * help centre speaks.
 *
 * Here rather than beside the portal's badge because the console states it
 * too: the statuses page says what a customer sees, and "the category word"
 * beside a Pending badge read as "Pending" when the portal says "In progress".
 * One list, so the page and the portal cannot name different words.
 */
export const CATEGORY_WORDS: Record<StatusCategory, Record<Locale, string>> = {
  open: { en: 'Open', ar: 'مفتوحة' },
  pending: { en: 'In progress', ar: 'قيد المعالجة' },
  resolved: { en: 'Resolved', ar: 'تم الحل' },
  closed: { en: 'Closed', ar: 'مغلقة' },
};
