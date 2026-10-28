import { and, asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  jobs,
  routingDecisions,
  ticketStatuses,
} from '@/db/schema';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import type { InboundDelivery, ParsedInboundEmail } from '@/lib/email/types';
import type { NormalisedComment, NormalisedDirectMessage } from '@/lib/meta/types';
import type { RoutingMode } from '@/lib/routing/mode';
import { SETTLE_ROUTING_PRIORITY } from '@/lib/routing/start';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { appendVisitorMessage } from '@/lib/widget/conversation';
import type { NormalisedEcho, NormalisedInboundMessage } from '@/lib/whatsapp/types';
import { resolveContact } from './contacts';
import { ingestInboundEmail } from './ingest';
import { ingestMetaComment, ingestMetaMessage } from './ingest-meta';
import { ingestWhatsAppEcho, ingestWhatsAppMessage } from './ingest-whatsapp';
import { ingestWhatsAppHistoryChunk } from './ingest-whatsapp-history';

/**
 * Where routing starts, on every inbound path (`plans/ticket-category-routing.md`,
 * decision 5): each ingest that inserts a ticket on a channel in a category
 * mode, while the classifier is in `apply`, writes the window, one decision row
 * naming the message that opened the ticket, and the `settle_routing` job for
 * the window's end, in the transaction that inserts the ticket.
 *
 * In one file, so the five paths — email, WhatsApp, a Meta direct message, a
 * Meta comment on its own row and on the platform's, and the widget — are held
 * to one set of expectations: a path that forgot `planRouting`, read its
 * channel row without the mode, or started routing on a continuation fails
 * here beside the paths that did not. `lib/routing/begin.db.test.ts` has the
 * creation pass and the email insert in depth; this is the breadth.
 *
 * Every group here is staffed with an agent who takes tickets at any hour, so
 * "held" is visible as nobody assigned after the creation pass, and "nothing
 * held" as the rota assigning on arrival. Each ingest runs the creation pass,
 * whose `beginRouting` moves a row with no category to `holding` — so a ticket
 * held from its insert reads `holding` once the ingest returns.
 *
 * Every best-effort step logs instead of throwing, so a failure inside one
 * would read as "nothing happened": a test fails on any error logged it did
 * not ask for.
 */

withCleanDatabase();

const MINUTE = 60_000;
const SUPPORT_NUMBER = '100000000000001';
const COEX_NUMBER = '106540352242922';
const BOT_NUMBER = '128318316834446';
const CUSTOMER = '201001234567';
const PSID = '24681357902468135';
/** Weeks before the test runs: every message here is processed long after it was sent. */
const SENT = new Date('2026-09-20T10:00:00Z');
const LATER = new Date('2026-09-20T11:30:00Z');

let errors: MockInstance;
let errorsExpected = false;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  errorsExpected = false;
  await classifier('apply');
});

afterEach(() => {
  const logged = errors.mock.calls.map((call) => String(call[0]));
  vi.restoreAllMocks();
  if (!errorsExpected) expect(logged).toEqual([]);
});

// --- Fixtures ---------------------------------------------------------------

/** The classifier's switch, which routing starts only under (`routingStartFor`). */
async function classifier(mode: 'off' | 'shadow' | 'apply', windowMinutes = 5): Promise<void> {
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
    values (1, ${mode}, 0.6, ${windowMinutes})
    on conflict (id) do update
      set mode = excluded.mode, routing_window_minutes = excluded.routing_window_minutes`);
  forgetCategoryAiSettings();
}

let people = 0;

/** A group that assigns round robin at any hour, with one agent online in it. */
async function staffedGroup(name = 'Customer Care'): Promise<{ id: string; agentId: string }> {
  people += 1;
  const [agent] = await db
    .insert(agents)
    .values({
      name: `Hana ${people}`,
      email: `agent${people}@shipblu.test`,
      presence: 'online',
      lastSeenAt: new Date(),
    })
    .returning({ id: agents.id });
  const [group] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
    .returning({ id: groups.id });
  await db.insert(groupMembers).values({ groupId: group!.id, agentId: agent!.id });
  return { id: group!.id, agentId: agent!.id };
}

async function channel(
  values: Pick<typeof channels.$inferInsert, 'type' | 'name'> &
    Partial<typeof channels.$inferInsert>,
): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({ config: {}, ...values })
    .returning({ id: channels.id });
  return row!.id;
}

type Mail = ParsedInboundEmail & InboundDelivery;

function mail(overrides: Partial<Mail> = {}): Mail {
  return {
    messageId: 'first@customer.example',
    references: [],
    from: { address: 'amira@customer.example', name: 'Amira' },
    to: [{ address: 'support@shipblu.test' }],
    cc: [],
    subject: 'Where is my parcel?',
    textBody: 'Hello, my parcel has not arrived.',
    attachments: [],
    headers: {},
    dateHeader: null,
    // Reached us three hours ago, and processed only now, after a worker pause.
    receivedAt: new Date(Date.now() - 180 * MINUTE),
    ...overrides,
  };
}

async function ingestMail({ receivedAt, ...parsed }: Mail): Promise<Ingested> {
  const result = await ingestInboundEmail(parsed, { receivedAt });
  if (!result) throw new Error('ingest returned null');
  return result;
}

function whatsapp(overrides: Partial<NormalisedInboundMessage> = {}): NormalisedInboundMessage {
  return {
    wamid: 'wamid.first',
    from: CUSTOMER,
    phoneNumberId: SUPPORT_NUMBER,
    profileName: 'Amira',
    sentAt: SENT,
    type: 'text',
    text: 'Where is my parcel?',
    media: null,
    location: null,
    replyToWamid: null,
    raw: { id: 'wamid.first' },
    ...overrides,
  };
}

function dm(overrides: Partial<NormalisedDirectMessage> = {}): NormalisedDirectMessage {
  return {
    platform: 'facebook',
    connection: 'facebook_page',
    mid: 'm_first',
    from: PSID,
    accountId: 'page-1',
    standby: false,
    senderName: null,
    sentAt: SENT,
    text: 'Where is my parcel?',
    attachments: [],
    replyToMid: null,
    raw: { mid: 'm_first' },
    ...overrides,
  };
}

function comment(overrides: Partial<NormalisedComment> = {}): NormalisedComment {
  return {
    platform: 'facebook',
    connection: 'facebook_page',
    commentId: 'post-1_c1',
    parentCommentId: null,
    postId: 'post-1',
    from: '1122334455',
    fromName: 'Amira Hassan',
    text: 'My parcel never came',
    createdAt: SENT,
    verb: 'add',
    raw: { comment_id: 'post-1_c1' },
    ...overrides,
  };
}

type Ingested = { conversationId: string; messageId: string; createdConversation: boolean };

/**
 * One inbound path: the channel row its new tickets are filed under, set to
 * `mode`, and a customer's first message and a second that continues its
 * ticket. `channel` answers the id of the row the ticket is filed under.
 */
type Path = {
  name: string;
  channel: (groupId: string, mode: RoutingMode) => Promise<string>;
  first: () => Promise<Ingested>;
  next: (first: Ingested) => Promise<Ingested>;
};

let widgetVisitor: string | null = null;

async function visitor(): Promise<string> {
  if (widgetVisitor) return widgetVisitor;
  const [row] = await db.insert(contacts).values({ name: null }).returning({ id: contacts.id });
  widgetVisitor = row!.id;
  return widgetVisitor;
}

beforeEach(() => {
  widgetVisitor = null;
});

const PATHS: Path[] = [
  {
    name: 'email',
    channel: (defaultGroupId, routingMode) =>
      channel({ type: 'email', name: 'Support mail', defaultGroupId, routingMode }),
    first: () => ingestMail(mail()),
    next: () =>
      ingestMail(
        mail({
          messageId: 'second@customer.example',
          inReplyTo: 'first@customer.example',
          references: ['first@customer.example'],
          receivedAt: new Date(),
        }),
      ),
  },
  {
    name: 'WhatsApp',
    channel: (defaultGroupId, routingMode) =>
      channel({
        type: 'whatsapp',
        name: 'WhatsApp Support',
        config: { phoneNumberId: SUPPORT_NUMBER },
        defaultGroupId,
        routingMode,
      }),
    first: () => ingestWhatsAppMessage(whatsapp()),
    next: () =>
      ingestWhatsAppMessage(
        whatsapp({ wamid: 'wamid.second', sentAt: LATER, raw: { id: 'wamid.second' } }),
      ),
  },
  {
    name: 'a Meta direct message',
    channel: (defaultGroupId, routingMode) =>
      channel({ type: 'facebook', name: 'Facebook', defaultGroupId, routingMode }),
    first: () => ingestMetaMessage(dm()),
    next: () => ingestMetaMessage(dm({ mid: 'm_second', sentAt: LATER, raw: { mid: 'm_second' } })),
  },
  {
    // The comments row decides, and the platform's row beside it does not: it
    // stays on its default group whatever the comments row says.
    name: 'a Meta comment, on its comments row',
    channel: async (defaultGroupId, routingMode) => {
      await channel({ type: 'facebook', name: 'Facebook', defaultGroupId });
      return channel({
        type: 'facebook_comment',
        name: 'Facebook comments',
        defaultGroupId,
        routingMode,
      });
    },
    first: () => ingestMetaComment(comment()),
    next: () =>
      ingestMetaComment(
        comment({ commentId: 'post-1_c2', parentCommentId: 'post-1_c1', createdAt: LATER }),
      ),
  },
  {
    // Until an admin adds a comments row, a comment ticket is filed under the
    // platform's direct-message row, and routes by that row's mode — which is
    // also the row the router reads the mode off again when it decides.
    name: 'a Meta comment, on the platform’s row',
    channel: (defaultGroupId, routingMode) =>
      channel({ type: 'facebook', name: 'Facebook', defaultGroupId, routingMode }),
    first: () => ingestMetaComment(comment()),
    next: () =>
      ingestMetaComment(
        comment({ commentId: 'post-1_c2', parentCommentId: 'post-1_c1', createdAt: LATER }),
      ),
  },
  {
    name: 'the widget',
    channel: (defaultGroupId, routingMode) =>
      channel({ type: 'webchat', name: 'Web chat', defaultGroupId, routingMode }),
    first: async () => appendVisitorMessage(await visitor(), 'Hi, where is my parcel?'),
    next: async () => appendVisitorMessage(await visitor(), 'Hello? Anybody there?'),
  },
];

async function ticketRow(id: string) {
  const [row] = await db
    .select({
      channelId: conversations.channelId,
      groupId: conversations.groupId,
      assigneeAgentId: conversations.assigneeAgentId,
      routingWindowEndsAt: conversations.routingWindowEndsAt,
      routingDecidedAt: conversations.routingDecidedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function decisions() {
  return db.select().from(routingDecisions).orderBy(asc(routingDecisions.startedAt));
}

async function settleJobs() {
  return db
    .select({
      payload: jobs.payload,
      runAt: jobs.runAt,
      priority: jobs.priority,
      dedupeKey: jobs.dedupeKey,
      status: jobs.status,
    })
    .from(jobs)
    .where(eq(jobs.type, 'settle_routing'));
}

async function events(id: string, type: string) {
  return db
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)));
}

async function resolve(id: string): Promise<void> {
  const [resolved] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Resolved'));
  await db
    .update(conversations)
    .set({ statusId: resolved!.id, resolvedAt: new Date() })
    .where(eq(conversations.id, id));
}

async function statusCategory(id: string): Promise<string> {
  const [row] = await db
    .select({ category: ticketStatuses.category })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  return row!.category;
}

/** Nothing about routing anywhere: no row, no job, no window on any ticket. */
async function expectNothingStarted(): Promise<void> {
  expect(await decisions()).toEqual([]);
  expect(await settleJobs()).toEqual([]);
  expect(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(sql`${conversations.routingWindowEndsAt} is not null`),
  ).toEqual([]);
}

/**
 * The three things the insert writes, once: on a live channel the window on
 * the ticket, the decision row naming the opening message and the window's
 * end, and the job due at that end; on a shadow channel the same row and job,
 * and no window. The window counts from when the message was processed —
 * after `before` — however long ago it was sent.
 */
async function expectStarted(
  ingested: Ingested,
  {
    channelId,
    groupId,
    shadow,
    before,
    windowMinutes = 5,
  }: {
    channelId: string;
    groupId: string;
    shadow: boolean;
    before: Date;
    windowMinutes?: number;
  },
) {
  const id = ingested.conversationId;
  const rows = await decisions();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toMatchObject({
    conversationId: id,
    channelId,
    shadow,
    // The creation pass begun it, and found no category to route on.
    stage: 'holding',
    outcome: null,
    fromGroupId: groupId,
    toGroupId: null,
    messageId: ingested.messageId,
    phaseOneAt: null,
    decidedAt: null,
  });
  expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
  expect(row.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
  expect(row.windowEndsAt.getTime() - row.startedAt.getTime()).toBe(windowMinutes * MINUTE);

  expect(await ticketRow(id)).toMatchObject({
    channelId,
    groupId,
    routingWindowEndsAt: shadow ? null : row.windowEndsAt,
    routingDecidedAt: null,
  });

  expect(await settleJobs()).toEqual([
    {
      payload: { conversationId: id },
      runAt: row.windowEndsAt,
      priority: SETTLE_ROUTING_PRIORITY,
      dedupeKey: `settle_routing:${id}`,
      status: 'pending',
    },
  ]);
  expect(SETTLE_ROUTING_PRIORITY).toBe(40);

  // Nothing decided yet, and a held ticket's skips write nothing.
  expect(await events(id, 'routed')).toEqual([]);
  expect(await events(id, 'assignment_skipped')).toEqual([]);
  return row;
}

// --- Every path -------------------------------------------------------------

describe.each(PATHS)('$name', (path) => {
  it('holds a new ticket from its insert: the window, the row and the job', async () => {
    const group = await staffedGroup();
    const channelId = await path.channel(group.id, 'category');
    const before = new Date();

    const ingested = await path.first();

    expect(ingested.createdConversation).toBe(true);
    await expectStarted(ingested, { channelId, groupId: group.id, shadow: false, before });
    // Held: the creation pass's assignment skipped, though the group is staffed.
    expect((await ticketRow(ingested.conversationId)).assigneeAgentId).toBeNull();
  });

  it('copies the window from the classifier’s setting', async () => {
    const group = await staffedGroup();
    const channelId = await path.channel(group.id, 'category');
    await classifier('apply', 12);
    const before = new Date();

    const ingested = await path.first();

    await expectStarted(ingested, {
      channelId,
      groupId: group.id,
      shadow: false,
      before,
      windowMinutes: 12,
    });
  });

  it('starts nothing for a message that continues the ticket', async () => {
    const group = await staffedGroup();
    const channelId = await path.channel(group.id, 'category');
    const before = new Date();
    const first = await path.first();

    const next = await path.next(first);

    expect(next).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    // Still the one row, naming the first message, and the one job.
    await expectStarted(first, { channelId, groupId: group.id, shadow: false, before });
  });

  // Routing state is written only for tickets created after a channel enters
  // a category mode, so the backlog is untouched by construction and needs no
  // backfill: a ticket from before keeps its old way when its customer writes.
  it('starts nothing for a ticket opened before the channel routed, when it continues', async () => {
    const group = await staffedGroup();
    const channelId = await path.channel(group.id, 'default_group');
    const first = await path.first();
    await db.update(channels).set({ routingMode: 'category' }).where(eq(channels.id, channelId));

    const next = await path.next(first);

    expect(next).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    await expectNothingStarted();
  });

  it('records a shadow channel’s ticket, holds nothing, and the rota assigns on arrival', async () => {
    const group = await staffedGroup();
    const channelId = await path.channel(group.id, 'category_shadow');
    const before = new Date();

    const ingested = await path.first();

    await expectStarted(ingested, { channelId, groupId: group.id, shadow: true, before });
    expect((await ticketRow(ingested.conversationId)).assigneeAgentId).toBe(group.agentId);
  });

  it.each(['off', 'shadow'] as const)(
    'starts nothing while the classifier is %s, and the rota assigns on arrival',
    async (mode) => {
      const group = await staffedGroup();
      await path.channel(group.id, 'category');
      await classifier(mode);

      const ingested = await path.first();

      await expectNothingStarted();
      expect((await ticketRow(ingested.conversationId)).assigneeAgentId).toBe(group.agentId);
    },
  );

  it('starts nothing on a channel that routes by its default group', async () => {
    const group = await staffedGroup();
    await path.channel(group.id, 'default_group');

    const ingested = await path.first();

    await expectNothingStarted();
    expect((await ticketRow(ingested.conversationId)).assigneeAgentId).toBe(group.agentId);
  });
});

// --- What never routes ------------------------------------------------------

describe('what starts nothing, whatever the column says', () => {
  it.each([
    [
      'a bounce',
      { from: { address: 'MAILER-DAEMON@mx.customer.example' }, subject: 'Undeliverable' },
    ],
    [
      'an out-of-office reply',
      {
        subject: 'Automatic reply: Where is my parcel?',
        textBody: 'I am out of the office until Sunday.',
        headers: { 'auto-submitted': 'auto-replied' },
      },
    ],
  ] as const)('an email ticket opened by %s, which is filed as spam', async (_, overrides) => {
    const group = await staffedGroup();
    await channel({
      type: 'email',
      name: 'Support mail',
      defaultGroupId: group.id,
      routingMode: 'category',
    });

    const ingested = await ingestMail(mail(overrides));

    expect(ingested.createdConversation).toBe(true);
    await expectNothingStarted();
  });

  it('the bot’s number, whose transcripts are not work', async () => {
    const group = await staffedGroup();
    await db
      .update(channels)
      .set({ routingMode: 'category', defaultGroupId: group.id })
      .where(eq(channels.type, 'whatsapp_bot'));

    const ingested = await ingestWhatsAppMessage(whatsapp({ phoneNumberId: BOT_NUMBER }));

    expect(ingested.createdConversation).toBe(true);
    await expectNothingStarted();
  });

  it('a coexistence number, whose replies are typed on the phone', async () => {
    const group = await staffedGroup();
    await coexistencePhone(group.id);

    const ingested = await ingestWhatsAppMessage(whatsapp({ phoneNumberId: COEX_NUMBER }));

    expect(ingested.createdConversation).toBe(true);
    await expectNothingStarted();
  });

  // A number no row names borrows the support row's group, but files under no
  // row: there is no mode the router could read again when it decides.
  it('a WhatsApp number no row names, while the support row routes by category', async () => {
    const group = await staffedGroup();
    await channel({
      type: 'whatsapp',
      name: 'WhatsApp Support',
      config: { phoneNumberId: '100000000000999' },
      defaultGroupId: group.id,
      routingMode: 'category',
    });

    const ingested = await ingestWhatsAppMessage(whatsapp());

    expect(await ticketRow(ingested.conversationId)).toMatchObject({
      channelId: null,
      groupId: group.id,
      // Nothing held, so the borrowed group's rota assigned it.
      assigneeAgentId: group.agentId,
    });
    await expectNothingStarted();
  });

  // The owner is outside the rota, stamped on the ticket in its insert; a hold
  // would only be recorded as `taken` at the window's end.
  it('a plain WhatsApp number somebody owns', async () => {
    const group = await staffedGroup();
    const [owner] = await db
      .insert(agents)
      .values({ name: 'Nayera', email: 'nayera@shipblu.test' })
      .returning({ id: agents.id });
    await channel({
      type: 'whatsapp',
      name: 'Nayera’s number',
      config: { phoneNumberId: SUPPORT_NUMBER },
      defaultGroupId: group.id,
      ownerAgentId: owner!.id,
      routingMode: 'category',
    });

    const ingested = await ingestWhatsAppMessage(whatsapp());

    expect((await ticketRow(ingested.conversationId)).assigneeAgentId).toBe(owner!.id);
    await expectNothingStarted();
  });

  // A deactivated owner counts as nobody (`effectiveOwnerId`): the number is a
  // team number until a handover, and its new tickets route like one.
  it('but a number whose owner was deactivated routes like a team number', async () => {
    const group = await staffedGroup();
    const [owner] = await db
      .insert(agents)
      .values({ name: 'Nayera', email: 'nayera@shipblu.test', isActive: false })
      .returning({ id: agents.id });
    const channelId = await channel({
      type: 'whatsapp',
      name: 'Nayera’s number',
      config: { phoneNumberId: SUPPORT_NUMBER },
      defaultGroupId: group.id,
      ownerAgentId: owner!.id,
      routingMode: 'category',
    });
    const before = new Date();

    const ingested = await ingestWhatsAppMessage(whatsapp());

    await expectStarted(ingested, { channelId, groupId: group.id, shadow: false, before });
    expect((await ticketRow(ingested.conversationId)).assigneeAgentId).toBeNull();
  });

  it('a reply that reopens a resolved ticket', async () => {
    const group = await staffedGroup();
    const channelId = await channel({
      type: 'email',
      name: 'Support mail',
      defaultGroupId: group.id,
    });
    const first = await ingestMail(mail());
    await db.update(channels).set({ routingMode: 'category' }).where(eq(channels.id, channelId));
    await resolve(first.conversationId);

    const reply = await ingestMail(
      mail({
        messageId: 'second@customer.example',
        references: ['first@customer.example'],
        receivedAt: new Date(),
      }),
    );

    expect(reply).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(await statusCategory(first.conversationId)).toBe('open');
    await expectNothingStarted();
  });

  // Filed under no row until an admin added the number; the customer's next
  // message files the ticket under the row rather than opening one beside it
  // (`findOrAdoptLive`). Adopting is continuing, and continuing never routes.
  it('a WhatsApp ticket filed under no row, adopted by the row added since', async () => {
    const group = await staffedGroup();
    const first = await ingestWhatsAppMessage(whatsapp());
    expect((await ticketRow(first.conversationId)).channelId).toBeNull();
    const channelId = await channel({
      type: 'whatsapp',
      name: 'WhatsApp Support',
      config: { phoneNumberId: SUPPORT_NUMBER },
      defaultGroupId: group.id,
      routingMode: 'category',
    });

    const next = await ingestWhatsAppMessage(
      whatsapp({ wamid: 'wamid.second', sentAt: LATER, raw: { id: 'wamid.second' } }),
    );

    expect(next).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect((await ticketRow(first.conversationId)).channelId).toBe(channelId);
    await expectNothingStarted();
  });

  it('a conversation the business wrote first, nor the customer’s reply that reopens it', async () => {
    const group = await staffedGroup();
    await coexistencePhone(group.id);

    const opened = await ingestWhatsAppEcho(phoneEcho());
    expect(opened.createdConversation).toBe(true);
    const reply = await ingestWhatsAppMessage(
      whatsapp({ phoneNumberId: COEX_NUMBER, sentAt: LATER }),
    );

    expect(reply).toMatchObject({
      conversationId: opened.conversationId,
      createdConversation: false,
    });
    await expectNothingStarted();
  });

  it('a coexistence number’s imported history', async () => {
    const group = await staffedGroup();
    await coexistencePhone(group.id);

    const result = await ingestWhatsAppHistoryChunk(
      {
        phoneNumberId: COEX_NUMBER,
        phase: 0,
        chunkOrder: 1,
        progress: 100,
        declined: null,
        messages: [
          {
            wamid: 'wamid.h1',
            customer: CUSTOMER,
            direction: 'inbound',
            sentAt: new Date('2025-02-10T23:42:35Z'),
            type: 'text',
            text: 'Where is my parcel?',
            mediaPlaceholder: false,
            location: null,
            replyToWamid: null,
            phoneStatus: 'READ',
            raw: { id: 'wamid.h1', from: CUSTOMER },
          },
        ],
      },
      new Date(),
    );

    expect(result).toMatchObject({ created: 1 });
    await expectNothingStarted();
  });
});

/** A Business-app number on Cloud API, its column set to `category` against the rule. */
async function coexistencePhone(defaultGroupId: string): Promise<string> {
  return channel({
    type: 'whatsapp',
    name: 'ShipBlu on the phone',
    defaultGroupId,
    routingMode: 'category',
    config: {
      phoneNumberId: COEX_NUMBER,
      coexistence: {
        onboardedAt: '2026-09-19T08:00:00.000Z',
        wabaId: '102290129340398',
        syncs: { history: { requestId: 'req-1', requestedAt: '2026-09-19T08:01:00.000Z' } },
      },
    },
  });
}

/** The business answering from the phone's app, echoed to us. */
function phoneEcho(overrides: Partial<NormalisedEcho> = {}): NormalisedEcho {
  return {
    wamid: 'wamid.phone-1',
    to: CUSTOMER,
    from: '15550783881',
    phoneNumberId: COEX_NUMBER,
    sentAt: SENT,
    type: 'text',
    text: 'Your order leaves the hub this afternoon.',
    media: null,
    location: null,
    replyToWamid: null,
    creationType: null,
    raw: { id: 'wamid.phone-1' },
    ...overrides,
  };
}

// --- A duplicate delivery ---------------------------------------------------

/** The SQLSTATE of a failed query, through the wrapper drizzle puts round it. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Two copies of one delivery processed at once — Instagram on both of its
 * connections, a provider's retry overlapping the first attempt. The first is
 * held after its last statement, holding every lock it took; the second runs
 * into its unique index, waits there, and fails once the first commits. Its
 * transaction then takes its ticket, if it inserted one, with it — and with the
 * ticket the decision row and the job, so there is one of each, and the job's
 * key is not spent on a ticket that never existed.
 *
 * The sender is resolved first, so neither copy opens a transaction of its own
 * to create the contact and the first transaction held is the insert's.
 */
describe('a duplicate delivery processed at once', () => {
  async function race(
    deliver: () => Promise<unknown>,
  ): Promise<{ first: unknown; second: unknown }> {
    const { atHold, release } = holdNextTransaction('after');
    const first = deliver();
    await atHold;
    // Settled into a value, so its rejection is never unhandled while the
    // first is still being awaited.
    const second = deliver().then(
      () => null,
      (error: unknown) => error,
    );
    await untilWaitingOnALock(db);
    release();
    return { first: await first, second: await second };
  }

  async function expectOneOfEach(): Promise<void> {
    const tickets = await db.select({ id: conversations.id }).from(conversations);
    expect(tickets).toHaveLength(1);
    const rows = await decisions();
    expect(rows.map((row) => row.conversationId)).toEqual([tickets[0]!.id]);
    expect((await settleJobs()).map((job) => job.dedupeKey)).toEqual([
      `settle_routing:${tickets[0]!.id}`,
    ]);
  }

  it('email: the second copy rolls back with its ticket', async () => {
    const group = await staffedGroup();
    await channel({
      type: 'email',
      name: 'Support mail',
      defaultGroupId: group.id,
      routingMode: 'category',
    });
    await resolveContact({ channel: 'email', identifier: 'amira@customer.example' });

    const { second } = await race(() => ingestMail(mail()));

    expect(sqlState(second)).toBe('23505');
    await expectOneOfEach();
  });

  it('a Meta direct message: the second copy rolls back with its ticket', async () => {
    const group = await staffedGroup();
    await channel({
      type: 'facebook',
      name: 'Facebook',
      defaultGroupId: group.id,
      routingMode: 'category',
    });
    await resolveContact({ channel: 'facebook', identifier: PSID });

    const { second } = await race(() => ingestMetaMessage(dm()));

    expect(sqlState(second)).toBe('23505');
    await expectOneOfEach();
  });

  it('a Meta comment: the second copy’s ticket is refused by the thread’s key', async () => {
    const group = await staffedGroup();
    await channel({
      type: 'facebook_comment',
      name: 'Facebook comments',
      defaultGroupId: group.id,
      routingMode: 'category',
    });
    await resolveContact({ channel: 'facebook', identifier: '1122334455' });

    const { second } = await race(() => ingestMetaComment(comment()));

    expect(sqlState(second)).toBe('23505');
    await expectOneOfEach();
  });

  // The thread's lock serialises the two, so the second continues the first's
  // ticket rather than opening one, and fails on the message alone.
  it('WhatsApp: the second copy waits for the first, and opens nothing', async () => {
    const group = await staffedGroup();
    await channel({
      type: 'whatsapp',
      name: 'WhatsApp Support',
      config: { phoneNumberId: SUPPORT_NUMBER },
      defaultGroupId: group.id,
      routingMode: 'category',
    });
    await resolveContact({ channel: 'whatsapp', identifier: CUSTOMER });

    const { second } = await race(() => ingestWhatsAppMessage(whatsapp()));

    expect(sqlState(second)).toBe('23505');
    await expectOneOfEach();
  });
});
