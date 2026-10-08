import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  aiPriorityRuns,
  contacts,
  conversationEvents,
  conversations,
  jobs,
  messages,
  slaPolicies,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { createTicket } from '@/lib/portal/tickets';
import { applySlaOnCreate } from '@/lib/sla';
import { stubFetch } from '@/lib/testing/fetch';
import { withCleanDatabase } from '@/lib/testing/db';
import type { Priority } from '@/lib/tickets/vocabulary';
import { enqueuePriorityClassification } from './enqueue';
import { PRIORITY_AI_ACTOR, classifyMessagePriority } from './run';

/**
 * The classifier against Postgres, with TypeSafe answered by the test.
 *
 * What only a database can show: that the write is guarded by what the ticket's
 * history says rather than by what the job was told, that a redelivered job
 * leaves one event and not two, that the SLA follows the new priority, and that
 * every statement here plans — `npm run test` runs no SQL, and this job is
 * skipped by CI's handler loop because it needs the provider.
 */

withCleanDatabase();

const BASE = 'https://typesafe.test';
const MINUTE = 60_000;

/** Every clock half as long for high and urgent, as the production policies are. */
const TARGETS = {
  low: { firstResponseMins: 120, nextResponseMins: 60, resolutionMins: 480 },
  medium: { firstResponseMins: 120, nextResponseMins: 60, resolutionMins: 480 },
  high: { firstResponseMins: 60, nextResponseMins: 60, resolutionMins: 480 },
  urgent: { firstResponseMins: 60, nextResponseMins: 60, resolutionMins: 480 },
};

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  vi.stubEnv('PRIORITY_AI', 'apply');
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

/** TypeSafe choosing `choice` with `probability`, the rest spread evenly. */
function answers(choice: Priority, probability = 0.9) {
  return stubFetch(() =>
    Response.json({
      model: 'jev-1.13.0',
      answers: {
        priority: {
          type: 'choice',
          choice,
          probabilities: {
            low: 0.02,
            medium: 0.03,
            high: 0.05,
            urgent: 0.9,
            [choice]: probability,
          },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 400 },
    }),
  );
}

async function openStatus(): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  return row!.id;
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: await openStatus(),
      channel: 'facebook',
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function inbound(
  conversationId: string,
  bodyText: string,
  values: Partial<typeof messages.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({ conversationId, direction: 'inbound', kind: 'reply', bodyText, ...values })
    .returning({ id: messages.id });
  return row!.id;
}

async function priorityOf(conversationId: string): Promise<string> {
  const [row] = await db
    .select({ priority: conversations.priority })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row!.priority;
}

async function eventsOf(conversationId: string, type: string) {
  return db
    .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, type)),
    )
    .orderBy(asc(conversationEvents.createdAt));
}

async function runOf(messageId: string) {
  const [row] = await db
    .select()
    .from(aiPriorityRuns)
    .where(eq(aiPriorityRuns.messageId, messageId));
  return row;
}

async function defaultPolicy() {
  await db.insert(slaPolicies).values({ name: 'Live support', targets: TARGETS, isDefault: true });
}

async function firstResponseDue(conversationId: string): Promise<Date | null> {
  const [row] = await db
    .select({ due: conversations.firstResponseDueAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row!.due;
}

describe('classifyMessagePriority: apply', () => {
  it('raises an untouched ticket, says so on the timeline, and records the answer', async () => {
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية لو الفلوس موصلتش');
    answers('urgent', 0.82);

    const result = await classifyMessagePriority(messageId, { baseUrl: BASE });

    expect(result).toEqual({ status: 'recorded', outcome: 'applied', predicted: 'urgent' });
    expect(await priorityOf(id)).toBe('urgent');

    const changed = await eventsOf(id, 'priority_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.actorLabel).toBe(PRIORITY_AI_ACTOR);
    expect(changed[0]!.data).toMatchObject({ to: 'urgent', from: 'medium', probability: 0.82 });

    const run = await runOf(messageId);
    expect(run).toMatchObject({
      mode: 'apply',
      model: 'jev-1.13.0',
      predicted: 'urgent',
      priorityBefore: 'medium',
      outcome: 'applied',
      withContext: true,
      inputTokens: 400,
      error: null,
    });
    expect(run!.probabilities).toMatchObject({ urgent: 0.82 });
  });

  it('brings the owed first-response deadline forward to the urgent target', async () => {
    await defaultPolicy();
    const id = await ticket();
    await applySlaOnCreate(id);
    const before = await firstResponseDue(id);
    expect(before).not.toBeNull();

    const messageId = await inbound(id, 'الشحنة اتفتحت ومش موجود فيها حاجة');
    answers('urgent');
    await classifyMessagePriority(messageId, { baseUrl: BASE });

    const after = await firstResponseDue(id);
    expect(after!.getTime()).toBeLessThan(before!.getTime());
    const recalculated = await eventsOf(id, 'sla_recalculated');
    expect(recalculated.map((event) => event.data)).toEqual([
      expect.objectContaining({ reason: 'priority', priority: 'urgent' }),
    ]);
  });

  it('sends the earlier inbound messages as context', async () => {
    const id = await ticket();
    await inbound(id, 'فين فلوس التحصيل', { createdAt: new Date(Date.now() - 5 * MINUTE) });
    const messageId = await inbound(id, 'بقالي اسبوع');
    const mock = answers('high');

    await classifyMessagePriority(messageId, { baseUrl: BASE });

    const body = JSON.parse(String((mock.mock.calls[0]![1] as RequestInit).body)) as {
      state: Record<string, unknown>;
    };
    expect(body.state).toEqual({
      channel: 'facebook',
      message: 'بقالي اسبوع',
      earlier_messages_from_the_same_customer: ['فين فلوس التحصيل'],
    });
  });

  it('does nothing below the threshold, and records that it did nothing', async () => {
    const id = await ticket();
    const messageId = await inbound(id, 'ok');
    answers('urgent', 0.4);

    const result = await classifyMessagePriority(messageId, { baseUrl: BASE });

    expect(result).toMatchObject({ outcome: 'below_threshold' });
    expect(await priorityOf(id)).toBe('medium');
    expect(await eventsOf(id, 'priority_changed')).toEqual([]);
  });

  it('raises but never lowers once an earlier answer was confident', async () => {
    const id = await ticket();
    const first = await inbound(id, 'هرفع قضية', { createdAt: new Date(Date.now() - MINUTE) });
    answers('urgent');
    await classifyMessagePriority(first, { baseUrl: BASE });

    const second = await inbound(id, 'شكرا');
    answers('low');
    const result = await classifyMessagePriority(second, { baseUrl: BASE });

    expect(result).toMatchObject({ outcome: 'not_raised', predicted: 'low' });
    expect(await priorityOf(id)).toBe('urgent');
  });
  it('does not let the opening message lower a ticket a later one already raised', async () => {
    const id = await ticket();
    const opening = await inbound(id, 'السلام عليكم', { createdAt: new Date(Date.now() - MINUTE) });
    const later = await inbound(id, 'هرفع قضية لو فلوس التحصيل موصلتش');

    // The later message's job runs first — concurrency, or the opening one's retry.
    answers('urgent');
    expect(await classifyMessagePriority(later, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });

    answers('low', 0.9);
    expect(await classifyMessagePriority(opening, { baseUrl: BASE })).toMatchObject({
      outcome: 'not_raised',
    });
    expect(await priorityOf(id)).toBe('urgent');
  });

  it('does not lower on a later message though nothing before it was confident', async () => {
    const id = await ticket();
    const first = await inbound(id, 'هرفع قضية لو فلوس التحصيل موصلتش', {
      createdAt: new Date(Date.now() - MINUTE),
    });
    answers('urgent', 0.55);
    expect(await classifyMessagePriority(first, { baseUrl: BASE })).toMatchObject({
      outcome: 'below_threshold',
    });

    const second = await inbound(id, 'تمام شكرا');
    answers('low', 0.92);
    expect(await classifyMessagePriority(second, { baseUrl: BASE })).toMatchObject({
      outcome: 'not_raised',
    });
    expect(await priorityOf(id)).toBe('medium');
  });
});

describe('classifyMessagePriority: somebody else owns the priority', () => {
  it('leaves a priority an agent set', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test', role: 'agent' })
      .returning({ id: agents.id });
    const id = await ticket({ priority: 'low' });
    await db.insert(conversationEvents).values({
      conversationId: id,
      type: 'priority_changed',
      actorAgentId: agent!.id,
      data: { to: 'low' },
    });
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    const result = await classifyMessagePriority(messageId, { baseUrl: BASE });

    expect(result).toMatchObject({ outcome: 'set_by_person' });
    expect(await priorityOf(id)).toBe('low');
  });

  it('leaves a priority an automation set, even back to the default', async () => {
    const id = await ticket();
    await db.insert(conversationEvents).values({
      conversationId: id,
      type: 'priority_changed',
      actorLabel: 'automation:VIP',
      data: { to: 'medium' },
    });
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'set_by_person',
    });
  });

  it('leaves a ticket an agent opened on the customer’s behalf', async () => {
    const id = await ticket();
    await db
      .insert(conversationEvents)
      .values({ conversationId: id, type: 'opened_by_agent', data: {} });
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'set_by_person',
    });
  });

  it('sees the agent-opened event already, when the job runs before the form returns', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test', role: 'agent' })
      .returning({ id: agents.id });
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });

    const created = await createTicket(contact!.id, {
      subject: 'COD',
      body: 'هرفع قضية',
      openedBy: { agentId: agent!.id, form: 'cod' },
    });
    // The event is written in the transaction that created the ticket, so it
    // is there the moment the queued job can see the message.
    answers('urgent');

    expect(await classifyMessagePriority(created.messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'set_by_person',
    });
  });

  it('leaves a ticket filed by a form with its own default priority', async () => {
    const [form] = await db
      .insert(ticketForms)
      .values({ slug: 'cod', nameEn: 'COD', defaultPriority: 'medium' })
      .returning({ id: ticketForms.id });
    const id = await ticket({ formId: form!.id });
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'set_by_person',
    });
    expect(await priorityOf(id)).toBe('medium');
  });

  it('leaves a priority that is not the one it expects, though no event says who moved it', async () => {
    const id = await ticket({ priority: 'high' });
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'set_by_person',
    });
    expect(await priorityOf(id)).toBe('high');
  });
});

describe('classifyMessagePriority: shadow, skips and failures', () => {
  it('records what it would have done in shadow mode and changes nothing', async () => {
    vi.stubEnv('PRIORITY_AI', 'shadow');
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'would_apply',
    });
    expect(await priorityOf(id)).toBe('medium');
    expect(await eventsOf(id, 'priority_changed')).toEqual([]);
    expect(await runOf(messageId)).toMatchObject({ mode: 'shadow', outcome: 'would_apply' });
  });

  it('asks nothing when switched off', async () => {
    vi.stubEnv('PRIORITY_AI', 'off');
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    const mock = answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      status: 'skipped',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('skips an autoresponder', async () => {
    const id = await ticket({ channel: 'email' });
    const messageId = await inbound(id, 'I am out of the office', { meta: { isAutoReply: true } });
    const mock = answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toEqual({
      status: 'skipped',
      reason: 'an automated email',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('skips a bounce on an existing ticket, whose text reads as urgent', async () => {
    const id = await ticket({ channel: 'email' });
    const messageId = await inbound(id, 'Delivery failed: permanent error', {
      meta: { isBounce: true, isAutomated: true },
    });
    const mock = answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      status: 'skipped',
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('weighs shadow answers against its own earlier would-apply, as apply would', async () => {
    vi.stubEnv('PRIORITY_AI', 'shadow');
    const id = await ticket();
    const first = await inbound(id, 'هرفع قضية', { createdAt: new Date(Date.now() - MINUTE) });
    answers('urgent');
    await classifyMessagePriority(first, { baseUrl: BASE });

    const second = await inbound(id, 'الشحنة متأخرة');
    answers('high');

    // Under apply the ticket would be urgent by now, so high is not a raise.
    expect(await classifyMessagePriority(second, { baseUrl: BASE })).toMatchObject({
      outcome: 'not_raised',
    });
    expect(await priorityOf(id)).toBe('medium');
  });

  it('classifies a person writing from a mailing-list address', async () => {
    // `isAutomated` is set by a List-Id header; a merchant's Google Group has one.
    const id = await ticket({ channel: 'email' });
    const messageId = await inbound(id, 'We will take legal action: COD for 40 orders is missing', {
      meta: { isAutomated: true, isAutoReply: false, isBounce: false },
    });
    answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
  });

  it('answers gone for a message that does not exist', async () => {
    expect(await classifyMessagePriority(crypto.randomUUID(), { baseUrl: BASE })).toEqual({
      status: 'gone',
    });
  });

  it('hands a rate limit back to the queue and records nothing', async () => {
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    stubFetch(() => new Response('slow down', { status: 429 }));

    await expect(classifyMessagePriority(messageId, { baseUrl: BASE })).rejects.toThrow(/429/);
    expect(await runOf(messageId)).toBeUndefined();
  });

  it('records a permanent refusal and does not throw it', async () => {
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    stubFetch(() => new Response('bad key', { status: 401 }));

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'failed',
    });
    expect(await runOf(messageId)).toMatchObject({ outcome: 'failed', predicted: null });
    expect(await priorityOf(id)).toBe('medium');
  });

  it('does nothing the second time a job is delivered', async () => {
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    const mock = answers('urgent');

    await classifyMessagePriority(messageId, { baseUrl: BASE });
    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toEqual({
      status: 'already_classified',
    });

    expect(mock).toHaveBeenCalledOnce();
    expect(await eventsOf(id, 'priority_changed')).toHaveLength(1);
  });

  it('writes once when two deliveries race past the first check', async () => {
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    await Promise.all([
      classifyMessagePriority(messageId, { baseUrl: BASE }),
      classifyMessagePriority(messageId, { baseUrl: BASE }),
    ]);

    expect(await eventsOf(id, 'priority_changed')).toHaveLength(1);
    expect(await db.select().from(aiPriorityRuns)).toHaveLength(1);
  });
});

describe('enqueuePriorityClassification', () => {
  async function queued() {
    return db
      .select({ payload: jobs.payload, dedupeKey: jobs.dedupeKey })
      .from(jobs)
      .where(eq(jobs.type, 'classify_priority'));
  }

  it('queues an inbound message on a channel the team works, once', async () => {
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    const message = {
      conversationId: id,
      messageId,
      bodyText: 'هرفع قضية',
      kind: 'reply',
      direction: 'inbound',
    };

    await enqueuePriorityClassification(message);
    await enqueuePriorityClassification(message);

    expect(await queued()).toEqual([
      { payload: { messageId }, dedupeKey: `classify_priority:${messageId}` },
    ]);
  });

  it('never queues the bot channel, an agent’s reply, or anything while off', async () => {
    const bot = await ticket({ channel: 'whatsapp_bot' });
    const botMessage = await inbound(bot, 'فين الشحنة');
    await enqueuePriorityClassification({
      conversationId: bot,
      messageId: botMessage,
      bodyText: 'فين الشحنة',
      kind: 'reply',
      direction: 'inbound',
    });

    const id = await ticket();
    await enqueuePriorityClassification({
      conversationId: id,
      messageId: crypto.randomUUID(),
      bodyText: 'We are on it',
      kind: 'reply',
      direction: 'outbound',
    });

    vi.stubEnv('PRIORITY_AI', 'off');
    const messageId = await inbound(id, 'هرفع قضية');
    await enqueuePriorityClassification({
      conversationId: id,
      messageId,
      bodyText: 'هرفع قضية',
      kind: 'reply',
      direction: 'inbound',
    });

    expect(await queued()).toEqual([]);
  });
});
