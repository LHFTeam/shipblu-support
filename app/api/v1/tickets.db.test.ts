import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  apiTickets,
  attachments,
  channels,
  contactIdentities,
  contactShippingAccounts,
  conversationEvents,
  conversations,
  conversationShipments,
  jobs,
  messages,
  routingDecisions,
  shipments,
  ticketStatuses,
} from '@/db/schema';
import { decodeCursor, encodeCursor } from '@/lib/api/cursor';
import {
  Config,
  ErrorBody,
  MessagesPage,
  ReadResult,
  SendResult,
  Session,
  TicketEnvelope,
  TicketsPage,
} from '@/lib/api/schemas';
import { lookupSession } from '@/lib/api/sessions';
import {
  afterStatement,
  backStatement,
  customerWrote,
  listStatement,
  markStatement,
} from '@/lib/api/tickets';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { mergeContacts } from '@/lib/contacts/merge';
import { resetEnvCache } from '@/lib/env';
import { isUuid } from '@/lib/http/uuid';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { storeAgentReply } from '@/lib/tickets/agent-reply';
import { resolveContact } from '@/lib/tickets/contacts';
import { getConversation } from '@/lib/tickets/conversation';
import { afterMessageStored } from '@/lib/tickets/lifecycle';
import { deliveryOf } from '@/lib/tickets/thread';
import { GET as getConfig } from './config/route';
import { POST as postRevoke } from './sessions/revoke/route';
import { POST as postSession } from './sessions/route';
import { GET as getMessages, POST as postMessage } from './tickets/[id]/messages/route';
import { POST as postRead } from './tickets/[id]/read/route';
import { GET as getTicket } from './tickets/[id]/route';
import { GET as getList, POST as postTicket } from './tickets/route';

/**
 * The myBlu app's tickets against Postgres (`plans/myblu-ticket-api.md`,
 * stages 4 and 5): opening one, writing on one, reading them back, listing
 * them and marking the team's replies read, through the routes as the app
 * calls them, and every way the API refuses a ticket that is not the caller's.
 *
 * Every best-effort step after a ticket's commit logs instead of throwing, so
 * a failure inside one would read as "nothing happened": a test fails on any
 * error logged that it did not ask for.
 */

withCleanDatabase();

const TOKEN = 'db-test-myblu-api-token-0123456789-abcdef';
const CLIENT = 'sdk-ts/0.1.0 app/5.4.1 ios/18.1';

/** Each test's own users, so the in-memory buckets an earlier test spent are never its own. */
let seq = 0;
let user = '';

let errors: MockInstance;
let infos: MockInstance;

beforeEach(async () => {
  seq += 1;
  user = `u_${seq}`;
  vi.stubEnv('MYBLU_API_TOKEN', TOKEN);
  resetEnvCache();
  infos = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await classifier('off');
});

afterEach(() => {
  const logged = errors.mock.calls.map((call) => String(call[0]));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(logged).toEqual([]);
});

// --- Fixtures ---------------------------------------------------------------

/** The classifier's switch, which routing starts only under (`routingStartFor`). */
async function classifier(mode: 'off' | 'apply', windowMinutes = 5): Promise<void> {
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
    values (1, ${mode}, 0.6, ${windowMinutes})
    on conflict (id) do update
      set mode = excluded.mode, routing_window_minutes = excluded.routing_window_minutes`);
  forgetCategoryAiSettings();
}

/** The `api` channel row new tickets are filed under (`apiChannel`). */
async function appRow(values: Partial<typeof channels.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({ type: 'api', name: 'myBlu app', config: {}, ...values })
    .returning({ id: channels.id });
  return row!.id;
}

let next = 0;
/** A fresh documentation address per request, so one test's address buckets are never another's. */
const address = () => `198.51.100.${(next += 1) % 250}-${next}`;

/** A phone of the test's own, so two tests never share a contact by number. */
const phoneOf = (n: number) => `+2010${String(n).padStart(8, '0')}`;

/** A session minted through the route, as myBlu's backend would mint it. */
async function minted(externalUserId = user, phone = phoneOf(seq)): Promise<string> {
  const response = await postSession(
    new Request('https://support.shipblu.com/api/v1/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': address(),
      },
      body: JSON.stringify({
        externalUserId,
        phone,
        name: 'Nour Adel',
        client: { platform: 'ios', appVersion: '5.4.0' },
      }),
    }),
  );
  expect(response.status).toBe(201);
  return Session.parse(await response.json()).token;
}

async function revoke(externalUserId: string, reason: string): Promise<void> {
  const response = await postRevoke(
    new Request('https://support.shipblu.com/api/v1/sessions/revoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': address(),
      },
      body: JSON.stringify({ externalUserId, reason }),
    }),
  );
  expect(response.status).toBe(204);
}

function clientRequest(
  path: string,
  token: string,
  {
    method = 'GET',
    body,
    key,
    headers = {},
  }: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`https://support.shipblu.com/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'ShipBlu-Client': CLIENT,
      'x-forwarded-for': address(),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(key !== undefined && { 'Idempotency-Key': key }),
      ...headers,
    },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

type CreateBody = { text: string; locale: 'ar' | 'en'; trackingNumber?: string };

function create(
  token: string,
  body: CreateBody = { text: 'Where is my parcel?', locale: 'en' },
  key: string = randomUUID(),
) {
  return postTicket(clientRequest('/tickets', token, { method: 'POST', body, key }));
}

function send(token: string, ticketId: string, text: string, key: string = randomUUID()) {
  return postMessage(
    clientRequest(`/tickets/${ticketId}/messages`, token, {
      method: 'POST',
      body: { text, locale: 'en' },
      key,
    }),
    params(ticketId),
  );
}

function ticket(token: string, ticketId: string) {
  return getTicket(clientRequest(`/tickets/${ticketId}`, token), params(ticketId));
}

function page(token: string, ticketId: string, query = '') {
  return getMessages(
    clientRequest(`/tickets/${ticketId}/messages${query}`, token),
    params(ticketId),
  );
}

async function sent(response: Response, status = 201) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return SendResult.parse(await response.json());
}

/** A ticket opened through the route, and what it answered. */
async function opened(token: string, body?: CreateBody, key?: string) {
  return sent(await create(token, body, key));
}

async function refusal(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = ErrorBody.parse(await response.json());
  expect(body.error.requestId).toBe(response.headers.get('shipblu-request-id'));
  return { status: response.status, ...body.error };
}

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function caller(token: string) {
  const session = await lookupSession(token, new Date());
  if (session.kind !== 'live') throw new Error('expected a live session');
  return session.caller;
}

let agentsMade = 0;
/** An agent of the test's own. */
async function agent(name = 'Omar'): Promise<string> {
  agentsMade += 1;
  const [row] = await db
    .insert(agents)
    .values({ name, email: `agent${agentsMade}.${seq}@shipblu.test` })
    .returning({ id: agents.id });
  return row!.id;
}

/**
 * A row from the team, written straight to the table: by default a reply as
 * a console send stores one on `api` — outbound, delivered, nothing queued —
 * and not moving the ticket's "last" columns, so a test can place it in time.
 */
async function teamRow(
  conversationId: string,
  values: Partial<typeof messages.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'outbound',
      kind: 'reply',
      bodyText: 'We have asked the courier.',
      deliveryStatus: 'delivered',
      ...values,
    })
    .returning({ id: messages.id });
  return row!.id;
}

/** `last_message_at` set from Postgres's own text, microseconds and all. */
async function stampLast(conversationId: string, text: string): Promise<void> {
  await db.execute(
    sql`update conversations set last_message_at = ${text}::timestamptz where id = ${conversationId}`,
  );
}

function list(token: string, query = '') {
  return getList(clientRequest(`/tickets${query}`, token));
}

async function listed(token: string, query = '') {
  const response = await list(token, query);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return TicketsPage.parse(await response.json());
}

const idsOf = (page: { tickets: { id: string }[] }) => page.tickets.map((t) => t.id);

function markRead(token: string, ticketId: string, upTo: unknown) {
  return postRead(
    clientRequest(`/tickets/${ticketId}/read`, token, { method: 'POST', body: { upTo } }),
    params(ticketId),
  );
}

async function marked(token: string, ticketId: string, upTo: string) {
  const response = await markRead(token, ticketId, upTo);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return ReadResult.parse(await response.json());
}

/** Every message, whole, by id: what a test compares before and after a write. */
async function everyMessage() {
  return new Map((await db.select().from(messages)).map((row) => [row.id, row]));
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

// --- Opening a ticket -------------------------------------------------------

describe('POST /tickets', () => {
  it('opens a ticket on the app row, with its message, its owner and where it came from', async () => {
    const group = await db.execute<{ id: string }>(
      sql`insert into groups (name) values ('Customer Care') returning id`,
    );
    const groupId = group[0]!.id;
    const channelId = await appRow({ defaultGroupId: groupId });
    const token = await minted();
    const key = randomUUID();

    const response = await create(
      token,
      { text: '  My parcel was left with a neighbour.\n', locale: 'en', trackingNumber: 'AB-12' },
      key,
    );
    const { ticket: answered, message } = await sent(response);
    expect(response.headers.get('idempotent-replayed')).toBeNull();

    expect(answered).toMatchObject({
      subject: 'My parcel was left with a neighbour.',
      trackingNumber: 'AB-12',
      status: 'open',
      statusLabel: null,
      canReply: true,
      unreadCount: 0,
      preview: {
        from: 'customer',
        text: 'My parcel was left with a neighbour.',
        hasAttachments: false,
      },
      survey: null,
    });
    expect(message).toMatchObject({
      from: 'customer',
      text: 'My parcel was left with a neighbour.',
      clientId: key,
      attachments: [],
    });
    // A named field list: nothing an agent's screen has rides along.
    expect(Object.keys(answered).sort()).toEqual(
      [
        'id',
        'number',
        'subject',
        'trackingNumber',
        'status',
        'statusLabel',
        'canReply',
        'createdAt',
        'lastMessageAt',
        'unreadCount',
        'preview',
        'survey',
      ].sort(),
    );

    const me = await caller(token);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, answered.id));
    expect(row).toMatchObject({
      channel: 'api',
      channelId,
      groupId,
      requesterContactId: me.contactId,
      requesterKind: null,
      assigneeAgentId: null,
      routingWindowEndsAt: null,
    });
    expect(await db.select().from(apiTickets)).toEqual([
      {
        conversationId: answered.id,
        identityId: me.identityId,
        trackingNumber: 'AB-12',
        createdAt: expect.any(Date),
      },
    ]);
    const [stored] = await messagesOf(answered.id);
    expect(stored).toMatchObject({
      id: message.id,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: me.contactId,
      bodyText: 'My parcel was left with a neighbour.',
      channelMessageId: `api:${me.identityId}:${key}`,
      deliveryStatus: 'delivered',
      meta: { locale: 'en', client: CLIENT, apiOperation: 'createTicket' },
    });
    expect(
      await db
        .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
        .from(conversationEvents)
        .where(eq(conversationEvents.type, 'opened_from_app')),
    ).toEqual([
      {
        actorLabel: 'myblu',
        data: {
          app: 'myblu',
          platform: 'ios',
          appVersion: '5.4.1',
          sdkVersion: 'sdk-ts/0.1.0',
          identityId: me.identityId,
        },
      },
    ]);
  });

  it('links a tracking number only when it is shaped like one of ours, and never to the person', async () => {
    await appRow();
    const token = await minted();
    const parcel = await opened(token, {
      text: 'Late again',
      locale: 'en',
      trackingNumber: '1755021358719',
    });
    const odd = await opened(token, {
      text: 'And this one',
      locale: 'en',
      trackingNumber: 'SB-4821',
    });

    const links = await db
      .select({
        conversationId: conversationShipments.conversationId,
        linkSource: conversationShipments.linkSource,
        trackingNumber: shipments.trackingNumber,
        recipient: shipments.recipientContactId,
      })
      .from(conversationShipments)
      .innerJoin(shipments, eq(shipments.id, conversationShipments.shipmentId));
    expect(links).toEqual([
      {
        conversationId: parcel.ticket.id,
        linkSource: 'detected',
        trackingNumber: '1755021358719',
        recipient: null,
      },
    ]);
    // Stored and returned as sent, linked to nothing, and no account written
    // off an `SB…` that reads like an SBID.
    expect(odd.ticket.trackingNumber).toBe('SB-4821');
    expect(await db.select().from(contactShippingAccounts)).toEqual([]);
    expect(
      await db
        .select({ id: shipments.id })
        .from(shipments)
        .where(eq(shipments.trackingNumber, 'SB-4821')),
    ).toEqual([]);
  });

  it('answers one key sent twice with one ticket, the second time as a replay', async () => {
    await appRow();
    const token = await minted();
    const key = randomUUID();

    const first = await opened(token, undefined, key);
    const again = await create(token, undefined, key);
    const replayed = await sent(again, 200);

    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(replayed.ticket.id).toBe(first.ticket.id);
    expect(replayed.message.id).toBe(first.message.id);
    expect(await db.select({ id: conversations.id }).from(conversations)).toHaveLength(1);
    expect(await db.select({ id: messages.id }).from(messages)).toHaveLength(1);
  });

  // A retry opens nothing, so it never spends the ten-an-hour bucket: spent
  // by every POST, the eleventh retry of one ticket was refused 429, and the
  // user's next real ticket with it, for the rest of the hour.
  it('never spends the new-ticket bucket on a replay', async () => {
    await appRow();
    const token = await minted();
    const key = randomUUID();
    const first = await opened(token, undefined, key);

    for (let retry = 0; retry < 11; retry++) {
      const again = await sent(await create(token, undefined, key), 200);
      expect(again.ticket.id).toBe(first.ticket.id);
    }
    expect((await create(token, { text: 'Another parcel', locale: 'en' })).status).toBe(201);
    expect(await db.select({ id: conversations.id }).from(conversations)).toHaveLength(2);
  });

  it('answers two creates racing on one key with the same ids, and opens one ticket', async () => {
    await appRow();
    const token = await minted();
    const key = randomUUID();

    // The first holds its transaction open, account lock and all, past its
    // last statement; the second has already found no key on the pool.
    const hold = holdNextTransaction('after');
    const first = create(token, undefined, key);
    await hold.atHold;
    const second = create(token, undefined, key);
    expect(await untilWaitingOnALock(db)).toBe(true);
    hold.release();

    const [one, two] = await Promise.all([first, second]);
    const a = SendResult.parse(await one.json());
    const b = SendResult.parse(await two.json());
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    expect(b.ticket.id).toBe(a.ticket.id);
    expect(b.message.id).toBe(a.message.id);
    expect(await db.select({ id: conversations.id }).from(conversations)).toHaveLength(1);
  });

  it('refuses a key spent on another operation or another ticket as key_reused', async () => {
    await appRow();
    const token = await minted();
    const first = await opened(token);
    const other = await opened(token, { text: 'Another parcel', locale: 'en' });
    const replyKey = randomUUID();
    expect((await send(token, first.ticket.id, 'Any news?', replyKey)).status).toBe(201);

    // The create's key on a send, the send's key on a create, and on another ticket.
    expect(
      await refusal(await send(token, first.ticket.id, 'Again', first.message.clientId!)),
    ).toMatchObject({ status: 409, code: 'key_reused' });
    expect(await refusal(await create(token, undefined, replyKey))).toMatchObject({
      status: 409,
      code: 'key_reused',
    });
    expect(await refusal(await send(token, other.ticket.id, 'News?', replyKey))).toMatchObject({
      status: 409,
      code: 'key_reused',
    });
    expect(await db.select({ id: messages.id }).from(messages)).toHaveLength(3);
  });

  it('answers a replayed create whose ticket the user can no longer read with 404, creating nothing', async () => {
    await appRow();
    const token = await minted();
    const key = randomUUID();
    const first = await opened(token, undefined, key);
    await db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(eq(conversations.id, first.ticket.id));

    expect(await refusal(await create(token, undefined, key))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(await db.select({ id: conversations.id }).from(conversations)).toHaveLength(1);
  });

  it('requires an Idempotency-Key that is a UUID, and refuses JSON it cannot take', async () => {
    await appRow();
    const token = await minted();
    const body = { text: 'Hello', locale: 'en' };

    for (const key of [undefined, 'not-a-uuid', '']) {
      const request = clientRequest('/tickets', token, { method: 'POST', body, key });
      expect(await refusal(await postTicket(request))).toMatchObject({
        status: 400,
        code: 'idempotency_key_required',
      });
    }
    expect(await refusal(await create(token, { text: '  \n ', locale: 'en' }))).toMatchObject({
      status: 400,
      code: 'empty_message',
    });
    expect(await refusal(await create(token, { text: 'Hi', locale: 'fr' as 'en' }))).toMatchObject({
      status: 400,
      code: 'invalid_request',
      field: 'locale',
    });
    expect(
      await refusal(await create(token, { text: 'Hi\u0000there', locale: 'en' })),
    ).toMatchObject({ status: 400, code: 'invalid_request', field: 'text' });
    expect(
      await refusal(await create(token, { text: 'x'.repeat(5001), locale: 'en' })),
    ).toMatchObject({ status: 400, code: 'invalid_request', field: 'text' });
    // Files are stage 7's.
    const multipart = clientRequest('/tickets', token, {
      method: 'POST',
      body: '--x\r\n',
      key: randomUUID(),
      headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
    });
    expect(await refusal(await postTicket(multipart))).toMatchObject({
      status: 400,
      code: 'invalid_request',
      field: 'Content-Type',
    });
    expect(await db.select({ id: conversations.id }).from(conversations)).toEqual([]);
  });

  it('answers 503 not_configured with no active app row, while the app’s tickets go on', async () => {
    const row = await appRow();
    const token = await minted();
    const first = await opened(token);
    await db.update(channels).set({ isActive: false }).where(eq(channels.id, row));

    expect(await refusal(await create(token))).toMatchObject({
      status: 503,
      code: 'not_configured',
    });
    expect((await ticket(token, first.ticket.id)).status).toBe(200);
    expect((await send(token, first.ticket.id, 'Still there?')).status).toBe(201);
  });

  it('refuses an eleventh open or pending ticket as too_many_open', async () => {
    await appRow();
    const token = await minted();
    const me = await caller(token);
    const open = await statusId('Open');
    const rows = await db
      .insert(conversations)
      .values(
        Array.from({ length: 10 }, () => ({
          channel: 'api' as const,
          statusId: open,
          requesterContactId: me.contactId,
        })),
      )
      .returning({ id: conversations.id });
    await db
      .insert(apiTickets)
      .values(rows.map((row) => ({ conversationId: row.id, identityId: me.identityId })));

    expect(await refusal(await create(token))).toMatchObject({
      status: 409,
      code: 'too_many_open',
    });

    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved') })
      .where(eq(conversations.id, rows[0]!.id));
    expect((await create(token)).status).toBe(201);
  });

  it('holds a ticket on a row in category mode: its window, its decision row and one settle_routing job', async () => {
    await classifier('apply');
    const channelId = await appRow({ routingMode: 'category' });
    const token = await minted();
    const before = Date.now();

    const { ticket: answered, message } = await opened(token);

    const [row] = await db
      .select({ windowEndsAt: conversations.routingWindowEndsAt })
      .from(conversations)
      .where(eq(conversations.id, answered.id));
    const decisions = await db.select().from(routingDecisions);
    expect(decisions).toEqual([
      expect.objectContaining({
        conversationId: answered.id,
        channelId,
        shadow: false,
        messageId: message.id,
        decidedAt: null,
      }),
    ]);
    const decision = decisions[0]!;
    expect(row!.windowEndsAt).toEqual(decision.windowEndsAt);
    expect(decision.startedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(decision.windowEndsAt.getTime() - decision.startedAt.getTime()).toBe(5 * 60_000);
    expect(
      await db
        .select({ payload: jobs.payload, runAt: jobs.runAt, dedupeKey: jobs.dedupeKey })
        .from(jobs)
        .where(eq(jobs.type, 'settle_routing')),
    ).toEqual([
      {
        payload: { conversationId: answered.id },
        runAt: decision.windowEndsAt,
        dedupeKey: `settle_routing:${answered.id}`,
      },
    ]);
  });

  it('starts nothing on a row left on its default group', async () => {
    await classifier('apply');
    await appRow();
    const token = await minted();
    await opened(token);
    expect(await db.select().from(routingDecisions)).toEqual([]);
    expect(
      await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, 'settle_routing')),
    ).toEqual([]);
  });
});

// --- Whose ticket it is -----------------------------------------------------

describe('a ticket that is not the caller’s', () => {
  /**
   * Every route that names a ticket answers it with the same 404, the read
   * marker given a reply on that very ticket included; and the list leaves it
   * out, its reply in no badge, and nobody's reply gains a `read_at`.
   */
  async function expectNotFound(token: string, ticketId: string) {
    const upTo = isUuid(ticketId) ? await teamRow(ticketId) : randomUUID();
    for (const response of [
      await ticket(token, ticketId),
      await page(token, ticketId),
      await send(token, ticketId, 'Let me in'),
      await markRead(token, ticketId, upTo),
    ]) {
      expect(await refusal(response)).toMatchObject({ status: 404, code: 'not_found' });
    }
    const theirs = await listed(token);
    expect(idsOf(theirs)).not.toContain(ticketId.toLowerCase());
    expect(theirs.unreadTotal).toBe(0);
    expect(
      await db.select({ id: messages.id }).from(messages).where(isNotNull(messages.readAt)),
    ).toEqual([]);
  }

  it('is 404 for another identity’s ticket, on another contact', async () => {
    await appRow();
    const mine = await opened(await minted());
    const stranger = await minted(`${user}_b`, phoneOf(seq + 5000));
    await expectNotFound(stranger, mine.ticket.id);
    // The customer's message and the reply `expectNotFound` put there.
    expect(await db.select({ id: messages.id }).from(messages)).toHaveLength(2);
  });

  // A 400 for an `upTo` that is not a reply on the ticket, answered before the
  // 404, would tell a stranger the ticket is there.
  it('is 404 on the read marker whatever upTo names, a note of that ticket included', async () => {
    await appRow();
    const mine = await opened(await minted());
    const stranger = await minted(`${user}_b`, phoneOf(seq + 5000));
    const note = await teamRow(mine.ticket.id, { kind: 'note', authorAgentId: await agent() });
    for (const upTo of [note, mine.message.id, randomUUID()]) {
      expect(await refusal(await markRead(stranger, mine.ticket.id, upTo))).toMatchObject({
        status: 404,
        code: 'not_found',
      });
    }
  });

  // Two identities on one contact — a merge, or one backend vouching a wrong
  // phone — change what an agent sees and never what another app user reads.
  it('is 404 for a second identity’s ticket on the same contact', async () => {
    await appRow();
    const first = await minted();
    const mine = await opened(first);
    const second = await minted(`${user}_b`, phoneOf(seq + 5000));
    const merged = await mergeContacts({
      survivorId: (await caller(first)).contactId,
      loserId: (await caller(second)).contactId,
      agentId: null,
    });
    expect(merged.ok).toBe(true);
    expect((await caller(second)).contactId).toBe((await caller(first)).contactId);

    await expectNotFound(second, mine.ticket.id);
    expect((await ticket(first, mine.ticket.id)).status).toBe(200);
  });

  it('is 404 for the same contact’s WhatsApp ticket', async () => {
    await appRow();
    const phone = phoneOf(seq);
    const { contactId } = await resolveContact({ channel: 'whatsapp', identifier: phone.slice(1) });
    const [chat] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        statusId: await statusId('Open'),
        requesterContactId: contactId,
      })
      .returning({ id: conversations.id });
    const token = await minted(user, phone);
    expect((await caller(token)).contactId).toBe(contactId);

    await expectNotFound(token, chat!.id);
  });

  it('is 404 for a ticket merged away, deleted or marked spam', async () => {
    await appRow();
    const token = await minted();
    for (const change of [
      async (id: string, other: string) =>
        db.update(conversations).set({ mergedIntoId: other }).where(eq(conversations.id, id)),
      async (id: string) =>
        db.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, id)),
      async (id: string) =>
        db.update(conversations).set({ isSpam: true }).where(eq(conversations.id, id)),
    ]) {
      const gone = await opened(token);
      const survivor = await opened(token, { text: 'Another', locale: 'en' });
      await change(gone.ticket.id, survivor.ticket.id);
      await expectNotFound(token, gone.ticket.id);
    }
  });

  it('is the same 404, before any query about it, for an id that is not a UUID', async () => {
    await appRow();
    const token = await minted();
    await expectNotFound(token, 'not-a-ticket');
  });
});

// --- Reading ----------------------------------------------------------------

describe('reading a thread', () => {
  it('returns replies only — never a note, a system row, a forward or a reaction — and counts the team’s unread', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const omar = await agent();
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000);
    await db.insert(messages).values([
      {
        conversationId: opening.id,
        direction: 'outbound',
        kind: 'note',
        authorAgentId: omar,
        bodyText: 'Private: courier blames the address',
        createdAt: at(1),
      },
      {
        conversationId: opening.id,
        direction: 'outbound',
        kind: 'system',
        bodyText: 'SLA breached',
        createdAt: at(2),
      },
      {
        conversationId: opening.id,
        direction: 'inbound',
        kind: 'forward',
        bodyText: 'Fwd: somebody else’s thread',
        createdAt: at(3),
      },
      {
        conversationId: opening.id,
        direction: 'outbound',
        kind: 'reply',
        authorAgentId: omar,
        bodyText: 'We have asked the courier.',
        bodyHtml: '<p>We have asked the courier.</p>',
        toAddresses: ['someone@example.com'],
        createdAt: at(4),
      },
      {
        conversationId: opening.id,
        direction: 'outbound',
        kind: 'reply',
        bodyText: 'We are closed until 9:00.',
        createdAt: at(5),
      },
      {
        conversationId: opening.id,
        direction: 'inbound',
        kind: 'reply',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: at(6),
      },
    ]);

    const response = await page(token, opening.id);
    expect(response.status).toBe(200);
    const body = MessagesPage.parse(await response.json());
    expect(body.messages.map(({ from, text }) => ({ from, text }))).toEqual([
      { from: 'customer', text: 'Where is my parcel?' },
      { from: 'agent', text: 'We have asked the courier.' },
      { from: 'system', text: 'We are closed until 9:00.' },
    ]);
    expect(body.messages.map((message) => message.clientId)).toEqual([
      expect.any(String),
      null,
      null,
    ]);
    expect(JSON.stringify(body)).not.toContain('Private');
    expect(JSON.stringify(body)).not.toContain('someone@example.com');
    expect(body.ticket).toMatchObject({
      unreadCount: 2,
      preview: { from: 'system', text: 'We are closed until 9:00.' },
    });
    expect(body.unreadTotal).toBe(2);
    expect(body.pollAfterSeconds).toBe(5);
    expect(body.olderCursor).toBeNull();
  });

  it('answers a message sent as files alone with text "" and its ticket with subject null', async () => {
    await appRow();
    const token = await minted();
    // What stage 7 stores for a photo sent with no words: the stand-in the
    // widget writes, the files it rebuilds it from, and the file itself.
    const { ticket: opening, message } = await opened(token);
    await db
      .update(conversations)
      .set({ subject: '[image]' })
      .where(eq(conversations.id, opening.id));
    await db
      .update(messages)
      .set({
        bodyText: '[image]',
        meta: { locale: 'ar', webchatFiles: [{ kind: 'image', filename: 'IMG_0412.jpg' }] },
      })
      .where(eq(messages.id, message.id));
    const [file] = await db
      .insert(attachments)
      .values({
        messageId: message.id,
        storagePath: `conversations/${opening.id}/${message.id}-0/file.jpg`,
        filename: 'IMG_0412.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2048,
      })
      .returning({ id: attachments.id });

    const body = MessagesPage.parse(await (await page(token, opening.id)).json());
    expect(body.messages).toEqual([
      expect.objectContaining({
        text: '',
        attachments: [
          { id: file!.id, filename: 'IMG_0412.jpg', contentType: 'image/jpeg', sizeBytes: 2048 },
        ],
      }),
    ]);
    expect(body.ticket).toMatchObject({
      subject: null,
      preview: { from: 'customer', text: '', hasAttachments: true },
    });
    expect(
      TicketEnvelope.parse(await (await ticket(token, opening.id)).json()).ticket.subject,
    ).toBeNull();
  });

  it('pages back from the newest page with before, and says where the thread starts', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    for (const text of ['two', 'three', 'four']) {
      expect((await send(token, opening.id, text)).status).toBe(201);
    }

    const newest = MessagesPage.parse(await (await page(token, opening.id, '?limit=2')).json());
    expect(newest.messages.map((message) => message.text)).toEqual(['three', 'four']);
    expect(newest.olderCursor).not.toBeNull();

    const older = MessagesPage.parse(
      await (await page(token, opening.id, `?limit=2&before=${newest.olderCursor}`)).json(),
    );
    expect(older.messages.map((message) => message.text)).toEqual(['Where is my parcel?', 'two']);
    expect(older.olderCursor).toBeNull();
  });

  it('polls with after: the cursor comes back unchanged when nothing is new, and moves when something is', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const first = MessagesPage.parse(await (await page(token, opening.id)).json());

    const idle = MessagesPage.parse(
      await (await page(token, opening.id, `?after=${first.newerCursor}`)).json(),
    );
    expect(idle.newerCursor).toBe(first.newerCursor);

    await send(token, opening.id, 'Any news?');
    const moved = MessagesPage.parse(
      await (await page(token, opening.id, `?after=${first.newerCursor}`)).json(),
    );
    expect(moved.messages.map((message) => message.text)).toContain('Any news?');
    expect(moved.newerCursor).not.toBe(first.newerCursor);
    // The text Postgres printed, microseconds kept.
    expect(decodeCursor('messages', moved.newerCursor)?.time).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
    );
  });

  // `created_at` is when a request took its `now`, not when it committed: a
  // message stamped before the cursor can land after the page that minted it.
  it('returns with after a row stamped earlier and committed later', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening, message } = await opened(token);
    const first = MessagesPage.parse(await (await page(token, opening.id)).json());
    expect(first.messages.map((m) => m.id)).toEqual([message.id]);

    const [opening_] = await messagesOf(opening.id);
    const [late] = await db
      .insert(messages)
      .values({
        conversationId: opening.id,
        direction: 'outbound',
        kind: 'reply',
        bodyText: 'Stamped before, committed after',
        createdAt: new Date(opening_!.createdAt.getTime() - 2_000),
      })
      .returning({ id: messages.id });

    const polled = MessagesPage.parse(
      await (await page(token, opening.id, `?after=${first.newerCursor}`)).json(),
    );
    expect(polled.messages.map((m) => m.id)).toContain(late!.id);
    // Nothing after the cursor itself: it stays where it was.
    expect(polled.newerCursor).toBe(first.newerCursor);
  });

  // Filled by rows at or before the cursor, a full page whose cursor did not
  // move would tell the client to ask again at once, for the same rows, for good.
  it('never fills a page with re-read rows alone', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const [only] = await messagesOf(opening.id);
    await db.insert(messages).values(
      [1, 2, 3].map((n) => ({
        conversationId: opening.id,
        direction: 'outbound' as const,
        kind: 'reply' as const,
        bodyText: `late ${n}`,
        createdAt: new Date(only!.createdAt.getTime() - n * 100),
      })),
    );
    const cursor = encodeCursor('messages', {
      time: (
        await db.execute<{ t: string }>(
          sql`select created_at::text as t from messages where id = ${only!.id}`,
        )
      )[0]!.t,
      id: only!.id,
    });

    const polled = MessagesPage.parse(
      await (await page(token, opening.id, `?limit=2&after=${cursor}`)).json(),
    );
    expect(polled.messages.length).toBeLessThan(2);
    expect(polled.newerCursor).toBe(cursor);
  });

  it('refuses a cursor this server did not mint, and both cursors at once', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const first = MessagesPage.parse(await (await page(token, opening.id)).json());

    // The last two are in this server's spelling and never signed: the second
    // names this ticket's own opening row, read from wherever it says until
    // the cursor carried a signature.
    const [opening_] = await db.execute<{ t: string; id: string }>(
      sql`select created_at::text as t, id from messages where conversation_id = ${opening.id}`,
    );
    for (const query of [
      '?after=bm90LWEtY3Vyc29y',
      '?before=MjAyNi0wMi0zMCAwOTo0MTowNyswMHx4',
      '?after=a=b',
      `?after=${Buffer.from('2026-01-01 00:00:00+00|11111111-1111-4111-8111-111111111111').toString('base64url')}`,
      `?before=${Buffer.from(`${opening_!.t}|${opening_!.id}`).toString('base64url')}`,
    ]) {
      expect(await refusal(await page(token, opening.id, query))).toMatchObject({
        status: 400,
        code: 'invalid_cursor',
      });
    }

    // The list's cursors, signed as this server signs them but for the list:
    // one the list answered, and one naming this ticket's own opening row,
    // which a thread would read a page from if the purpose did not differ.
    await opened(token, { text: 'A second parcel', locale: 'en' });
    const listCursor = (await listed(token, '?limit=1')).olderCursor;
    expect(listCursor).not.toBeNull();
    const ownRowAsList = encodeCursor('tickets', { time: opening_!.t, id: opening_!.id });
    for (const cursor of [listCursor!, ownRowAsList]) {
      for (const query of [`?after=${cursor}`, `?before=${cursor}`]) {
        expect(await refusal(await page(token, opening.id, query))).toMatchObject({
          status: 400,
          code: 'invalid_cursor',
        });
      }
    }

    const both = await refusal(
      await page(token, opening.id, `?after=${first.newerCursor}&before=${first.newerCursor}`),
    );
    expect(both).toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'The query: `after` and `before` cannot be sent together.',
    });
    expect(both.field).toBeUndefined();
    expect(await refusal(await page(token, opening.id, '?limit=101'))).toMatchObject({
      status: 400,
      code: 'invalid_request',
      field: 'limit',
    });
  });

  it('binds no bare Date in any statement it builds', async () => {
    await appRow();
    const token = await minted();
    const me = await caller(token);
    const cursor = { time: '2026-11-12 09:41:07.004213+00', id: randomUUID() };
    const text = encodeCursor('messages', cursor);
    const statements = [
      backStatement(me, randomUUID(), { kind: 'newest', limit: 30 }).toSQL(),
      backStatement(me, randomUUID(), { kind: 'before', cursor, text, limit: 30 }).toSQL(),
      afterStatement(me, randomUUID(), { kind: 'after', cursor, text, limit: 30 }).toSQL(),
      db
        .update(conversations)
        .set(customerWrote(new Date()))
        .where(eq(conversations.id, randomUUID()))
        .toSQL(),
      listStatement(me, { cursor: null, limit: 30, trackingNumber: null }).toSQL(),
      listStatement(me, { cursor, limit: 30, trackingNumber: 'AB-12' }).toSQL(),
      markStatement(db, me, randomUUID(), cursor).toSQL(),
    ];
    for (const statement of statements) {
      expect(statement.params.filter((param) => param instanceof Date)).toEqual([]);
    }
  });
});

// --- Writing on a ticket ----------------------------------------------------

describe('POST /tickets/{id}/messages', () => {
  it('adds the user’s message, and a retry under its key is one message', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const key = randomUUID();

    const first = await sent(await send(token, opening.id, 'Any news?', key));
    const again = await send(token, opening.id, 'Any news?', key);
    const replayed = await sent(again, 200);

    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(replayed.message.id).toBe(first.message.id);
    expect(first.message).toMatchObject({ from: 'customer', text: 'Any news?', clientId: key });
    expect(await messagesOf(opening.id)).toHaveLength(2);
    const [, stored] = await messagesOf(opening.id);
    expect(stored!.meta).toEqual({ locale: 'en', client: CLIENT, apiOperation: 'sendMessage' });
  });

  // The contract's `format: uuid` takes either case, and a client holding ids
  // as a native UUID type prints them upper-case (Swift's `uuidString`). Which
  // ticket a key was spent on is compared in code, so the route lower-cases
  // the path's id first, or the retry met the row's id as another ticket's.
  it('takes a ticket id in upper case, and replays a retry sent on it', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const upper = opening.id.toUpperCase();
    const key = randomUUID();

    const first = await sent(await send(token, upper, 'Any news?', key));
    const again = await send(token, upper, 'Any news?', key);
    const replayed = await sent(again, 200);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(replayed.message.id).toBe(first.message.id);
    expect(first.ticket.id).toBe(opening.id);
    expect(await messagesOf(opening.id)).toHaveLength(2);

    const read = TicketEnvelope.parse(await (await ticket(token, upper)).json());
    expect(read.ticket.id).toBe(opening.id);
    const thread = MessagesPage.parse(await (await page(token, upper)).json());
    expect(thread.messages.map((m) => m.id)).toContain(first.message.id);
  });

  // The unique index is the backstop: the second waits on the ticket's lock,
  // meets the first's message there, rolls back and answers what it stored.
  it('answers two sends racing on one key with one message', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const key = randomUUID();

    const hold = holdNextTransaction('after');
    const first = send(token, opening.id, 'Hello?', key);
    await hold.atHold;
    const second = send(token, opening.id, 'Hello?', key);
    expect(await untilWaitingOnALock(db)).toBe(true);
    hold.release();

    const [one, two] = await Promise.all([first, second]);
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    const a = SendResult.parse(await one.json());
    const b = SendResult.parse(await two.json());
    expect(b.message.id).toBe(a.message.id);
    expect(await messagesOf(opening.id)).toHaveLength(2);
  });

  it('reopens a resolved ticket', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved'), resolvedAt: new Date() })
      .where(eq(conversations.id, opening.id));

    const { ticket: after } = await sent(await send(token, opening.id, 'It never came.'));

    expect(after).toMatchObject({ status: 'open', canReply: true });
    expect(
      await db
        .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
        .from(conversationEvents)
        .where(
          and(
            eq(conversationEvents.conversationId, opening.id),
            eq(conversationEvents.type, 'reopened'),
          ),
        ),
    ).toEqual([{ actorLabel: 'myblu', data: { reason: 'customer_replied', resolvedBy: null } }]);
  });

  it('refuses a closed ticket with 409 ticket_closed, writing nothing', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    await db
      .update(conversations)
      .set({ statusId: await statusId('Closed') })
      .where(eq(conversations.id, opening.id));

    expect(await refusal(await send(token, opening.id, 'Hello?'))).toMatchObject({
      status: 409,
      code: 'ticket_closed',
    });
    expect(await messagesOf(opening.id)).toHaveLength(1);
    const read = TicketEnvelope.parse(await (await ticket(token, opening.id)).json());
    expect(read.ticket).toMatchObject({ status: 'closed', canReply: false });
  });
});

// --- A contact merge --------------------------------------------------------

/**
 * The gate reads the session's contact before the write's transaction; a merge
 * of that contact into another committed in between re-points the identity,
 * moves the contact's tickets and stamps it deleted. A write under the gate's
 * contact landed on the tombstone — a create answered 201 and then 404 for
 * good — so each write reads the contact through the identity, and holds it,
 * inside its transaction (`holdRequester`).
 */
describe('a contact merge between the gate and the write', () => {
  async function survivorContact(): Promise<string> {
    const { contactId } = await resolveContact({
      channel: 'email',
      identifier: `nour${seq}@example.test`,
    });
    return contactId;
  }

  async function filedUnder(conversationId: string) {
    const [row] = await db
      .select({ requester: conversations.requesterContactId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const authors = (await messagesOf(conversationId)).map((m) => m.authorContactId);
    return { requester: row!.requester, authors };
  }

  it('files a create under the survivor of a merge committed after its gate', async () => {
    await appRow();
    const token = await minted();
    const before = await caller(token);
    const survivor = await survivorContact();

    // Begun and holding nothing: the gate, the key and the routing plan are read.
    const hold = holdNextTransaction('before');
    const creating = create(token);
    await hold.atHold;
    const merged = await mergeContacts({
      survivorId: survivor,
      loserId: before.contactId,
      agentId: null,
    });
    expect(merged.ok).toBe(true);
    hold.release();

    const { ticket: opening } = await sent(await creating);
    expect(await filedUnder(opening.id)).toEqual({ requester: survivor, authors: [survivor] });
    expect((await ticket(token, opening.id)).status).toBe(200);
  });

  it('waits out a merge in flight and files the create under its survivor', async () => {
    await appRow();
    const token = await minted();
    const before = await caller(token);
    const survivor = await survivorContact();

    // The merge holds both contacts FOR UPDATE, uncommitted; the create has
    // read the identity's old contact and waits to hold it.
    const hold = holdNextTransaction('after');
    const merging = mergeContacts({
      survivorId: survivor,
      loserId: before.contactId,
      agentId: null,
    });
    await hold.atHold;
    const creating = create(token);
    // Released before it is asserted, so a create that never waits cannot
    // leave the merge holding both contacts for every test after this one.
    const waited = await untilWaitingOnALock(db, { rowLockIn: '^\\s*select\\M' });
    hold.release();
    expect(waited).toBe(true);
    expect((await merging).ok).toBe(true);

    const { ticket: opening } = await sent(await creating);
    expect(await filedUnder(opening.id)).toEqual({ requester: survivor, authors: [survivor] });
    expect((await ticket(token, opening.id)).status).toBe(200);
  });

  it('takes a send on the user’s ticket after a merge moved it', async () => {
    await appRow();
    const token = await minted();
    const before = await caller(token);
    const { ticket: opening } = await opened(token);
    const survivor = await survivorContact();

    const hold = holdNextTransaction('before');
    const sending = send(token, opening.id, 'Any news?');
    await hold.atHold;
    const merged = await mergeContacts({
      survivorId: survivor,
      loserId: before.contactId,
      agentId: null,
    });
    expect(merged.ok).toBe(true);
    hold.release();

    expect((await sending).status).toBe(201);
    expect(await filedUnder(opening.id)).toEqual({
      requester: survivor,
      authors: [survivor, survivor],
    });
  });
});

// --- The console ------------------------------------------------------------

describe('the ticket in the console', () => {
  it('reads the header line off opened_from_app, and nothing off a ticket the app did not open', async () => {
    await appRow();
    const [row] = await db
      .insert(agents)
      .values({ name: 'Omar', email: `omar.console${seq}@shipblu.test`, role: 'admin' })
      .returning();
    const admin = {
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
    const { ticket: opening } = await opened(await minted());
    const [mail] = await db
      .insert(conversations)
      .values({
        channel: 'email',
        statusId: await statusId('Open'),
        requesterContactId: (await caller(await minted(`${user}_m`, phoneOf(seq + 7000))))
          .contactId,
      })
      .returning({ number: conversations.number });

    expect((await getConversation(admin, opening.number))?.openedFromApp).toBe('iOS 5.4.1');
    expect((await getConversation(admin, mail!.number))?.openedFromApp).toBeNull();
  });
});

// --- Leaving the app --------------------------------------------------------

describe('a revoke', () => {
  it('with account_deleted takes the user’s tickets out of the app and leaves them on the contact', async () => {
    await appRow();
    const token = await minted();
    const me = await caller(token);
    const { ticket: opening } = await opened(token);

    await revoke(user, 'account_deleted');
    const again = await minted();

    expect(await refusal(await ticket(again, opening.id))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(await db.select().from(apiTickets)).toEqual([]);
    const [kept] = await db
      .select({ requester: conversations.requesterContactId, deletedAt: conversations.deletedAt })
      .from(conversations)
      .where(eq(conversations.id, opening.id));
    expect(kept).toEqual({ requester: me.contactId, deletedAt: null });
    expect(await messagesOf(opening.id)).toHaveLength(1);
    // The identity itself stays, as every channel's does.
    expect(
      await db
        .select({ id: contactIdentities.id })
        .from(contactIdentities)
        .where(eq(contactIdentities.id, me.identityId)),
    ).toHaveLength(1);
  });

  it('with signed_out ends the sessions and leaves the tickets in the app', async () => {
    await appRow();
    const { ticket: opening } = await opened(await minted());

    await revoke(user, 'signed_out');
    expect((await ticket(await minted(), opening.id)).status).toBe(200);
  });

  it('refuses a create whose session was revoked while it waited for the account', async () => {
    await appRow();
    const token = await minted();
    const me = await caller(token);

    // The revoke holds the account's lock; the create's gate has already
    // found the session live, and waits behind it.
    const hold = holdNextTransaction('after');
    const revoking = revoke(user, 'account_deleted');
    await hold.atHold;
    const creating = create(token);
    expect(await untilWaitingOnALock(db)).toBe(true);
    hold.release();
    await revoking;

    expect(await refusal(await creating)).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(
      await db.select().from(apiTickets).where(eq(apiTickets.identityId, me.identityId)),
    ).toEqual([]);
    expect(await db.select({ id: conversations.id }).from(conversations)).toEqual([]);
  });
});

// --- The list ---------------------------------------------------------------

describe('GET /tickets', () => {
  it('lists the caller’s tickets and nobody else’s, and counts only their replies', async () => {
    await appRow();
    const phone = phoneOf(seq);
    // The number's WhatsApp history, which the mint joins the account to.
    const { contactId } = await resolveContact({ channel: 'whatsapp', identifier: phone.slice(1) });
    const [chat] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        statusId: await statusId('Open'),
        requesterContactId: contactId,
      })
      .returning({ id: conversations.id });
    const token = await minted(user, phone);
    const me = await caller(token);
    expect(me.contactId).toBe(contactId);

    const first = await opened(token);
    const second = await opened(token, { text: 'Another parcel', locale: 'en' });
    // Three of the caller's own the team took out of the queue.
    const away = await opened(token, { text: 'Merged away', locale: 'en' });
    const deleted = await opened(token, { text: 'Deleted', locale: 'en' });
    const spam = await opened(token, { text: 'Spam', locale: 'en' });
    await db
      .update(conversations)
      .set({ mergedIntoId: second.ticket.id })
      .where(eq(conversations.id, away.ticket.id));
    await db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(eq(conversations.id, deleted.ticket.id));
    await db
      .update(conversations)
      .set({ isSpam: true })
      .where(eq(conversations.id, spam.ticket.id));

    // Another identity on another contact.
    const stranger = await minted(`${user}_b`, phoneOf(seq + 5000));
    const strangers = await opened(stranger);
    // A second identity whose contact the team merged into the caller's.
    const twin = await minted(`${user}_c`, phoneOf(seq + 6000));
    const twins = await opened(twin);
    const merged = await mergeContacts({
      survivorId: me.contactId,
      loserId: (await caller(twin)).contactId,
      agentId: null,
    });
    expect(merged.ok).toBe(true);

    for (const id of [
      chat!.id,
      away.ticket.id,
      deleted.ticket.id,
      spam.ticket.id,
      strangers.ticket.id,
      twins.ticket.id,
      first.ticket.id,
    ]) {
      await teamRow(id);
    }

    const answer = await listed(token);
    expect(idsOf(answer).sort()).toEqual([first.ticket.id, second.ticket.id].sort());
    expect(answer.unreadTotal).toBe(1);
    const theirs = await listed(twin);
    expect(idsOf(theirs)).toEqual([twins.ticket.id]);
    expect(theirs.unreadTotal).toBe(1);
  });

  // Three tickets stamped to the microsecond alike, one 500 µs after them:
  // sub-millisecond, so a cursor rounded through a JS `Date` reads the newer
  // one's instant as before the three and skips them.
  it('pages through a tie on lastMessageAt one ticket at a time, each once, by id', async () => {
    await appRow();
    const token = await minted();
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      ids.push((await opened(token, { text: `Parcel ${n}`, locale: 'en' })).ticket.id);
    }
    const [newer, ...tied] = ids;
    for (const id of tied) await stampLast(id, '2026-11-12 09:41:07.004213+00');
    await stampLast(newer!, '2026-11-12 09:41:07.004713+00');

    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const query: string = before === null ? '?limit=1' : `?limit=1&before=${before}`;
      const answer = await listed(token, query);
      seen.push(...idsOf(answer));
      before = answer.olderCursor;
      pages += 1;
    } while (before !== null && pages < 10);

    // A uuid's lower-case text sorts as Postgres compares its bytes.
    expect(seen).toEqual([newer, ...[...tied].sort().reverse()]);
    expect(pages).toBe(4);
  });

  it('keeps a cursor’s microseconds, so the next page starts one microsecond older', async () => {
    await appRow();
    const token = await minted();
    const older = await opened(token, { text: 'Older', locale: 'en' });
    const newer = await opened(token, { text: 'Newer', locale: 'en' });
    await stampLast(older.ticket.id, '2026-11-12 09:41:07.123456+00');
    await stampLast(newer.ticket.id, '2026-11-12 09:41:07.123457+00');

    const first = await listed(token, '?limit=1');
    expect(idsOf(first)).toEqual([newer.ticket.id]);
    expect(decodeCursor('tickets', first.olderCursor!)?.time).toMatch(/:07\.123457/);
    const next = await listed(token, `?limit=1&before=${first.olderCursor}`);
    expect(idsOf(next)).toEqual([older.ticket.id]);
    expect(next.olderCursor).toBeNull();
  });

  it('puts the ticket with the newest message first, and a note moves nothing and shows nothing', async () => {
    await appRow();
    const token = await minted();
    const a = await opened(token, { text: 'First parcel', locale: 'en' });
    const b = await opened(token, { text: 'Second parcel', locale: 'en' });
    expect(idsOf(await listed(token))).toEqual([b.ticket.id, a.ticket.id]);

    // The team answers the older one, through the console's own path.
    await storeAgentReply(a.ticket.id, 'api', {
      authorAgentId: await agent(),
      bodyText: 'We have asked the courier.',
      deliveryStatus: 'delivered',
    });
    const answered = await listed(token);
    expect(idsOf(answered)).toEqual([a.ticket.id, b.ticket.id]);

    // A note on the ticket now second, as the console writes one.
    const [note] = await db
      .insert(messages)
      .values({
        conversationId: b.ticket.id,
        direction: 'outbound',
        kind: 'note',
        authorAgentId: await agent('Mona'),
        bodyText: 'Private: courier blames the address',
        deliveryStatus: 'delivered',
      })
      .returning({ id: messages.id });
    await afterMessageStored({
      conversationId: b.ticket.id,
      messageId: note!.id,
      bodyText: 'Private: courier blames the address',
      kind: 'note',
      direction: 'outbound',
    });
    const noted = await listed(token);
    expect(noted.tickets).toEqual(answered.tickets);
    expect(JSON.stringify(noted)).not.toContain('Private');
  });

  // Scoped by the identity, never by the token or the session row.
  it('lists the same tickets and badge to a fresh session for the same user, and none after account_deleted', async () => {
    await appRow();
    const token = await minted();
    const a = await opened(token);
    await opened(token, { text: 'Another parcel', locale: 'en' });
    await teamRow(a.ticket.id);
    const first = await listed(token);
    expect(first.unreadTotal).toBe(1);

    const again = await listed(await minted());
    expect(idsOf(again)).toEqual(idsOf(first));
    expect(again.unreadTotal).toBe(1);

    await revoke(user, 'signed_out');
    expect(await refusal(await list(token))).toMatchObject({ status: 401 });
    const back = await listed(await minted());
    expect(idsOf(back)).toEqual(idsOf(first));
    expect(back.unreadTotal).toBe(1);

    await revoke(user, 'account_deleted');
    expect(await listed(await minted())).toMatchObject({
      tickets: [],
      olderCursor: null,
      unreadTotal: 0,
    });
  });

  it('filters on the tracking number the ticket was opened with, exactly, and keeps the badge whole', async () => {
    await appRow();
    const token = await minted();
    const ab1 = await opened(token, { text: 'Late', locale: 'en', trackingNumber: 'AB-12' });
    const cd = await opened(token, { text: 'Damaged', locale: 'en', trackingNumber: 'CD-34' });
    const ab2 = await opened(token, { text: 'Still late', locale: 'en', trackingNumber: 'AB-12' });
    const bare = await opened(token, { text: 'No number', locale: 'en' });
    await teamRow(cd.ticket.id);
    // A number only the team linked, in `conversation_shipments`: never the claim.
    const [parcel] = await db
      .insert(shipments)
      .values({ trackingNumber: 'EF-56' })
      .returning({ id: shipments.id });
    await db
      .insert(conversationShipments)
      .values({ conversationId: bare.ticket.id, shipmentId: parcel!.id, linkSource: 'manual' });

    const filtered = await listed(token, '?trackingNumber=AB-12');
    expect(idsOf(filtered)).toEqual([ab2.ticket.id, ab1.ticket.id]);
    // The badge is every ticket's, CD-34's reply included.
    expect(filtered.unreadTotal).toBe(1);

    const one = await listed(token, '?trackingNumber=AB-12&limit=1');
    expect(idsOf(one)).toEqual([ab2.ticket.id]);
    const two = await listed(token, `?trackingNumber=AB-12&limit=1&before=${one.olderCursor}`);
    expect(idsOf(two)).toEqual([ab1.ticket.id]);
    expect(two.olderCursor).toBeNull();

    // No row to carry the badge: it is read on its own, still unfiltered.
    for (const number of ['ZZ-99', 'ab-12', 'EF-56']) {
      expect(await listed(token, `?trackingNumber=${number}`)).toEqual({
        tickets: [],
        olderCursor: null,
        unreadTotal: 1,
        pollAfterSeconds: 30,
      });
    }
  });

  it('answers the contract’s page: every status, each ticket as GET /tickets/{id} draws it, a badge its rows add up to', async () => {
    const row = await appRow();
    const token = await minted();
    const open = await opened(token);
    const resolved = await opened(token, { text: 'Resolved one', locale: 'en' });
    const closed = await opened(token, { text: 'Closed one', locale: 'en' });
    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved'), resolvedAt: new Date() })
      .where(eq(conversations.id, resolved.ticket.id));
    await db
      .update(conversations)
      .set({ statusId: await statusId('Closed') })
      .where(eq(conversations.id, closed.ticket.id));
    await teamRow(open.ticket.id, { authorAgentId: await agent() });
    await teamRow(open.ticket.id, { bodyText: 'We are closed until 10:00.' });
    await teamRow(resolved.ticket.id);
    // The list reads no channel row: switched off, it goes on.
    await db.update(channels).set({ isActive: false }).where(eq(channels.id, row));

    const response = await list(token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'olderCursor',
      'pollAfterSeconds',
      'tickets',
      'unreadTotal',
    ]);
    const answer = TicketsPage.parse(body);
    const config = Config.parse(await (await getConfig(clientRequest('/config', token))).json());
    expect(answer.pollAfterSeconds).toBe(30);
    expect(answer.pollAfterSeconds).toBe(config.polling.listSeconds);

    expect(answer.tickets.map(({ id, status, canReply }) => ({ id, status, canReply }))).toEqual([
      { id: closed.ticket.id, status: 'closed', canReply: false },
      { id: resolved.ticket.id, status: 'resolved', canReply: true },
      { id: open.ticket.id, status: 'open', canReply: true },
    ]);
    for (const listedTicket of answer.tickets) {
      const one = TicketEnvelope.parse(await (await ticket(token, listedTicket.id)).json());
      expect(listedTicket).toEqual(one.ticket);
    }
    expect(answer.tickets.find((t) => t.id === open.ticket.id)).toMatchObject({
      unreadCount: 2,
      preview: { from: 'system', text: 'We are closed until 10:00.' },
    });
    expect(answer.unreadTotal).toBe(3);
    expect(answer.tickets.reduce((sum, t) => sum + t.unreadCount, 0)).toBe(answer.unreadTotal);
    expect(answer.olderCursor).toBeNull();
  });

  it('refuses a cursor it did not mint, a page size out of range and a tracking number outside the contract', async () => {
    await appRow();
    const token = await minted();
    const { ticket: older } = await opened(token);
    const { ticket: newer } = await opened(token, { text: 'A second parcel', locale: 'en' });

    // The newer ticket's own `(last_message_at, id)` in this server's
    // spelling, which the list would page from to the older one: unsigned,
    // signed for a thread, and signed for the list under a secret this server
    // does not hold. And a thread's cursor as a thread answered it.
    const [row] = await db.execute<{ t: string }>(
      sql`select last_message_at::text as t from conversations where id = ${newer.id}`,
    );
    const own = { time: row!.t, id: newer.id };
    const thread = MessagesPage.parse(await (await page(token, newer.id)).json()).newerCursor;
    for (const query of [
      '?before=bm90LWEtY3Vyc29y',
      '?before=',
      '?before=a=b',
      `?before=${Buffer.from(`${own.time}|${own.id}`).toString('base64url')}`,
      `?before=${encodeCursor('messages', own)}`,
      `?before=${encodeCursor('tickets', own, 'x'.repeat(64))}`,
      `?before=${thread}`,
    ]) {
      expect(await refusal(await list(token, query))).toMatchObject({
        status: 400,
        code: 'invalid_cursor',
      });
    }
    // Signed for the list, the same row reads the page after it: the refusals
    // above are the purpose's and the signature's, not the row's.
    expect(idsOf(await listed(token, `?before=${encodeCursor('tickets', own)}`))).toEqual([
      older.id,
    ]);

    const limit = await refusal(await list(token, '?limit=101'));
    expect(limit).toMatchObject({ status: 400, code: 'invalid_request', field: 'limit' });
    expect(limit.message).not.toContain('body');
    expect(await refusal(await list(token, '?trackingNumber=AB%2012'))).toMatchObject({
      status: 400,
      code: 'invalid_request',
      field: 'trackingNumber',
    });
  });
});

// --- The read marker --------------------------------------------------------

describe('POST /tickets/{id}/read', () => {
  /** A ticket holding one of everything a thread can hold, in order, a second apart. */
  async function threadOfEverything(token: string) {
    const { ticket: opening, message } = await opened(token);
    const me = await caller(token);
    const omar = await agent();
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000);
    const r1 = await teamRow(opening.id, { authorAgentId: omar, createdAt: at(1) });
    const n1 = await teamRow(opening.id, {
      kind: 'note',
      authorAgentId: omar,
      bodyText: 'Private: courier blames the address',
      createdAt: at(2),
    });
    // The out-of-hours acknowledgement: a reply nobody wrote.
    const s1 = await teamRow(opening.id, {
      bodyText: 'We are closed until 10:00.',
      createdAt: at(3),
    });
    const system = await teamRow(opening.id, {
      kind: 'system',
      bodyText: 'SLA breached',
      createdAt: at(4),
    });
    const r2 = await teamRow(opening.id, {
      authorAgentId: omar,
      bodyText: 'The courier is on the way.',
      createdAt: at(5),
    });
    const c2 = await teamRow(opening.id, {
      direction: 'inbound',
      authorContactId: me.contactId,
      bodyText: 'Thank you',
      createdAt: at(6),
    });
    return { opening, c1: message.id, r1, n1, s1, system, r2, c2 };
  }

  it('marks the team’s replies up to upTo read, and touches nothing else', async () => {
    await appRow();
    const token = await minted();
    const t = await threadOfEverything(token);
    const other = await opened(token, { text: 'Another parcel', locale: 'en' });
    const elsewhere = await teamRow(other.ticket.id);
    const before = await everyMessage();
    const [ticketBefore] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, t.opening.id));
    const eventsBefore = await db.select({ id: conversationEvents.id }).from(conversationEvents);

    const answer = await marked(token, t.opening.id, t.s1);

    const after = await everyMessage();
    for (const id of [t.r1, t.s1]) {
      expect(after.get(id)).toMatchObject({ readAt: expect.any(Date), deliveryStatus: 'read' });
      // Nothing else on the row moved.
      expect({ ...after.get(id), readAt: null, deliveryStatus: 'delivered' }).toEqual(
        before.get(id),
      );
    }
    for (const id of [t.c1, t.n1, t.system, t.r2, t.c2, elsewhere]) {
      expect(after.get(id)).toEqual(before.get(id));
    }
    // Nothing on the ticket, and nothing on its timeline: a read is not activity.
    const [ticketAfter] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, t.opening.id));
    expect(ticketAfter).toEqual(ticketBefore);
    expect(await db.select({ id: conversationEvents.id }).from(conversationEvents)).toEqual(
      eventsBefore,
    );

    expect(answer.ticket.unreadCount).toBe(1);
    expect(answer.unreadTotal).toBe(2);
    // The list and the thread, read straight after, say what the marker said.
    const listedNow = await listed(token);
    expect(listedNow.unreadTotal).toBe(answer.unreadTotal);
    expect(listedNow.tickets.find((x) => x.id === t.opening.id)).toEqual(answer.ticket);
    const thread = MessagesPage.parse(await (await page(token, t.opening.id)).json());
    expect(thread.unreadTotal).toBe(answer.unreadTotal);
    expect(thread.ticket).toEqual(answer.ticket);
  });

  it('changes nothing marking twice or backwards, and two markers at once mark each reply once', async () => {
    await appRow();
    const token = await minted();
    const t = await threadOfEverything(token);

    const first = await marked(token, t.opening.id, t.r2);
    expect(first.ticket.unreadCount).toBe(0);
    const once = await everyMessage();
    for (const upTo of [t.r2, t.c1, t.r1]) {
      const again = await marked(token, t.opening.id, upTo);
      expect(again.ticket.unreadCount).toBe(0);
      expect(again.unreadTotal).toBe(0);
    }
    expect(await everyMessage()).toEqual(once);
    const me = await caller(token);
    const cursorOf = async (id: string) => ({
      time: (
        await db.execute<{ t: string }>(
          sql`select created_at::text as t from messages where id = ${id}`,
        )
      )[0]!.t,
      id,
    });
    expect(await markStatement(db, me, t.opening.id, await cursorOf(t.r2))).toEqual([]);

    // Two more replies, and two markers racing for them.
    const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
    const r3 = await teamRow(t.opening.id, { createdAt: later(10) });
    const r4 = await teamRow(t.opening.id, { createdAt: later(11) });
    infos.mockClear();
    const answers = await Promise.all([
      marked(token, t.opening.id, r4),
      marked(token, t.opening.id, r4),
    ]);
    expect(answers.map((a) => a.ticket.unreadCount)).toEqual([0, 0]);
    const counts = infos.mock.calls
      .map((call) => /^\[api\] read marked .* marked=(\d+) /.exec(String(call[0]))?.[1])
      .filter((count) => count !== undefined)
      .map(Number);
    expect(counts.sort()).toEqual([0, 2]);
    const rows = await everyMessage();
    for (const id of [r3, r4]) {
      expect(rows.get(id)).toMatchObject({ readAt: expect.any(Date), deliveryStatus: 'read' });
    }
  });

  it('takes the customer’s own message as upTo, and breaks a tie on the instant by id', async () => {
    await appRow();
    const token = await minted();
    const t = await threadOfEverything(token);
    const answer = await marked(token, t.opening.id, t.c2);
    expect(answer.ticket.unreadCount).toBe(0);
    const rows = await everyMessage();
    for (const id of [t.r1, t.s1, t.r2]) expect(rows.get(id)?.readAt).not.toBeNull();
    expect(rows.get(t.n1)?.readAt).toBeNull();

    // Two replies stamped to the microsecond alike: the lower id is first.
    const { ticket: tied } = await opened(token, { text: 'Tied', locale: 'en' });
    const stamp = new Date(Date.now() + 60_000);
    const pair = [
      await teamRow(tied.id, { createdAt: stamp }),
      await teamRow(tied.id, { createdAt: stamp }),
    ].sort();
    const [lower, higher] = pair as [string, string];
    expect((await marked(token, tied.id, lower)).ticket.unreadCount).toBe(1);
    const after = await everyMessage();
    expect(after.get(lower)?.readAt).not.toBeNull();
    expect(after.get(higher)?.readAt).toBeNull();

    // Ids in upper case, as a native UUID type prints them.
    expect(
      (await marked(token, tied.id.toUpperCase(), higher.toUpperCase())).ticket.unreadCount,
    ).toBe(0);
    expect((await everyMessage()).get(higher)?.readAt).not.toBeNull();
  });

  it('refuses an upTo the thread does not return, naming it, and marks nothing', async () => {
    await appRow();
    const token = await minted();
    const t = await threadOfEverything(token);
    const forward = await teamRow(t.opening.id, { direction: 'inbound', kind: 'forward' });
    const reaction = await teamRow(t.opening.id, {
      direction: 'inbound',
      bodyText: '[reacted 🙏]',
      meta: { whatsappType: 'reaction' },
    });
    const other = await opened(token, { text: 'Another parcel', locale: 'en' });
    const before = await everyMessage();

    for (const upTo of [t.n1, t.system, forward, reaction, other.message.id, randomUUID()]) {
      expect(await refusal(await markRead(token, t.opening.id, upTo))).toMatchObject({
        status: 400,
        code: 'invalid_request',
        field: 'upTo',
      });
    }
    for (const body of [{}, { upTo: 'not-a-message' }]) {
      const response = await postRead(
        clientRequest(`/tickets/${t.opening.id}/read`, token, { method: 'POST', body }),
        params(t.opening.id),
      );
      expect(await refusal(response)).toMatchObject({
        status: 400,
        code: 'invalid_request',
        field: 'upTo',
      });
    }
    expect(await everyMessage()).toEqual(before);
  });

  it('is drawn as Read in the console, never over a failure, and passes a reaction by', async () => {
    await appRow();
    const token = await minted();
    const t = await threadOfEverything(token);
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000);
    const failed = await teamRow(t.opening.id, {
      deliveryStatus: 'failed',
      deliveryError: 'contrived',
      createdAt: at(7),
    });
    // Impossible on `api`, which has no reactions: the badge and the marker
    // still answer it alike.
    const reaction = await teamRow(t.opening.id, {
      bodyText: '[reacted 👍]',
      meta: { whatsappType: 'reaction' },
      createdAt: at(8),
    });
    const last = await teamRow(t.opening.id, { createdAt: at(9) });
    expect(
      TicketEnvelope.parse(await (await ticket(token, t.opening.id)).json()).ticket.unreadCount,
    ).toBe(5);

    await marked(token, t.opening.id, last);
    const rows = await everyMessage();
    expect(rows.get(failed)).toMatchObject({ readAt: expect.any(Date), deliveryStatus: 'failed' });
    expect(rows.get(reaction)).toMatchObject({ readAt: null, deliveryStatus: 'delivered' });

    const [row] = await db
      .insert(agents)
      .values({ name: 'Admin', email: `admin.read${seq}@shipblu.test`, role: 'admin' })
      .returning();
    const detail = await getConversation(
      {
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
      },
      t.opening.number,
    );
    const drawn = (id: string) => deliveryOf(detail!.messages.find((m) => m.id === id)!);
    expect(drawn(t.r1)).toEqual({ receipt: 'read' });
    expect(drawn(failed)).toMatchObject({ error: expect.stringContaining('Not delivered') });
  });

  // The decision is read before the write: a ticket deleted, merged or marked
  // spam between the two, or never the caller's, is in the write's own WHERE.
  it('scopes its write in the statement that acts', async () => {
    await appRow();
    const token = await minted();
    const me = await caller(token);
    const stranger = await caller(await minted(`${user}_b`, phoneOf(seq + 5000)));
    const far = new Date(Date.now() + 3_600_000).toISOString();
    const everything = { time: far.replace('T', ' ').replace('Z', '+00'), id: randomUUID() };

    const { ticket: mine } = await opened(token);
    await teamRow(mine.id);
    expect(await markStatement(db, stranger, mine.id, everything)).toEqual([]);
    for (const change of [{ deletedAt: new Date() }, { isSpam: true }]) {
      const { ticket: gone } = await opened(token, { text: 'Gone', locale: 'en' });
      await teamRow(gone.id);
      await db.update(conversations).set(change).where(eq(conversations.id, gone.id));
      expect(await markStatement(db, me, gone.id, everything)).toEqual([]);
    }
    expect(
      await db.select({ id: messages.id }).from(messages).where(isNotNull(messages.readAt)),
    ).toEqual([]);
    expect(await markStatement(db, me, mine.id, everything)).toHaveLength(1);
  });

  it('spends the read bucket, never the send bucket', async () => {
    await appRow();
    const token = await minted();
    const t = await threadOfEverything(token);
    for (let i = 0; i < 20; i++) await marked(token, t.opening.id, t.r2);
    expect((await send(token, t.opening.id, 'Any news?')).status).toBe(201);
  });
});

/**
 * The marker holds the requester as the sends do (`holdRequester`): a merge of
 * the session's contact committed after the gate, or in flight, moves the
 * ticket's requester, and a marker reading the gate's contact answered `404` —
 * which the SDK meets by dropping the ticket and failing its outbox.
 */
describe('a contact merge between the gate and the read marker', () => {
  async function survivorContact(): Promise<string> {
    const { contactId } = await resolveContact({
      channel: 'email',
      identifier: `nour.read${seq}@example.test`,
    });
    return contactId;
  }

  it('marks the user’s ticket after a merge committed since its gate', async () => {
    await appRow();
    const token = await minted();
    const before = await caller(token);
    const { ticket: opening } = await opened(token);
    const reply = await teamRow(opening.id);
    const survivor = await survivorContact();

    const hold = holdNextTransaction('before');
    const marking = markRead(token, opening.id, reply);
    await hold.atHold;
    const merged = await mergeContacts({
      survivorId: survivor,
      loserId: before.contactId,
      agentId: null,
    });
    expect(merged.ok).toBe(true);
    hold.release();

    const response = await marking;
    expect(response.status).toBe(200);
    expect(ReadResult.parse(await response.json()).ticket.unreadCount).toBe(0);
    expect((await everyMessage()).get(reply)?.readAt).not.toBeNull();
  });

  it('waits out a merge in flight, then marks', async () => {
    await appRow();
    const token = await minted();
    const before = await caller(token);
    const { ticket: opening } = await opened(token);
    const reply = await teamRow(opening.id);
    const survivor = await survivorContact();

    const hold = holdNextTransaction('after');
    const merging = mergeContacts({
      survivorId: survivor,
      loserId: before.contactId,
      agentId: null,
    });
    await hold.atHold;
    const marking = markRead(token, opening.id, reply);
    const waited = await untilWaitingOnALock(db, { rowLockIn: '^\\s*select\\M' });
    hold.release();
    expect(waited).toBe(true);
    expect((await merging).ok).toBe(true);

    expect((await marking).status).toBe(200);
    expect((await everyMessage()).get(reply)?.readAt).not.toBeNull();
  });
});
