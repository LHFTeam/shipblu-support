import { AsyncLocalStorage } from 'node:async_hooks';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  aiPriorityRuns,
  automationRules,
  channels,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  jobs,
  messages,
  slaPolicies,
  ticketCategories,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { runAutomations } from '@/lib/automations';
import { setConversationCategory } from '@/lib/categories/write';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import type { NormalisedComment } from '@/lib/meta/types';
import { createTicket } from '@/lib/portal/tickets';
import { routeNow, type RouteResult } from '@/lib/routing/apply';
import { beginRouting } from '@/lib/routing/begin';
import { routingWindowValues, startRouting } from '@/lib/routing/start';
import { applySlaOnCreate } from '@/lib/sla';
import { stubFetch } from '@/lib/testing/fetch';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction } from '@/lib/testing/hold-transaction';
import { ingestMetaComment } from '@/lib/tickets/ingest-meta';
import type { Priority } from '@/lib/tickets/vocabulary';
import { enqueuePriorityClassification } from './enqueue';
import { PRIORITY_AI_ACTOR, classifyMessagePriority, type ClassifyResult } from './run';

/**
 * The classifier against Postgres, with TypeSafe answered by the test.
 *
 * What only a database can show: that the write is guarded by what the ticket's
 * history says rather than by what the job was told, that a redelivered job
 * leaves one event and not two, that the SLA follows the new priority, and that
 * every statement here plans — `npm run test` runs no SQL, and this job is
 * skipped by CI's handler loop because it needs the provider.
 */

/** How many of the next reads of the hours catalog fail, as a lost connection would fail them. */
const catalog = vi.hoisted(() => ({ failing: 0 }));
vi.mock('@/lib/hours/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/hours/catalog')>();
  return {
    ...real,
    loadHoursCatalog: async () => {
      if (catalog.failing > 0) {
        catalog.failing -= 1;
        throw new Error('the hours catalog could not be read');
      }
      return real.loadHoursCatalog();
    },
  };
});

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
  catalog.failing = 0;
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
  // Round the clock, so a target is a fixed number of wall-clock minutes. Under
  // the seeded Cairo calendar, 60 and 120 working minutes from 15:30 land either
  // side of the 17:00 close, and the assertions would hold or not by time of day.
  await db.insert(slaPolicies).values({
    name: 'Live support',
    hoursSource: 'round_the_clock',
    targets: TARGETS,
    isDefault: true,
  });
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

  // The policies and the hours a deferral re-times with inside the write are
  // read only on a decision in flight, and best-effort
  // (`clockInputsIfInFlight`). Read before every applied answer, outside any
  // try, a catalog that could not be read threw the classification away
  // before it was written, and the job failed; the answer is written, and the
  // re-time's failure logged after it, as for any priority change.
  it('applies an answer whose clocks cannot be re-timed, and logs that they were not', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await defaultPolicy();
    const id = await ticket();
    await applySlaOnCreate(id);
    const before = await firstResponseDue(id);
    const messageId = await inbound(id, 'الشحنة اتفتحت ومش موجود فيها حاجة');
    answers('urgent');

    catalog.failing = Infinity;
    const result = await classifyMessagePriority(messageId, { baseUrl: BASE });
    catalog.failing = 0;

    expect(result).toEqual({ status: 'recorded', outcome: 'applied', predicted: 'urgent' });
    expect(await priorityOf(id)).toBe('urgent');
    expect(await eventsOf(id, 'priority_changed')).toHaveLength(1);
    expect(await firstResponseDue(id)).toEqual(before);
    expect(errors.mock.calls.map((call) => String(call[0]))).toContainEqual(
      `[sla] could not move the clocks on ${id}`,
    );
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

  it('does not take a message sent in the same second as the opening for the opening', async () => {
    // WhatsApp stamps a message to the whole second, so a burst shares one.
    const sameSecond = new Date(Math.floor(Date.now() / 1000) * 1000 - MINUTE);
    const id = await ticket({ channel: 'whatsapp' });
    const opening = await inbound(id, 'الشحنة اتفتحت ومش موجود فيها حاجة', {
      createdAt: sameSecond,
    });
    const burst = await inbound(id, '؟', { createdAt: sameSecond });

    answers('urgent', 0.5);
    expect(await classifyMessagePriority(opening, { baseUrl: BASE })).toMatchObject({
      outcome: 'below_threshold',
    });
    answers('low', 0.95);
    expect(await classifyMessagePriority(burst, { baseUrl: BASE })).toMatchObject({
      outcome: 'not_raised',
    });
    expect(await priorityOf(id)).toBe('medium');
  });

  // On a coexistence number the business can write first, and the customer's
  // 👍 on that is filed before anything they say.
  it('takes the first thing the customer wrote for the opening, not a reaction before it', async () => {
    const id = await ticket({ channel: 'whatsapp' });
    await inbound(id, '[reacted 👍]', {
      meta: { whatsappType: 'reaction' },
      createdAt: new Date(Date.now() - 2 * MINUTE),
    });
    const opening = await inbound(id, 'ازاي اغير عنوان التوصيل؟', {
      createdAt: new Date(Date.now() - MINUTE),
    });
    const mock = answers('low', 0.9);

    expect(await classifyMessagePriority(opening, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
    expect(await priorityOf(id)).toBe('low');

    // Nor is it context: the customer had said nothing before.
    const body = JSON.parse(String((mock.mock.calls[0]![1] as RequestInit).body)) as {
      state: Record<string, unknown>;
    };
    expect(body.state).not.toHaveProperty('earlier_messages_from_the_same_customer');
  });

  it('lets the opening message lower though a later one, answered first, was refused', async () => {
    const id = await ticket();
    const opening = await inbound(id, 'ازاي اغير عنوان التوصيل؟', {
      createdAt: new Date(Date.now() - MINUTE),
    });
    const later = await inbound(id, 'شكرا');

    // A refusal to lower moved nothing, so it has not judged the opening: the
    // ticket ends where it would have had the jobs run in order.
    answers('low', 0.9);
    expect(await classifyMessagePriority(later, { baseUrl: BASE })).toMatchObject({
      outcome: 'not_raised',
    });
    answers('low', 0.9);
    expect(await classifyMessagePriority(opening, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
    expect(await priorityOf(id)).toBe('low');
  });

  it('reads its own last write by the order the writes landed in, not the order they began', async () => {
    const id = await ticket();
    await inbound(id, 'السلام عليكم', { createdAt: new Date(Date.now() - 2 * MINUTE) });
    const slower = await inbound(id, 'هرفع قضية', { createdAt: new Date(Date.now() - MINUTE) });
    const faster = await inbound(id, 'الشحنة متأخرة اسبوع');

    // The slower job opens its transaction first and is held before the row
    // lock; the faster one takes the lock, raises to high and commits. Both
    // transactions' `now()` is when they began, so the slower one's later write
    // would carry the earlier stamp.
    const hold = holdNextTransaction('before');

    answers('urgent');
    const slow = classifyMessagePriority(slower, { baseUrl: BASE });
    await hold.atHold;
    answers('high');
    expect(await classifyMessagePriority(faster, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
    hold.release();
    expect(await slow).toMatchObject({ outcome: 'applied', predicted: 'urgent' });
    expect(await priorityOf(id)).toBe('urgent');

    // Its own write, so the next answer is weighed and not refused as somebody else's.
    const next = await inbound(id, 'لسه مفيش رد');
    answers('urgent');
    expect(await classifyMessagePriority(next, { baseUrl: BASE })).toMatchObject({
      outcome: 'unchanged',
    });
  });
});

/*
 * Meta delivers a thread's comments in no order, so a passer-by's reply under a
 * customer's comment can be stored first and open the ticket under its own
 * author, who is then the requester and has his words asked about as the
 * opening. When the customer's comment arrives she becomes the requester
 * (`adoptRootAuthor`), and from then on his run judged somebody else: it is
 * neither her opening nor an answer that judged it (`priorityFacts`). What he
 * raised stays on the column; her own opening may lower it.
 *
 * Built through the real ingest, so the move is the one `ingestMetaComment`
 * makes and the messages carry the authors and dates it gives them.
 */
describe('classifyMessagePriority: a comment thread whose first comment arrives after a reply', () => {
  const AMIRA = '1122334455';
  const BOB = '9988776655';

  /** Amira's comment, the thread's root, dated five minutes ago unless told otherwise. */
  function comment(overrides: Partial<NormalisedComment> = {}): NormalisedComment {
    return {
      platform: 'facebook',
      connection: 'facebook_page',
      commentId: 'post-1_c1',
      parentCommentId: null,
      postId: 'post-1',
      from: AMIRA,
      fromName: 'Amira Hassan',
      text: 'ازاي اغير عنوان التوصيل؟',
      createdAt: new Date(Date.now() - 5 * MINUTE),
      verb: 'add',
      raw: {},
      ...overrides,
    };
  }

  /** Bob's reply under it, which Meta's created_time puts after it. */
  function bobsReply(overrides: Partial<NormalisedComment> = {}): NormalisedComment {
    return comment({
      commentId: 'post-1_c2',
      parentCommentId: 'post-1_c1',
      from: BOB,
      fromName: 'Bob',
      text: 'نصابين، هرفع قضية عليكم كلكم',
      createdAt: new Date(Date.now() - 2 * MINUTE),
      ...overrides,
    });
  }

  /** Another comment of Amira's under her own, `minutesAgo` ago. */
  function amirasReply(n: number, text: string, minutesAgo: number): NormalisedComment {
    return comment({
      commentId: `post-1_c${n}`,
      parentCommentId: 'post-1_c1',
      text,
      createdAt: new Date(Date.now() - minutesAgo * MINUTE),
    });
  }

  async function contactOf(identifier: string): Promise<string> {
    const [row] = await db
      .select({ id: contactIdentities.contactId })
      .from(contactIdentities)
      .where(eq(contactIdentities.identifier, identifier));
    return row!.id;
  }

  async function requesterOf(conversationId: string): Promise<string> {
    const [row] = await db
      .select({ requester: conversations.requesterContactId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return row!.requester;
  }

  /** Bob's reply opens the ticket and raises it to `level`, as he was its requester. */
  async function openedByBob(level: Priority): Promise<{ id: string; bobsMessage: string }> {
    const opened = await ingestMetaComment(bobsReply());
    expect(await requesterOf(opened.conversationId)).toBe(await contactOf(BOB));
    answers(level);
    expect(await classifyMessagePriority(opened.messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
      predicted: level,
    });
    return { id: opened.conversationId, bobsMessage: opened.messageId };
  }

  /** Amira's comment arrives and takes the ticket from Bob. */
  async function rootArrives(overrides: Partial<NormalisedComment> = {}): Promise<string> {
    const root = await ingestMetaComment(comment(overrides));
    expect(root.createdConversation).toBe(false);
    expect(await requesterOf(root.conversationId)).toBe(await contactOf(AMIRA));
    return root.messageId;
  }

  it('lets her comment, dated before his reply, lower what his reply raised', async () => {
    const { id, bobsMessage } = await openedByBob('urgent');
    const root = await rootArrives();

    // His `applied` run is not an answer that judged her ticket, so hers is
    // the opening's answer and may set any level.
    answers('low', 0.9);
    expect(await classifyMessagePriority(root, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
      predicted: 'low',
    });
    expect(await priorityOf(id)).toBe('low');
    expect((await eventsOf(id, 'priority_changed')).map((event) => event.data)).toEqual([
      expect.objectContaining({ from: 'medium', to: 'urgent', messageId: bobsMessage }),
      expect.objectContaining({ from: 'urgent', to: 'low', messageId: root }),
    ]);

    // And his words after the move are a passer-by's, as anybody else's are.
    const later = await ingestMetaComment(
      bobsReply({ commentId: 'post-1_c3', text: 'لسه محدش رد؟', createdAt: new Date() }),
    );
    answers('urgent', 0.95);
    expect(await classifyMessagePriority(later.messageId, { baseUrl: BASE })).toEqual({
      status: 'skipped',
      reason: 'not written by the requester',
    });
    expect(await runOf(later.messageId)).toBeUndefined();
    expect(await priorityOf(id)).toBe('low');
  });

  // Meta can send a comment without `created_time`, and `lib/meta/parse.ts`
  // then stamps it when it is parsed — after the reply under it. His reply is
  // still not her opening.
  it('lets her comment lower it though, sent with no time, it is dated after his reply', async () => {
    const { id, bobsMessage } = await openedByBob('urgent');
    const root = await rootArrives({ createdAt: new Date() });

    const dated = await db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(inArray(messages.id, [root, bobsMessage]));
    const at = new Map(dated.map((row) => [row.id, row.createdAt.getTime()]));
    expect(at.get(root)!).toBeGreaterThan(at.get(bobsMessage)!);

    answers('low', 0.9);
    expect(await classifyMessagePriority(root, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
      predicted: 'low',
    });
    expect(await priorityOf(id)).toBe('low');
  });

  // His job read the ticket while he held it, asked the provider, and came to
  // its lock while her comment's ingest was moving the requester to her. Under
  // the lock he is a passer-by, so his answer is thrown away: no run that would
  // count as having judged her opening, and no write of his words' level.
  it('throws away the answer of a job that read the ticket before her comment took it', async () => {
    const opened = await ingestMetaComment(bobsReply());
    const [amira] = await db
      .insert(contacts)
      .values({ name: 'Amira Hassan' })
      .returning({ id: contacts.id });
    const mock = answers('urgent', 0.95);

    let raced: Promise<ClassifyResult> | undefined;
    await db.transaction(async (tx) => {
      // What `adoptRootAuthor` writes, ahead of the root's own message insert.
      await tx
        .update(conversations)
        .set({ requesterContactId: amira!.id, requesterKind: null })
        .where(eq(conversations.id, opened.conversationId));
      raced = classifyMessagePriority(opened.messageId, { baseUrl: BASE });
      await untilSomebodyWaits();
    });

    expect(await raced).toEqual({ status: 'skipped', reason: 'not written by the requester' });
    // It got past the first read — Bob was the requester still — and asked.
    expect(mock).toHaveBeenCalledOnce();
    expect(await runOf(opened.messageId)).toBeUndefined();
    expect(await priorityOf(opened.conversationId)).toBe('medium');
    expect(await eventsOf(opened.conversationId, 'priority_changed')).toEqual([]);
  });

  // Pinned, and accepted: her comment had no words, so nothing asked about
  // it, but it was her opening all the same, and her later words may raise and
  // never lower — what any customer's caption-less photo leaves. Bob raised to
  // high rather than urgent, so a raise after it can be seen.
  it('leaves what his reply raised when her comment had no words, and still lets her raise it', async () => {
    const { id, bobsMessage } = await openedByBob('high');
    const root = await rootArrives({ text: '' });

    const [stored] = await db
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(eq(messages.id, root));
    expect(stored!.bodyText).toBe('[empty comment]');
    // Ingest queued his reply and not her comment; run by hand, it asks nothing.
    const queued = (
      await db
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(eq(jobs.type, 'classify_priority'))
    ).map((job) => job.payload);
    expect(queued).toContainEqual({ messageId: bobsMessage });
    expect(queued).not.toContainEqual({ messageId: root });
    answers('low', 0.95);
    expect(await classifyMessagePriority(root, { baseUrl: BASE })).toEqual({
      status: 'skipped',
      reason: 'no text',
    });

    const thanks = await ingestMetaComment(amirasReply(3, 'تمام شكرا', 1));
    answers('low', 0.95);
    expect(await classifyMessagePriority(thanks.messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'not_raised',
    });
    expect(await priorityOf(id)).toBe('high');

    const threat = await ingestMetaComment(amirasReply(4, 'هرفع قضية لو الفلوس موصلتش', 0));
    answers('urgent', 0.95);
    expect(await classifyMessagePriority(threat.messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
    expect(await priorityOf(id)).toBe('urgent');
  });

  // Pinned, and accepted: her comment was her opening, and was asked about —
  // too unsure to act on, which leaves his level. Rule 3 is about which
  // message was the opening, not which one Jev was sure of, so her next words
  // may raise and never lower, as on any ticket whose opening was unsure.
  it('leaves what his reply raised when the answer to her comment was unsure', async () => {
    const { id } = await openedByBob('urgent');
    const root = await rootArrives();

    answers('low', 0.5);
    expect(await classifyMessagePriority(root, { baseUrl: BASE })).toMatchObject({
      outcome: 'below_threshold',
    });
    expect(await runOf(root)).toMatchObject({
      outcome: 'below_threshold',
      priorityBefore: 'urgent',
    });
    expect(await priorityOf(id)).toBe('urgent');

    const thanks = await ingestMetaComment(amirasReply(3, 'تمام شكرا', 1));
    answers('low', 0.95);
    expect(await classifyMessagePriority(thanks.messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'not_raised',
    });
    expect(await priorityOf(id)).toBe('urgent');
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
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const created = await createTicket(contact!.id, {
      subject: 'COD',
      body: 'هرفع قضية',
      formId: form!.id,
      priority: 'medium',
      priorityChosenBy: { label: 'form:cod' },
    });
    answers('urgent');

    expect(await classifyMessagePriority(created.messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'set_by_person',
    });
    expect(await priorityOf(created.conversationId)).toBe('medium');
  });

  it('names the agent, not the form, for a priority an agent chose on it', async () => {
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
      priority: 'high',
      priorityChosenBy: { agentId: agent!.id },
    });

    const [event] = await db
      .select({
        actorAgentId: conversationEvents.actorAgentId,
        actorLabel: conversationEvents.actorLabel,
      })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, created.conversationId),
          eq(conversationEvents.type, 'priority_changed'),
        ),
      );
    expect(event).toEqual({ actorAgentId: agent!.id, actorLabel: null });

    answers('urgent');
    expect(await classifyMessagePriority(created.messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'set_by_person',
    });
  });

  it('still raises a ticket whose form was given a default after it was filed', async () => {
    const [form] = await db
      .insert(ticketForms)
      .values({ slug: 'cod', nameEn: 'COD' })
      .returning({ id: ticketForms.id });
    const id = await ticket({ formId: form!.id });
    const opening = await inbound(id, 'ازاي اغير العنوان؟', {
      createdAt: new Date(Date.now() - MINUTE),
    });
    answers('low');
    await classifyMessagePriority(opening, { baseUrl: BASE });

    // An admin edits the form later; the ticket was not filed holding it.
    await db
      .update(ticketForms)
      .set({ defaultPriority: 'high' })
      .where(eq(ticketForms.id, form!.id));

    const later = await inbound(id, 'هرفع قضية');
    answers('urgent');
    expect(await classifyMessagePriority(later, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
    expect(await priorityOf(id)).toBe('urgent');
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

describe('classifyMessagePriority: a rule setting priority at the same moment', () => {
  async function ruleSetting(priority: Priority) {
    // Only on a ticket still at the default: the classifier's own `on_update`
    // pass after it raises one would otherwise run this rule a second time, and
    // the test is about the one run it holds.
    await db.insert(automationRules).values({
      name: 'Back to normal',
      trigger: 'on_update',
      conditions: { all: [{ field: 'priority', op: 'eq', value: 'medium' }] },
      actions: [{ type: 'set_priority', value: priority }],
    });
  }

  it('waits for the rule’s column and event together, and leaves the rule’s choice', async () => {
    // The rule has written the column and its event and not yet committed. Two
    // autocommits instead, the classifier could land between them, read the
    // rule's `medium` with no event owning it, and write over it.
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    await ruleSetting('medium');
    const hold = holdNextTransaction('after');
    const rule = runAutomations('on_update', id);
    await hold.atHold;

    answers('urgent');
    const classified = classifyMessagePriority(messageId, { baseUrl: BASE });
    hold.release();
    await rule;

    expect(await classified).toMatchObject({ outcome: 'set_by_person' });
    expect(await priorityOf(id)).toBe('medium');
  });

  it('orders a rule that began before the classifier and wrote after it as the later write', async () => {
    // The rule's transaction is open before the classifier runs and writes once
    // the classifier has committed: its value is the one the column keeps, so
    // the timeline has to say it came last.
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    await ruleSetting('low');
    const hold = holdNextTransaction('before');
    const rule = runAutomations('on_update', id);
    await hold.atHold;

    answers('urgent');
    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
    hold.release();
    await rule;

    expect(await priorityOf(id)).toBe('low');
    const changes = await eventsOf(id, 'priority_changed');
    expect(changes.map((event) => event.actorLabel)).toEqual([
      PRIORITY_AI_ACTOR,
      'automation:Back to normal',
    ]);
  });
});

describe('classifyMessagePriority: the rules that watch priority', () => {
  async function escalateUrgent() {
    await db.insert(automationRules).values({
      name: 'Escalate urgent',
      trigger: 'on_update',
      conditions: { all: [{ field: 'priority', op: 'eq', value: 'urgent' }] },
      actions: [{ type: 'add_tags', tags: ['escalated'] }],
    });
  }

  async function tagsOf(conversationId: string): Promise<string[]> {
    const [row] = await db
      .select({ tags: conversations.tags })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return row!.tags;
  }

  it('runs the on_update rules after it applies a change, as a console edit does', async () => {
    await escalateUrgent();
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      outcome: 'applied',
    });
    expect(await tagsOf(id)).toEqual(['escalated']);
  });

  it('runs no rule for an answer it did not apply', async () => {
    // A rule that matches the ticket as it stands, so the only thing keeping it
    // from running is that nothing was applied.
    await db.insert(automationRules).values({
      name: 'Watch everything',
      trigger: 'on_update',
      conditions: { all: [{ field: 'priority', op: 'eq', value: 'medium' }] },
      actions: [{ type: 'add_tags', tags: ['ran'] }],
    });
    const id = await ticket();
    const below = await inbound(id, 'هرفع قضية', { createdAt: new Date(Date.now() - MINUTE) });
    answers('urgent', 0.4);
    expect(await classifyMessagePriority(below, { baseUrl: BASE })).toMatchObject({
      outcome: 'below_threshold',
    });

    vi.stubEnv('PRIORITY_AI', 'shadow');
    const shadow = await inbound(id, 'هرفع قضية تاني');
    answers('urgent');
    expect(await classifyMessagePriority(shadow, { baseUrl: BASE })).toMatchObject({
      outcome: 'would_apply',
    });

    expect(await tagsOf(id)).toEqual([]);
  });
});

/**
 * Jev's answer landing while the router finishes a decision on the ticket:
 * phase one written, its pass claimed and reading the ticket at medium, the
 * hold not yet ended (`lib/routing/apply.ts`). The classifier's own pass, run
 * after its commit, was unordered with the router's end of the hold, and a
 * rule keyed on priority moved the ticket to Escalations after the router had
 * handed it to Omar in Sales — `assign_group` never touches an assignee, so
 * Omar held an Escalations ticket. Handed to the router (`deferToRouter`), the
 * pass runs again on the urgent ticket before anybody is assigned.
 *
 * The router's calls and the classifier's are told apart by who opened each
 * transaction (`routeWithAnswerBetween`), so the answer lands at a named point
 * in the decision and its follow-ups lag the router — the order that made the
 * difference, made certain.
 */
describe('classifyMessagePriority on a decision in flight', () => {
  let people = 0;
  // Every step after the commits is best-effort and logs rather than throws,
  // so a step that failed shows only here.
  let errors: MockInstance;

  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function agentIn(groupName: string, name: string) {
    people += 1;
    const [agent] = await db
      .insert(agents)
      .values({
        name,
        email: `agent${people}@shipblu.test`,
        presence: 'online',
        lastSeenAt: new Date(),
      })
      .returning({ id: agents.id });
    const [group] = await db
      .insert(groups)
      .values({ name: groupName, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
      .returning({ id: groups.id });
    await db.insert(groupMembers).values({ groupId: group!.id, agentId: agent!.id });
    return { agentId: agent!.id, groupId: group!.id };
  }

  /**
   * An email ticket in `groupId` on a mailbox that routes by category, held as
   * the insert holds one and begun as the creation pass begins it; and the
   * customer's opening message, which the classifier answers.
   */
  async function heldTicket(groupId: string) {
    await db.execute(sql`
      insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
      values (1, 'apply', 0.6, 5)
      on conflict (id) do update set mode = excluded.mode`);
    forgetCategoryAiSettings();
    const [channel] = await db
      .insert(channels)
      .values({
        type: 'email',
        name: 'Support mail',
        config: {},
        defaultGroupId: groupId,
        routingMode: 'category',
      })
      .returning({ id: channels.id });
    const plan = { start: 'live', channelId: channel!.id, windowMinutes: 5 } as const;
    const now = new Date();
    const id = await ticket({
      channel: 'email',
      channelId: channel!.id,
      groupId,
      ...routingWindowValues(plan, {}, now),
    });
    const messageId = await inbound(id, 'هرفع قضية لو الفلوس موصلتش', { createdAt: now });
    await db.transaction((tx) =>
      startRouting(tx, plan, { conversationId: id, messageId, groupId }, now),
    );
    expect(await beginRouting(id)).toBe('continue');
    return { id, messageId };
  }

  async function holder(id: string) {
    const [row] = await db
      .select({ groupId: conversations.groupId, assigneeAgentId: conversations.assigneeAgentId })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  /** The lines the page draws, by `created_at`: whether the rules ran before the assignment. */
  async function linesOf(id: string) {
    const rows = await db
      .select({ type: conversationEvents.type })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, id),
          inArray(conversationEvents.type, ['routed', 'tagged', 'group_changed', 'assigned']),
        ),
      )
      .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
    return rows.map((row) => row.type);
  }

  it('hands its rules to the router, which moves the urgent ticket before anybody is assigned', async () => {
    const home = await agentIn('Home', 'Hana Home');
    const sales = await agentIn('Sales', 'Omar Sales');
    const escalations = await agentIn('Escalations', 'Ezz Escalations');
    const [salesCategory] = await db
      .update(ticketCategories)
      .set({ routeGroupId: sales.groupId })
      .where(eq(ticketCategories.key, 'sales'))
      .returning({ id: ticketCategories.id });
    const { id, messageId } = await heldTicket(home.groupId);
    // Jev's category answer, which the router then decides on.
    expect(
      (await setConversationCategory(id, salesCategory!.id, { label: 'jev:category' })).outcome,
    ).toBe('changed');
    await db.insert(automationRules).values([
      {
        name: 'Count passes',
        trigger: 'on_update',
        conditions: { all: [] },
        actions: [{ type: 'add_tags', tags: ['seen'] }],
        position: 0,
      },
      {
        name: 'Urgent goes to Escalations',
        trigger: 'on_update',
        conditions: { field: 'priority', op: 'eq', value: 'urgent' },
        actions: [{ type: 'assign_group', groupId: escalations.groupId }],
        position: 1,
      },
    ]);
    answers('urgent');

    // Phase one, then the claim that reads the ticket for the pass: the answer
    // lands after that read and before the pass acts on it.
    const { routed, answered } = await routeWithAnswerBetween({
      route: () => routeNow(id, { label: 'jev:category' }),
      afterRouterTransaction: 2,
      answer: () => classifyMessagePriority(messageId, { baseUrl: BASE }),
    });

    expect(routed).toBe('decided');
    expect(answered).toMatchObject({ status: 'recorded', outcome: 'applied' });
    expect(await priorityOf(id)).toBe('urgent');
    expect(await holder(id)).toEqual({
      groupId: escalations.groupId,
      assigneeAgentId: escalations.agentId,
    });
    // The pass that read medium, the one that read urgent and moved the ticket
    // on, and only then the assignment — no pass of the classifier's own.
    expect(await linesOf(id)).toEqual(['routed', 'tagged', 'tagged', 'group_changed', 'assigned']);
    expect(errors).not.toHaveBeenCalled();
  });

  // Seventy minutes old: medium owes a first response at 120, urgent at 60, so
  // the urgent answer makes the ticket overdue. Without routing the classifier
  // re-times the clocks and then runs its pass, so a rule asking whether the
  // ticket is overdue reads the urgent deadline. Handed to the router, the
  // classifier runs no pass, and the router's runs again the moment the answer
  // commits: re-timed after that commit, the pass read medium's deadline, the
  // escalation never ran, and Omar was given the ticket in Sales.
  it('re-times the clocks before the router’s pass reads them', async () => {
    await defaultPolicy();
    const home = await agentIn('Home', 'Hana Home');
    const sales = await agentIn('Sales', 'Omar Sales');
    const escalations = await agentIn('Escalations', 'Ezz Escalations');
    const [salesCategory] = await db
      .update(ticketCategories)
      .set({ routeGroupId: sales.groupId })
      .where(eq(ticketCategories.key, 'sales'))
      .returning({ id: ticketCategories.id });
    const { id, messageId } = await heldTicket(home.groupId);
    await db
      .update(conversations)
      .set({ createdAt: new Date(Date.now() - 70 * MINUTE) })
      .where(eq(conversations.id, id));
    await applySlaOnCreate(id);
    expect((await firstResponseDue(id))!.getTime()).toBeGreaterThan(Date.now());
    expect(
      (await setConversationCategory(id, salesCategory!.id, { label: 'jev:category' })).outcome,
    ).toBe('changed');
    await db.insert(automationRules).values({
      name: 'Overdue escalates',
      trigger: 'on_update',
      conditions: { field: 'is_first_response_overdue', op: 'eq', value: true },
      actions: [{ type: 'assign_group', groupId: escalations.groupId }],
    });
    answers('urgent');

    const { routed, answered } = await routeWithAnswerBetween({
      route: () => routeNow(id, { label: 'jev:category' }),
      afterRouterTransaction: 2,
      answer: () => classifyMessagePriority(messageId, { baseUrl: BASE }),
    });

    expect(routed).toBe('decided');
    expect(answered).toMatchObject({ status: 'recorded', outcome: 'applied' });
    expect((await firstResponseDue(id))!.getTime()).toBeLessThan(Date.now());
    expect(await holder(id)).toEqual({
      groupId: escalations.groupId,
      assigneeAgentId: escalations.agentId,
    });
    expect(errors).not.toHaveBeenCalled();
  });

  // The answer lands on a ticket resolved once the decision was in flight —
  // after phase one, before the router's pass is claimed. The router owes a
  // ticket nobody may work no pass and gives its own up, so handed to it, the
  // rules keyed on the urgent priority never ran; a resolved ticket that never
  // routed runs them after the same answer. Not handed over, the classifier
  // runs its own pass, and the router assigns nobody.
  it('runs its own rules on a ticket resolved after phase one', async () => {
    const home = await agentIn('Home', 'Hana Home');
    const sales = await agentIn('Sales', 'Omar Sales');
    const [salesCategory] = await db
      .update(ticketCategories)
      .set({ routeGroupId: sales.groupId })
      .where(eq(ticketCategories.key, 'sales'))
      .returning({ id: ticketCategories.id });
    const [resolved] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    const { id, messageId } = await heldTicket(home.groupId);
    expect(
      (await setConversationCategory(id, salesCategory!.id, { label: 'jev:category' })).outcome,
    ).toBe('changed');
    await db.insert(automationRules).values({
      name: 'Urgent is noted',
      trigger: 'on_update',
      conditions: { field: 'priority', op: 'eq', value: 'urgent' },
      actions: [{ type: 'add_tags', tags: ['urgent-seen'] }],
    });
    answers('urgent');

    const { routed, answered } = await routeWithAnswerBetween({
      route: () => routeNow(id, { label: 'jev:category' }),
      afterRouterTransaction: 1,
      answer: async () => {
        await db
          .update(conversations)
          .set({ statusId: resolved!.id, resolvedAt: new Date() })
          .where(eq(conversations.id, id));
        return classifyMessagePriority(messageId, { baseUrl: BASE });
      },
    });

    expect(routed).toBe('decided');
    expect(answered).toMatchObject({ status: 'recorded', outcome: 'applied' });
    const [row] = await db
      .select({ tags: conversations.tags, routingDecidedAt: conversations.routingDecidedAt })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.tags).toEqual(['urgent-seen']);
    expect(row!.routingDecidedAt).not.toBeNull();
    expect((await holder(id)).assigneeAgentId).toBeNull();
    expect(errors).not.toHaveBeenCalled();
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

  // Ingest no longer queues one, and a job run by hand still asks nothing:
  // `[reacted 🙏]` is our placeholder, which `hasCustomerText` already refuses.
  it('skips a WhatsApp reaction, whose text is ours', async () => {
    const id = await ticket({ channel: 'whatsapp' });
    const messageId = await inbound(id, '[reacted 🙏]', { meta: { whatsappType: 'reaction' } });
    const mock = answers('urgent');

    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toEqual({
      status: 'skipped',
      reason: 'no text',
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

  it('skips a photo or a voice note sent with no words, which the model cannot see', async () => {
    const id = await ticket({ channel: 'whatsapp' });
    for (const placeholder of [
      '[image]',
      '[voice note]',
      '[document: invoice.pdf]',
      '[2 attachments]',
    ]) {
      const messageId = await inbound(id, placeholder);
      answers('low', 0.95);
      expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toEqual({
        status: 'skipped',
        reason: 'no text',
      });
    }
    expect(await db.select().from(aiPriorityRuns)).toEqual([]);
    expect(await priorityOf(id)).toBe('medium');
  });

  it('asks only about what the ticket’s own customer wrote', async () => {
    // A public comment thread: anybody may reply under the customer's comment,
    // and ingest files the reply on the customer's ticket.
    const [customer] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const [stranger] = await db
      .insert(contacts)
      .values({ name: 'Passer-by' })
      .returning({ id: contacts.id });
    const id = await ticket({
      channel: 'facebook_comment',
      requesterContactId: customer!.id,
      externalId: 'facebook:comment:1',
    });
    await inbound(id, 'هرفع قضية عليكم كلكم', {
      authorContactId: stranger!.id,
      createdAt: new Date(Date.now() - 2 * MINUTE),
    });
    const theirs = await inbound(id, 'نصابين محدش بيرد', { authorContactId: stranger!.id });

    answers('urgent', 0.95);
    expect(await classifyMessagePriority(theirs, { baseUrl: BASE })).toEqual({
      status: 'skipped',
      reason: 'not written by the requester',
    });
    expect(await priorityOf(id)).toBe('medium');

    // The customer's own words are asked about, without the stranger's as context.
    const own = await inbound(id, 'الطلب وصل؟', { authorContactId: customer!.id });
    const mock = answers('low', 0.95);
    await classifyMessagePriority(own, { baseUrl: BASE });
    const body = JSON.parse(String((mock.mock.calls[0]![1] as RequestInit).body)) as {
      state: Record<string, unknown>;
    };
    expect(JSON.stringify(body.state)).not.toContain('هرفع قضية');
  });

  // The job compares the message's author with the requester again under the
  // ticket's lock. A merge of the customer into another record, committing
  // while the job asked the provider, moves both; the author the job first
  // read is the record merged away, and compared with the new requester it
  // would refuse the customer's own words as somebody else's.
  it('still answers the customer whose record was merged while it asked', async () => {
    const id = await ticket();
    const [opened] = await db
      .select({ requester: conversations.requesterContactId })
      .from(conversations)
      .where(eq(conversations.id, id));
    const requester = opened!.requester;
    const messageId = await inbound(id, 'هرفع قضية لو الفلوس موصلتش', {
      authorContactId: requester,
    });
    const [survivor] = await db
      .insert(contacts)
      .values({ name: 'Amira Hassan' })
      .returning({ id: contacts.id });
    answers('urgent', 0.95);

    let raced: Promise<ClassifyResult> | undefined;
    await db.transaction(async (tx) => {
      // What `mergeContacts` does to her tickets and then to her messages.
      await tx
        .update(conversations)
        .set({ requesterContactId: survivor!.id })
        .where(eq(conversations.requesterContactId, requester));
      await tx
        .update(messages)
        .set({ authorContactId: survivor!.id })
        .where(eq(messages.authorContactId, requester));
      raced = classifyMessagePriority(messageId, { baseUrl: BASE });
      await untilSomebodyWaits();
    });

    expect(await raced).toEqual({ status: 'recorded', outcome: 'applied', predicted: 'urgent' });
    expect(await priorityOf(id)).toBe('urgent');
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

  it('answers a message whose earlier attempt failed, when it is run again', async () => {
    // A wrong key fails every message; once it is fixed, `npm run job` re-runs one.
    const id = await ticket();
    const messageId = await inbound(id, 'هرفع قضية');
    stubFetch(() => new Response('bad key', { status: 401 }));
    await classifyMessagePriority(messageId, { baseUrl: BASE });

    answers('urgent');
    expect(await classifyMessagePriority(messageId, { baseUrl: BASE })).toMatchObject({
      status: 'recorded',
      outcome: 'applied',
    });
    expect(await runOf(messageId)).toMatchObject({ outcome: 'applied', error: null });
    expect(await priorityOf(id)).toBe('urgent');
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

  it('never queues a caption-less photo, whose text is ours and not the customer’s', async () => {
    const id = await ticket({ channel: 'whatsapp' });
    const messageId = await inbound(id, '[voice note]');
    await enqueuePriorityClassification({
      conversationId: id,
      messageId,
      bodyText: '[voice note]',
      kind: 'reply',
      direction: 'inbound',
    });

    expect(await queued()).toEqual([]);
  });
});

/** Who opened a transaction: the router's call, or the classifier's answer. */
const opener = new AsyncLocalStorage<'router' | 'answer'>();

/**
 * Runs `route` with `answer` landing once the router's `afterRouterTransaction`th
 * transaction has committed (1 is phase one), before the router goes on — the
 * classifier's write commits there. Every transaction the classifier opens
 * after its write waits until the router has finished: its follow-ups lagging
 * the router, made certain. Transactions are told apart by who opened them, so
 * the router's own steps and the classifier's are counted apart however they
 * interleave. `routeWithEditBetween` in `app/(console)/ticket-actions.db.test.ts`
 * is the same harness, for a console edit.
 */
async function routeWithAnswerBetween({
  route,
  afterRouterTransaction,
  answer,
}: {
  route: () => Promise<RouteResult>;
  afterRouterTransaction: number;
  answer: () => Promise<unknown>;
}): Promise<{ routed: RouteResult; answered: unknown }> {
  const real = PgDatabase.prototype.transaction;
  let routerOpened = 0;
  let answerOpened = 0;
  let answered: Promise<unknown> | undefined;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => (wrote = resolve));

  const spy = vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementation(async function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    const who = opener.getStore();
    if (who === 'answer') {
      const nth = ++answerOpened;
      if (nth > 1) await released;
      const result: unknown = await real.call(this, run, config);
      if (nth === 1) wrote();
      return result as never;
    }
    if (who === 'router') {
      const nth = ++routerOpened;
      const result: unknown = await real.call(this, run, config);
      if (nth === afterRouterTransaction) {
        answered = opener.run('answer', answer);
        await Promise.race([written, answered]);
      }
      return result as never;
    }
    return real.call(this, run, config) as never;
  });

  try {
    const routed = await opener.run('router', route);
    release();
    return { routed, answered: await answered };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Resolves once another session is waiting on a lock this test holds — a copy
 * of the one in `lib/csat/meta-feedback.db.test.ts`.
 */
async function untilSomebodyWaits(): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (row && row.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing came to wait on the lock this test holds');
}
