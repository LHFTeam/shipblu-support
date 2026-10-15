import type { SQL } from 'drizzle-orm';
import { and, ne, sql } from 'drizzle-orm';
import { messages } from '@/db/schema';

/**
 * Leaves WhatsApp reactions out of a query over `messages` — the SQL twin of
 * `isReaction` (`lib/whatsapp/reaction.ts`), which says why a row is recognised
 * by its kind or, for one release, by the tag the rows stored before the kind
 * carried.
 *
 * A reader that already picks `kind = 'reply'` needs only the tag half, and
 * keeps this until that half goes; the kind half is here so that the predicate
 * means what its name says wherever it is used.
 *
 * `is distinct from` rather than `<>` for the tag, because the key is absent on
 * every row that is not a WhatsApp message: `->>` is null there,
 * `null <> 'reaction'` is null, and the `<>` spelling would quietly drop every
 * email, portal, widget and Meta row from whatever it filters.
 */
export function notReaction(): SQL {
  return and(
    ne(messages.kind, 'reaction'),
    sql`${messages.meta}->>'whatsappType' is distinct from 'reaction'`,
  )!;
}
