import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * ShipBlu's own locations — the hubs, warehouses and offices employees work out
 * of. No number of them is expected; the register holds whatever has been
 * entered.
 *
 * A location is three facts: a name people say out loud, a **code** they type,
 * and a shared **email** that reaches whoever is there. All three are here
 * because all three are how a location gets referred to in practice, and the
 * code and the address are both unique because both are used as identifiers —
 * one in conversation, one in a mail client.
 *
 * One thing points at it: `side_conversations.location_id`, the hub a thread
 * was sent to — which is why deleting a row goes through
 * `lib/locations/remove.ts`. Otherwise nothing in this system routes on a
 * location, no agent carries one, and no ticket is attributed to one: this is
 * the register of what exists, entered once, so that whichever of those lands
 * next has a real row to point at instead of a free-text hub name typed a
 * different way by every agent. Guessing which of them to build now would mean
 * guessing the column that carries it.
 *
 * The email is on the record, not in the mail path. It is the address an agent
 * escalates to or copies by hand — no channel row, no inbound routing, nothing
 * that could put a customer's reply somewhere nobody is watching.
 */
export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),

    /**
     * Short identifier, uppercased by `normaliseLocationCode()` before every
     * write and lookup — so `cai-1`, `CAI-1` and ` cai-1 ` are one location
     * rather than three, and the plain unique index below is enough to enforce
     * it. Same discipline as agent emails.
     */
    code: text('code').notNull(),

    /** The location's shared mailbox, lowercased like every other address here. */
    email: text('email').notNull(),

    /**
     * A closed hub keeps its row. Its code has been written on parcels and in
     * tickets, and deleting it would make that history unreadable — so a
     * location that stops operating is deactivated, and only one that was
     * entered by mistake is deleted.
     */
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('locations_code_idx').on(t.code),
    uniqueIndex('locations_email_idx').on(t.email),
    index('locations_name_idx').on(t.name),
  ],
);
