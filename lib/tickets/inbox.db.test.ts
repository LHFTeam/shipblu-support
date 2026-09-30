import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { withCleanDatabase } from '@/lib/testing/db';
import { listInbox } from './inbox';
import { PAGE_SIZE, parseFilters, parseInboxCursor } from './inbox-filters';

/**
 * The inbox list's read model. What is pinned here is what the list decides a
 * badge from: a Facebook or Instagram comment ticket has no messaging window,
 * and the row has to say so, or the list badges "window closed" on a ticket
 * the header rightly shows none for.
 *
 * And the search, which is only worth testing against Postgres: the Arabic
 * clauses are regular expressions Postgres parses, and the ticket a number
 * names is a second query whose seam with the paged one is the cursor.
 */

withCleanDatabase();

async function admin(): Promise<SessionAgent> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', role: 'admin' })
    .returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions: {},
    avatarUrl: null,
    isAcceptingTickets: true,
    sessionIdleForMs: 0,
  };
}

async function ticket(channel: 'facebook' | 'instagram', externalId: string | null) {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({
      channel,
      statusId: open!.id,
      requesterContactId: contact!.id,
      externalId,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('listInbox', () => {
  it('marks a Meta comment ticket, and not a direct-message one', async () => {
    const agent = await admin();
    const comment = await ticket('instagram', 'instagram:comment:17900000000000001');
    const facebookComment = await ticket('facebook', 'facebook:comment:123_456');
    const message = await ticket('facebook', null);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row.isComment]));

    expect(byId.get(comment)).toBe(true);
    expect(byId.get(facebookComment)).toBe(true);
    expect(byId.get(message)).toBe(false);
  });
});

async function openStatusId(): Promise<string> {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  return open!.id;
}

/** Tickets for the search tests, one requester each. */
async function tickets(
  specs: Array<{ name?: string; phone?: string; body?: string; lastMessageAt?: Date }>,
) {
  const statusId = await openStatusId();
  const people = await db
    .insert(contacts)
    .values(specs.map((spec) => ({ name: spec.name ?? null, primaryPhone: spec.phone ?? null })))
    .returning({ id: contacts.id });
  const rows = await db
    .insert(conversations)
    .values(
      specs.map((spec, i) => ({
        channel: 'whatsapp' as const,
        statusId,
        requesterContactId: people[i]!.id,
        ...(spec.lastMessageAt ? { lastMessageAt: spec.lastMessageAt } : {}),
      })),
    )
    .returning({ id: conversations.id, number: conversations.number });

  const bodies = specs.flatMap((spec, i) =>
    spec.body
      ? [{ conversationId: rows[i]!.id, direction: 'inbound' as const, bodyText: spec.body }]
      : [],
  );
  if (bodies.length) await db.insert(messages).values(bodies);

  return rows;
}

describe('listInbox search', () => {
  it('finds a name and a message whichever way the Arabic was spelled', async () => {
    const agent = await admin();
    const [hamza, message, other] = await tickets([
      { name: 'أحمد سمير' },
      { name: 'Nada', body: 'عايز الغاء الشحنة لو سمحت' },
      { name: 'محمد' },
    ]);

    const ids = async (q: string) =>
      (await listInbox(agent, parseFilters({ q }))).rows.map((row) => row.id);

    expect(await ids('احمد')).toEqual([hamza!.id]);
    expect(await ids('الشحنه')).toEqual([message!.id]);
    // The ILIKE path is untouched for a query with nothing to widen.
    expect(await ids('Nada')).toEqual([message!.id]);
    expect(await ids('محمد')).toEqual([other!.id]);
    // Regular expression syntax is the query's own text, not an unbalanced
    // group Postgres would refuse.
    expect(await ids('أحمد (')).toEqual([]);
  });

  it('puts the ticket a number names first, and on no later page', async () => {
    const agent = await admin();
    const [named] = await tickets([
      { name: 'Old', lastMessageAt: new Date('2026-01-01T09:00:00Z') },
    ]);
    const n = named!.number;

    // A page and one more of newer tickets whose phones hold the same digits, so
    // a bare number matches them all and recency alone would bury the named one.
    await tickets(
      Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
        phone: `2010${n}${String(i).padStart(4, '0')}`,
      })),
    );

    const filters = parseFilters({ q: String(n) });
    const first = await listInbox(agent, filters);
    expect(first.rows[0]!.id).toBe(named!.id);
    expect(first.rows).toHaveLength(PAGE_SIZE + 1);
    expect(first.nextCursor).not.toBeNull();

    const second = await listInbox(agent, filters, parseInboxCursor(first.nextCursor));
    expect(second.rows.map((row) => row.id)).not.toContain(named!.id);
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.rows, ...second.rows].map((row) => row.id);
    expect(new Set(seen).size).toBe(PAGE_SIZE + 2);

    // Named by number is not a way round the filters: the ticket is WhatsApp.
    const email = await listInbox(agent, parseFilters({ q: `#${n}`, channel: 'email' }));
    expect(email.rows).toEqual([]);
  });
});
