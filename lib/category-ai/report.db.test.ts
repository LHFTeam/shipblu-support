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
  messages,
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

async function message(conversationId: string, at: number, id?: string): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      ...(id ? { id } : {}),
      conversationId,
      direction: 'inbound',
      kind: 'reply',
      bodyText: 'بكام الشحن؟',
      createdAt: minute(at),
    })
    .returning({ id: messages.id });
  return row!.id;
}

async function statusNamed(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function agent() {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona', email: 'mona@shipblu.test' })
    .returning({ id: agents.id });
  return row!.id;
}

describe('runQuestions', () => {
  it('lists each label, question and mode, newest first, with what each holds', async () => {
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
    // The switch to apply, under the same label and question: a run of its own.
    await answer(second.id, 3, 'applied', 'sales', { mode: 'apply', createdAt: minute(120) });

    expect(await runQuestions()).toEqual([
      expect.objectContaining({
        runLabel: 'archive-1',
        fingerprint: QUESTION,
        mode: 'record',
        rows: 1,
        tickets: 1,
      }),
      expect.objectContaining({ runLabel: 'live', fingerprint: 'q-2', mode: 'apply' }),
      expect.objectContaining({ runLabel: 'live', fingerprint: QUESTION, mode: 'apply', rows: 1 }),
      {
        runLabel: 'live',
        fingerprint: QUESTION,
        mode: 'shadow',
        rows: 2,
        tickets: 2,
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
    // And another mode: apply's rows are their own run.
    await answer(right.id, 2, 'applied', 'courier_jobs', { mode: 'apply' });
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

    const report = await categoryAiReport('live', QUESTION, 'shadow');

    expect(report.total).toMatchObject({
      tickets: 5,
      judged: 5,
      settled: 5,
      labelled: 2,
      jev: { right: 1, of: 2 },
      rules: { right: 1, of: 1 },
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
    });
    expect(report.toLabel).toEqual([
      { conversationId: plain.id, number: plain.number, channel: 'whatsapp' },
    ]);
    // The apply rows are a run of their own: one ticket, filed as courier jobs.
    expect((await categoryAiReport('live', QUESTION, 'apply')).total).toMatchObject({
      tickets: 1,
      settled: 1,
    });
  });

  it("reads Jev's write and the person's change after it", async () => {
    const mona = await agent();
    const filed = await ticket();
    const sales = await categoryId('sales');
    const answered = await message(filed.id, 0);
    await answer(filed.id, 0, 'applied', 'sales', { mode: 'apply', messageId: answered });
    await db.insert(conversationEvents).values(
      categoryChangedEvent(
        filed.id,
        { from: null, to: sales, category: { id: sales, key: 'sales', labelEn: 'Sales' } },
        { label: CATEGORY_AI_ACTOR },
        {
          probability: 0.9,
          model: 'jev-1.13.0',
          messageId: answered,
          messageCreatedAt: minute(0).toISOString(),
          runLabel: 'live',
        },
      ),
    );
    await db.update(conversations).set({ categoryId: sales }).where(eq(conversations.id, filed.id));
    await setConversationCategory(filed.id, await categoryId('merchant_support'), {
      agentId: mona,
    });

    const report = await categoryAiReport('live', QUESTION, 'apply');

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
    expect(report.labelledAfterWrite).toBe(1);
  });

  // WhatsApp stamps a burst to the second: the two rows tie on the instant,
  // and only the message ids say which came first, as the live job read them.
  it('orders two messages of the same second by their ids', async () => {
    const t = await ticket();
    const first = await message(t.id, 0, '00000000-0000-4000-8000-00000000000a');
    const second = await message(t.id, 0, '00000000-0000-4000-8000-00000000000b');
    // Written in the other order, so neither insertion nor row id can decide.
    await answer(t.id, 0, 'after_settle', null, { messageId: second });
    await answer(t.id, 0, 'would_apply', 'sales', { messageId: first });

    const report = await categoryAiReport('live', QUESTION, 'shadow');

    expect(report.total).toMatchObject({ settled: 1, settledOnFirst: 1 });
    expect(report.sweep.find((row) => row.inForce)).toMatchObject({ settled: 1, unasked: 0 });
  });

  it('offers a never-settled ticket only once Jev can no longer be asked about it', async () => {
    const open = await ticket();
    const resolved = await ticket({ statusId: await statusNamed('Resolved') });
    const answeredTicket = await ticket({ firstRespondedAt: minute(5) });
    for (const t of [open, resolved, answeredTicket]) {
      await answer(t.id, 0, 'below_threshold', 'sales', { probability: 0.3 });
    }

    const report = await categoryAiReport('live', QUESTION, 'shadow');

    expect(report.toLabel.map((each) => each.number).sort()).toEqual(
      [resolved.number, answeredTicket.number].sort(),
    );
  });

  // Four asked in shadow, then the switch to apply: the live job capped the
  // sixth message on the asks the shadow view holds, and so does the sweep.
  it('counts the asks the label holds in its other views towards the cap', async () => {
    const t = await ticket();
    for (const at of [0, 1, 2, 3]) {
      await answer(t.id, at, 'unknown', 'unknown', { messageId: await message(t.id, at) });
    }
    await answer(t.id, 4, 'applied', 'sales', {
      mode: 'apply',
      probability: 0.65,
      messageId: await message(t.id, 4),
    });
    await answer(t.id, 5, 'after_settle', null, {
      mode: 'apply',
      messageId: await message(t.id, 5),
    });
    // Another label's answers are another cap's.
    await answer(t.id, 6, 'unknown', 'unknown', {
      runLabel: 'archive-1',
      messageId: await message(t.id, 6),
    });

    const report = await categoryAiReport('live', QUESTION, 'apply');

    expect(report.sweep.find((row) => row.threshold === 0.7)).toMatchObject({
      settled: 0,
      unasked: 0,
    });
  });

  it('answers an empty report for a label nobody wrote', async () => {
    const report = await categoryAiReport('nothing', QUESTION, 'shadow');
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

  // A run by hand after the outage: the message has its live row now, so it
  // is in the report's figures and not missing from them.
  it('leaves out a message a later live row answered, or recorded failing', async () => {
    const t = await ticket();
    const answered = await message(t.id, 0);
    const failed = await message(t.id, 1);
    const missing = await message(t.id, 2);
    const backfilled = await message(t.id, 3);
    await answer(t.id, 0, 'would_apply', 'sales', { messageId: answered });
    await answer(t.id, 1, 'failed', null, { messageId: failed, error: 'refused' });
    // A backfill's row is another label's: the live answer is still missing.
    await answer(t.id, 3, 'would_apply', 'sales', { messageId: backfilled, runLabel: 'archive-1' });
    await db.insert(jobs).values([
      ...[answered, failed, missing, backfilled].map((messageId, n) => ({
        type: 'classify_category' as const,
        status: 'dead' as const,
        payload: { messageId },
        createdAt: minute(10 + n),
      })),
      // Died on its schema: whatever it holds must not refuse the page.
      {
        type: 'classify_category',
        status: 'dead',
        payload: { messageId: 'nope' },
        createdAt: minute(20),
      },
    ]);
    expect(await deadClassifyJobs()).toEqual({ count: 3, first: minute(12), last: minute(20) });
  });
});
