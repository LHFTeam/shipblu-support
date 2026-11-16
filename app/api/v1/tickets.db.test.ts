import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  apiTickets,
  attachments,
  automationRules,
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
import { ErrorBody, MessagesPage, SendResult, Session, TicketEnvelope } from '@/lib/api/schemas';
import { lookupSession } from '@/lib/api/sessions';
import { afterStatement, backStatement, customerWrote } from '@/lib/api/tickets';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { mergeContacts } from '@/lib/contacts/merge';
import { claimJobs } from '@/lib/queue';
import { finishApiMessage } from '@/worker/handlers/finish-api-message';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { resolveContact } from '@/lib/tickets/contacts';
import { getConversation } from '@/lib/tickets/conversation';
import { POST as postRevoke } from './sessions/revoke/route';
import { POST as postSession } from './sessions/route';
import { GET as getTicket } from './tickets/[id]/route';
import { GET as getMessages, POST as postMessage } from './tickets/[id]/messages/route';
import { POST as postTicket } from './tickets/route';

/**
 * The myBlu app's tickets against Postgres (`plans/myblu-ticket-api.md`,
 * stage 4): opening one, writing on one and reading them back, through the
 * routes as the app calls them, and every way the API refuses a ticket that is
 * not the caller's.
 *
 * Every best-effort step after a ticket's commit logs instead of throwing, so
 * a failure inside one would read as "nothing happened": a test fails on any
 * error logged that it did not ask for.
 */

/**
 * The tracking-number link, passed through but for one call a test makes fail,
 * as drizzle fails a query: the number among its parameters and in Postgres's
 * `detail`, which the log line must carry neither of.
 */
const linkFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('@/lib/shipments/links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shipments/links')>();
  return {
    ...actual,
    linkClaimedTrackingNumber: async (
      ...args: Parameters<typeof actual.linkClaimedTrackingNumber>
    ) => {
      const failure = linkFailure.next;
      linkFailure.next = null;
      if (failure) throw failure;
      return actual.linkClaimedTrackingNumber(...args);
    },
  };
});

/**
 * The queue, passed through but for one take a test makes fail: the request
 * that stored a message never taking the work it owes (`lib/api/finish.ts`).
 */
const takeFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('@/lib/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...actual,
    takeQueuedJob: async (...args: Parameters<typeof actual.takeQueuedJob>) => {
      const failure = takeFailure.next;
      takeFailure.next = null;
      if (failure) throw failure;
      return actual.takeQueuedJob(...args);
    },
  };
});

withCleanDatabase();

const TOKEN = 'db-test-myblu-api-token-0123456789-abcdef';
const CLIENT = 'sdk-ts/0.1.0 app/5.4.1 ios/18.1';

/** Each test's own users, so the in-memory buckets an earlier test spent are never its own. */
let seq = 0;
let user = '';

let errors: MockInstance;

beforeEach(async () => {
  seq += 1;
  user = `u_${seq}`;
  vi.stubEnv('MYBLU_API_TOKEN', TOKEN);
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
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
          sdk: 'sdk-ts',
          sdkVersion: '0.1.0',
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

  it('opens the ticket when the link fails, and logs the failure without the number', async () => {
    await appRow();
    const token = await minted();
    const number = '1755021358719';
    linkFailure.next = new Error(
      `Failed query: select 1 from "shipments" where "tracking_number" = $1\nparams: ${number}`,
      {
        cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          detail: `Key (tracking_number)=(${number}) already exists.`,
        }),
      },
    );

    const ticket = await opened(token, {
      text: 'Late again',
      locale: 'en',
      trackingNumber: number,
    });

    expect(ticket.ticket.trackingNumber).toBe(number);
    const lines = errors.mock.calls.map((call) =>
      call
        .map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part)))
        .join(' '),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not link a claimed tracking number');
    expect(lines[0]).toContain('23505');
    expect(lines[0]).not.toContain(number);
    errors.mockClear();
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

  // An outbox resends a refused create on every foreground. Charged for each
  // refusal, ten foregrounds with the app's row off or at the open cap ran the
  // hour out, and the first create that could open was refused 429.
  it('never spends the new-ticket bucket on a create that opens nothing', async () => {
    const token = await minted();
    for (let attempt = 0; attempt < 11; attempt++) {
      expect((await refusal(await create(token))).code).toBe('not_configured');
    }
    await appRow();
    expect((await create(token)).status).toBe(201);

    const me = await caller(token);
    const open = await statusId('Open');
    const rows = await db
      .insert(conversations)
      .values(
        Array.from({ length: 9 }, () => ({
          channel: 'api' as const,
          statusId: open,
          requesterContactId: me.contactId,
        })),
      )
      .returning({ id: conversations.id });
    await db
      .insert(apiTickets)
      .values(rows.map((row) => ({ conversationId: row.id, identityId: me.identityId })));
    // Seven more fill the minute's send bucket short of its twenty.
    for (let attempt = 0; attempt < 7; attempt++) {
      expect((await refusal(await create(token))).code).toBe('too_many_open');
    }
    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved') })
      .where(eq(conversations.channel, 'api'));
    expect((await create(token)).status).toBe(201);
  });

  it('refuses an eleventh ticket opened in the hour as rate_limited, with when to come back', async () => {
    await appRow();
    const token = await minted();
    for (let n = 0; n < 10; n++) {
      expect((await create(token, { text: `Parcel ${n}`, locale: 'en' })).status).toBe(201);
      // Resolved, so the open cap is never what refuses.
      await db
        .update(conversations)
        .set({ statusId: await statusId('Resolved') })
        .where(eq(conversations.channel, 'api'));
    }

    const refused = await create(token);
    expect(await refusal(refused)).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await db.select({ id: conversations.id }).from(conversations)).toHaveLength(10);
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

  // The cap bounds opening a ticket (`tickets.maxOpen`); a reply is a ticket
  // going on, and refusing it would cut a conversation off in the middle.
  it('lets a reply reopen a resolved ticket past the open cap', async () => {
    await appRow();
    const token = await minted();
    const me = await caller(token);
    const { ticket: opening } = await opened(token);
    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved') })
      .where(eq(conversations.id, opening.id));
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

    expect((await send(token, opening.id, 'It came back again')).status).toBe(201);
    expect((await ticket(token, opening.id)).status).toBe(200);
    const [row] = await db
      .select({ category: ticketStatuses.category })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
      .where(eq(conversations.id, opening.id));
    expect(row!.category).toBe('open');
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
  /** Every route that names a ticket answers it with the same 404. */
  async function expectNotFound(token: string, ticketId: string) {
    for (const response of [
      await ticket(token, ticketId),
      await page(token, ticketId),
      await send(token, ticketId, 'Let me in'),
    ]) {
      expect(await refusal(response)).toMatchObject({ status: 404, code: 'not_found' });
    }
  }

  it('is 404 for another identity’s ticket, on another contact', async () => {
    await appRow();
    const mine = await opened(await minted());
    const stranger = await minted(`${user}_b`, phoneOf(seq + 5000));
    await expectNotFound(stranger, mine.ticket.id);
    expect(await db.select({ id: messages.id }).from(messages)).toHaveLength(1);
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
  async function agent(): Promise<string> {
    const [row] = await db
      .insert(agents)
      .values({ name: 'Omar', email: `omar${seq}@shipblu.test` })
      .returning({ id: agents.id });
    return row!.id;
  }

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
      // The team's own reaction: a row no read returns, so one the app could
      // never mark read, and never in the badge.
      {
        conversationId: opening.id,
        direction: 'outbound',
        kind: 'reply',
        bodyText: '[reacted 👍]',
        meta: { whatsappType: 'reaction' },
        createdAt: at(7),
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
    // A poll never pages back, whatever it returned.
    expect(idle.olderCursor).toBeNull();
    expect(moved.olderCursor).toBeNull();
    // The text Postgres printed, microseconds kept.
    expect(decodeCursor(moved.newerCursor)?.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
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
    // Its first row is the overlap's, at the thread's start: a cursor taken
    // from it offered "load older" and paged back to nothing.
    expect(polled.olderCursor).toBeNull();
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
    const cursor = encodeCursor({
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
    const text = encodeCursor(cursor);
    const statements = [
      backStatement(me, randomUUID(), { kind: 'newest', limit: 30 }).toSQL(),
      backStatement(me, randomUUID(), { kind: 'before', cursor, text, limit: 30 }).toSQL(),
      afterStatement(me, randomUUID(), { kind: 'after', cursor, text, limit: 30 }).toSQL(),
      db
        .update(conversations)
        .set(customerWrote(new Date()))
        .where(eq(conversations.id, randomUUID()))
        .toSQL(),
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

  // A key is spent twice exactly when two requests race, which is when a
  // merge can have moved the contact: replayed under the gate's contact, the
  // second answered 404 for the user's own message, and the SDK dropped it.
  it('answers a retry that raced its first across a merge with what the first stored', async () => {
    await appRow();
    const token = await minted();
    const before = await caller(token);
    const { ticket: opening } = await opened(token);
    const survivor = await survivorContact();
    const key = randomUUID();

    // The retry's gate and key are read under the old contact; it then waits
    // while the merge commits and the first request stores the message.
    const hold = holdNextTransaction('before');
    const retrying = send(token, opening.id, 'Any news?', key);
    await hold.atHold;
    const merged = await mergeContacts({
      survivorId: survivor,
      loserId: before.contactId,
      agentId: null,
    });
    expect(merged.ok).toBe(true);
    const first = await sent(await send(token, opening.id, 'Any news?', key));
    hold.release();

    const retry = await retrying;
    const replayed = await sent(retry, 200);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(replayed.message.id).toBe(first.message.id);
    expect(await filedUnder(opening.id)).toEqual({
      requester: survivor,
      authors: [survivor, survivor],
    });
  });

  // Stamped before its locks, a reply that waited out a merge committed older
  // than `after`'s overlap, behind a cursor another device had polled past.
  it('stamps a reply once it holds its locks, not when it was asked', async () => {
    await appRow();
    const token = await minted();
    const before = await caller(token);
    const { ticket: opening } = await opened(token);
    const survivor = await survivorContact();

    const hold = holdNextTransaction('after');
    const merging = mergeContacts({
      survivorId: survivor,
      loserId: before.contactId,
      agentId: null,
    });
    await hold.atHold;
    const sending = send(token, opening.id, 'Still waiting');
    const waited = await untilWaitingOnALock(db, { rowLockIn: '^\\s*select\\M' });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const released = Date.now();
    hold.release();
    expect(waited).toBe(true);
    expect((await merging).ok).toBe(true);

    const { message } = await sent(await sending);
    expect(Date.parse(message.createdAt)).toBeGreaterThanOrEqual(released);
  });
});

// --- The work after a stored message ----------------------------------------

/**
 * Owed in the write's own transaction and taken by the request, so a request
 * that ends after its commit — and a retry then answered as a replay — leaves
 * the ticket its rules, its policy and its reply all the same
 * (`lib/api/finish.ts`).
 */
describe('the work after a stored message', () => {
  async function urgentOnCreate(): Promise<void> {
    await db.insert(automationRules).values({
      name: 'Every new ticket is urgent',
      trigger: 'on_create',
      conditions: {},
      actions: [{ type: 'set_priority', value: 'urgent' }],
    });
  }

  async function priorityOf(conversationId: string) {
    const [row] = await db
      .select({ priority: conversations.priority })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return row!.priority;
  }

  async function owed(messageId: string) {
    const [row] = await db
      .select({ status: jobs.status, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.dedupeKey, `finish_api_message:${messageId}`));
    return row ?? null;
  }

  it('is owed by every write and taken by its request, which runs it', async () => {
    await appRow();
    await urgentOnCreate();
    const token = await minted();
    const { ticket: opening, message } = await opened(token);

    expect(await priorityOf(opening.id)).toBe('urgent');
    expect(await owed(message.id)).toEqual({ status: 'completed', attempts: 0 });
    const reply = await sent(await send(token, opening.id, 'Any news?'));
    expect(await owed(reply.message.id)).toEqual({ status: 'completed', attempts: 0 });
  });

  it('is run by the worker when the request never took it, never by a replay, and once', async () => {
    await appRow();
    await urgentOnCreate();
    const token = await minted();
    const key = randomUUID();

    takeFailure.next = new Error('Connection terminated unexpectedly');
    const { ticket: opening, message } = await opened(token, undefined, key);
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('left to finish_api_message'),
    ]);
    errors.mockClear();
    expect(await priorityOf(opening.id)).toBe('medium');

    const replayed = await sent(await create(token, undefined, key), 200);
    expect(replayed.message.id).toBe(message.id);
    expect(await priorityOf(opening.id)).toBe('medium');
    expect(await owed(message.id)).toEqual({ status: 'pending', attempts: 0 });

    // Due a minute on; brought forward, as the minute passing would.
    await db
      .update(jobs)
      .set({ runAt: new Date() })
      .where(eq(jobs.dedupeKey, `finish_api_message:${message.id}`));
    const job = (await claimJobs(10, 'worker-test')).find(
      (claimed) => claimed.type === 'finish_api_message',
    );
    expect(job).toBeDefined();

    // A second attempt follows one that may have begun the work: never run.
    await finishApiMessage({ ...job!, attempts: 2 });
    expect(await priorityOf(opening.id)).toBe('medium');
    await finishApiMessage(job!);
    expect(await priorityOf(opening.id)).toBe('urgent');
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
    expect((await getConversation(admin, opening.number))?.releasedFromApp).toBeNull();
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

  // Nobody reads a reply on these any more (`api` has no other carrier), so
  // each says so to the agents who still have it, and an open one leaves the
  // queues, its clocks stopped, by the owner's decision on #532.
  it('marks each released ticket, resolves an open one by the system, and surveys nobody', async () => {
    await appRow();
    const token = await minted();
    const { ticket: open } = await opened(token);
    const { ticket: done } = await opened(token);
    const resolvedAt = new Date('2026-11-01T10:00:00Z');
    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved'), resolvedAt })
      .where(eq(conversations.id, done.id));

    await revoke(user, 'number_released');

    const events = await db
      .select({
        conversationId: conversationEvents.conversationId,
        type: conversationEvents.type,
        actorLabel: conversationEvents.actorLabel,
        actorAgentId: conversationEvents.actorAgentId,
        data: conversationEvents.data,
      })
      .from(conversationEvents)
      .where(inArray(conversationEvents.type, ['released_from_app', 'status_changed']))
      .orderBy(asc(conversationEvents.type));
    expect(events.filter((event) => event.conversationId === open.id)).toEqual([
      {
        conversationId: open.id,
        type: 'released_from_app',
        actorLabel: 'myblu',
        actorAgentId: null,
        data: { reason: 'number_released' },
      },
      {
        conversationId: open.id,
        type: 'status_changed',
        actorLabel: 'myblu',
        actorAgentId: null,
        data: { to: 'Resolved', category: 'resolved', via: 'released_from_app' },
      },
    ]);
    expect(events.filter((event) => event.conversationId === done.id)).toEqual([
      {
        conversationId: done.id,
        type: 'released_from_app',
        actorLabel: 'myblu',
        actorAgentId: null,
        data: { reason: 'number_released' },
      },
    ]);

    const rows = await db
      .select({
        id: conversations.id,
        category: ticketStatuses.category,
        resolvedAt: conversations.resolvedAt,
        resolvedBy: conversations.resolvedByAgentId,
      })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId));
    expect(rows.find((row) => row.id === open.id)).toMatchObject({
      category: 'resolved',
      resolvedAt: expect.any(Date),
      resolvedBy: null,
    });
    // Already resolved: marked, and its resolve left as it was.
    expect(rows.find((row) => row.id === done.id)).toMatchObject({
      category: 'resolved',
      resolvedAt,
    });
    expect(await db.select().from(jobs).where(eq(jobs.type, 'send_csat'))).toEqual([]);
    expect(await db.select().from(apiTickets)).toEqual([]);

    const [row] = await db
      .insert(agents)
      .values({ name: 'Omar', email: `omar.release${seq}@shipblu.test`, role: 'admin' })
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
    expect((await getConversation(admin, open.number))?.releasedFromApp).toBe(
      'the number changed hands',
    );
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

  // The reply's own race with the revoke: without the account lock, its locked
  // read still saw the ownership row the uncommitted revoke had deleted, and a
  // deleted account reopened its resolved ticket and was then answered 404.
  it('refuses a reply whose session was revoked while it waited, and reopens nothing', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);
    const resolved = await statusId('Resolved');
    await db
      .update(conversations)
      .set({ statusId: resolved })
      .where(eq(conversations.id, opening.id));

    const hold = holdNextTransaction('after');
    const revoking = revoke(user, 'account_deleted');
    await hold.atHold;
    const replying = send(token, opening.id, 'Is anybody there?');
    expect(await untilWaitingOnALock(db)).toBe(true);
    hold.release();
    await revoking;

    expect(await refusal(await replying)).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await messagesOf(opening.id)).toHaveLength(1);
    const [row] = await db
      .select({ statusId: conversations.statusId })
      .from(conversations)
      .where(eq(conversations.id, opening.id));
    expect(row!.statusId).toBe(resolved);
  });

  it('refuses a reply on a session signed out while it waited, though the ticket stays in the app', async () => {
    await appRow();
    const token = await minted();
    const { ticket: opening } = await opened(token);

    const hold = holdNextTransaction('after');
    const revoking = revoke(user, 'signed_out');
    await hold.atHold;
    const replying = send(token, opening.id, 'Still there?');
    expect(await untilWaitingOnALock(db)).toBe(true);
    hold.release();
    await revoking;

    expect(await refusal(await replying)).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await messagesOf(opening.id)).toHaveLength(1);
    expect((await ticket(await minted(), opening.id)).status).toBe(200);
  });
});
