import { and, asc, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groups,
  messages,
  ticketCategories,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { shownLabel } from './status-words';
import { appendReply, createTicket, getTicket, listTickets } from './tickets';

/**
 * What the portal's two ingest paths write today, quirks included, so the
 * shared ingest steps of Stage 4.2 can be proven to change nothing.
 *
 * Both take the contact the portal session already resolved, and stamp their
 * own clock. `appendReply` is the one path that finds its ticket by number
 * rather than by thread, and every refusal it can give is pinned here, since a
 * refusal is what stops a customer writing onto a ticket that is not theirs.
 */

withCleanDatabase();

async function customer(name = 'Amira'): Promise<string> {
  const [row] = await db.insert(contacts).values({ name }).returning({ id: contacts.id });
  if (!row) throw new Error('contact not inserted');
  return row.id;
}

async function conversation(id: string) {
  const [row] = await db
    .select({
      number: conversations.number,
      channel: conversations.channel,
      channelId: conversations.channelId,
      groupId: conversations.groupId,
      formId: conversations.formId,
      subject: conversations.subject,
      status: ticketStatuses.name,
      priority: conversations.priority,
      categoryId: conversations.categoryId,
      type: conversations.type,
      tags: conversations.tags,
      customFields: conversations.customFields,
      requesterContactId: conversations.requesterContactId,
      reopenCount: conversations.reopenCount,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  if (!row) throw new Error(`no conversation ${id}`);
  return row;
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function setStatus(conversationId: string, name: string, extra = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!status) throw new Error(`no status ${name}`);
  await db
    .update(conversations)
    .set({ statusId: status.id, ...extra })
    .where(eq(conversations.id, conversationId));
}

/** Resolves a ticket the way an agent does: status, time and who. */
async function agentRow(name: string): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@shipblu.test` })
    .returning({ id: agents.id });
  if (!row) throw new Error('no agent');
  return row.id;
}

/** One of the four categories the baseline seeds, by its key. */
async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  if (!row) throw new Error(`no category ${key}`);
  return row.id;
}

/**
 * The ticket's `category_changed` events, and whether each was stamped after
 * the ticket's own row: `created_at` is `now()`, the instant the transaction
 * began, so only `CHANGE_STAMP` — the clock read when the event is inserted —
 * lands later. Compared in SQL, because a `Date` keeps milliseconds and the
 * transaction can run inside one.
 */
async function categoryEvents(conversationId: string) {
  return db
    .select({
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
      stampedAfterOpening: sql<boolean>`${conversationEvents.createdAt} > ${conversations.createdAt}`,
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'category_changed'),
      ),
    );
}

async function resolveAsAgent(conversationId: string): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  if (!agent) throw new Error('no agent');
  await setStatus(conversationId, 'Resolved', {
    resolvedAt: new Date('2026-09-20T10:30:00Z'),
    resolvedByAgentId: agent.id,
  });
  return agent.id;
}

describe('createTicket', () => {
  it('files a portal ticket, under the column defaults when nothing presets it', async () => {
    const contactId = await customer();
    const before = Date.now();

    const created = await createTicket(contactId, {
      subject: 'Parcel damaged',
      body: 'The box arrived crushed.',
    });
    const after = Date.now();

    expect(created.number).toBe(1);

    const ticket = await conversation(created.conversationId);
    expect(ticket).toMatchObject({
      channel: 'portal',
      // No `portal` channel row is seeded, so no group either.
      channelId: null,
      groupId: null,
      formId: null,
      subject: 'Parcel damaged',
      status: 'Open',
      priority: 'medium',
      categoryId: null,
      type: null,
      tags: [],
      customFields: {},
      requesterContactId: contactId,
    });

    const [message] = await messagesOf(created.conversationId);
    expect(message).toMatchObject({
      id: created.messageId,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: contactId,
      bodyText: 'The box arrived crushed.',
      bodyHtml: null,
      deliveryStatus: 'delivered',
    });

    // One clock for the whole write: the message and both conversation stamps.
    const at = message?.createdAt.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(message?.deliveredAt?.getTime()).toBe(at);
    expect(ticket.lastMessageAt?.getTime()).toBe(at);
    expect(ticket.lastCustomerMessageAt?.getTime()).toBe(at);

    const events = await db
      .select({ type: conversationEvents.type })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, created.conversationId));
    expect(events).toEqual([{ type: 'subcategorised' }]);
  });

  it('takes what a form presets', async () => {
    const contactId = await customer();
    const [group] = await db.insert(groups).values({ name: 'Claims' }).returning({ id: groups.id });
    const [form] = await db
      .insert(ticketForms)
      .values({ slug: 'claims' })
      .returning({ id: ticketForms.id });
    const sales = await categoryId('sales');

    const created = await createTicket(contactId, {
      subject: 'Claim',
      body: 'Please refund.',
      formId: form?.id,
      groupId: group?.id,
      priority: 'high',
      type: 'claim',
      tags: ['refund'],
      customFields: { order: '5512' },
      category: { id: sales, chosenBy: { label: 'form:claims' } },
    });

    expect(await conversation(created.conversationId)).toMatchObject({
      formId: form?.id,
      groupId: group?.id,
      priority: 'high',
      categoryId: sales,
      type: 'claim',
      tags: ['refund'],
      customFields: { order: '5512' },
    });
    // In the transaction that opened the ticket, so the on-create rules, the
    // first policy selection and assignment all read a category somebody is
    // named for. The form is the actor, not a person: from Stage 4 only an
    // agent's choice is ground truth, and a default is nobody's judgement. The
    // key and the English label are frozen as they were, so the timeline still
    // says what was chosen after an admin renames it.
    expect(await categoryEvents(created.conversationId)).toEqual([
      {
        actorAgentId: null,
        actorLabel: 'form:claims',
        data: { from: null, to: sales, key: 'sales', label: 'Sales' },
        stampedAfterOpening: true,
      },
    ]);
  });

  it('names the agent who chose the category, and no label', async () => {
    const contactId = await customer();
    const agentId = await agentRow('Mona');
    const support = await categoryId('customer_support');

    const created = await createTicket(contactId, {
      subject: 'Where is it?',
      body: 'Called in.',
      category: { id: support, chosenBy: { agentId } },
    });

    expect((await conversation(created.conversationId)).categoryId).toBe(support);
    expect(await categoryEvents(created.conversationId)).toEqual([
      {
        actorAgentId: agentId,
        actorLabel: null,
        data: { from: null, to: support, key: 'customer_support', label: 'Customer support' },
        stampedAfterOpening: true,
      },
    ]);
  });

  // Postgres reads an id in capitals as the same uuid and stores the column
  // lower-case whatever it was handed, but `data.to` is jsonb, kept as written.
  // A hand-made POST spelling the id in capitals would leave the event naming a
  // spelling the column does not, and from Stage 4 Jev's ownership rule reads
  // one against the other.
  it('names the category in its event exactly as the column stores it, whatever case it came in', async () => {
    const contactId = await customer();
    const sales = await categoryId('sales');

    const created = await createTicket(contactId, {
      subject: 'Prices',
      body: 'How much for 100 parcels a month?',
      category: { id: sales.toUpperCase(), chosenBy: { label: 'form:sales' } },
    });

    const { categoryId: stored } = await conversation(created.conversationId);
    expect(stored).toBe(sales);
    expect(await categoryEvents(created.conversationId)).toEqual([
      {
        actorAgentId: null,
        actorLabel: 'form:sales',
        data: { from: null, to: stored, key: 'sales', label: 'Sales' },
        stampedAfterOpening: true,
      },
    ]);
  });

  describe('opens the ticket with no category, and says why in the log, when the category is', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // A customer's ticket is never refused over an admin's retire: the form
    // keeps a retired default, and the ticket it opens simply has none — no
    // column, and no event claiming a choice the ticket does not carry.
    it.each([
      {
        state: 'retired',
        reason: 'retired_category',
        category: async () => {
          const merchant = await categoryId('merchant_support');
          await db
            .update(ticketCategories)
            .set({ isActive: false })
            .where(eq(ticketCategories.id, merchant));
          return merchant;
        },
      },
      {
        state: 'gone',
        reason: 'unknown_category',
        category: async () => '00000000-0000-0000-0000-000000000000',
      },
      // Not a uuid at all, from a hand-made POST: no category either, rather
      // than Postgres's 22P02 out of the transaction, which would refuse the
      // customer's ticket over a field they never saw.
      {
        state: 'not a uuid',
        reason: 'unknown_category',
        category: async () => 'not-a-uuid',
      },
    ])('$state', async ({ reason, category }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const contactId = await customer();
      const id = await category();

      const created = await createTicket(contactId, {
        subject: 'Claim',
        body: 'Please refund.',
        category: { id, chosenBy: { label: 'form:claims' } },
      });

      expect(await conversation(created.conversationId)).toMatchObject({
        subject: 'Claim',
        status: 'Open',
        categoryId: null,
      });
      expect(await messagesOf(created.conversationId)).toMatchObject([
        { bodyText: 'Please refund.' },
      ]);
      expect(await categoryEvents(created.conversationId)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        `[create_ticket] category left off a new ticket category=${id} reason=${reason}`,
      );
    });
  });
});

describe('getTicket', () => {
  it('shows a WhatsApp ticket’s messages and neither side’s reactions', async () => {
    const contactId = await customer();
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [chat] = await db
      .insert(conversations)
      .values({ channel: 'whatsapp', statusId: open!.id, requesterContactId: contactId })
      .returning({ id: conversations.id, number: conversations.number });
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute));
    await db.insert(messages).values([
      {
        conversationId: chat!.id,
        direction: 'inbound',
        bodyText: 'Where is it?',
        createdAt: at(0),
      },
      {
        conversationId: chat!.id,
        direction: 'outbound',
        bodyText: '[reacted ❤️]',
        meta: { whatsappType: 'reaction', echo: true, echoSource: 'business_app' },
        createdAt: at(1),
      },
      { conversationId: chat!.id, direction: 'outbound', bodyText: 'Today.', createdAt: at(2) },
      {
        conversationId: chat!.id,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: at(3),
      },
    ]);

    const ticket = await getTicket(contactId, chat!.number);

    expect(ticket?.messages.map(({ from, body }) => ({ from, body }))).toEqual([
      { from: 'customer', body: 'Where is it?' },
      { from: 'agent', body: 'Today.' },
    ]);
  });
});

describe('the status label a customer sees', () => {
  // The statuses page says what a customer sees through `shownLabel`, and the
  // portal decides it in SQL; each would otherwise be free to drift from the
  // other, and the page would describe a portal that no longer exists. The
  // empty label cannot be saved through the console, which stores blank as
  // null, but a row edited by hand can hold one, and the two must still agree.
  it('is decided by the portal’s SQL exactly as `shownLabel` decides it', async () => {
    const contactId = await customer();
    const cases = [true, false].flatMap((visibleToCustomer) =>
      [null, 'Being checked', ''].map((customerLabel) => ({ visibleToCustomer, customerLabel })),
    );

    const expected = new Map<number, string | null>();
    for (const [index, shape] of cases.entries()) {
      const [status] = await db
        .insert(ticketStatuses)
        .values({ name: `Case ${index}`, category: 'pending', position: 10 + index, ...shape })
        .returning({ id: ticketStatuses.id });
      const [ticket] = await db
        .insert(conversations)
        .values({ channel: 'email', statusId: status!.id, requesterContactId: contactId })
        .returning({ number: conversations.number });
      expected.set(ticket!.number, shownLabel(shape));
    }

    const listed = await listTickets(contactId);
    expect(new Map(listed.map((row) => [row.number, row.statusLabel]))).toEqual(expected);

    for (const [number, label] of expected) {
      expect((await getTicket(contactId, number))?.statusLabel).toBe(label);
    }
    // Every shape the rule can answer is covered, not six copies of one.
    expect(new Set(expected.values())).toEqual(new Set([null, 'Being checked', '']));
  });
});

describe('appendReply', () => {
  it('adds the customer’s reply to their own ticket', async () => {
    const contactId = await customer();
    const created = await createTicket(contactId, { subject: 'Parcel damaged', body: 'Crushed.' });

    expect(await appendReply(contactId, created.number, 'Photos attached.')).toEqual({ ok: true });

    const [, reply] = await messagesOf(created.conversationId);
    expect(reply).toMatchObject({
      direction: 'inbound',
      authorContactId: contactId,
      bodyText: 'Photos attached.',
    });
    expect((await conversation(created.conversationId)).lastCustomerMessageAt?.getTime()).toBe(
      reply?.createdAt.getTime(),
    );
  });

  it('reopens a resolved ticket, naming who resolved it', async () => {
    const contactId = await customer();
    const created = await createTicket(contactId, { subject: 'Parcel damaged', body: 'Crushed.' });
    const resolver = await resolveAsAgent(created.conversationId);

    expect(await appendReply(contactId, created.number, 'Not fixed.')).toEqual({ ok: true });

    expect(await conversation(created.conversationId)).toMatchObject({
      status: 'Open',
      reopenCount: 1,
      resolvedAt: null,
      resolvedByAgentId: resolver,
    });
    const reopened = await db
      .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.type, 'reopened'));
    expect(reopened).toEqual([
      { actorLabel: 'portal', data: { reason: 'customer_replied', resolvedBy: resolver } },
    ]);
  });

  // The portal reopens a WhatsApp ticket too, for a customer it knows by email.
  // Left out of the realignment, a ticket resolved across a handover and
  // reopened here stayed with the previous owner for good.
  it("brings a resolved WhatsApp ticket over to its number's owner when the customer replies", async () => {
    const contactId = await customer();
    const nayera = await agentRow('Nayera Mohamed');
    const ali = await agentRow('Ali Nasser');
    const [phone] = await db
      .insert(channels)
      .values({ type: 'whatsapp', name: 'Nayera Mohamed', ownerAgentId: ali, config: {} })
      .returning({ id: channels.id });
    const [resolved] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    const [ticket] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        channelId: phone!.id,
        statusId: resolved!.id,
        requesterContactId: contactId,
        accountableAgentId: nayera,
        assigneeAgentId: nayera,
      })
      .returning({ id: conversations.id, number: conversations.number });

    expect(await appendReply(contactId, ticket!.number, 'Still not here.')).toEqual({ ok: true });

    const [after] = await db
      .select({
        accountable: conversations.accountableAgentId,
        assignee: conversations.assigneeAgentId,
      })
      .from(conversations)
      .where(eq(conversations.id, ticket!.id));
    expect(after).toEqual({ accountable: ali, assignee: ali });
  });

  it('answers on a ticket that arrived on another channel, as inbound', async () => {
    const contactId = await customer();
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [emailed] = await db
      .insert(conversations)
      .values({
        channel: 'email',
        statusId: open!.id,
        subject: 'By mail',
        requesterContactId: contactId,
      })
      .returning({ id: conversations.id, number: conversations.number });

    expect(await appendReply(contactId, emailed!.number, 'Replying from the portal')).toEqual({
      ok: true,
    });
    expect(await messagesOf(emailed!.id)).toMatchObject([
      { direction: 'inbound', bodyText: 'Replying from the portal' },
    ]);
  });

  describe('refuses, writing nothing,', () => {
    async function refused(contactId: string, number: number, conversationId: string) {
      const before = await messagesOf(conversationId);
      expect(await appendReply(contactId, number, 'Let me in')).toEqual({ ok: false });
      expect(await messagesOf(conversationId)).toHaveLength(before.length);
    }

    it('a closed ticket', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Done', body: 'Thanks.' });
      await setStatus(created.conversationId, 'Closed');

      await refused(contactId, created.number, created.conversationId);
    });

    it('somebody else’s ticket', async () => {
      const owner = await customer('Owner');
      const stranger = await customer('Stranger');
      const created = await createTicket(owner, { subject: 'Mine', body: 'Private.' });

      await refused(stranger, created.number, created.conversationId);
    });

    it('a ticket filed as spam', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Spam', body: 'Buy now.' });
      await db
        .update(conversations)
        .set({ isSpam: true })
        .where(eq(conversations.id, created.conversationId));

      await refused(contactId, created.number, created.conversationId);
    });

    it('a deleted ticket', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Gone', body: 'Deleted.' });
      await db
        .update(conversations)
        .set({ deletedAt: new Date() })
        .where(eq(conversations.id, created.conversationId));

      await refused(contactId, created.number, created.conversationId);
    });

    it('a bot transcript, which no customer writes onto', async () => {
      const contactId = await customer();
      const created = await createTicket(contactId, { subject: 'Bot', body: 'Menu.' });
      await db
        .update(conversations)
        .set({ channel: 'whatsapp_bot' })
        .where(eq(conversations.id, created.conversationId));

      await refused(contactId, created.number, created.conversationId);
    });
  });
});
