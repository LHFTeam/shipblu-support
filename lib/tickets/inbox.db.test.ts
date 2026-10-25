import { eq, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  businessHours,
  channels,
  contacts,
  conversations,
  csatSurveys,
  groups,
  messages,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { withCleanDatabase, withoutCommentChannelCheck } from '@/lib/testing/db';
import { getConversation } from './conversation';
import { listInbox } from './inbox';
import { PAGE_SIZE, parseFilters, parseInboxCursor } from './inbox-filters';

/**
 * The inbox list's read model. What is pinned here is what the list decides a
 * badge from: a Facebook or Instagram comment ticket has no messaging window,
 * and the row has to say so, or the list badges "window closed" on a ticket
 * the header rightly shows none for; and the reply arrow, which has to be
 * about the same message the preview shows, and that message has to be one the
 * customer actually saw.
 *
 * And the search, which is only worth testing against Postgres: the Arabic
 * clauses are regular expressions Postgres parses, and the ticket a number
 * names is a second query whose seam with the paged one is the cursor.
 */

withCleanDatabase();

async function admin(): Promise<SessionAgent> {
  return signedIn('admin', 'omar@shipblu.test');
}

async function signedIn(role: 'admin' | 'agent', email: string): Promise<SessionAgent> {
  const [row] = await db.insert(agents).values({ name: email, email, role }).returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions: {},
    avatarUrl: null,
    avatarColor: row!.avatarColor,
    isAcceptingTickets: true,
    acceptingOffReason: null,
    sessionIdleForMs: 0,
  };
}

async function openStatusId(): Promise<string> {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  return open!.id;
}

async function ticket(
  channel:
    | 'facebook'
    | 'facebook_comment'
    | 'instagram'
    | 'instagram_comment'
    | 'whatsapp'
    | 'webchat'
    | 'email'
    | 'portal',
  externalId: string | null,
  assigneeAgentId: string | null = null,
) {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .insert(conversations)
    .values({
      channel,
      statusId: await openStatusId(),
      requesterContactId: contact!.id,
      externalId,
      assigneeAgentId,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('listInbox', () => {
  it('marks a Meta comment ticket, and not a direct-message one', async () => {
    const agent = await admin();
    const comment = await ticket('instagram_comment', 'instagram:comment:17900000000000001');
    const facebookComment = await ticket('facebook_comment', 'facebook:comment:123_456');
    const message = await ticket('facebook', null);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row.isComment]));

    expect(byId.get(comment)).toBe(true);
    expect(byId.get(facebookComment)).toBe(true);
    expect(byId.get(message)).toBe(false);
  });

  it('marks a ticket whose newest visible message is ours, and ignores notes', async () => {
    const agent = await admin();
    const answered = await ticket('facebook', null);
    const waiting = await ticket('facebook', null);
    const notedAfterReply = await ticket('facebook', null);
    const silent = await ticket('facebook', null);

    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
    await db.insert(messages).values([
      { conversationId: answered, direction: 'inbound', bodyText: 'وين شحنتي؟', createdAt: at(0) },
      // An automated reply carries no author and is still ours.
      { conversationId: answered, direction: 'outbound', bodyText: 'On its way', createdAt: at(1) },

      { conversationId: waiting, direction: 'outbound', bodyText: 'On its way', createdAt: at(0) },
      { conversationId: waiting, direction: 'inbound', bodyText: 'Thanks', createdAt: at(1) },

      // A note is written after our reply but the customer never sees it, so
      // the reply is still the last word — and the preview says the same.
      { conversationId: notedAfterReply, direction: 'inbound', bodyText: 'Hi', createdAt: at(0) },
      {
        conversationId: notedAfterReply,
        direction: 'outbound',
        bodyText: 'Hello',
        authorAgentId: agent.id,
        createdAt: at(1),
      },
      {
        conversationId: notedAfterReply,
        direction: 'outbound',
        kind: 'note',
        bodyText: 'Check with the hub',
        authorAgentId: agent.id,
        createdAt: at(2),
      },
    ]);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(answered)).toMatchObject({ lastFromUs: true, preview: 'On its way' });
    expect(byId.get(waiting)).toMatchObject({ lastFromUs: false, preview: 'Thanks' });
    expect(byId.get(notedAfterReply)).toMatchObject({ lastFromUs: true, preview: 'Hello' });
    expect(byId.get(silent)).toMatchObject({ lastFromUs: false, preview: null });
  });

  it('carries the assignee for the tile, and nothing for an unassigned ticket', async () => {
    const agent = await admin();
    const [assignee] = await db
      .insert(agents)
      .values({
        name: 'Dina Mostafa',
        email: 'dina@shipblu.test',
        avatarUrl: 'https://example.test/dina.png',
      })
      .returning();
    const assigned = await ticket('instagram', null, assignee!.id);
    const unassigned = await ticket('instagram', null);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(assigned)).toMatchObject({
      assigneeId: assignee!.id,
      assigneeName: 'Dina Mostafa',
      assigneeAvatarUrl: 'https://example.test/dina.png',
      // Whatever the trigger gave her, read straight through.
      assigneeColor: assignee!.avatarColor,
    });
    expect(assignee!.avatarColor).not.toBeNull();
    expect(byId.get(unassigned)).toMatchObject({
      assigneeId: null,
      assigneeName: null,
      assigneeAvatarUrl: null,
      assigneeColor: null,
    });
  });

  it('lists one category by id and names each ticket’s category on its row', async () => {
    const agent = await admin();
    // The baseline seeds the starter set, so the ids are read rather than made.
    const registry = await db
      .select({ id: ticketCategories.id, key: ticketCategories.key })
      .from(ticketCategories);
    const idOf = (key: string) => registry.find((row) => row.key === key)!.id;
    const sales = idOf('sales');
    const merchant = idOf('merchant_support');

    const selling = await ticket('whatsapp', null);
    const sellingByEmail = await ticket('email', null);
    const merchantTicket = await ticket('facebook', null);
    const none = await ticket('webchat', null);
    await db.update(conversations).set({ categoryId: sales }).where(eq(conversations.id, selling));
    await db
      .update(conversations)
      .set({ categoryId: sales })
      .where(eq(conversations.id, sellingByEmail));
    await db
      .update(conversations)
      .set({ categoryId: merchant })
      .where(eq(conversations.id, merchantTicket));
    // Retired after the tickets were filed: they still carry it, so a link to
    // it still lists them, and the row still names what the ticket holds.
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.id, sales));

    const ids = async (params: Record<string, string>) =>
      (await listInbox(agent, parseFilters(params))).rows.map((row) => row.id).sort();

    expect(await ids({ category: sales })).toEqual([selling, sellingByEmail].sort());
    // Upper case, as a hand-typed link might carry it: the parser folds it.
    expect(await ids({ category: merchant.toUpperCase() })).toEqual([merchantTicket]);
    // With the other axes, not instead of them.
    expect(await ids({ category: sales, channel: 'email' })).toEqual([sellingByEmail]);
    expect(await ids({})).toEqual([selling, sellingByEmail, merchantTicket, none].sort());

    const { rows } = await listInbox(agent, parseFilters({}));
    const labelOf = new Map(rows.map((row) => [row.id, row.categoryLabel]));
    expect(labelOf.get(selling)).toBe('Sales');
    expect(labelOf.get(merchantTicket)).toBe('Merchant support');
    expect(labelOf.get(none)).toBeNull();
  });

  it('keeps the category filter inside what the agent may see', async () => {
    const sara = await signedIn('agent', 'sara@shipblu.test');
    const [sales] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, 'sales'));
    const hers = await ticket('whatsapp', null, sara.id);
    // Unassigned and in no group of hers: outside what she may open.
    const nobodys = await ticket('whatsapp', null);
    await db
      .update(conversations)
      .set({ categoryId: sales!.id })
      .where(inArray(conversations.id, [hers, nobodys]));

    const { rows } = await listInbox(sara, parseFilters({ category: sales!.id }));

    expect(rows.map((row) => row.id)).toEqual([hers]);
  });

  it('skips what the customer never saw: a system notice, a failed send, an autoresponder', async () => {
    const agent = await admin();
    const noticeAfterAck = await ticket('facebook', null);
    const failedReply = await ticket('facebook', null);
    const bouncedReply = await ticket('email', null);
    const outOfOffice = await ticket('email', null);

    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
    await db.insert(messages).values([
      // The form path: the customer's message, our acknowledgement, and then an
      // inbound notice to the team that an attachment was not stored.
      { conversationId: noticeAfterAck, direction: 'inbound', bodyText: 'Hi', createdAt: at(0) },
      {
        conversationId: noticeAfterAck,
        direction: 'outbound',
        bodyText: 'We got your request',
        createdAt: at(1),
      },
      {
        conversationId: noticeAfterAck,
        direction: 'inbound',
        kind: 'system',
        bodyText: 'Could not store x.pdf — ask the customer to send it again.',
        createdAt: at(2),
      },

      // Our reply never arrived, so the customer is still the one waiting.
      {
        conversationId: failedReply,
        direction: 'inbound',
        bodyText: 'وين شحنتي؟',
        createdAt: at(0),
      },
      {
        conversationId: failedReply,
        direction: 'outbound',
        bodyText: 'On its way',
        authorAgentId: agent.id,
        deliveryStatus: 'failed',
        createdAt: at(1),
      },
      { conversationId: bouncedReply, direction: 'inbound', bodyText: 'Refund?', createdAt: at(0) },
      {
        conversationId: bouncedReply,
        direction: 'outbound',
        bodyText: 'Refunded',
        authorAgentId: agent.id,
        deliveryStatus: 'bounced',
        createdAt: at(1),
      },

      // The customer's mail server answering our reply asks nothing of us.
      { conversationId: outOfOffice, direction: 'inbound', bodyText: 'Refund?', createdAt: at(0) },
      {
        conversationId: outOfOffice,
        direction: 'outbound',
        bodyText: 'Refunded',
        authorAgentId: agent.id,
        deliveryStatus: 'delivered',
        createdAt: at(1),
      },
      {
        conversationId: outOfOffice,
        direction: 'inbound',
        bodyText: 'I am out of the office until Sunday',
        meta: { isAutoReply: true },
        createdAt: at(2),
      },
    ]);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(noticeAfterAck)).toMatchObject({
      lastFromUs: true,
      preview: 'We got your request',
    });
    expect(byId.get(failedReply)).toMatchObject({ lastFromUs: false, preview: 'وين شحنتي؟' });
    expect(byId.get(bouncedReply)).toMatchObject({ lastFromUs: false, preview: 'Refund?' });
    expect(byId.get(outOfOffice)).toMatchObject({ lastFromUs: true, preview: 'Refunded' });
  });

  it('skips a reaction from either side: it is nobody’s last word', async () => {
    const agent = await admin();
    const thanked = await ticket('whatsapp', null);
    const hearted = await ticket('whatsapp', null);
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
    const reaction = { whatsappType: 'reaction' };

    await db.insert(messages).values([
      // The customer's 🙏 on our answer leaves the arrow on our answer.
      { conversationId: thanked, direction: 'inbound', bodyText: 'فين شحنتي؟', createdAt: at(0) },
      {
        conversationId: thanked,
        direction: 'outbound',
        bodyText: 'On its way',
        authorAgentId: agent.id,
        createdAt: at(1),
      },
      {
        conversationId: thanked,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: reaction,
        createdAt: at(2),
      },

      // The business's ❤️ from the phone is not an answer, so the ticket still
      // reads as the customer waiting on us.
      { conversationId: hearted, direction: 'inbound', bodyText: 'Refund?', createdAt: at(0) },
      {
        conversationId: hearted,
        direction: 'outbound',
        bodyText: '[reacted ❤️]',
        meta: { ...reaction, echo: true, echoSource: 'business_app' },
        createdAt: at(1),
      },
    ]);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(thanked)).toMatchObject({ lastFromUs: true, preview: 'On its way' });
    expect(byId.get(hearted)).toMatchObject({ lastFromUs: false, preview: 'Refund?' });
  });

  it('breaks a tie on created_at the way the ticket timeline does', async () => {
    const agent = await admin();
    const tied = await ticket('facebook', null);

    // Two rows stamped with one instant, as a provider's second-precision
    // `sentAt` or a batch sharing one `now` produces. The ids are fixed so that
    // insertion order and id order disagree: inserted first but with the larger
    // id, the customer's row is what the id tiebreak picks, and a timeline that
    // fell back to the heap's order would show ours last instead.
    const same = new Date(Date.UTC(2026, 8, 1, 10, 0));
    await db.insert(messages).values([
      {
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        conversationId: tied,
        direction: 'inbound',
        bodyText: 'from them',
        createdAt: same,
      },
      {
        id: '00000000-0000-4000-8000-000000000001',
        conversationId: tied,
        direction: 'outbound',
        bodyText: 'from us',
        createdAt: same,
      },
    ]);

    const { rows } = await listInbox(agent, parseFilters({}));
    const row = rows.find((candidate) => candidate.id === tied)!;
    const detail = await getConversation(agent, row.number);
    const shownLast = detail!.messages.at(-1)!;

    expect(row).toMatchObject({ preview: 'from them', lastFromUs: false });
    expect(shownLast).toMatchObject({ bodyText: 'from them', direction: 'inbound' });
  });
});

describe('getConversation', () => {
  it("draws each message with its own author's face, not the requester's", async () => {
    const agent = await admin();
    await db
      .update(agents)
      .set({ avatarUrl: 'https://example.test/omar.png', avatarColor: 'violet' })
      .where(eq(agents.id, agent.id));

    const id = await ticket('email', null);
    // A CC'd stranger with a picture, and a contact deleted since it wrote —
    // whose picture the avatar route would refuse, so the tile must not ask.
    const [cc, gone] = await db
      .insert(contacts)
      .values([
        { name: 'Hana', avatarPath: 'avatars/hana.jpg' },
        { name: 'Gone', avatarPath: 'avatars/gone.jpg', deletedAt: new Date() },
      ])
      .returning({ id: contacts.id });
    const [requester] = await db
      .select({ id: conversations.requesterContactId, number: conversations.number })
      .from(conversations)
      .where(eq(conversations.id, id));

    const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 10, minute));
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'from the requester',
        authorContactId: requester!.id,
        createdAt: at(0),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'from the cc',
        authorContactId: cc!.id,
        createdAt: at(1),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'from the deleted',
        authorContactId: gone!.id,
        createdAt: at(2),
      },
      {
        conversationId: id,
        direction: 'outbound',
        bodyText: 'from the agent',
        authorAgentId: agent.id,
        createdAt: at(3),
      },
      { conversationId: id, direction: 'outbound', bodyText: 'from nobody', createdAt: at(4) },
    ]);

    const detail = await getConversation(agent, requester!.number);
    const byText = new Map(detail!.messages.map((message) => [message.bodyText, message]));

    expect(byText.get('from the requester')).toMatchObject({
      authorContactId: requester!.id,
      authorContactHasAvatar: false,
      authorAgentColor: null,
      authorAgentAvatarUrl: null,
    });
    expect(byText.get('from the cc')).toMatchObject({
      authorContactId: cc!.id,
      authorContactHasAvatar: true,
    });
    expect(byText.get('from the deleted')).toMatchObject({
      authorContactId: gone!.id,
      authorContactHasAvatar: false,
    });
    expect(byText.get('from the agent')).toMatchObject({
      authorIsAgent: true,
      authorContactId: null,
      authorContactHasAvatar: false,
      authorAgentColor: 'violet',
      authorAgentAvatarUrl: 'https://example.test/omar.png',
    });
    expect(byText.get('from nobody')).toMatchObject({
      authorIsAgent: false,
      authorContactId: null,
      authorAgentColor: null,
      authorAgentAvatarUrl: null,
    });
  });

  describe('our number and who is accountable', () => {
    async function numberTicket(values: {
      channel: 'whatsapp' | 'whatsapp_bot' | 'webchat';
      channelId: string | null;
      accountableAgentId?: string | null;
      assigneeAgentId?: string | null;
    }) {
      const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
      const [row] = await db
        .insert(conversations)
        .values({
          statusId: await openStatusId(),
          requesterContactId: contact!.id,
          ...values,
        })
        .returning({ number: conversations.number });
      return row!.number;
    }

    async function channel(values: {
      type: 'whatsapp' | 'whatsapp_bot' | 'webchat';
      name: string;
      config: Record<string, unknown>;
      ownerAgentId?: string | null;
    }) {
      const [row] = await db.insert(channels).values(values).returning({ id: channels.id });
      return row!.id;
    }

    // The coexistence block as onboarding writes it: the WABA id, the Meta
    // phone number id and the number Meta reported for it.
    const coexistence = (displayPhoneNumber: string) => ({
      phoneNumberId: '1070000000000001',
      coexistence: {
        onboardedAt: '2026-09-01T10:00:00.000Z',
        wabaId: '2090000000000001',
        displayPhoneNumber,
        verifiedName: 'ShipBlu',
      },
    });

    it("names an owned coexistence number, its owner and the ticket's accountable agent", async () => {
      const agent = await admin();
      const [nayera, bob] = await db
        .insert(agents)
        .values([
          { name: 'نيرة محمد', email: 'nayera@shipblu.test', role: 'agent' },
          { name: 'Bob', email: 'bob@shipblu.test', role: 'agent' },
        ])
        .returning({ id: agents.id });
      const line = await channel({
        type: 'whatsapp',
        name: 'Nayera Mohamed',
        config: coexistence('+20 12 78707918'),
        ownerAgentId: nayera!.id,
      });
      // Covered by Bob: the work moved, the accountability did not.
      const number = await numberTicket({
        channel: 'whatsapp',
        channelId: line,
        accountableAgentId: nayera!.id,
        assigneeAgentId: bob!.id,
      });

      const detail = await getConversation(agent, number);

      expect(detail!.businessNumber).toEqual({
        name: 'Nayera Mohamed',
        displayNumber: '+20 12 78707918',
        owner: { id: nayera!.id, name: 'نيرة محمد', active: true },
      });
      expect(detail!.accountable).toEqual({ id: nayera!.id, name: 'نيرة محمد', active: true });
      expect(detail!.assigneeName).toBe('Bob');

      // The object is serialised into the page: nothing of the stored config
      // but the display number may ride along with it.
      const shipped = JSON.stringify(detail);
      expect(shipped).not.toContain('1070000000000001');
      expect(shipped).not.toContain('2090000000000001');
      expect(shipped).not.toContain('onboardedAt');
    });

    it('says when the owner and the accountable agent are deactivated', async () => {
      const agent = await admin();
      const [omar] = await db
        .insert(agents)
        .values({ name: 'Omar Former', email: 'omar.former@shipblu.test', isActive: false })
        .returning({ id: agents.id });
      const line = await channel({
        type: 'whatsapp',
        name: 'Omar line',
        config: coexistence('+20 10 40204380'),
        ownerAgentId: omar!.id,
      });
      const number = await numberTicket({
        channel: 'whatsapp',
        channelId: line,
        accountableAgentId: omar!.id,
        assigneeAgentId: omar!.id,
      });

      const detail = await getConversation(agent, number);

      expect(detail!.accountable).toEqual({ id: omar!.id, name: 'Omar Former', active: false });
      expect(detail!.businessNumber!.owner).toEqual({
        id: omar!.id,
        name: 'Omar Former',
        active: false,
      });
    });

    it('names a plain number without a display number, and the bot by its row', async () => {
      const agent = await admin();
      const plain = await channel({
        type: 'whatsapp',
        name: 'Support line',
        config: { phoneNumberId: '1070000000000002' },
      });
      const bot = await channel({
        type: 'whatsapp_bot',
        name: 'Second bot',
        config: { phoneNumberId: '1070000000000003' },
      });

      const onPlain = await getConversation(
        agent,
        await numberTicket({ channel: 'whatsapp', channelId: plain }),
      );
      const onBot = await getConversation(
        agent,
        await numberTicket({ channel: 'whatsapp_bot', channelId: bot }),
      );

      // The phone number id is Meta's id, not a number; a plain row has no
      // other, so the badge names the channel and nothing more.
      expect(onPlain!.businessNumber).toEqual({
        name: 'Support line',
        displayNumber: null,
        owner: null,
      });
      expect(onPlain!.accountable).toBeNull();
      expect(JSON.stringify(onPlain)).not.toContain('1070000000000002');
      expect(onBot!.businessNumber).toEqual({
        name: 'Second bot',
        displayNumber: null,
        owner: null,
      });
    });

    it('names no number on a webchat ticket, or on a WhatsApp ticket filed before tickets knew theirs', async () => {
      const agent = await admin();
      const chat = await channel({ type: 'webchat', name: 'Website chat', config: {} });

      const webchat = await getConversation(
        agent,
        await numberTicket({ channel: 'webchat', channelId: chat }),
      );
      const unplaced = await getConversation(
        agent,
        await numberTicket({ channel: 'whatsapp', channelId: null }),
      );

      expect(webchat!.businessNumber).toBeNull();
      expect(webchat!.accountable).toBeNull();
      expect(unplaced!.businessNumber).toBeNull();
      expect(unplaced!.accountable).toBeNull();
    });
  });
});

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
    .returning({
      id: conversations.id,
      number: conversations.number,
      contactId: conversations.requesterContactId,
    });

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
    // Its own phone holds its number too, so the text search matches it as well
    // as the lookup does. Without that, the paged query would leave it out
    // whether or not it excludes the named ticket, and the assertions below
    // that nothing is shown twice would pass on a query that shows it twice.
    await db
      .update(contacts)
      .set({ primaryPhone: `2010${n}9999` })
      .where(eq(contacts.id, named!.contactId));

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

  it('treats a query that is only a pasted direction mark or decoration as no search', async () => {
    const agent = await admin();
    // No subject, no name, no email, no phone and no messages: nothing a
    // search clause could match, so only an unsearched list shows it.
    const [bare] = await tickets([{}]);

    const unsearched = await listInbox(agent, parseFilters({}));
    expect(unsearched.rows.map((row) => row.id)).toContain(bare!.id);

    for (const q of ['\u200F', 'ـ', '\u064E']) {
      const { rows } = await listInbox(agent, parseFilters({ q }));
      expect(
        rows.map((row) => row.id),
        JSON.stringify(q),
      ).toEqual(unsearched.rows.map((row) => row.id));
    }
  });

  it('finds a resolved ticket by its number under the default status filter, and only that one', async () => {
    const agent = await admin();
    const [named, other] = await tickets([{ name: 'Old' }, { name: 'Also resolved' }]);
    const [resolved] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.category, 'resolved'))
      .limit(1);
    await db
      .update(conversations)
      .set({ statusId: resolved!.id })
      .where(inArray(conversations.id, [named!.id, other!.id]));
    // The other resolved ticket holds the same digits, so the text search
    // reaches it — and the status filter, which the number skips and the text
    // search does not, is what keeps it out.
    await db
      .update(contacts)
      .set({ primaryPhone: `2010${named!.number}9999` })
      .where(eq(contacts.id, other!.contactId));

    const { rows } = await listInbox(agent, parseFilters({ q: String(named!.number) }));

    expect(rows.map((row) => row.id)).toEqual([named!.id]);
    expect(rows[0]!.statusCategory).toBe('resolved');
  });

  it('does not reach a ticket by number that the agent could not open from the list', async () => {
    const agent = await signedIn('agent', 'sara@shipblu.test');
    // Unassigned, and waiting in a group she is not in: an agent without
    // ticket.view.all sees her own tickets and her groups', and this is
    // neither. The baseline's Support group, which she is not a member of.
    const [theirs] = await tickets([{ name: 'Not yours' }]);
    const [support] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.name, 'Support'));
    await db
      .update(conversations)
      .set({ groupId: support!.id })
      .where(eq(conversations.id, theirs!.id));

    const { rows } = await listInbox(agent, parseFilters({ q: `#${theirs!.number}` }));

    expect(rows).toEqual([]);
  });
});

describe('the Rated 1–2 view', () => {
  const RATED = parseFilters({ status: 'all', rating: 'low' });
  // Noon in Cairo, pinned: the window is read from the clock when the list is
  // asked for, and a team midnight passing between the fixtures and the query
  // would move it a day under the test. Only `Date` is faked; the database's
  // clock plays no part, since the window is bound as two dates.
  const NOON = DateTime.fromISO('2026-10-14T12:00', { zone: 'Africa/Cairo' });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON.toJSDate());
  });
  afterEach(() => {
    vi.useRealTimers();
    forgetHoursCatalog();
  });

  async function statusId(name: string): Promise<string> {
    const [row] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, name));
    return row!.id;
  }

  /** A ticket in `status`, rated `rating` at `respondedAt`. */
  async function rated(
    rating: number,
    respondedAt: Date,
    status = 'Resolved',
    assigneeAgentId: string | null = null,
  ) {
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    const [row] = await db
      .insert(conversations)
      .values({
        channel: 'email',
        statusId: await statusId(status),
        requesterContactId: contact!.id,
        assigneeAgentId,
      })
      .returning({ id: conversations.id, number: conversations.number });
    await db
      .insert(csatSurveys)
      .values({ conversationId: row!.id, status: 'answered', rating, respondedAt });
    return row!;
  }

  const anHourAgo = () => NOON.minus({ hours: 1 }).toJSDate();

  it('lists a low rating from the last seven days on any status, once per ticket', async () => {
    const agent = await admin();
    const firstDay = NOON.startOf('day').minus({ days: 6 });

    const resolved = await rated(1, anHourAgo());
    const closed = await rated(2, anHourAgo(), 'Closed');
    const reopened = await rated(1, firstDay.plus({ minutes: 5 }).toJSDate(), 'Open');
    // Answered low twice: one row, and the paging stays clean.
    await db.insert(csatSurveys).values({
      conversationId: resolved.id,
      status: 'answered',
      rating: 2,
      respondedAt: anHourAgo(),
    });
    await rated(3, anHourAgo());
    // A minute before the window's first midnight.
    await rated(1, firstDay.minus({ minutes: 1 }).toJSDate());

    const { rows, nextCursor } = await listInbox(agent, RATED);
    expect(rows.map((row) => row.id).sort()).toEqual([resolved.id, closed.id, reopened.id].sort());
    expect(nextCursor).toBeNull();
  });

  it('cuts its days at the team’s midnight, wherever the team’s schedule is', async () => {
    const agent = await admin();
    await db
      .update(businessHours)
      .set({ timezone: 'America/Los_Angeles' })
      .where(eq(businessHours.isDefault, true));
    forgetHoursCatalog();
    vi.setSystemTime(
      DateTime.fromISO('2026-10-14T12:00', { zone: 'America/Los_Angeles' }).toJSDate(),
    );

    // The window's first day is the 8th in Los Angeles, which begins at 10:00
    // in Cairo: an answer at 05:00 in Cairo is a day too early there, though a
    // Cairo window would hold it.
    const early = await rated(
      1,
      DateTime.fromISO('2026-10-08T05:00', { zone: 'Africa/Cairo' }).toJSDate(),
    );
    const inside = await rated(
      1,
      DateTime.fromISO('2026-10-08T12:00', { zone: 'Africa/Cairo' }).toJSDate(),
    );

    const ids = (await listInbox(agent, RATED)).rows.map((row) => row.id);
    expect(ids).toEqual([inside.id]);
    expect(ids).not.toContain(early.id);
  });

  it('lists the ticket a low-rated one was merged into', async () => {
    const agent = await admin();
    const merged = await rated(1, anHourAgo());
    const survivor = await rated(5, anHourAgo(), 'Open');
    await db
      .update(conversations)
      .set({ mergedIntoId: survivor.id })
      .where(eq(conversations.id, merged.id));

    expect((await listInbox(agent, RATED)).rows.map((row) => row.id)).toEqual([survivor.id]);
  });

  it('returns nothing to an agent who may not see the ratings, however the URL asks', async () => {
    const agent = { ...(await admin()), permissions: { 'report.view': false } };
    await rated(1, anHourAgo());

    expect((await listInbox(agent, RATED)).rows).toEqual([]);
  });

  it('shows an agent who sees only their own tickets only their own', async () => {
    const agent = {
      ...(await signedIn('agent', 'mona@shipblu.test')),
      permissions: { 'report.view': true, 'ticket.view.all': false },
    };
    const theirs = await rated(1, anHourAgo(), 'Resolved', agent.id);
    await rated(1, anHourAgo());

    expect((await listInbox(agent, RATED)).rows.map((row) => row.id)).toEqual([theirs.id]);
  });

  it('keeps a ticket named by number to the view', async () => {
    const agent = await admin();
    const low = await rated(1, anHourAgo());
    const high = await rated(5, anHourAgo());

    const search = (number: number) =>
      listInbox(agent, parseFilters({ status: 'all', rating: 'low', q: `#${number}` }));
    expect((await search(low.number)).rows.map((row) => row.id)).toEqual([low.id]);
    expect((await search(high.number)).rows).toEqual([]);
  });
});

// The plan's rollback of Stage 1.2 moves every comment ticket back onto its
// platform's channel, where only its external id says it is a public thread:
// the inbox's badge and the ticket page's direct-message state both read it.
describe('a comment ticket, once rolling back 1.2 has moved comments back', () => {
  const { moveCommentsBack } = withoutCommentChannelCheck();

  it('is still marked as one, and given no direct-message thread state', async () => {
    const agent = await admin();
    const comment = await ticket('facebook_comment', 'facebook:comment:123_456');
    expect(await moveCommentsBack()).toBe(1);
    const message = await ticket('facebook', null);

    const { rows } = await listInbox(agent, parseFilters({}));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(comment)?.isComment).toBe(true);
    expect(byId.get(message)?.isComment).toBe(false);

    const onPost = await getConversation(agent, byId.get(comment)!.number);
    const direct = await getConversation(agent, byId.get(message)!.number);
    expect(onPost?.metaThread).toBeNull();
    expect(direct?.metaThread).not.toBeNull();
  });
});
