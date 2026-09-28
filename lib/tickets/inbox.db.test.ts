import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, ticketStatuses } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { withCleanDatabase } from '@/lib/testing/db';
import { listInbox } from './inbox';
import { parseFilters } from './inbox-filters';

/**
 * The inbox list's read model. What is pinned here is what the list decides a
 * badge from: a Facebook or Instagram comment ticket has no messaging window,
 * and the row has to say so, or the list badges "window closed" on a ticket
 * the header rightly shows none for.
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
