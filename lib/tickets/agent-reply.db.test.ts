import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  autoResponses,
  businessHours,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  jobs,
  messages,
  routingDecisions,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { settleRouting } from '@/lib/routing/apply';
import { beginRouting } from '@/lib/routing/begin';
import { startRouting } from '@/lib/routing/start';
import { withCleanDatabase } from '@/lib/testing/db';
import { storeAgentReply } from './agent-reply';

/**
 * The sequence both console senders share once their checks have passed. What
 * it must get right is what separates an agent's reply from an automated one:
 * the ticket leaves the unanswered queue and the response clock stops, and the
 * send is queued exactly once — or not at all on web chat, whose row is its
 * delivery.
 */

withCleanDatabase();

// Far enough back that a stamp left at its default cannot pass for one the
// reply moved.
const LAST_MESSAGE_AT = new Date('2026-09-01T09:00:00Z');

async function ticket(channel: 'email' | 'whatsapp' | 'webchat' | 'facebook') {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
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
      lastMessageAt: LAST_MESSAGE_AT,
    })
    .returning({ id: conversations.id });
  return { id: row!.id, agentId: agent!.id };
}

describe('storeAgentReply', () => {
  it('stores the reply, marks the ticket answered and queues it on its carrier', async () => {
    const { id, agentId } = await ticket('whatsapp');

    const messageId = await storeAgentReply(id, 'whatsapp', {
      authorAgentId: agentId,
      bodyText: 'Your parcel is on its way.',
      deliveryStatus: 'pending',
      meta: { sendKind: 'text' },
    });

    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(message).toMatchObject({
      conversationId: id,
      direction: 'outbound',
      kind: 'reply',
      authorAgentId: agentId,
      bodyText: 'Your parcel is on its way.',
      deliveryStatus: 'pending',
      meta: { sendKind: 'text' },
    });

    const [row] = await db
      .select({
        lastMessageAt: conversations.lastMessageAt,
        lastAgentMessageAt: conversations.lastAgentMessageAt,
        firstRespondedAt: conversations.firstRespondedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.lastAgentMessageAt).toBeInstanceOf(Date);
    expect(row!.lastMessageAt.getTime()).toBeGreaterThan(LAST_MESSAGE_AT.getTime());
    expect(row!.firstRespondedAt).toBeInstanceOf(Date);

    expect(
      await db
        .select({ type: jobs.type, payload: jobs.payload, priority: jobs.priority })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `send:${messageId}`)),
    ).toEqual([{ type: 'send_whatsapp', payload: { messageId }, priority: 10 }]);
  });

  it.each([
    ['email', 'send_email'],
    ['facebook', 'send_meta'],
  ] as const)('sends a %s ticket by %s', async (channel, carrier) => {
    const { id, agentId } = await ticket(channel);

    const messageId = await storeAgentReply(id, channel, {
      authorAgentId: agentId,
      bodyText: 'Thanks for waiting.',
      deliveryStatus: 'pending',
    });

    expect(
      await db
        .select({ type: jobs.type })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `send:${messageId}`)),
    ).toEqual([{ type: carrier }]);
  });

  it('queues nothing on web chat, whose row is its delivery', async () => {
    const { id, agentId } = await ticket('webchat');

    await storeAgentReply(id, 'webchat', {
      authorAgentId: agentId,
      bodyText: 'Hello!',
      deliveryStatus: 'delivered',
      deliveredAt: new Date(),
    });

    expect(await db.select({ id: jobs.id }).from(jobs)).toEqual([]);
    const [row] = await db
      .select({ lastAgentMessageAt: conversations.lastAgentMessageAt })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.lastAgentMessageAt).toBeInstanceOf(Date);
  });
});

/**
 * An agent answering a ticket held for routing has decided for it
 * (`plans/ticket-category-routing.md`, decision 5): the reply ends the hold as
 * `manual`, naming the agent, in the transaction that marks the ticket
 * answered, and what the hold kept back follows — the assignment, through the
 * group's rota, and the held out-of-hours reply, which the agent's answer has
 * made moot. On a ticket that never entered routing, the reply does what it
 * always did and assigns nobody; on one a shadow channel only watches, it
 * decides nothing (`decidesShadow`).
 *
 * The seeded calendar is shut for good, so the held acknowledgement would go
 * the moment anything paid it without its answered guard. The group assigns
 * at any hour, so who is picked never depends on the clock.
 */
describe('storeAgentReply on a ticket held for routing', () => {
  let errors: MockInstance;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.execute(sql`
      insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
      values (1, 'apply', 0.6, 5)
      on conflict (id) do update set mode = excluded.mode`);
    forgetCategoryAiSettings();
    const shut: { start: string; end: string }[] = [];
    await db
      .update(businessHours)
      .set({
        schedule: { sun: shut, mon: shut, tue: shut, wed: shut, thu: shut, fri: shut, sat: shut },
      })
      .where(eq(businessHours.isDefault, true));
    forgetHoursCatalog();
    await db
      .insert(autoResponses)
      .values({ bodyEn: 'Thanks — we are closed, and will reply when we open.' });
  });

  afterEach(() => {
    const logged = errors.mock.calls.map((call) => String(call[0]));
    vi.restoreAllMocks();
    expect(logged).toEqual([]);
  });

  /**
   * A mailbox that routes by category, its team of one, the supervisor who
   * replies — in no group — and a ticket on it. Started as the insert starts
   * one and begun as the creation pass begins it, unless `routed` is false.
   */
  async function heldMail({
    shadow = false,
    routed = true,
  }: { shadow?: boolean; routed?: boolean } = {}) {
    const [hana, omar] = await db
      .insert(agents)
      .values([
        { name: 'Hana', email: 'hana@shipblu.test', presence: 'online', lastSeenAt: new Date() },
        { name: 'Omar', email: 'omar@shipblu.test', role: 'supervisor' },
      ])
      .returning({ id: agents.id });
    const [care] = await db
      .insert(groups)
      .values({
        name: 'Customer Care',
        assignmentStrategy: 'round_robin',
        assignWithinHoursOnly: false,
      })
      .returning({ id: groups.id });
    await db.insert(groupMembers).values({ groupId: care!.id, agentId: hana!.id });
    const [mailbox] = await db
      .insert(channels)
      .values({
        type: 'email',
        name: 'Support mail',
        config: {},
        defaultGroupId: care!.id,
        routingMode: 'category',
      })
      .returning({ id: channels.id });
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira', primaryEmail: 'amira@customer.example' })
      .returning({ id: contacts.id });
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const opened = new Date();
    const [ticket] = await db
      .insert(conversations)
      .values({
        channel: 'email',
        channelId: mailbox!.id,
        groupId: care!.id,
        statusId: open!.id,
        requesterContactId: contact!.id,
        lastMessageAt: opened,
        lastCustomerMessageAt: opened,
      })
      .returning({ id: conversations.id });
    const id = ticket!.id;
    const [message] = await db
      .insert(messages)
      .values({ conversationId: id, direction: 'inbound', kind: 'reply', bodyText: 'Hello?' })
      .returning({ id: messages.id });
    if (routed) {
      await db.transaction((tx) =>
        startRouting(
          tx,
          { start: shadow ? 'shadow' : 'live', channelId: mailbox!.id, windowMinutes: 5 },
          { conversationId: id, messageId: message!.id, groupId: care!.id },
          opened,
        ),
      );
      expect(await beginRouting(id)).toBe('continue');
    }
    return { id, hana: hana!.id, omar: omar!.id, care: care!.id };
  }

  const reply = (id: string, authorAgentId: string) =>
    storeAgentReply(id, 'email', {
      authorAgentId,
      bodyText: 'Your parcel is on its way.',
      deliveryStatus: 'pending',
    });

  async function ticketRow(id: string) {
    const [row] = await db
      .select({
        groupId: conversations.groupId,
        assigneeAgentId: conversations.assigneeAgentId,
        routingDecidedAt: conversations.routingDecidedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  async function decisionOf(id: string) {
    const [row] = await db
      .select()
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, id));
    return row;
  }

  async function routedEvents(id: string) {
    return db
      .select({
        actorAgentId: conversationEvents.actorAgentId,
        actorLabel: conversationEvents.actorLabel,
        data: conversationEvents.data,
      })
      .from(conversationEvents)
      .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, 'routed')));
  }

  async function acknowledgements(id: string) {
    return db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          eq(messages.direction, 'outbound'),
          sql`${messages.meta}->>'autoResponse' is not null`,
        ),
      );
  }

  it('ends the hold as manual, naming the agent, and assigns the ticket through the rota', async () => {
    const t = await heldMail();

    await reply(t.id, t.omar);

    expect(await decisionOf(t.id)).toMatchObject({
      stage: 'decided',
      outcome: 'manual',
      toGroupId: t.care,
      decidedByAgentId: t.omar,
    });
    expect(await routedEvents(t.id)).toMatchObject([
      { actorAgentId: t.omar, actorLabel: null, data: { outcome: 'manual', to: t.care } },
    ]);
    expect(await ticketRow(t.id)).toMatchObject({ groupId: t.care, assigneeAgentId: t.hana });
    expect((await ticketRow(t.id)).routingDecidedAt).toBeInstanceOf(Date);
    // Out of hours, but answered: the held acknowledgement is not sent after
    // the agent's own reply.
    expect(await acknowledgements(t.id)).toEqual([]);

    // The window's end finds it decided and records nothing new.
    expect(await settleRouting(t.id)).toBe('none');
    expect(await routedEvents(t.id)).toHaveLength(1);
  });

  it('on a ticket that never entered routing, assigns nobody, as it never did', async () => {
    const t = await heldMail({ routed: false });

    await reply(t.id, t.omar);

    expect(await decisionOf(t.id)).toBeUndefined();
    expect(await routedEvents(t.id)).toEqual([]);
    expect(await ticketRow(t.id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
  });

  it('on a ticket routing has already decided, changes none of the record', async () => {
    const t = await heldMail();
    expect(await settleRouting(t.id)).toBe('decided');
    const decided = await decisionOf(t.id);

    await reply(t.id, t.omar);

    expect(await decisionOf(t.id)).toEqual(decided);
    expect(await routedEvents(t.id)).toMatchObject([{ data: { outcome: 'fallback' } }]);
  });

  // Nothing holds a shadow ticket, so the rota assigned it on arrival — which a
  // live hold would have prevented — and its agent answering it is no decision
  // the live mode would ever have seen. Counted as `manual`, the reply would
  // decide nearly every shadow ticket before the router's answer was recorded,
  // and inflate exactly the figure the shadow week is read for. The router's
  // own answer is what the window's end then records.
  it('on a ticket a shadow channel only watches, decides nothing and leaves the router its answer', async () => {
    const t = await heldMail({ shadow: true });
    expect((await assignConversation(t.id)).assignedTo).toBe(t.hana);

    await reply(t.id, t.hana);

    expect(await decisionOf(t.id)).toMatchObject({
      shadow: true,
      stage: 'holding',
      outcome: null,
      decidedByAgentId: null,
      decidedAt: null,
    });
    expect(await routedEvents(t.id)).toEqual([]);
    expect(await ticketRow(t.id)).toMatchObject({
      assigneeAgentId: t.hana,
      routingDecidedAt: null,
    });

    // Still undecided, so the window's end records what the router would have
    // done: nothing filed it, so it would have stayed where it arrived.
    expect(await settleRouting(t.id)).toBe('shadow');
    expect(await decisionOf(t.id)).toMatchObject({
      stage: 'decided',
      outcome: 'fallback',
      decidedByAgentId: null,
      decidedByLabel: 'settle_routing',
    });
    expect(await routedEvents(t.id)).toEqual([]);
    expect(await ticketRow(t.id)).toMatchObject({
      assigneeAgentId: t.hana,
      routingDecidedAt: null,
    });
  });
});
