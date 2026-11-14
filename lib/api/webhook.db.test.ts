import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  apiTickets,
  contactIdentities,
  contacts,
  conversations,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { mergeContacts } from '@/lib/contacts/merge';
import { resetEnvCache } from '@/lib/env';
import { PermanentJobError } from '@/lib/queue';
import { stubFetch } from '@/lib/testing/fetch';
import { withCleanDatabase } from '@/lib/testing/db';
import { storeAgentReply } from '@/lib/tickets/agent-reply';
import { deliverAutomatedReply } from '@/lib/tickets/outbound';
import { notifyMyblu } from '@/worker/handlers/notify-myblu';
import { enqueueMessageCreated, NOTIFY_MAX_ATTEMPTS } from './notify';
import { MessageCreatedEvent } from './schemas';
import { revokeSessions } from './sessions';

/**
 * The myBlu webhook against Postgres (`plans/myblu-ticket-api.md`, stage 6):
 * which replies queue `notify_myblu`, and what its handler sends — or does not
 * — once it reads the rows. The handler's one statement is planned and run
 * here, which is why `scripts/ci/db-jobs.txt` names this file rather than
 * running the job bare in CI's `database` job: it needs a reply on an app
 * ticket to read, and it posts.
 */

withCleanDatabase();

const RECEIVER = 'https://myblu.example.test/support/webhook/';
const SECRET = 'db-test-webhook-secret-0123456789-abcdef';

let errors: MockInstance;

beforeEach(() => {
  vi.stubEnv('MYBLU_WEBHOOK_URL', RECEIVER);
  vi.stubEnv('MYBLU_WEBHOOK_SECRET', SECRET);
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  const logged = errors.mock.calls.map((call) => String(call[0]));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
  expect(logged).toEqual([]);
});

// --- Fixtures ---------------------------------------------------------------

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

let made = 0;

async function agent(): Promise<string> {
  made += 1;
  const [row] = await db
    .insert(agents)
    .values({ name: 'Omar', email: `omar${made}@shipblu.test`, role: 'agent' })
    .returning({ id: agents.id });
  return row!.id;
}

/** A contact holding the myBlu identity of `externalId`. */
async function appUser(externalId: string) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Nour', primaryPhone: '201001234567' })
    .returning({ id: contacts.id });
  const [identity] = await db
    .insert(contactIdentities)
    .values({
      contactId: contact!.id,
      channel: 'api',
      identifier: `myblu:${externalId}`,
      isVerified: true,
    })
    .returning({ id: contactIdentities.id });
  return { contactId: contact!.id, identityId: identity!.id };
}

/** A ticket on `channel`, opened by `externalId`'s identity when it is the app's. */
async function ticket(channel: 'api' | 'webchat' = 'api', externalId = 'u_83412') {
  const user = await appUser(externalId);
  const [row] = await db
    .insert(conversations)
    .values({
      channel,
      statusId: await statusId('Open'),
      requesterContactId: user.contactId,
      subject: 'Where is my parcel?',
    })
    .returning({ id: conversations.id, number: conversations.number });
  if (channel === 'api') {
    await db.insert(apiTickets).values({ conversationId: row!.id, identityId: user.identityId });
  }
  return { ...user, ticketId: row!.id, number: row!.number, channel };
}

async function agentReply(t: { ticketId: string; channel: 'api' | 'webchat' }) {
  return storeAgentReply(t.ticketId, t.channel, {
    authorAgentId: await agent(),
    bodyText: 'We have asked the courier to call you.',
    deliveryStatus: 'delivered',
  });
}

async function message(
  ticketId: string,
  values: Partial<typeof messages.$inferInsert>,
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: ticketId,
      direction: 'outbound',
      kind: 'reply',
      bodyText: 'text',
      ...values,
    })
    .returning({ id: messages.id });
  return row!.id;
}

function queued() {
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

/** The job for `messageId`, as the worker claims it. */
async function jobFor(messageId: string) {
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.type, 'notify_myblu'), eq(jobs.dedupeKey, `notify_myblu:message:${messageId}`)),
    );
  if (row) return { ...row, attempts: 1, status: 'processing' as const };
  // One the doors would never queue, as a hand-written payload names it.
  return {
    id: randomUUID(),
    type: 'notify_myblu',
    payload: { event: 'message.created', messageId },
    status: 'processing' as const,
    priority: 100,
    runAt: new Date(),
    attempts: 1,
    maxAttempts: NOTIFY_MAX_ATTEMPTS,
    lastError: null,
    dedupeKey: null,
    lockedAt: new Date(),
    lockedBy: 'test',
    completedAt: null,
    createdAt: new Date(),
  };
}

function receiver(status = 200) {
  return stubFetch(() => new Response(null, { status }));
}

/** What the receiver was sent, checked as myBlu's backend checks it. */
function delivered(fetchMock: ReturnType<typeof receiver>) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  const headers = new Headers(init!.headers);
  const body = init!.body as string;
  const timestamp = headers.get('x-shipblu-timestamp')!;
  expect(url).toBe(RECEIVER);
  expect(headers.get('x-shipblu-signature')).toBe(
    `v1=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')}`,
  );
  const event = MessageCreatedEvent.strict().parse(JSON.parse(body));
  expect(headers.get('x-shipblu-event')).toBe(event.type);
  expect(headers.get('x-shipblu-event-id')).toBe(event.id);
  return event;
}

// --- Queueing ---------------------------------------------------------------

describe('which replies queue notify_myblu', () => {
  it('an agent’s reply on an app ticket queues one, once ever for the message', async () => {
    const t = await ticket();

    const messageId = await agentReply(t);
    await enqueueMessageCreated('api', messageId);

    expect(await queued()).toEqual([
      {
        payload: { event: 'message.created', messageId },
        priority: 10,
        maxAttempts: NOTIFY_MAX_ATTEMPTS,
        dedupeKey: `notify_myblu:message:${messageId}`,
      },
    ]);
    // No carrier beside it: the row is the delivery.
    expect(await db.select({ type: jobs.type }).from(jobs)).toEqual([{ type: 'notify_myblu' }]);
  });

  it('an automated reply on an app ticket queues one, at its sender’s priority', async () => {
    const t = await ticket();

    const messageId = await deliverAutomatedReply({
      conversationId: t.ticketId,
      channel: 'api',
      requesterEmail: null,
      bodyText: 'We are closed now, and will answer from 9 tomorrow.',
      bodyHtml: '<p>We are closed now.</p>',
      actorLabel: 'automation:Out of hours',
      eventType: 'auto_replied',
    });

    expect(await queued()).toEqual([
      expect.objectContaining({ payload: { event: 'message.created', messageId }, priority: 20 }),
    ]);
  });

  it('a web chat reply queues none', async () => {
    await agentReply(await ticket('webchat'));
    expect(await queued()).toEqual([]);
  });

  it('nothing is queued while the URL is unset, whatever the secret', async () => {
    vi.stubEnv('MYBLU_WEBHOOK_URL', '');
    resetEnvCache();

    await agentReply(await ticket());

    expect(await queued()).toEqual([]);
    expect(await db.select({ id: jobs.id }).from(jobs)).toEqual([]);
  });
});

// --- Sending ----------------------------------------------------------------

describe('notify_myblu', () => {
  it('posts message.created, signed, naming the ticket’s user and the reply by id only', async () => {
    const t = await ticket();
    const messageId = await agentReply(t);
    const fetchMock = receiver(202);

    await notifyMyblu(await jobFor(messageId));

    const event = delivered(fetchMock);
    const [stored] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(event).toEqual({
      version: 1,
      id: `message.created:${messageId}`,
      type: 'message.created',
      occurredAt: stored!.createdAt.toISOString(),
      user: { externalId: 'u_83412' },
      ticket: { id: t.ticketId, number: t.number, status: 'open' },
      message: { id: messageId, from: 'agent' },
    });
    // Nothing of what the agent wrote, nor the phone.
    const body = fetchMock.mock.calls[0]![1]!.body as string;
    expect(body).not.toContain('courier');
    expect(body).not.toContain('201001234567');
  });

  it('calls an automated reply `system`, and sends the status the ticket has when it runs', async () => {
    const t = await ticket();
    const messageId = await message(t.ticketId, {});
    await db
      .update(conversations)
      .set({ statusId: await statusId('Pending') })
      .where(eq(conversations.id, t.ticketId));
    const fetchMock = receiver();

    await notifyMyblu(await jobFor(messageId));

    expect(delivered(fetchMock)).toMatchObject({
      ticket: { status: 'pending' },
      message: { from: 'system' },
    });
  });

  it('names the user off the ownership row after a merge gives the contact a second app identity', async () => {
    const t = await ticket('api', 'u_83412');
    const other = await appUser('u_other');
    const messageId = await agentReply(t);
    // The survivor already holds another account's identity; the ticket's
    // requester and its owner's identity both move to it.
    const merged = await mergeContacts({
      survivorId: other.contactId,
      loserId: t.contactId,
      agentId: null,
    });
    expect(merged.ok).toBe(true);
    const fetchMock = receiver();

    await notifyMyblu(await jobFor(messageId));

    expect(delivered(fetchMock).user).toEqual({ externalId: 'u_83412' });
  });

  it('refuses a note’s id, the customer’s own message and a web chat reply, sending nothing', async () => {
    const t = await ticket();
    const webchat = await ticket('webchat', 'u_webchat');
    const fetchMock = receiver();
    const ids = [
      await message(t.ticketId, { kind: 'note', authorAgentId: await agent() }),
      await message(t.ticketId, { direction: 'inbound' }),
      await message(webchat.ticketId, { authorAgentId: await agent() }),
    ];

    for (const id of ids) {
      await expect(notifyMyblu(await jobFor(id))).rejects.toBeInstanceOf(PermanentJobError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends for good on a message that is gone', async () => {
    const fetchMock = receiver();

    await expect(notifyMyblu(await jobFor(randomUUID()))).rejects.toThrow(
      /no longer exists — purged, or never written/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing once the account is deleted, and completes', async () => {
    const t = await ticket();
    const messageId = await agentReply(t);
    await revokeSessions('u_83412', 'account_deleted', new Date());
    const fetchMock = receiver();

    await notifyMyblu(await jobFor(messageId));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing on a ticket marked spam, or to a blocked user, or a day late', async () => {
    const fetchMock = receiver();

    const spam = await ticket('api', 'u_spam');
    const onSpam = await agentReply(spam);
    await db.update(conversations).set({ isSpam: true }).where(eq(conversations.id, spam.ticketId));

    const blocked = await ticket('api', 'u_blocked');
    const toBlocked = await agentReply(blocked);
    await db.update(contacts).set({ isBlocked: true }).where(eq(contacts.id, blocked.contactId));

    const late = await ticket('api', 'u_late');
    const lateReply = await agentReply(late);
    await db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(messages.id, lateReply));

    for (const id of [onSpam, toBlocked, lateReply]) {
      await notifyMyblu(await jobFor(id));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing for a job already queued once the URL is unset, and completes', async () => {
    const messageId = await agentReply(await ticket());
    vi.stubEnv('MYBLU_WEBHOOK_URL', '');
    resetEnvCache();
    const fetchMock = receiver();

    await notifyMyblu(await jobFor(messageId));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails the attempt by name, for the queue to retry, while the URL is unusable', async () => {
    const messageId = await agentReply(await ticket());
    vi.stubEnv('MYBLU_WEBHOOK_URL', 'http://myblu.example.test/support/webhook/');
    resetEnvCache();
    const fetchMock = receiver();

    const failure = await notifyMyblu(await jobFor(messageId)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
    expect((failure as Error).message).toBe(
      'notify_myblu: MYBLU_WEBHOOK_URL is not https — nothing sent',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails the attempt, for the queue to retry, when the receiver refuses it, and leaves the reply delivered', async () => {
    const messageId = await agentReply(await ticket());
    receiver(503);

    const failure = await notifyMyblu(await jobFor(messageId)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
    const [reply] = await db
      .select({ deliveryStatus: messages.deliveryStatus })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(reply).toEqual({ deliveryStatus: 'delivered' });
  });
});
