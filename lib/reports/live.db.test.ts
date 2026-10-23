import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { agentLoad, todayByHour } from './live';

/**
 * The live report's hourly volume, the one figure on it counted from messages
 * rather than tickets — so the one that has to say for itself which rows are
 * traffic. And the board of who is carrying what, the one table on it keyed on
 * two different people per ticket.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const NOW = DateTime.fromISO('2026-10-13T12:30', { zone: ZONE });

async function ticket(
  channel: 'whatsapp' | 'email',
  values: Partial<typeof conversations.$inferInsert> & { status?: string } = {},
): Promise<string> {
  const { status = 'Open', ...rest } = values;
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, status));
  const [inserted] = await db
    .insert(conversations)
    .values({ channel, statusId: row!.id, requesterContactId: contact!.id, ...rest })
    .returning({ id: conversations.id });
  return inserted!.id;
}

describe('todayByHour', () => {
  it('counts what was said, from either side, and neither side’s reactions', async () => {
    const chat = await ticket('whatsapp');
    const mail = await ticket('email');
    const at = (time: string) => DateTime.fromISO(`2026-10-13T${time}`, { zone: ZONE }).toJSDate();

    await db.insert(messages).values([
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: 'فين شحنتي؟',
        meta: { whatsappType: 'text' },
        createdAt: at('11:05'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: 'On its way',
        meta: { sendKind: 'text' },
        createdAt: at('11:10'),
      },
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: at('11:12'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: '[reacted ❤️]',
        meta: { whatsappType: 'reaction', echo: true, echoSource: 'business_app' },
        createdAt: at('11:15'),
      },
      // No `whatsappType` at all, as on every email: still traffic.
      { conversationId: mail, direction: 'inbound', bodyText: 'Refund?', createdAt: at('11:20') },
    ]);

    const hours = await todayByHour(ZONE, NOW.toJSDate());

    expect(hours.find((bucket) => bucket.hour === 11)).toEqual({
      hour: 11,
      inbound: 2,
      outbound: 1,
    });
  });
});

describe('agentLoad', () => {
  // The board's Breached column must name the person tomorrow's report files
  // the breach under, while Open and Waiting on us stay the capacity check's
  // count of what each person holds.
  it('counts a breach against the number’s owner and the work against whoever holds it', async () => {
    const [nayera, bob] = await db
      .insert(agents)
      .values([
        { name: 'Nayera', email: 'nayera@shipblu.test', role: 'agent' },
        { name: 'Bob', email: 'bob@shipblu.test', role: 'agent' },
      ])
      .returning({ id: agents.id });
    const waiting = { lastCustomerMessageAt: NOW.minus({ hours: 2 }).toJSDate() };

    // Nayera's number, Bob working it, past its first-response target and
    // waiting on a reply.
    await ticket('whatsapp', {
      accountableAgentId: nayera!.id,
      assigneeAgentId: bob!.id,
      firstResponseBreached: true,
      ...waiting,
    });
    // Nayera's number, nobody holding it, past its resolution target.
    await ticket('whatsapp', { accountableAgentId: nayera!.id, resolutionBreached: true });
    // Bob's own, on a team number: his breach, as before owners existed.
    await ticket('email', { assigneeAgentId: bob!.id, firstResponseBreached: true });
    // Bob's and on time.
    await ticket('email', { assigneeAgentId: bob!.id });
    // Nayera's, breached and resolved since: out of the live backlog altogether.
    await ticket('whatsapp', {
      accountableAgentId: nayera!.id,
      assigneeAgentId: nayera!.id,
      firstResponseBreached: true,
      status: 'Resolved',
    });

    const load = await agentLoad();
    const row = (id: string) => load.find((agent) => agent.id === id);

    expect(row(nayera!.id)).toMatchObject({
      open: 0,
      awaitingReply: 0,
      breached: 2,
      oldestWaitingSince: null,
    });
    expect(row(bob!.id)).toMatchObject({
      open: 3,
      awaitingReply: 1,
      breached: 1,
      oldestWaitingSince: waiting.lastCustomerMessageAt,
    });
  });
});
