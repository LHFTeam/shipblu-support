import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  conversationEvents,
  conversations,
  csatSurveys,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { NOTIFY_MAX_ATTEMPTS } from '@/lib/api/notify';
import {
  ErrorBody,
  SendResult,
  Session,
  SurveyCreatedEvent,
  SurveyEnvelope,
  TicketEnvelope,
  TicketsPage,
} from '@/lib/api/schemas';
import { sendPulledSurvey } from '@/lib/csat';
import { MAX_COMMENT } from '@/lib/csat/limits';
import { saveCsatSettings, UNSET_CSAT_SETTINGS } from '@/lib/csat/settings';
import { ratingLabels } from '@/lib/csat/wording';
import { resetEnvCache } from '@/lib/env';
import type { ClaimedJob } from '@/lib/queue';
import { stubFetch } from '@/lib/testing/fetch';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { notifyMyblu } from '@/worker/handlers/notify-myblu';
import { sendCsat } from '@/worker/handlers/send-csat';
import { POST as postSession } from './sessions/route';
import { POST as postMessage } from './tickets/[id]/messages/route';
import { GET as getTicket } from './tickets/[id]/route';
import { GET as getSurvey, POST as postSurvey } from './tickets/[id]/survey/route';
import { GET as getList, POST as postTicket } from './tickets/route';

/**
 * The myBlu app's survey against Postgres (`plans/myblu-ticket-api.md`,
 * stage 8; `plans/csat.md`, _myBlu_): `send_csat` on an app ticket writing a
 * survey the app pulls, the app reading and answering it through the routes as
 * the SDK calls them, the ticket's `survey` summary, and the `survey.created`
 * push that tells myBlu's backend one is waiting.
 *
 * Every best-effort step after a commit logs instead of throwing, so a failure
 * inside one would read as "nothing happened": a test fails on any error
 * logged that it did not ask for.
 */

withCleanDatabase();

const TOKEN = 'db-test-myblu-api-token-0123456789-abcdef';
const CLIENT = 'sdk-ts/0.1.0 app/5.4.1 ios/18.1';
const RECEIVER = 'https://myblu.example.test/support/webhook/';
const SECRET = 'db-test-webhook-secret-0123456789-abcdef';

let seq = 0;
let user = '';
let errors: MockInstance;

beforeEach(async () => {
  seq += 1;
  user = `survey_${seq}`;
  vi.stubEnv('MYBLU_API_TOKEN', TOKEN);
  vi.stubEnv('MYBLU_WEBHOOK_URL', RECEIVER);
  vi.stubEnv('MYBLU_WEBHOOK_SECRET', SECRET);
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await db.insert(channels).values({ type: 'api', name: 'myBlu app', config: {} });
  await surveysOn();
});

afterEach(() => {
  const logged = errors.mock.calls.map((call) => String(call[0]));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(logged).toEqual([]);
});

// --- Fixtures ---------------------------------------------------------------

let admins = 0;

/** The survey switch on, for the app among the channels. */
async function surveysOn(app = true) {
  admins += 1;
  const [admin] = await db
    .insert(agents)
    .values({ name: 'Admin', email: `admin${admins}@shipblu.test`, role: 'admin' })
    .returning({ id: agents.id });
  await saveCsatSettings(
    {
      ...UNSET_CSAT_SETTINGS,
      enabled: true,
      channels: { email: true, webchat: true, facebook: true, instagram: true, api: app },
    },
    admin!.id,
  );
}

let next = 0;
const address = () => `198.51.100.${(next += 1) % 250}-${next}`;

async function minted(externalUserId = user): Promise<string> {
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
        phone: `+2012${String(seq * 10 + next).padStart(8, '0')}`,
        name: 'Nour Adel',
        client: { platform: 'ios', appVersion: '5.4.1' },
      }),
    }),
  );
  expect(response.status).toBe(201);
  return Session.parse(await response.json()).token;
}

function clientRequest(
  path: string,
  token: string,
  { method = 'GET', body }: { method?: string; body?: unknown } = {},
): Request {
  return new Request(`https://support.shipblu.com/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'ShipBlu-Client': CLIENT,
      'x-forwarded-for': address(),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(method === 'POST' &&
        (path === '/tickets' || path.endsWith('/messages')) && { 'Idempotency-Key': randomUUID() }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** A ticket the user opened through the route, in `locale`'s words. */
async function opened(token: string, locale: 'ar' | 'en' = 'en') {
  const text = locale === 'en' ? 'Where is my parcel?' : 'فين الشحنة بتاعتي؟';
  const response = await postTicket(
    clientRequest('/tickets', token, { method: 'POST', body: { text, locale } }),
  );
  expect(response.status).toBe(201);
  return SendResult.parse(await response.json()).ticket;
}

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function resolve(ticketId: string) {
  await db
    .update(conversations)
    .set({ statusId: await statusId('Resolved'), resolvedAt: new Date() })
    .where(eq(conversations.id, ticketId));
}

/** `send_csat` as the worker claims it, an agent's resolve its trigger. */
async function surveyed(ticketId: string) {
  await sendCsat({
    id: randomUUID(),
    type: 'send_csat',
    payload: { conversationId: ticketId },
  } as unknown as ClaimedJob);
}

/** A ticket the user opened, resolved and surveyed. */
async function surveyedTicket(token: string, locale: 'ar' | 'en' = 'en') {
  const ticket = await opened(token, locale);
  await resolve(ticket.id);
  await surveyed(ticket.id);
  return ticket;
}

function read(token: string, ticketId: string) {
  return getSurvey(clientRequest(`/tickets/${ticketId}/survey`, token), params(ticketId));
}

function answer(token: string, ticketId: string, body: unknown) {
  return postSurvey(
    clientRequest(`/tickets/${ticketId}/survey`, token, { method: 'POST', body }),
    params(ticketId),
  );
}

async function survey(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  // Strict: every key the route answers is one the contract publishes.
  return SurveyEnvelope.strict().parse(await response.json()).survey;
}

async function refusal(response: Response) {
  return { status: response.status, ...ErrorBody.parse(await response.json()).error };
}

async function rowsOf(ticketId: string) {
  return db
    .select({
      id: csatSurveys.id,
      status: csatSurveys.status,
      delivery: csatSurveys.delivery,
      channel: csatSurveys.channel,
      locale: csatSurveys.locale,
      messageId: csatSurveys.messageId,
      tokenHash: csatSurveys.tokenHash,
      rating: csatSurveys.rating,
      comment: csatSurveys.comment,
      answerSource: csatSurveys.answerSource,
    })
    .from(csatSurveys)
    .where(eq(csatSurveys.conversationId, ticketId));
}

function pushes() {
  return db
    .select({
      payload: jobs.payload,
      priority: jobs.priority,
      maxAttempts: jobs.maxAttempts,
      dedupeKey: jobs.dedupeKey,
    })
    .from(jobs)
    .where(eq(jobs.type, 'notify_myblu'));
}

/** The queued push for `surveyId`, as the worker claims it. */
async function pushFor(surveyId: string): Promise<ClaimedJob> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.type, 'notify_myblu'), eq(jobs.dedupeKey, `notify_myblu:survey:${surveyId}`)),
    );
  if (!row) throw new Error(`no push queued for survey ${surveyId}`);
  return { ...row, attempts: 1, status: 'processing' } as ClaimedJob;
}

async function eventsOf(ticketId: string, type: string) {
  return db
    .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, ticketId), eq(conversationEvents.type, type)));
}

// --- The send ----------------------------------------------------------------

describe('send_csat on an app ticket', () => {
  it('writes a survey the app pulls: no message, no link, a line on the timeline and one push queued', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);

    const [row] = await rowsOf(ticket.id);
    expect(row).toMatchObject({
      status: 'sent',
      delivery: 'api_pull',
      channel: 'api',
      locale: 'en',
      messageId: null,
      tokenHash: null,
    });
    // Nothing written on the thread: the app draws the survey itself.
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, ticket.id), eq(messages.direction, 'outbound'))),
    ).toEqual([]);
    expect(await eventsOf(ticket.id, 'csat_sent')).toEqual([
      {
        actorLabel: expect.any(String),
        data: { surveyId: row!.id, delivery: 'api_pull', locale: 'en' },
      },
    ]);
    expect(await pushes()).toEqual([
      {
        payload: { event: 'survey.created', surveyId: row!.id },
        // The survey's own carrier priority, as an email survey's would be.
        priority: 50,
        maxAttempts: NOTIFY_MAX_ATTEMPTS,
        dedupeKey: `notify_myblu:survey:${row!.id}`,
      },
    ]);
    // And no carrier beside it: nothing is sent by email.
    expect(
      await db.select({ type: jobs.type }).from(jobs).where(eq(jobs.type, 'send_email')),
    ).toEqual([]);
  });

  // No message and no other write touches the ticket, so without its own
  // touch nothing fired `notify_change`, and an agent who pressed "Send now"
  // read "Survey queued" until something else changed the ticket.
  it('touches the ticket, so an open page wakes to the survey', async () => {
    const token = await minted();
    const ticket = await opened(token);
    await resolve(ticket.id);
    const [before] = await db
      .select({ updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.id, ticket.id));

    await surveyed(ticket.id);

    const [after] = await db
      .select({ updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.id, ticket.id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it('surveys a closed ticket too, and an Arabic one in Arabic', async () => {
    const token = await minted();
    const ticket = await opened(token, 'ar');
    await db
      .update(conversations)
      .set({ statusId: await statusId('Closed') })
      .where(eq(conversations.id, ticket.id));

    await surveyed(ticket.id);

    expect(await rowsOf(ticket.id)).toMatchObject([
      { status: 'sent', delivery: 'api_pull', locale: 'ar' },
    ]);
  });

  it('queues no push while the URL is unset, and the survey is there all the same', async () => {
    vi.stubEnv('MYBLU_WEBHOOK_URL', '');
    resetEnvCache();
    const token = await minted();
    const ticket = await surveyedTicket(token);

    expect(await pushes()).toEqual([]);
    expect((await survey(await read(token, ticket.id))).status).toBe('sent');
  });

  it('skips the ticket while the app is off among the channels, and the app sees no survey', async () => {
    await surveysOn(false);
    const token = await minted();
    const ticket = await surveyedTicket(token);

    expect(await rowsOf(ticket.id)).toMatchObject([{ status: 'skipped' }]);
    expect(await pushes()).toEqual([]);
    expect(await refusal(await read(token, ticket.id))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect((await ticketOf(token, ticket.id)).survey).toBeNull();
  });
});

// --- Reading -------------------------------------------------------------------

function ticketOf(token: string, ticketId: string) {
  return getTicket(clientRequest(`/tickets/${ticketId}`, token), params(ticketId))
    .then((response) => response.json())
    .then((body) => TicketEnvelope.parse(body).ticket);
}

async function listed(token: string) {
  const response = await getList(clientRequest('/tickets', token));
  return TicketsPage.parse(await response.json()).tickets;
}

describe('GET /tickets/{id}/survey', () => {
  it('is 404 until the survey is sent, and then the survey worded in its own locale', async () => {
    const token = await minted();
    const ticket = await opened(token);

    expect(await refusal(await read(token, ticket.id))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect((await ticketOf(token, ticket.id)).survey).toBeNull();

    await resolve(ticket.id);
    await surveyed(ticket.id);

    const [row] = await rowsOf(ticket.id);
    expect(await survey(await read(token, ticket.id))).toEqual({
      id: row!.id,
      status: 'sent',
      rating: null,
      comment: null,
      locale: 'en',
      intro: expect.any(String),
      question: expect.any(String),
      labels: ratingLabels('en'),
      commentPrompt: expect.any(String),
      commentMaxChars: MAX_COMMENT,
      button: expect.any(String),
      thanks: expect.any(String),
      expiresAt: null,
    });
  });

  it('is summarised on the ticket and in the list, so the app can prompt without a call per ticket', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const quiet = await opened(token);

    expect((await ticketOf(token, ticket.id)).survey).toEqual({ status: 'sent' });
    const tickets = await listed(token);
    expect(tickets.find((t) => t.id === ticket.id)?.survey).toEqual({ status: 'sent' });
    expect(tickets.find((t) => t.id === quiet.id)?.survey).toBeNull();
  });

  // The push refuses any survey but a pulled one; the route and the summary
  // ask the same, so the app is never served a survey the push says is not its.
  it('serves only a survey the app pulls, never one sent another way', async () => {
    const token = await minted();
    const ticket = await opened(token);
    await resolve(ticket.id);
    await db.insert(csatSurveys).values({
      conversationId: ticket.id,
      status: 'sent',
      delivery: 'email_link',
      channel: 'api',
      locale: 'en',
      sentAt: new Date(),
    });

    expect(await refusal(await read(token, ticket.id))).toMatchObject({ status: 404 });
    expect((await listed(token)).find((t) => t.id === ticket.id)?.survey).toBeNull();
  });

  it('is 404 for another user’s ticket, and for an id that is not one', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const stranger = await minted(`${user}_other`);

    expect(await refusal(await read(stranger, ticket.id))).toMatchObject({ status: 404 });
    expect(await refusal(await read(token, 'not-a-ticket'))).toMatchObject({ status: 404 });
    expect(await refusal(await read(token, randomUUID()))).toMatchObject({ status: 404 });
  });

  // A survey writes no message: ordered by the message alone, a ticket far
  // down the list whose survey was written never reached the page a poll
  // re-reads, and its summary never arrived without the push.
  it('brings a ticket whose survey is given to the top of the list, and pages by the same order', async () => {
    const token = await minted();
    const older = await opened(token);
    const newer = await opened(token);
    await resolve(older.id);
    await surveyed(older.id);
    const [given] = await db
      .select({ sentAt: csatSurveys.sentAt })
      .from(csatSurveys)
      .where(eq(csatSurveys.conversationId, older.id));

    const tickets = await listed(token);
    expect(tickets.map((t) => t.id)).toEqual([older.id, newer.id]);
    expect(tickets[0]).toMatchObject({
      lastActivityAt: given!.sentAt!.toISOString(),
      survey: { status: 'sent' },
    });
    expect(tickets[1]!.lastActivityAt).toBe(tickets[1]!.lastMessageAt);
    // The one ticket's read says the same, through the same columns.
    expect((await ticketOf(token, older.id)).lastActivityAt).toBe(given!.sentAt!.toISOString());

    const first = TicketsPage.parse(
      await (await getList(clientRequest('/tickets?limit=1', token))).json(),
    );
    expect(first.tickets.map((t) => t.id)).toEqual([older.id]);
    const second = TicketsPage.parse(
      await (
        await getList(clientRequest(`/tickets?limit=1&before=${first.olderCursor}`, token))
      ).json(),
    );
    expect(second.tickets.map((t) => t.id)).toEqual([newer.id]);
  });

  // A survey asks how a resolved ticket went, and nothing expires one when the
  // user writes again. The push withholds it then (`reopened`); the route, its
  // POST and the summary did not, and the app prompted "rate us" in the middle
  // of the conversation.
  it('is no survey while the ticket is open again, and the same survey once it is resolved again', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const [sent] = await rowsOf(ticket.id);
    const reply = await postMessage(
      clientRequest(`/tickets/${ticket.id}/messages`, token, {
        method: 'POST',
        body: { text: 'It still has not come', locale: 'en' },
      }),
      params(ticket.id),
    );
    expect(reply.status).toBe(201);
    expect((await ticketOf(token, ticket.id)).status).toBe('open');

    expect(await refusal(await read(token, ticket.id))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect((await ticketOf(token, ticket.id)).survey).toBeNull();
    expect((await listed(token)).find((t) => t.id === ticket.id)?.survey).toBeNull();
    expect(await refusal(await answer(token, ticket.id, { rating: 5 }))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(await rowsOf(ticket.id)).toMatchObject([{ status: 'sent', rating: null }]);

    await resolve(ticket.id);
    expect((await survey(await read(token, ticket.id))).id).toBe(sent!.id);
    expect((await ticketOf(token, ticket.id)).survey).toEqual({ status: 'sent' });
    expect((await listed(token)).find((t) => t.id === ticket.id)?.survey).toEqual({
      status: 'sent',
    });
  });

  it('serves the survey the ticket has, not a newer one the team decided not to send', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const [sent] = await rowsOf(ticket.id);
    await db.insert(csatSurveys).values({
      conversationId: ticket.id,
      status: 'skipped',
      skipReason: 'recently_surveyed',
      channel: 'api',
    });

    expect((await survey(await read(token, ticket.id))).id).toBe(sent!.id);
    expect((await ticketOf(token, ticket.id)).survey).toEqual({ status: 'sent' });
  });
});

// --- Answering ------------------------------------------------------------------

describe('POST /tickets/{id}/survey', () => {
  it('keeps the first rating, records it as the app’s, and attaches a comment posted after it', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);

    const rated = await survey(await answer(token, ticket.id, { rating: 4 }));
    expect(rated).toMatchObject({ status: 'answered', rating: 4, comment: null });
    expect(await eventsOf(ticket.id, 'csat_received')).toEqual([
      { actorLabel: expect.any(String), data: { rating: 4, source: 'api' } },
    ]);

    // The comment, posted second with a rating that differs: the first stands.
    const commented = await survey(
      await answer(token, ticket.id, { rating: 1, comment: '  The courier called first.  ' }),
    );
    expect(commented).toMatchObject({
      status: 'answered',
      rating: 4,
      comment: 'The courier called first.',
    });
    // And a second comment changes nothing.
    expect(
      await survey(await answer(token, ticket.id, { rating: 4, comment: 'Changed my mind.' })),
    ).toMatchObject({ rating: 4, comment: 'The courier called first.' });

    expect(await rowsOf(ticket.id)).toMatchObject([
      { status: 'answered', rating: 4, answerSource: 'api' },
    ]);
    expect(await eventsOf(ticket.id, 'csat_received')).toHaveLength(1);
    expect((await ticketOf(token, ticket.id)).survey).toEqual({ status: 'answered' });
  });

  it('answers a survey a newer one superseded as it stands, recording nothing', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    await db
      .update(csatSurveys)
      .set({ status: 'expired' })
      .where(eq(csatSurveys.conversationId, ticket.id));

    expect(await survey(await answer(token, ticket.id, { rating: 5 }))).toMatchObject({
      status: 'expired',
      rating: null,
    });
    expect(await rowsOf(ticket.id)).toMatchObject([
      { status: 'expired', rating: null, answerSource: null },
    ]);
    expect(await eventsOf(ticket.id, 'csat_received')).toEqual([]);
  });

  // The answer read the survey as `sent`, and a newer send superseded it
  // before the rating was written: asked off that read alone, the rating
  // landed on the superseded survey, and the answer drew the newer one
  // unanswered, so the user was asked again.
  it('records nothing on a survey a newer send superseded while the answer waited, and answers that survey', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const [first] = await rowsOf(ticket.id);
    // Sent two days ago, outside the resurvey window, so a second send may go.
    await db
      .update(csatSurveys)
      .set({ sentAt: new Date(Date.now() - 2 * 24 * 3_600_000) })
      .where(eq(csatSurveys.id, first!.id));

    // A second send, held open after it superseded the first and wrote the
    // second; the answer's read still sees the first as sent, and its write
    // waits on the ticket's lock.
    const hold = holdNextTransaction('after');
    const sending = sendPulledSurvey({
      conversationId: ticket.id,
      locale: 'en',
      snapshot: { agentId: null, groupId: null, channel: 'api' },
      resurveyAfterDays: 1,
      ruleId: null,
    });
    await hold.atHold;
    const answering = answer(token, ticket.id, { rating: 5 });
    expect(await untilWaitingOnALock(db)).toBe(true);
    hold.release();
    expect(await sending).toMatchObject({ kind: 'sent' });

    expect(await survey(await answering)).toMatchObject({
      id: first!.id,
      status: 'expired',
      rating: null,
    });
    const rows = await rowsOf(ticket.id);
    expect(
      rows
        .map((row) => ({ status: row.status, rating: row.rating }))
        .sort((a, b) => a.status.localeCompare(b.status)),
    ).toEqual([
      { status: 'expired', rating: null },
      { status: 'sent', rating: null },
    ]);
    expect(await eventsOf(ticket.id, 'csat_received')).toEqual([]);
  });

  it('records nothing for another user, and is 404 to them', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const stranger = await minted(`${user}_other`);

    expect(await refusal(await answer(stranger, ticket.id, { rating: 1 }))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(await rowsOf(ticket.id)).toMatchObject([{ status: 'sent', rating: null }]);
  });

  it('refuses a rating outside 1 to 5, and a comment past the limit, naming the field', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);

    for (const [body, field] of [
      [{ rating: 0 }, 'rating'],
      [{ rating: 6 }, 'rating'],
      [{ rating: 4.5 }, 'rating'],
      [{}, 'rating'],
      [{ rating: 4, comment: 'x'.repeat(MAX_COMMENT + 1) }, 'comment'],
    ] as const) {
      expect(await refusal(await answer(token, ticket.id, body))).toMatchObject({
        status: 400,
        code: 'invalid_request',
        field,
      });
    }
    expect(await rowsOf(ticket.id)).toMatchObject([{ status: 'sent', rating: null }]);
  });
});

// --- The push --------------------------------------------------------------------

function receiver(status = 200) {
  return stubFetch(() => new Response(null, { status }));
}

describe('notify_myblu for a survey', () => {
  it('posts survey.created, signed, naming the user, the ticket and the survey by id only', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const [row] = await rowsOf(ticket.id);
    const [sentAt] = await db
      .select({ sentAt: csatSurveys.sentAt })
      .from(csatSurveys)
      .where(eq(csatSurveys.id, row!.id));
    const fetchMock = receiver(202);

    await notifyMyblu(await pushFor(row!.id));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init!.headers);
    const body = init!.body as string;
    expect(url).toBe(RECEIVER);
    expect(headers.get('x-shipblu-signature')).toBe(
      `v1=${createHmac('sha256', SECRET)
        .update(`${headers.get('x-shipblu-timestamp')}.${body}`)
        .digest('hex')}`,
    );
    const event = SurveyCreatedEvent.strict().parse(JSON.parse(body));
    expect(headers.get('x-shipblu-event')).toBe('survey.created');
    expect(headers.get('x-shipblu-event-id')).toBe(`survey.created:${row!.id}`);
    expect(event).toEqual({
      version: 1,
      id: `survey.created:${row!.id}`,
      type: 'survey.created',
      occurredAt: sentAt!.sentAt!.toISOString(),
      user: { externalId: user },
      ticket: { id: ticket.id, number: ticket.number, status: 'resolved' },
      survey: { id: row!.id, expiresAt: null },
    });
  });

  it('sends nothing once the survey is answered, and completes', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const [row] = await rowsOf(ticket.id);
    await survey(await answer(token, ticket.id, { rating: 5 }));
    const fetchMock = receiver();

    await notifyMyblu(await pushFor(row!.id));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing for a ticket open again, and completes', async () => {
    const token = await minted();
    const ticket = await surveyedTicket(token);
    const [row] = await rowsOf(ticket.id);
    await db
      .update(conversations)
      .set({ statusId: await statusId('Open') })
      .where(eq(conversations.id, ticket.id));
    const fetchMock = receiver();

    await notifyMyblu(await pushFor(row!.id));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends for good on a survey that is gone', async () => {
    const fetchMock = receiver();
    const job = {
      id: randomUUID(),
      type: 'notify_myblu',
      payload: { event: 'survey.created', surveyId: randomUUID() },
      attempts: 1,
      maxAttempts: NOTIFY_MAX_ATTEMPTS,
      status: 'processing',
    } as unknown as ClaimedJob;

    await expect(notifyMyblu(job)).rejects.toThrow(/no longer exists — purged, or never written/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
