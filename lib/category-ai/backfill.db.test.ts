import { and, asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  CATEGORY_AI_LIVE_LABEL,
  agents,
  aiCategoryRuns,
  automationRules,
  contacts,
  conversationEvents,
  conversationShipments,
  conversations,
  messages,
  shipments,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { setConversationCategory } from '@/lib/categories/write';
import { createTicket } from '@/lib/portal/tickets';
import { resetEnvCache } from '@/lib/env';
import { stubFetch } from '@/lib/testing/fetch';
import { withCleanDatabase } from '@/lib/testing/db';
import { untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { applyCategoryRun, recordCategoryRun, type RecordRun } from './backfill';
import { CATEGORY_AI_ACTOR } from './decide';
import { classifyMessageCategory } from './run';
import { forgetCategoryAiSettings } from './settings';

/**
 * `backfill_category_ai` against Postgres, with TypeSafe answered by the test
 * (`plans/ticket-category-routing.md`, Stage 4.1).
 *
 * Record mode is graded on tickets people label later, so the case that
 * matters most is the first: a label written after the messages does not make
 * them owned. Apply mode files a backlog and must wake nothing, which only a
 * real rule and a real ticket can show.
 */

withCleanDatabase();

const BASE = 'https://typesafe.test';

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability) values (1, 'off', 0.6)
    on conflict (id) do update set mode = excluded.mode, min_probability = excluded.min_probability`);
  forgetCategoryAiSettings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

/** Answers in turn, one per call; the last repeats. */
function answersInTurn(...choices: string[]) {
  let call = 0;
  return stubFetch(() => {
    const choice = choices[Math.min(call, choices.length - 1)]!;
    call += 1;
    return Response.json({
      model: 'jev-1.13.0',
      answers: {
        ticket_category: { type: 'choice', choice, probabilities: { [choice]: 0.9 } },
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

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: await statusId('Open'),
      channel: 'whatsapp',
      ...values,
    })
    .returning({ id: conversations.id });
  return { id: row!.id, requester: contact!.id };
}

async function inbound(
  t: { id: string; requester: string },
  bodyText: string,
  createdAt: Date,
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: t.id,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: t.requester,
      bodyText,
      createdAt,
    })
    .returning({ id: messages.id });
  return row!.id;
}

async function runsOf(conversationId: string, runLabel = 'archive-1') {
  return db
    .select({
      messageId: aiCategoryRuns.messageId,
      outcome: aiCategoryRuns.outcome,
      predictedKey: aiCategoryRuns.predictedKey,
      mode: aiCategoryRuns.mode,
      categoryKeyBefore: aiCategoryRuns.categoryKeyBefore,
      hasShipment: aiCategoryRuns.hasShipment,
    })
    .from(aiCategoryRuns)
    .where(
      and(eq(aiCategoryRuns.conversationId, conversationId), eq(aiCategoryRuns.runLabel, runLabel)),
    )
    .orderBy(asc(aiCategoryRuns.messageCreatedAt));
}

async function carried(conversationId: string) {
  const [row] = await db
    .select({ categoryId: conversations.categoryId, tags: conversations.tags })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row!;
}

async function eventsOf(conversationId: string, type: string) {
  return db
    .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, type)),
    );
}

const record = (over: Partial<RecordRun> = {}) =>
  recordCategoryRun({
    runLabel: 'archive-1',
    channels: null,
    dryRun: false,
    call: { baseUrl: BASE },
    ...over,
  });

describe('recordCategoryRun', () => {
  // The case the evaluation rests on: a supervisor's label, written after the
  // messages, is the ground truth they are graded against — not a reason to
  // skip them.
  it('judges each message as of when it arrived, not as the ticket is now', async () => {
    answersInTurn('sales');
    const labelledLater = await ticket();
    await inbound(labelledLater, 'بكام الشحن؟', at(10));
    const [mona] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test' })
      .returning({ id: agents.id });
    await setConversationCategory(labelledLater.id, await categoryId('sales'), {
      agentId: mona!.id,
    });

    const labelledFirst = await ticket();
    await db.insert(conversationEvents).values({
      conversationId: labelledFirst.id,
      type: 'category_changed',
      actorAgentId: mona!.id,
      data: { from: null, to: await categoryId('merchant_support') },
      createdAt: at(20),
    });
    await inbound(labelledFirst, 'امتى التحويل؟', at(10));

    expect(await record()).toMatchObject({ status: 'ran' });

    expect(await runsOf(labelledLater.id)).toEqual([
      expect.objectContaining({ outcome: 'would_apply', predictedKey: 'sales', mode: 'record' }),
    ]);
    expect(await runsOf(labelledFirst.id)).toEqual([
      expect.objectContaining({
        outcome: 'owned',
        predictedKey: null,
        categoryKeyBefore: 'merchant_support',
      }),
    ]);
  });

  // `createTicket` stamps the message before its transaction opens, so the
  // agent's opening and the form's default are stamped after it — and the live
  // job, which runs after that transaction, reads both and records `owned`.
  it('reads the writes that opened a ticket as known to its first message', async () => {
    answersInTurn('sales');
    const [mona] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test' })
      .returning({ id: agents.id });
    const requester = async () =>
      (await db.insert(contacts).values({ name: 'Amira' }).returning({ id: contacts.id }))[0]!.id;
    const byForm = await createTicket(await requester(), {
      subject: 'Rates',
      body: 'بكام الشحن؟',
      category: { id: await categoryId('merchant_support'), chosenBy: { label: 'form:delivery' } },
    });
    const byAgent = await createTicket(await requester(), {
      subject: 'Rates',
      body: 'بكام الشحن؟',
      openedBy: { agentId: mona!.id, form: 'delivery' },
    });

    await record();

    expect(await runsOf(byForm.conversationId)).toEqual([
      expect.objectContaining({ outcome: 'owned', categoryKeyBefore: 'merchant_support' }),
    ]);
    expect(await runsOf(byAgent.conversationId)).toEqual([
      expect.objectContaining({ outcome: 'owned' }),
    ]);
  });

  // Ingest links a message's tracking number before it queues the job, so the
  // link is stamped after its own message and the live row counts it.
  it('counts a shipment linked from the message itself, as the live row does', async () => {
    answersInTurn('customer_support');
    const t = await ticket();
    const message = await inbound(t, 'فين الشحنة 1755021358719', at(10));
    await inbound(t, 'لو سمحت', at(5));
    const [shipment] = await db
      .insert(shipments)
      .values({ trackingNumber: '1755021358719' })
      .returning({ id: shipments.id });
    await db
      .insert(conversationShipments)
      .values({ conversationId: t.id, shipmentId: shipment!.id, detectedInMessageId: message });

    await record();

    expect((await runsOf(t.id)).map((run) => run.hasShipment)).toEqual([true, true]);
  });

  // `backfill_shipment_links` stamps a link when it runs, so only the message
  // it came from — here an agent's note between two customer messages — says
  // when the ticket had it.
  it('counts a link from an agent’s note from the note on', async () => {
    answersInTurn('customer_support');
    const t = await ticket();
    await inbound(t, 'فين الشحنة', at(30));
    const [note] = await db
      .insert(messages)
      .values({
        conversationId: t.id,
        direction: 'outbound',
        kind: 'note',
        bodyText: 'Tracking 1755021358719',
        createdAt: at(20),
      })
      .returning({ id: messages.id });
    await inbound(t, 'لو سمحت', at(10));
    const [shipment] = await db
      .insert(shipments)
      .values({ trackingNumber: '1755021358719' })
      .returning({ id: shipments.id });
    await db
      .insert(conversationShipments)
      .values({ conversationId: t.id, shipmentId: shipment!.id, detectedInMessageId: note!.id });

    await record();

    expect((await runsOf(t.id)).map((run) => run.hasShipment)).toEqual([false, true]);
  });

  it('settles on the label’s own earlier answer, and asks nothing after it', async () => {
    const calls = answersInTurn('unknown', 'sales');
    const t = await ticket();
    await inbound(t, 'السلام عليكم', at(30));
    await inbound(t, 'بكام الشحن؟', at(20));
    await inbound(t, 'وكام للصعيد؟', at(10));

    await record();

    // A greeting never settles, so the next message is asked; the one after
    // the settle is known beforehand.
    expect((await runsOf(t.id)).map((run) => run.outcome)).toEqual([
      'unknown',
      'would_apply',
      'after_settle',
    ]);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  // The live job is never queued once somebody has answered, so a record
  // label covering those messages would hold rows no live label can.
  it('passes over the messages after the first reply, as the live job is never queued for them', async () => {
    const calls = answersInTurn('unknown');
    const t = await ticket({ firstRespondedAt: at(15) });
    await inbound(t, 'عايز اعرف', at(20));
    await inbound(t, 'تمام شكرا', at(10));

    const result = await record();

    expect((await runsOf(t.id)).map((run) => run.outcome)).toEqual(['unknown']);
    expect(result.status === 'ran' && result.tallies.get('whatsapp')?.skipped).toBe(1);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('caps at five messages asked', async () => {
    const calls = answersInTurn('unknown');
    const t = await ticket();
    for (let n = 0; n < 7; n++) await inbound(t, `رسالة رقم ${n + 1}`, at(30 - n));

    await record();

    expect((await runsOf(t.id)).map((run) => run.outcome)).toEqual([
      ...Array.from({ length: 5 }, () => 'unknown'),
      'capped',
      'capped',
    ]);
    expect(calls).toHaveBeenCalledTimes(5);
  });

  // Written straight to the column, with no event saying by whom: the live job
  // and apply mode both read that as somebody's choice.
  it('reads a category no event explains as owned from the first message', async () => {
    const calls = answersInTurn('sales');
    const t = await ticket({ categoryId: await categoryId('courier_jobs') });
    await inbound(t, 'بكام الشحن؟', at(10));

    await record();

    expect((await runsOf(t.id)).map((run) => run.outcome)).toEqual(['owned']);
    expect(calls).not.toHaveBeenCalled();
  });

  // One refusal of the key is every ticket's: the run stops rather than paying
  // a call and writing a failed row per ticket.
  it('stops the whole run when TypeSafe refuses the key', async () => {
    const calls = stubFetch(() => new Response('{"error":"unauthorized"}', { status: 401 }));
    const first = await ticket();
    const second = await ticket();
    await inbound(first, 'بكام الشحن؟', at(20));
    await inbound(second, 'فين الشحنه؟', at(10));

    expect(await record()).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/TypeSafe refused the key \(401\)/),
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await runsOf(first.id)).toEqual([]);
    expect(await runsOf(second.id)).toEqual([]);
  });

  // Recorded past a gap, the settle and the cap would be read off a history
  // missing an answer, and a re-run filling it could not put them back.
  it('stops a ticket at a failure, and a re-run resumes it from the gap', async () => {
    stubFetch(() => new Response('{"error":"bad request"}', { status: 400 }));
    const t = await ticket();
    const first = await inbound(t, 'بكام الشحن؟', at(20));
    await inbound(t, 'وكام للصعيد؟', at(10));

    await record();
    expect(await runsOf(t.id)).toEqual([
      expect.objectContaining({ messageId: first, outcome: 'failed' }),
    ]);

    const calls = answersInTurn('sales');
    await record();
    expect((await runsOf(t.id)).map((run) => run.outcome)).toEqual(['would_apply', 'after_settle']);
    expect(calls).toHaveBeenCalledTimes(1);

    // And again: everything is answered, so nothing is asked.
    await record();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('stops a ticket at a transient failure and writes nothing for it', async () => {
    stubFetch(() => new Response('{"error":"busy"}', { status: 503 }));
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(20));

    const result = await record();
    expect(result.status === 'ran' && result.tallies.get('whatsapp')?.transient).toBe(1);
    expect(await runsOf(t.id)).toEqual([]);
  });

  it('keeps its rows apart from the live classifier’s for the same message', async () => {
    answersInTurn('sales');
    await db.execute(sql`update category_ai_settings set mode = 'shadow'`);
    forgetCategoryAiSettings();
    const t = await ticket();
    const message = await inbound(t, 'بكام الشحن؟', at(10));
    await classifyMessageCategory(message, { baseUrl: BASE });

    await record();

    expect(await runsOf(t.id, CATEGORY_AI_LIVE_LABEL)).toHaveLength(1);
    expect(await runsOf(t.id)).toEqual([expect.objectContaining({ outcome: 'would_apply' })]);
  });

  it('writes nothing in a dry run, and asks nothing', async () => {
    const calls = answersInTurn('sales');
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(10));

    const result = await record({ dryRun: true });

    expect(result.status === 'ran' && result.tallies.get('whatsapp')?.asked).toBe(1);
    expect(calls).not.toHaveBeenCalled();
    expect(await runsOf(t.id)).toEqual([]);
  });

  // Which answer would settle a ticket is not known without asking, but the
  // cap is: a dry run's count is the most a real run would ask.
  it('counts a dry run up to the cap', async () => {
    answersInTurn('sales');
    const t = await ticket();
    for (let n = 0; n < 7; n++) await inbound(t, `رسالة رقم ${n + 1}`, at(30 - n));

    const result = await record({ dryRun: true });

    expect(result.status === 'ran' && result.tallies.get('whatsapp')).toMatchObject({
      asked: 5,
      outcomes: { capped: 2 },
    });
  });

  // A category added since changes the question; answers to two questions
  // under one label would be averaged by every report that reads it.
  it('refuses to add to a label that answered another question', async () => {
    answersInTurn('sales');
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(10));
    await record();
    await db
      .update(ticketCategories)
      .set({ labelEn: 'New business' })
      .where(eq(ticketCategories.key, 'sales'));

    expect(await record()).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/"archive-1" answered another question/),
    });
    expect(await record({ runLabel: 'archive-2' })).toMatchObject({ status: 'ran' });
  });

  it('refuses the live label', async () => {
    expect(await record({ runLabel: CATEGORY_AI_LIVE_LABEL })).toMatchObject({
      status: 'refused',
    });
  });
});

describe('applyCategoryRun', () => {
  const apply = (dryRun = false) =>
    applyCategoryRun({ fromLabel: 'archive-1', channels: null, dryRun });

  it('files an open ticket from its settling answer, naming the label and the message', async () => {
    answersInTurn('sales');
    const t = await ticket();
    const message = await inbound(t, 'بكام الشحن؟', at(10));
    await record();

    expect(await apply()).toMatchObject({ status: 'ran', candidates: 1, applied: 1 });

    expect((await carried(t.id)).categoryId).toBe(await categoryId('sales'));
    expect(await eventsOf(t.id, 'category_changed')).toEqual([
      {
        actorLabel: CATEGORY_AI_ACTOR,
        data: expect.objectContaining({
          to: await categoryId('sales'),
          runLabel: 'archive-1',
          messageId: message,
          model: 'jev-1.13.0',
        }),
      },
    ]);
  });

  // The plan's "it fires nothing": a rule keyed on the category is counted in
  // the report, and does not run.
  it('wakes no rule and moves no deadline, and says which rules it would wake', async () => {
    answersInTurn('sales');
    const sales = await categoryId('sales');
    await db.insert(automationRules).values([
      {
        name: 'Sales get a tag',
        trigger: 'on_update',
        conditions: { field: 'category.id', op: 'eq', value: sales },
        actions: [{ type: 'add_tags', tags: ['sales'] }],
      },
      {
        name: 'Unfiled after a day',
        trigger: 'time_based',
        conditions: { field: 'category.id', op: 'is_empty' },
        actions: [{ type: 'add_tags', tags: ['unfiled'] }],
      },
      {
        name: 'Everything',
        trigger: 'on_update',
        conditions: {},
        actions: [{ type: 'add_tags', tags: ['seen'] }],
      },
    ]);
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(10));
    await record();

    const result = await apply();

    expect(result).toMatchObject({
      rules: [
        { trigger: 'on_update', name: 'Sales get a tag', newly: 1, stops: 0 },
        { trigger: 'time_based', name: 'Unfiled after a day', newly: 0, stops: 1 },
      ],
    });
    expect((await carried(t.id)).tags).toEqual([]);
    expect(await eventsOf(t.id, 'sla_recalculated')).toEqual([]);
  });

  it('leaves a ticket that is resolved, owned, filed by Jev or out of every queue', async () => {
    answersInTurn('sales');
    const tickets = {
      resolved: await ticket({ statusId: await statusId('Resolved') }),
      owned: await ticket(),
      jev: await ticket(),
      spam: await ticket(),
    };
    for (const t of Object.values(tickets)) await inbound(t, 'بكام الشحن؟', at(10));
    await record();
    await setConversationCategory(tickets.owned.id, await categoryId('merchant_support'), {
      label: 'automation:Merchants',
    });
    await setConversationCategory(tickets.jev.id, await categoryId('customer_support'), {
      label: CATEGORY_AI_ACTOR,
    });
    await db
      .update(conversations)
      .set({ isSpam: true })
      .where(eq(conversations.id, tickets.spam.id));

    const result = await apply();

    expect(result).toMatchObject({ status: 'ran', candidates: 4, applied: 0 });
    expect(result.status === 'ran' && Object.fromEntries(result.left)).toEqual({
      'resolved or closed': 1,
      owned: 1,
      'filed by Jev already': 1,
      spam: 1,
    });
    expect((await carried(tickets.jev.id)).categoryId).toBe(await categoryId('customer_support'));
  });

  // An agent setting the ticket pending as the backfill reaches it: the filing
  // waits for the agent's write, and must find the ticket at its new status
  // rather than read it as gone.
  it('files a ticket a writer moved to another status while the filing waited for it', async () => {
    answersInTurn('sales');
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(10));
    await record();

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let moved!: () => void;
    const holding = new Promise<void>((resolve) => (moved = resolve));
    const pending = await statusId('Pending');
    const writer = db.transaction(async (tx) => {
      await tx.update(conversations).set({ statusId: pending }).where(eq(conversations.id, t.id));
      moved();
      await held;
    });
    await holding;

    const applying = apply();
    await untilWaitingOnALock(db);
    release();
    await writer;

    await expect(applying).resolves.toMatchObject({ status: 'ran', candidates: 1, applied: 1 });
    expect((await carried(t.id)).categoryId).toBe(await categoryId('sales'));
  });

  it('writes nothing in a dry run', async () => {
    answersInTurn('sales');
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(10));
    await record();

    expect(await apply(true)).toMatchObject({ status: 'ran', applied: 1 });
    expect((await carried(t.id)).categoryId).toBeNull();
  });

  it('refuses to file from the live label', async () => {
    expect(
      await applyCategoryRun({ fromLabel: CATEGORY_AI_LIVE_LABEL, channels: null, dryRun: false }),
    ).toEqual({ status: 'refused', reason: '"live" is the live classifier\'s' });
  });

  // A person files a ticket between the candidate read and its locked
  // re-check — simulated by a trigger that fires as Jev files the first one.
  // The report says which rules filing woke, so it counts what was filed.
  it('reports the rules woken only by tickets it filed', async () => {
    answersInTurn('sales');
    const sales = await categoryId('sales');
    await db.insert(automationRules).values({
      name: 'Sales get a tag',
      trigger: 'on_update',
      conditions: { field: 'category.id', op: 'eq', value: sales },
      actions: [{ type: 'add_tags', tags: ['sales'] }],
    });
    const [mona] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test' })
      .returning({ id: agents.id });
    const [first, second] = [await ticket(), await ticket()].sort((a, b) => (a.id < b.id ? -1 : 1));
    await inbound(first!, 'بكام الشحن؟', at(20));
    await inbound(second!, 'بكام الشحن للصعيد؟', at(10));
    await record();

    await db.execute(
      sql.raw(`
        create function test_person_files() returns trigger language plpgsql as $$
        begin
          if new.actor_label = '${CATEGORY_AI_ACTOR}' and new.conversation_id = '${first!.id}' then
            insert into conversation_events (conversation_id, type, actor_agent_id, data)
            values ('${second!.id}', 'category_changed', '${mona!.id}', '{"to": null, "key": null}');
          end if;
          return new;
        end $$;
        create trigger test_person_files after insert on conversation_events
          for each row execute function test_person_files();`),
    );
    try {
      const result = await apply();

      expect(result).toMatchObject({
        status: 'ran',
        candidates: 2,
        applied: 1,
        rules: [{ trigger: 'on_update', name: 'Sales get a tag', newly: 1, stops: 0 }],
      });
      expect(result.status === 'ran' && Object.fromEntries(result.left)).toEqual({ owned: 1 });
    } finally {
      await db.execute(
        sql.raw(`drop trigger test_person_files on conversation_events;
          drop function test_person_files();`),
      );
    }
  });

  it('refuses a label with no rows, or answered under another question than today’s', async () => {
    expect(await apply()).toEqual({ status: 'refused', reason: 'no rows under "archive-1"' });

    answersInTurn('sales');
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(10));
    await record();
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.key, 'courier_jobs'));

    expect(await apply()).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/"archive-1" answered another question/),
    });
    expect((await carried(t.id)).categoryId).toBeNull();
  });

  // The event names the message the answer was to, so the live classifier
  // reads the backfill's write as that message's settle.
  it('settles the ticket for the live classifier', async () => {
    answersInTurn('sales');
    const t = await ticket();
    await inbound(t, 'بكام الشحن؟', at(10));
    await record();
    await apply();

    await db.execute(sql`update category_ai_settings set mode = 'apply'`);
    forgetCategoryAiSettings();
    const calls = answersInTurn('customer_support');
    const later = await inbound(t, 'فين الشحنه', at(1));

    await expect(classifyMessageCategory(later, { baseUrl: BASE })).resolves.toMatchObject({
      outcome: 'after_settle',
    });
    expect(calls).not.toHaveBeenCalled();
    expect((await carried(t.id)).categoryId).toBe(await categoryId('sales'));
  });
});
