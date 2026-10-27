import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  CATEGORY_AI_LIVE_LABEL,
  agents,
  aiCategoryRuns,
  autoResponses,
  contacts,
  conversationEvents,
  conversations,
  jobs,
  messages,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { maybeSendAutoResponse } from '@/lib/auto-response';
import { setConversationCategory } from '@/lib/categories/write';
import { resetEnvCache } from '@/lib/env';
import { stubFetch } from '@/lib/testing/fetch';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { cairo } from '@/lib/testing/time';
import { CATEGORY_AI_ACTOR } from './decide';
import { enqueueCategoryClassification } from './enqueue';
import { requestFingerprint } from './request';
import { classifyMessageCategory } from './run';
import { forgetCategoryAiSettings } from './settings';

/**
 * The category classifier against Postgres, with TypeSafe answered by the
 * test (`plans/ticket-category-routing.md`, decision 4).
 *
 * What only a database shows: that the write is guarded by what the ticket's
 * history says rather than by what the job was told, that the earliest message
 * settles the ticket whichever job runs first, that an owned, settled or
 * capped ticket is never sent to Jev at all, and that every statement here
 * plans — CI's handler loop skips this job, because it needs the provider.
 */

withCleanDatabase();

const BASE = 'https://typesafe.test';

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  forgetCategoryAiSettings();
  await mode('apply');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

/**
 * The switch, written straight to its row. No agent is named: every test
 * starts from a truncated `agents`, so an id kept from an earlier one is a
 * foreign key to nobody. `settings.db.test.ts` covers the admin's write.
 */
async function mode(value: 'off' | 'shadow' | 'apply', minProbability = 0.6): Promise<void> {
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability)
    values (1, ${value}, ${minProbability})
    on conflict (id) do update set mode = excluded.mode, min_probability = excluded.min_probability`);
  forgetCategoryAiSettings();
}

/** TypeSafe choosing `choice` with `probability`, the rest spread over the others. */
function answers(choice: string, probability = 0.9) {
  return stubFetch(() =>
    Response.json({
      model: 'jev-1.13.0',
      answers: {
        ticket_category: {
          type: 'choice',
          choice,
          probabilities: { sales: 0.02, customer_support: 0.03, [choice]: probability },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 500 },
    }),
  );
}

/** Answers in turn, one per call. */
function answersInTurn(...choices: string[]) {
  let call = 0;
  return stubFetch(() => {
    const choice = choices[Math.min(call, choices.length - 1)]!;
    call += 1;
    return Response.json({
      model: 'jev-1.13.0',
      answers: {
        ticket_category: {
          type: 'choice',
          choice,
          probabilities: { [choice]: 0.9 },
          confidence: 0.8,
        },
      },
    });
  });
}

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  return row!.id;
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: status!.id,
      channel: 'whatsapp',
      ...values,
    })
    .returning({ id: conversations.id });
  return { id: row!.id, requester: contact!.id };
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

async function carried(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ categoryId: conversations.categoryId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row!.categoryId;
}

async function categoryEvents(conversationId: string) {
  return db
    .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'category_changed'),
      ),
    )
    .orderBy(asc(conversationEvents.createdAt));
}

async function runsOf(conversationId: string) {
  return db
    .select({
      messageId: aiCategoryRuns.messageId,
      runLabel: aiCategoryRuns.runLabel,
      outcome: aiCategoryRuns.outcome,
      predictedKey: aiCategoryRuns.predictedKey,
      model: aiCategoryRuns.model,
      error: aiCategoryRuns.error,
      fingerprint: aiCategoryRuns.requestFingerprint,
      minProbability: aiCategoryRuns.minProbability,
      baselineCategoryKey: aiCategoryRuns.baselineCategoryKey,
    })
    .from(aiCategoryRuns)
    .where(eq(aiCategoryRuns.conversationId, conversationId))
    .orderBy(asc(aiCategoryRuns.messageCreatedAt));
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

describe('classifyMessageCategory, writing', () => {
  it('writes a confident answer, with one event naming Jev and what it weighed', async () => {
    const calls = answers('sales');
    const { id } = await ticket();
    const message = await inbound(id, 'محتاجه اعرف الاسعار الاول قبل التسجيل');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'recorded',
      outcome: 'applied',
      predicted: 'sales',
    });

    expect(await carried(id)).toBe(await categoryId('sales'));
    const events = await categoryEvents(id);
    expect(events).toEqual([
      {
        actorLabel: CATEGORY_AI_ACTOR,
        data: expect.objectContaining({
          from: null,
          to: await categoryId('sales'),
          key: 'sales',
          probability: 0.9,
          model: 'jev-1.13.0',
          messageId: message,
          runLabel: CATEGORY_AI_LIVE_LABEL,
        }),
      },
    ]);

    const [run] = await runsOf(id);
    expect(run).toMatchObject({
      runLabel: 'live',
      outcome: 'applied',
      predictedKey: 'sales',
      model: 'jev-1.13.0',
      minProbability: 0.6,
      baselineCategoryKey: 'sales',
    });
    // The fingerprint is of the question actually sent.
    const sent = JSON.parse(String(calls.mock.calls[0]![1]!.body)) as {
      questions: Record<string, never>;
      state: Record<string, unknown>;
    };
    expect(run!.fingerprint).toBe(requestFingerprint(sent.questions));
    expect(sent.state.is_public_comment).toBe(false);
  });

  it('records a would-be write in shadow, and writes nothing', async () => {
    answers('sales');
    await mode('shadow');
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'would_apply',
    });
    expect(await carried(id)).toBeNull();
    expect(await categoryEvents(id)).toEqual([]);
  });

  it('never settles on unknown, so the next message is still asked', async () => {
    answersInTurn('unknown', 'customer_support');
    const { id } = await ticket();
    const hello = await inbound(id, 'السلام عليكم', { createdAt: at(2) });
    const question = await inbound(id, 'فين الشحنه', { createdAt: at(1) });

    await expect(classifyMessageCategory(hello, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'unknown',
    });
    await expect(classifyMessageCategory(question, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(await carried(id)).toBe(await categoryId('customer_support'));
  });

  it('holds an answer below the threshold, and records the threshold it was held to', async () => {
    answers('sales', 0.55);
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'below_threshold',
    });
    expect(await carried(id)).toBeNull();
    expect((await runsOf(id))[0]).toMatchObject({ minProbability: 0.6 });
  });
});

describe('classifyMessageCategory, who owns the category', () => {
  // Decided before the call, so an owned ticket costs no answer.
  it('leaves a category a person chose, without asking', async () => {
    const calls = answers('sales');
    const { id } = await ticket();
    await setConversationCategory(id, await categoryId('merchant_support'), {
      label: 'automation:Merchant number',
    });
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'recorded',
      outcome: 'owned',
      predicted: null,
    });
    expect(calls).not.toHaveBeenCalled();
    expect(await carried(id)).toBe(await categoryId('merchant_support'));
    expect((await runsOf(id))[0]).toMatchObject({ outcome: 'owned', model: null });
  });

  it('leaves a ticket an agent opened, whose category is the agent’s', async () => {
    const calls = answers('sales');
    const { id } = await ticket();
    await db.insert(conversationEvents).values({ conversationId: id, type: 'opened_by_agent' });
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'owned',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  // Read before the call, the column and the events are two statements, and a
  // Jev write committing between them leaves a column that disagrees with
  // Jev's last event — the state built here. Only the look under the lock may
  // call that owned; before the call the events alone decide, so Jev is asked.
  it('decides the column half of ownership only under the lock', async () => {
    const calls = answers('sales');
    const { id } = await ticket();
    await db.insert(conversationEvents).values({
      conversationId: id,
      type: 'category_changed',
      actorLabel: CATEGORY_AI_ACTOR,
      data: { from: null, to: await categoryId('customer_support') },
    });
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'owned',
      predicted: 'sales',
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  // A person or a rule filing the ticket while Jev is being asked wins,
  // because the facts are read again under the lock after the call.
  it.each(['a person', 'a rule'])(
    'loses to %s who filed it while the call was out',
    async (who) => {
      const support = await categoryId('customer_support');
      const { id } = await ticket();
      const [agent] = await db
        .insert(agents)
        .values({ name: 'Mona', email: 'mona@shipblu.test' })
        .returning({ id: agents.id });
      const actor = who === 'a person' ? { agentId: agent!.id } : { label: 'automation:Support' };
      stubFetch(async () => {
        await setConversationCategory(id, support, actor);
        return Response.json({
          model: 'jev-1.13.0',
          answers: {
            ticket_category: { type: 'choice', choice: 'sales', probabilities: { sales: 0.9 } },
          },
        });
      });
      const message = await inbound(id, 'بكام الشحن؟');

      await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
        outcome: 'owned',
      });
      expect(await carried(id)).toBe(support);
    },
  );
});

describe('classifyMessageCategory, settling', () => {
  it('leaves a settled ticket alone on a later message, without asking', async () => {
    answers('sales');
    const { id } = await ticket();
    const first = await inbound(id, 'بكام الشحن؟', { createdAt: at(2) });
    const later = await inbound(id, 'فين الشحنه', { createdAt: at(1) });
    await classifyMessageCategory(first, { baseUrl: BASE });

    const calls = answers('customer_support');
    await expect(classifyMessageCategory(later, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'after_settle',
    });
    expect(calls).not.toHaveBeenCalled();
    expect(await carried(id)).toBe(await categoryId('sales'));
  });

  // Jobs retry out of order: the earliest message's answer settles the ticket
  // whichever job ran first.
  it('lets an earlier message answered late take the settle over', async () => {
    const { id } = await ticket();
    const first = await inbound(id, 'بكام الشحن؟', { createdAt: at(2) });
    const later = await inbound(id, 'فين الشحنه', { createdAt: at(1) });

    answers('customer_support');
    await classifyMessageCategory(later, { baseUrl: BASE });
    expect(await carried(id)).toBe(await categoryId('customer_support'));

    answers('sales');
    await expect(classifyMessageCategory(first, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(await carried(id)).toBe(await categoryId('sales'));
    expect((await categoryEvents(id)).map((event) => (event.data as { key: string }).key)).toEqual([
      'customer_support',
      'sales',
    ]);
  });

  // A shadow `would_apply` settles in shadow, or shadow would measure a
  // classifier that never settles — and does not once apply is on.
  it('settles on a would-be write in shadow, and not after the switch to apply', async () => {
    await mode('shadow');
    answers('sales');
    const { id } = await ticket();
    const first = await inbound(id, 'بكام الشحن؟', { createdAt: at(2) });
    const later = await inbound(id, 'بكام الشحن للاسكندرية؟', { createdAt: at(1) });
    await classifyMessageCategory(first, { baseUrl: BASE });

    await mode('apply');
    await expect(classifyMessageCategory(later, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'applied',
    });
  });
});

describe('classifyMessageCategory, the cap', () => {
  it('stops once somebody has answered the ticket, without asking', async () => {
    const calls = answers('sales');
    const { id } = await ticket({ firstRespondedAt: new Date() });
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'capped',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('stops after five messages were asked about, and not before', async () => {
    answers('unknown');
    const { id } = await ticket();
    const sent: string[] = [];
    for (let i = 6; i >= 1; i--) sent.push(await inbound(id, `رسالة ${i}`, { createdAt: at(i) }));

    for (const message of sent.slice(0, 5)) {
      await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
        outcome: 'unknown',
      });
    }
    await expect(classifyMessageCategory(sent[5]!, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'capped',
    });
  });

  // A failed row keeps the prediction a retired category refused; it is a gap,
  // not an answer, so it is not one of the five.
  it('does not count a failed row towards the cap', async () => {
    answers('sales');
    const { id } = await ticket();
    for (let i = 7; i >= 3; i--) {
      const message = await inbound(id, `رسالة ${i}`, { createdAt: at(i) });
      await db.insert(aiCategoryRuns).values({
        conversationId: id,
        messageId: message,
        messageCreatedAt: at(i),
        runLabel: CATEGORY_AI_LIVE_LABEL,
        mode: 'apply',
        requestFingerprint: 's1-0000000000000000',
        channel: 'whatsapp',
        predictedKey: 'sales',
        outcome: 'failed',
        error: 'category sales was retired while Jev was asked',
      });
    }
    const message = await inbound(id, 'بكام الشحن؟', { createdAt: at(1) });

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'applied',
    });
  });

  // Deleting a message sets its rows' message id to null; the answer was still
  // paid for, and `<>` against a null would have dropped it from the count.
  it('still counts the answers to messages deleted since', async () => {
    answers('unknown');
    const { id } = await ticket();
    const asked: string[] = [];
    for (let i = 7; i >= 3; i--) asked.push(await inbound(id, `رسالة ${i}`, { createdAt: at(i) }));
    for (const message of asked) await classifyMessageCategory(message, { baseUrl: BASE });
    await db.delete(messages).where(inArray(messages.id, asked));
    const message = await inbound(id, 'بكام الشحن؟', { createdAt: at(1) });

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'capped',
    });
  });

  // The acknowledgement is software, so it is not a first response: the
  // customer's next message is still asked about. Driven through the real
  // sender, so a change that started the clock on it would fail here.
  it('still asks after an out-of-hours acknowledgement', async () => {
    answersInTurn('unknown', 'sales');
    await db.insert(autoResponses).values({
      channel: 'facebook_comment',
      bodyEn: 'Thanks for your comment — we will reply when we open.',
    });
    const night = cairo('2026-10-21T23:00');
    const { id, requester } = await ticket({
      channel: 'facebook_comment',
      externalId: 'facebook:comment:post-1_c1',
      lastCustomerMessageAt: night,
    });
    const comment = (commentId: string, bodyText: string, createdAt: Date) =>
      inbound(id, bodyText, {
        authorContactId: requester,
        channelMessageId: commentId,
        meta: { metaKind: 'comment', platform: 'facebook', commentId, isPublic: true },
        createdAt,
      });
    const first = await comment('post-1_c1', 'السلام عليكم', cairo('2026-10-21T22:50'));
    await classifyMessageCategory(first, { baseUrl: BASE });

    await maybeSendAutoResponse({ conversationId: id, messageId: first }, night);
    const outbound = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.direction, 'outbound')));
    expect(outbound).toHaveLength(1);

    const second = await comment('post-1_c2', 'بكام الشحن؟', cairo('2026-10-21T22:55'));
    await expect(classifyMessageCategory(second, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'applied',
      predicted: 'sales',
    });
  });
});

describe('classifyMessageCategory, racing', () => {
  // The later message's job asks while the earlier one's write holds the
  // ticket's row, uncommitted: its first look cannot see that write, so it
  // asks, and the look under the lock is what stops it writing over the settle.
  it('lets a settle that commits during the call win over a later message', async () => {
    answersInTurn('sales', 'customer_support');
    const { id } = await ticket();
    const first = await inbound(id, 'بكام الشحن؟', { createdAt: at(2) });
    const later = await inbound(id, 'فين الشحنه', { createdAt: at(1) });

    const hold = holdNextTransaction('after');
    const settling = classifyMessageCategory(first, { baseUrl: BASE });
    await hold.atHold;
    const racing = classifyMessageCategory(later, { baseUrl: BASE });
    await untilWaitingOnALock(db);
    hold.release();

    await expect(settling).resolves.toMatchObject({ outcome: 'applied', predicted: 'sales' });
    await expect(racing).resolves.toMatchObject({
      outcome: 'after_settle',
      predicted: 'customer_support',
    });
    expect(await carried(id)).toBe(await categoryId('sales'));
    expect(await categoryEvents(id)).toHaveLength(1);
  });

  // Marked spam, deleted or merged while Jev was asked: in nobody's queue now.
  it('writes nothing to a ticket that left every queue during the call', async () => {
    const { id } = await ticket();
    stubFetch(async () => {
      await db.update(conversations).set({ isSpam: true }).where(eq(conversations.id, id));
      return Response.json({
        model: 'jev-1.13.0',
        answers: {
          ticket_category: { type: 'choice', choice: 'sales', probabilities: { sales: 0.9 } },
        },
      });
    });
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'skipped',
      reason: 'spam',
    });
    expect(await carried(id)).toBeNull();
    expect(await runsOf(id)).toEqual([]);
  });
});

describe('classifyMessageCategory, what is asked about', () => {
  // A passer-by's "price?" under the customer's comment must not file the
  // complaint as a sales enquiry.
  it('skips a message the requester did not write, and writes no row', async () => {
    const calls = answers('sales');
    const { id } = await ticket({
      channel: 'facebook_comment',
      externalId: 'facebook:comment:111_222',
    });
    const [passerBy] = await db
      .insert(contacts)
      .values({ name: 'Passer-by' })
      .returning({ id: contacts.id });
    const message = await inbound(id, 'بكام؟', { authorContactId: passerBy!.id });

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'skipped',
      reason: 'not written by the requester',
    });
    expect(calls).not.toHaveBeenCalled();
    expect(await runsOf(id)).toEqual([]);
  });

  it('tells Jev a comment is public', async () => {
    const calls = answers('sales');
    const { id, requester } = await ticket({
      channel: 'facebook_comment',
      externalId: 'facebook:comment:111_333',
    });
    const message = await inbound(id, 'بكام الشحن؟', { authorContactId: requester });

    await classifyMessageCategory(message, { baseUrl: BASE });
    const sent = JSON.parse(String(calls.mock.calls[0]![1]!.body)) as {
      state: Record<string, unknown>;
    };
    expect(sent.state).toMatchObject({ channel: 'facebook', is_public_comment: true });
  });

  it('skips while the switch is off', async () => {
    await mode('off');
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');
    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'skipped',
      reason: 'the category classifier is off',
    });
  });
});

/** TypeSafe answering `choice`, once `during` has happened — what changed while it was asked. */
function answersAfter(during: () => Promise<void>, choice = 'sales', probability = 0.9) {
  return stubFetch(async () => {
    await during();
    return Response.json({
      model: 'jev-1.13.0',
      answers: {
        ticket_category: {
          type: 'choice',
          choice,
          probabilities: { [choice]: probability },
          confidence: 0.8,
        },
      },
    });
  });
}

async function statusNamed(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

describe('classifyMessageCategory, what changed while Jev was asked', () => {
  // An admin switching the classifier off because of what it filed stops the
  // write already waiting on its answer, and leaves no row: the switch found
  // off.
  it('writes nothing once the switch was turned off during the call', async () => {
    answersAfter(() => mode('off'));
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'skipped',
      reason: 'the category classifier was switched off',
    });
    expect(await carried(id)).toBeNull();
    expect(await runsOf(id)).toEqual([]);
  });

  it('records a shadow answer once the switch went back to shadow', async () => {
    answersAfter(() => mode('shadow'));
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      status: 'recorded',
      outcome: 'would_apply',
    });
    expect(await carried(id)).toBeNull();
    const [row] = await db
      .select({ mode: aiCategoryRuns.mode })
      .from(aiCategoryRuns)
      .where(eq(aiCategoryRuns.conversationId, id));
    expect(row).toEqual({ mode: 'shadow' });
  });

  it('weighs the answer against the threshold as it is once answered', async () => {
    answersAfter(() => mode('apply', 0.95), 'sales', 0.9);
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'below_threshold',
    });
    expect(await runsOf(id)).toEqual([
      expect.objectContaining({ outcome: 'below_threshold', minProbability: 0.95 }),
    ]);
  });

  it('never asks about a resolved ticket, as the backfill never files one', async () => {
    const calls = answers('sales');
    const { id } = await ticket({ statusId: await statusNamed('Resolved') });
    const message = await inbound(id, 'شكرا');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'skipped',
      reason: 'resolved or closed',
    });
    expect(calls).not.toHaveBeenCalled();
    expect(await runsOf(id)).toEqual([]);
  });

  it('files nothing on a ticket resolved during the call', async () => {
    const { id } = await ticket();
    const resolved = await statusNamed('Resolved');
    answersAfter(async () => {
      await db.update(conversations).set({ statusId: resolved }).where(eq(conversations.id, id));
    });
    const message = await inbound(id, 'شكرا');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'skipped',
      reason: 'resolved or closed',
    });
    expect(await carried(id)).toBeNull();
    expect(await runsOf(id)).toEqual([]);
  });

  // An agent's reply that sets the ticket pending, not yet committed when the
  // answer comes back: the look under the lock waits for it, and must find the
  // ticket at its new status. Joined to the status instead, the wait re-checked
  // the ticket against the status read before it, found none, and the job went
  // to `dead` as though the message were gone.
  it('finds a ticket a writer moved to another status while the answer waited for it', async () => {
    const { id } = await ticket();
    const pending = await statusNamed('Pending');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let writer: Promise<void> = Promise.resolve();
    answersAfter(
      () =>
        new Promise<void>((moved) => {
          writer = db.transaction(async (tx) => {
            await tx
              .update(conversations)
              .set({ statusId: pending })
              .where(eq(conversations.id, id));
            moved();
            await held;
          });
        }),
    );
    const message = await inbound(id, 'بكام الشحن؟');

    const classifying = classifyMessageCategory(message, { baseUrl: BASE });
    await untilWaitingOnALock(db);
    release();
    await writer;

    await expect(classifying).resolves.toMatchObject({ outcome: 'applied', predicted: 'sales' });
    expect(await carried(id)).toBe(await categoryId('sales'));
  });

  // The shadow measures the classifier apply turns on: an answer apply could
  // not write must not settle the ticket in shadow either.
  it('records a category retired during a shadow call as the failure apply would', async () => {
    await mode('shadow');
    answersAfter(async () => {
      await db
        .update(ticketCategories)
        .set({ isActive: false })
        .where(eq(ticketCategories.key, 'sales'));
    });
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'failed',
    });
    expect(await runsOf(id)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        error: 'category sales was retired while Jev was asked',
      }),
    ]);
  });
});

describe('classifyMessageCategory, again and after a failure', () => {
  it('answers a redelivered job from its row, without asking twice', async () => {
    const calls = answers('sales');
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await classifyMessageCategory(message, { baseUrl: BASE });
    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toEqual({
      status: 'already_classified',
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await categoryEvents(id)).toHaveLength(1);
  });

  it('records a permanent refusal, which a run by hand later replaces', async () => {
    stubFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'failed',
    });
    expect((await runsOf(id))[0]).toMatchObject({ outcome: 'failed', error: expect.any(String) });

    answers('sales');
    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(await runsOf(id)).toEqual([
      expect.objectContaining({ outcome: 'applied', error: null }),
    ]);
  });

  it('sends a transient failure back to the queue, recording nothing', async () => {
    stubFetch(() => new Response('busy', { status: 503 }));
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).rejects.toThrow();
    expect(await runsOf(id)).toEqual([]);
  });

  // A failed row does not settle and does not count towards the cap; a run by
  // hand asks again over the new list.
  it('records a category retired while Jev was asked as a failure, and writes nothing', async () => {
    const { id } = await ticket();
    const sales = await categoryId('sales');
    stubFetch(async () => {
      await db
        .update(ticketCategories)
        .set({ isActive: false })
        .where(eq(ticketCategories.id, sales));
      return Response.json({
        model: 'jev-1.13.0',
        answers: {
          ticket_category: { type: 'choice', choice: 'sales', probabilities: { sales: 0.9 } },
        },
      });
    });
    const message = await inbound(id, 'بكام الشحن؟');

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'failed',
    });
    expect(await carried(id)).toBeNull();
    expect((await runsOf(id))[0]).toMatchObject({
      outcome: 'failed',
      error: 'category sales was retired while Jev was asked',
    });
  });

  // Replaced whole: merged over the failure, the capped row kept its error —
  // which the table refuses beside any other outcome — and the prediction the
  // retired category had refused, which the cap would have counted.
  it('replaces a failure with an answer known before asking, leaving none of it behind', async () => {
    const { id } = await ticket();
    const sales = await categoryId('sales');
    stubFetch(async () => {
      await db
        .update(ticketCategories)
        .set({ isActive: false })
        .where(eq(ticketCategories.id, sales));
      return Response.json({
        model: 'jev-1.13.0',
        answers: {
          ticket_category: { type: 'choice', choice: 'sales', probabilities: { sales: 0.9 } },
        },
      });
    });
    const message = await inbound(id, 'بكام الشحن؟');
    await classifyMessageCategory(message, { baseUrl: BASE });
    await db
      .update(conversations)
      .set({ firstRespondedAt: new Date() })
      .where(eq(conversations.id, id));

    await expect(classifyMessageCategory(message, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'capped',
    });
    expect(await runsOf(id)).toEqual([
      expect.objectContaining({ outcome: 'capped', predictedKey: null, model: null, error: null }),
    ]);
  });

  // A backfill measures the archive under its own label, beside the live answer.
  it('keeps a live answer and a backfill’s answer for the same message apart', async () => {
    answers('sales');
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');
    await classifyMessageCategory(message, { baseUrl: BASE });
    const [live] = await db
      .select()
      .from(aiCategoryRuns)
      .where(eq(aiCategoryRuns.messageId, message));

    await db
      .insert(aiCategoryRuns)
      .values({ ...live!, id: undefined, runLabel: 'archive-1', mode: 'record' });

    expect((await runsOf(id)).map((run) => run.runLabel).sort()).toEqual(['archive-1', 'live']);
  });
});

describe('enqueueCategoryClassification', () => {
  const queued = async () =>
    (await db.select({ type: jobs.type }).from(jobs)).filter(
      (job) => job.type === 'classify_category',
    );

  it('queues a customer message on an unanswered ticket while the switch is on', async () => {
    const { id } = await ticket();
    const message = await inbound(id, 'بكام الشحن؟');
    await enqueueCategoryClassification({
      conversationId: id,
      messageId: message,
      bodyText: 'بكام الشحن؟',
      kind: 'reply',
      direction: 'inbound',
    });
    expect(await queued()).toHaveLength(1);
  });

  it.each([
    ['off', { mode: 'off' as const }],
    ['answered', { firstRespondedAt: new Date() }],
    ['the bot channel', { channel: 'whatsapp_bot' as const }],
  ])('queues nothing when %s', async (_name, over) => {
    if ('mode' in over) await mode(over.mode);
    const { id } = await ticket('mode' in over ? {} : over);
    const message = await inbound(id, 'بكام الشحن؟');
    await enqueueCategoryClassification({
      conversationId: id,
      messageId: message,
      bodyText: 'بكام الشحن؟',
      kind: 'reply',
      direction: 'inbound',
    });
    expect(await queued()).toEqual([]);
  });
});

describe('the tables', () => {
  // 0047 freed the name a fresh database would otherwise have given the old
  // subcategory table's key, so both databases name the new one alike.
  it('name their primary keys as production does', async () => {
    const rows = (await db.execute(sql`
      select conrelid::regclass::text as table_name, conname from pg_constraint
      where contype = 'p'
        and conrelid in ('public.ai_category_runs'::regclass, 'public.ai_subcategory_runs'::regclass,
                         'public.ticket_categories'::regclass, 'public.category_ai_settings'::regclass)
      order by 1`)) as unknown as { table_name: string; conname: string }[];
    expect(rows.map((row) => row.conname)).toEqual([
      'ai_category_runs_pkey',
      'ai_subcategory_runs_pkey',
      'category_ai_settings_pkey',
      'ticket_categories_pkey',
    ]);
  });

  it('hold the settings to one row, a known mode and the ranges', async () => {
    for (const statement of [
      sql`insert into category_ai_settings (id) values (2)`,
      sql`update category_ai_settings set mode = 'aplly' where id = 1`,
      sql`update category_ai_settings set min_probability = 1.5 where id = 1`,
      sql`update category_ai_settings set routing_window_minutes = 31 where id = 1`,
    ]) {
      await expect(db.execute(statement)).rejects.toThrow();
    }
  });
});
