import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  conversationShipments,
  internalRecipients,
  jobs,
  shipments,
  sideConversationMessages,
  sideConversations,
  ticketStatuses,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/env';
import {
  replyToSideConversation,
  setSideConversationState,
  startSideConversation,
  type StartSideConversationInput,
} from '@/lib/side-conversations/write';
import { withCleanDatabase } from '@/lib/testing/db';
import { ticketShipmentDetail, ticketShipments, ticketSideConversations } from './tickets';

/**
 * The WhatsApp Web extension reaches tickets through these and through
 * `lib/side-conversations/write.ts`, which the console's actions now call too.
 * A route is a new door onto the same rooms, so what is pinned here is that it
 * is the same door: the ticket visibility rule, the permission, and the
 * refusal that keeps a side conversation away from the customer it is about.
 */

withCleanDatabase();

beforeEach(() => {
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'support@shipblu.test');
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const CUSTOMER_EMAIL = 'amira@customer.test';

async function agent(
  role: SessionAgent['role'],
  permissions: Record<string, boolean> = {},
): Promise<SessionAgent> {
  const [row] = await db
    .insert(agents)
    .values({ email: `${role}-${Math.random()}@shipblu.test`, name: role, role, permissions })
    .returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions: row!.permissions,
    avatarUrl: null,
    avatarColor: null,
    isAcceptingTickets: true,
    acceptingOffReason: null,
    sessionIdleForMs: 0,
  };
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: CUSTOMER_EMAIL })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: status!.id,
      channel: 'whatsapp',
      subject: 'Where is my parcel',
      ...values,
    })
    .returning({ id: conversations.id, number: conversations.number });
  return row!;
}

async function hub(email = 'hub@shipblu.test') {
  const [row] = await db
    .insert(internalRecipients)
    .values({ name: 'Downtown Hub', email })
    .returning({ id: internalRecipients.id });
  return `recipient:${row!.id}`;
}

function start(conversationId: string, over: Partial<StartSideConversationInput> = {}) {
  return {
    conversationId,
    body: 'Can you check the shelf for this one?',
    recipientId: 'other',
    toAddress: '',
    ccAddresses: '',
    subject: '',
    anchorMessageId: null,
    includeAnchor: false,
    setPending: false,
    ...over,
  };
}

describe('startSideConversation', () => {
  it('sends to the address the directory holds, and queues the email', async () => {
    const supervisor = await agent('supervisor');
    const { id, number } = await ticket();

    const result = await startSideConversation(
      supervisor,
      start(id, { recipientId: await hub(), toAddress: 'ignored@elsewhere.test' }),
    );

    expect(result).toEqual({ error: null, conversationNumber: number });
    const [side] = await db.select().from(sideConversations);
    // The typed address is not read for a directory entry: the row's is.
    expect(side!.toAddresses).toEqual(['hub@shipblu.test']);
    expect(await db.select().from(sideConversationMessages)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(conversationEvents)
        .where(eq(conversationEvents.type, 'side_conversation_started')),
    ).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.type, 'send_side_email'))).toHaveLength(1);
  });

  it('refuses the customer’s own address and writes nothing', async () => {
    const supervisor = await agent('supervisor');
    const { id } = await ticket();

    const result = await startSideConversation(
      supervisor,
      start(id, { toAddress: CUSTOMER_EMAIL.toUpperCase() }),
    );

    expect(result.error).toMatch(/customer’s own address/);
    expect(await db.select().from(sideConversations)).toHaveLength(0);
  });

  it('answers a ticket the agent cannot see as one that does not exist', async () => {
    const plain = await agent('agent');
    const { id } = await ticket();

    expect(await startSideConversation(plain, start(id, { recipientId: await hub() }))).toEqual({
      error: 'Ticket not found',
    });
  });

  it('refuses an agent without the permission, before reading the ticket', async () => {
    const barred = await agent('supervisor', { 'ticket.side_conversation': false });
    const { id } = await ticket();

    expect((await startSideConversation(barred, start(id))).error).toMatch(/permission/);
  });

  it('answers a malformed recipient or ticket id as missing, not a database error', async () => {
    const supervisor = await agent('supervisor');
    const { id } = await ticket();

    expect(
      await startSideConversation(supervisor, start(id, { recipientId: 'recipient:x' })),
    ).toEqual({ error: 'That recipient is no longer available' });
    expect(await startSideConversation(supervisor, start('not-a-uuid'))).toEqual({
      error: 'Ticket not found',
    });
  });
});

describe('a side conversation reached by its own id', () => {
  async function thread(owner: SessionAgent) {
    const { id } = await ticket();
    await startSideConversation(owner, start(id, { recipientId: await hub() }));
    const [side] = await db.select({ id: sideConversations.id }).from(sideConversations);
    return side!.id;
  }

  it('takes a reply and a state change from an agent who can see its ticket', async () => {
    const supervisor = await agent('supervisor');
    const sideId = await thread(supervisor);

    expect(
      (await replyToSideConversation(supervisor, { sideConversationId: sideId, body: 'Any news?' }))
        .error,
    ).toBeNull();
    expect(
      (await setSideConversationState(supervisor, { sideConversationId: sideId, state: 'done' }))
        .error,
    ).toBeNull();
    expect(await db.select().from(sideConversationMessages)).toHaveLength(2);
  });

  it('is not found for an agent who cannot see its ticket', async () => {
    const sideId = await thread(await agent('supervisor'));
    const plain = await agent('agent');

    expect(
      await replyToSideConversation(plain, { sideConversationId: sideId, body: 'Hi' }),
    ).toEqual({ error: 'Side conversation not found' });
    expect(
      await setSideConversationState(plain, { sideConversationId: sideId, state: 'done' }),
    ).toEqual({ error: 'Side conversation not found' });
    expect(await db.select().from(sideConversationMessages)).toHaveLength(1);
  });
});

describe('the extension’s reads', () => {
  async function linkedParcel(conversationId: string, trackingNumber: string) {
    const [shipment] = await db
      .insert(shipments)
      .values({ trackingNumber })
      .returning({ id: shipments.id });
    await db.insert(conversationShipments).values({ conversationId, shipmentId: shipment!.id });
    return shipment!.id;
  }

  it('lists a visible ticket’s parcels with the console’s card', async () => {
    const supervisor = await agent('supervisor');
    const { id } = await ticket();
    await linkedParcel(id, '1234567890123');

    const list = await ticketShipments(supervisor, id);

    expect(list).toHaveLength(1);
    expect(list![0]).toMatchObject({
      trackingNumber: '1234567890123',
      card: { label: 'Not synced yet', tone: 'unknown' },
      returning: false,
    });
  });

  it('shows nothing of a ticket the agent cannot see', async () => {
    const plain = await agent('agent');
    const { id } = await ticket();
    await linkedParcel(id, '1234567890123');

    expect(await ticketShipments(plain, id)).toBeNull();
    expect(await ticketSideConversations(plain, id)).toBeNull();
  });

  it('shows a plain agent the ticket assigned to them', async () => {
    const plain = await agent('agent');
    const { id } = await ticket({ assigneeAgentId: plain.id });

    expect(await ticketSideConversations(plain, id)).toEqual({
      canWrite: true,
      sideConversations: [],
    });
  });

  it('opens a parcel’s detail only through the ticket it is linked to', async () => {
    const supervisor = await agent('supervisor');
    const mine = await ticket();
    const other = await ticket();
    const elsewhere = await linkedParcel(other.id, '9999999999999');

    expect(await ticketShipmentDetail(supervisor, mine.id, elsewhere)).toBeNull();
  });

  it('keeps the detail behind contact.view', async () => {
    const barred = await agent('supervisor', { 'contact.view': false });
    const { id } = await ticket();
    const parcel = await linkedParcel(id, '1234567890123');

    expect(await ticketShipmentDetail(barred, id, parcel)).toBe('forbidden');
  });
});
