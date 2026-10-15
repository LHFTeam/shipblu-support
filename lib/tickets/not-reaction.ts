import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
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
 * The kind is compared as text. As an enum comparison, `'reaction'` is bound as
 * a `message_kind`, and a database that has not run migration 0035 refuses it
 * with 22P02 — so a worker or cron started on this code before the web deploy
 * had migrated would fail every query through here: the sending number of
 * every WhatsApp reply, the language of every automated one. As text it needs
 * the value to exist nowhere.
 *
 * `is distinct from` rather than `<>` for the tag, because the key is absent on
 * every row that is not a WhatsApp message: `->>` is null there,
 * `null <> 'reaction'` is null, and the `<>` spelling would quietly drop every
 * email, portal, widget and Meta row from whatever it filters.
 */
export function notReaction(): SQL {
  return sql`(${messages.kind}::text <> 'reaction' and ${messages.meta}->>'whatsappType' is distinct from 'reaction')`;
}
