import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

/**
 * Where an agent's reply goes, decided by its channel, from the console's
 * action to the row and the queue, against real Postgres.
 *
 * `sendReply` chooses what the row carries — the HTML part, the address, the
 * delivery status — and `storeAgentReply` whether a carrier is queued. On the
 * myBlu app (`api`) both asked about web chat by name, and `carrierFor('api')`
 * answers `send_email`, so a reply to an app ticket was written and queued as
 * an email: never sent to a contact with no address, and mailed to one with an
 * address about a conversation they had in the app. Its row is its delivery,
 * as web chat's is (`rowIsDelivery`), and an email ticket is the control that
 * the predicate did not swallow email with it.
 */

const signedIn = vi.hoisted(() => ({ id: '' }));

vi.mock('@/lib/auth/guard', () => ({
  requireAgent: async () => ({ id: signedIn.id, role: 'admin', permissions: {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { db } = await import('@/db/client');
const { agents, contacts, conversations, jobs, messages, ticketStatuses } =
  await import('@/db/schema');
const { withCleanDatabase } = await import('@/lib/testing/db');
const { sendReply } = await import('./reply-actions');

withCleanDatabase();

/** An open ticket on `channel`, its requester holding an address, and the agent signed in. */
async function ticket(channel: 'email' | 'webchat' | 'api') {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  signedIn.id = agent!.id;
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: 'amira@example.test' })
    .returning({ id: contacts.id });
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

async function reply(conversationId: string) {
  const data = new FormData();
  data.set('conversationId', conversationId);
  data.set('body', 'Thanks for waiting.\nIt leaves the hub today.');
  const state = await sendReply({ error: null }, data);
  expect(state.error).toBeNull();

  const stored = await db
    .select({
      id: messages.id,
      authorAgentId: messages.authorAgentId,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
      toAddresses: messages.toAddresses,
      deliveryStatus: messages.deliveryStatus,
      deliveredAt: messages.deliveredAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  expect(stored).toHaveLength(1);
  return stored[0]!;
}

describe('sendReply, by where the reply goes', () => {
  // The address is the contact's whatever it is, which on the app can be a
  // previous holder of the phone's — so it is not stored, as it is not on web
  // chat, and nothing is queued to it.
  it.each(['api', 'webchat'] as const)(
    'on %s, stores the reply delivered, with no HTML part and no address, and queues no job',
    async (channel) => {
      const conversationId = await ticket(channel);

      const stored = await reply(conversationId);

      expect(stored).toMatchObject({
        authorAgentId: signedIn.id,
        bodyText: 'Thanks for waiting.\nIt leaves the hub today.',
        bodyHtml: null,
        toAddresses: [],
        deliveryStatus: 'delivered',
        deliveredAt: expect.any(Date),
      });
      expect(await db.select({ type: jobs.type }).from(jobs)).toEqual([]);
    },
  );

  it('still writes an email reply as one, and queues send_email', async () => {
    const conversationId = await ticket('email');

    const stored = await reply(conversationId);

    expect(stored).toMatchObject({
      bodyHtml: expect.stringContaining('It leaves the hub today.'),
      toAddresses: ['amira@example.test'],
      deliveryStatus: 'pending',
      deliveredAt: null,
    });
    expect(
      await db
        .select({ type: jobs.type, payload: jobs.payload })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `send:${stored.id}`)),
    ).toEqual([{ type: 'send_email', payload: { messageId: stored.id } }]);
  });
});
