import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { messages } from '@/db/schema';

/**
 * Leaves WhatsApp reactions out of a query over `messages` — the SQL twin of
 * `isReaction` (`lib/whatsapp/reaction.ts`), which says why a reader that picks
 * somebody's last words needs it.
 *
 * `is distinct from` rather than `<>`, because the key is absent on every row
 * that is not a WhatsApp message: `->>` is null there, `null <> 'reaction'` is
 * null, and the `<>` spelling would quietly drop every email, portal, widget and
 * Meta row from whatever it filters.
 */
export function notReaction(): SQL {
  return sql`${messages.meta}->>'whatsappType' is distinct from 'reaction'`;
}
