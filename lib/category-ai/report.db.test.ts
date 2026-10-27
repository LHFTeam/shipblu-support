import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  aiCategoryRuns,
  contacts,
  conversationEvents,
  conversations,
  jobs,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { categoryChangedEvent, setConversationCategory } from '@/lib/categories/write';
import { withCleanDatabase } from '@/lib/testing/db';
import { CATEGORY_AI_ACTOR, type CategoryOutcome } from './decide';
import { categoryAiReport, deadClassifyJobs, runQuestions } from './report';

/**
 * The report's reads against Postgres: that the label and the question scope
 * every one of them, that a person's label written by the real writer reads
 * back with its key, and that the `jsonb` and job reads plan. What the figures
 * mean is `grade.test.ts`'s; this file proves the rows reach it.
 */

withCleanDatabase();

const QUESTION = 'q-1';
const minute = (n: number) => new Date(Date.parse('2026-10-01T09:00:00Z') + n * 60_000);

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  return row!.id;
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: status!.id,
      channel: 'whatsapp',
      ...values,
    })
    .returning({ id: conversations.id, number: conversations.number });
  return row!;
}

async function answer(
  conversationId: string,
  at: number,
  outcome: CategoryOutcome,
  predictedKey: string | null,
  values: Partial<typeof aiCategoryRuns.$inferInsert> = {},
) {
  await db.insert(aiCategoryRuns).values({
    conversationId,
    messageCreatedAt: minute(at),
    runLabel: 'live',
    mode: 'shadow',
    requestFingerprint: QUESTION,
    outcome,
    predictedKey,
    probability: predictedKey ? 0.9 : null,
    minProbability: 0.6,
    channel: 'whatsapp',
    ...values,
  });
}

async function agent() {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona', email: 'mona@shipblu.test' })
    .returning({ id: agents.id });
  return row!.id;
}

describe('runQuestions', () => {
  it('lists each label and question, newest first, with what each holds', async () => {
    const first = await ticket();
    const second = await ticket();
    await answer(first.id, 0, 'would_apply', 'sales', { createdAt: minute(100) });
    await answer(second.id, 1, 'unknown', 'unknown', { createdAt: minute(101) });
    await answer(first.id, 0, 'would_apply', 'sales', {
      runLabel: 'archive-1',
      mode: 'record',
      createdAt: minute(200),
    });
    await answer(first.id, 2, 'applied', 'sales', {
      mode: 'apply',
      requestFingerprint: 'q-2',
      createdAt: minute(150),
    });

    expect(await runQuestions()).toEqual([
      expect.objectContaining({
        runLabel: 'archive-1',
        fingerprint: QUESTION,
        rows: 1,
        tickets: 1,
      }),
      expect.objectContaining({ runLabel: 'live', fingerprint: 'q-2', modes: ['apply'] }),
      {
        runLabel: 'live',
        fingerprint: QUESTION,
        rows: 2,
        tickets: 2,
        modes: ['shadow'],
        firstMessageAt: minute(0),
        lastMessageAt: minute(1),
        lastWrittenAt: minute(101),
      },
    ]);
  });
});

describe('categoryAiReport', () => {
  it("grades the chosen label and question against a person's label", async () => {
    const mona = await agent();
    const right = await ticket();
    const wrong = await ticket();
    const ruled = await ticket();
    const spam = await ticket({ isSpam: true });
    const plain = await ticket();
    const elsewhere = await ticket();
    const reworded = await ticket();

    await answer(right.id, 0, 'would_apply', 'sales', { baselineCategoryKey: 'sales' });
    await answer(wrong.id, 0, 'would_apply', 'sales');
    await answer(ruled.id, 0, 'would_apply', 'courier_jobs');
    await answer(spam.id, 0, 'would_apply', 'courier_jobs');
    await answer(plain.id, 0, 'would_apply', 'courier_jobs');
    // Another label and another question: neither reaches this report.
    await answer(elsewhere.id, 0, 'would_apply', 'sales', { runLabel: 'archive-1' });
    await answer(right.id, 1, 'would_apply', 'courier_jobs', { requestFingerprint: 'q-2' });
    await answer(reworded.id, 0, 'would_apply', 'sales', { requestFingerprint: 'q-2' });

    // A person, through the writer the console uses, so the key is the one it stores.
    await setConversationCategory(right.id, await categoryId('sales'), { agentId: mona });
    await setConversationCategory(wrong.id, await categoryId('customer_support'), {
      agentId: mona,
    });
    await setConversationCategory(elsewhere.id, await categoryId('sales'), { agentId: mona });
    // A rule writes the same column, and is not ground truth.
    await setConversationCategory(ruled.id, await categoryId('courier_jobs'), {
      label: 'automation:file-couriers',
    });

    const report = await categoryAiReport('live', QUESTION);

    expect(report.total).toMatchObject({
      tickets: 5,
      judged: 5,
      settled: 5,
      labelled: 2,
      settledLabelled: 2,
      right: 1,
      rulesAnswered: 1,
      rulesRight: 1,
    });
    expect(report.categories.map((each) => each.key)).toEqual([
      'sales',
      'customer_support',
      'merchant_support',
      'courier_jobs',
    ]);
    expect(report.confusion).toEqual(
      expect.arrayContaining([
        { label: 'sales', settled: 'sales', count: 1 },
        { label: 'customer_support', settled: 'sales', count: 1 },
      ]),
    );
    // Courier jobs: agreeing with the rule's category would leave no label,
    // and the spam ticket cannot be labelled at all.
    expect(report.sample.find((stratum) => stratum.key === 'courier_jobs')).toEqual({
      key: 'courier_jobs',
      labelled: 0,
      waiting: 1,
    });
    expect(report.toLabel).toEqual([
      { conversationId: plain.id, number: plain.number, channel: 'whatsapp' },
    ]);
  });

  it("reads Jev's write and the person's change after it", async () => {
    const mona = await agent();
    const filed = await ticket();
    const sales = await categoryId('sales');
    await answer(filed.id, 0, 'applied', 'sales', { mode: 'apply' });
    await db.insert(conversationEvents).values(
      categoryChangedEvent(
        filed.id,
        { from: null, to: sales, category: { id: sales, key: 'sales', labelEn: 'Sales' } },
        { label: CATEGORY_AI_ACTOR },
        {
          probability: 0.9,
          model: 'jev-1.13.0',
          messageId: null,
          messageCreatedAt: minute(0).toISOString(),
          runLabel: 'live',
        },
      ),
    );
    await db.update(conversations).set({ categoryId: sales }).where(eq(conversations.id, filed.id));
    await setConversationCategory(filed.id, await categoryId('merchant_support'), {
      agentId: mona,
    });

    const report = await categoryAiReport('live', QUESTION);

    expect(report.filed).toEqual([
      {
        key: 'sales',
        filed: 1,
        changed: 1,
        changedTo: [{ key: 'merchant_support', count: 1 }],
      },
    ]);
    // A label after Jev wrote is a correction, not ground truth.
    expect(report.total.labelled).toBe(0);
    expect(report.labelledAfterJev).toBe(1);
  });

  it('answers an empty report for a label nobody wrote', async () => {
    const report = await categoryAiReport('nothing', QUESTION);
    expect(report.total.tickets).toBe(0);
    expect(report.slices).toEqual([]);
  });
});

describe('deadClassifyJobs', () => {
  it('counts only classify_category jobs that died', async () => {
    await db.insert(jobs).values([
      { type: 'classify_category', status: 'dead', createdAt: minute(5) },
      { type: 'classify_category', status: 'dead', createdAt: minute(9) },
      { type: 'classify_category', status: 'completed', createdAt: minute(1) },
      { type: 'classify_priority', status: 'dead', createdAt: minute(2) },
    ]);
    expect(await deadClassifyJobs()).toEqual({ count: 2, first: minute(5), last: minute(9) });
  });
});
