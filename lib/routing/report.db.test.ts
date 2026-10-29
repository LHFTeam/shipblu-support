import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  aiCategoryRuns,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groups,
  routingDecisions,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { CATEGORY_AI_ACTOR, type CategoryOutcome } from '@/lib/category-ai/decide';
import type { ReportWindow } from '@/lib/reports/rollup';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo, inCairo } from '@/lib/testing/time';
import { SETTLE_ACTOR } from './apply';
import { ROUTING_OUTCOMES, type RoutingOutcome } from './decide';
import { ROUTING_GRACE_MS } from './hold';
import {
  decidedFirst,
  decisionTiming,
  fallbackReasons,
  fallbackStatement,
  historyStatement,
  outcomesStatement,
  routedStillUnassigned,
  routerDecided,
  routingChannels,
  routingHistory,
  routingOutcomes,
  shadowAgainstPeople,
  shadowStatement,
  STILL_UNASSIGNED_AFTER_MS,
  stillUnassignedStatement,
  strandedRouting,
  strandedStatement,
  takenStatement,
  takenTickets,
  timingStatement,
} from './report';

/**
 * The routing report's reads against Postgres. Every fragment here is raw SQL
 * — a `jsonb` path, a lateral, a cast, a window function — so nothing short of
 * running it says it plans, let alone that it selects what the page claims.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
/** The week up to the autumn change: Cairo's 2026-10-29 has 23:00–24:00 twice. */
const WEEK: ReportWindow = { from: '2026-10-23', to: '2026-10-29', zone: ZONE };
const NOW = cairo('2026-10-30T12:00');
const IN_WEEK = cairo('2026-10-26T10:00');
const MINUTE = 60_000;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

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
      channel: 'webchat',
      ...values,
    })
    .returning({ id: conversations.id, number: conversations.number });
  return row!;
}

let named = 0;
async function channel(values: Partial<typeof channels.$inferInsert> = {}): Promise<string> {
  named += 1;
  const [row] = await db
    .insert(channels)
    .values({ type: 'webchat', name: `Channel ${named}`, config: {}, ...values })
    .returning({ id: channels.id });
  return row!.id;
}

async function group(
  name: string,
  strategy: 'manual' | 'round_robin' | 'load_balanced' = 'round_robin',
): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: strategy })
    .returning({ id: groups.id });
  return row!.id;
}

async function agent(): Promise<string> {
  named += 1;
  const [row] = await db
    .insert(agents)
    .values({ name: `Mona ${named}`, email: `mona${named}@shipblu.test` })
    .returning({ id: agents.id });
  return row!.id;
}

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  return row!.id;
}

type Decision = Partial<typeof routingDecisions.$inferInsert> & {
  /** A decided row's outcome; leave out for one still undecided. */
  outcome?: RoutingOutcome;
  ticket?: Partial<typeof conversations.$inferInsert>;
};

/**
 * One routing row, on a ticket of its own. Started at `IN_WEEK` with a
 * five-minute window unless told otherwise; given an outcome it is decided at
 * the window's end, the instant `settle_routing` would record it.
 */
async function decision({ ticket: ticketValues, ...values }: Decision = {}) {
  const conversation = await ticket(ticketValues);
  const startedAt = values.startedAt ?? IN_WEEK;
  const windowEndsAt = values.windowEndsAt ?? at(startedAt, 5 * MINUTE);
  const decided = values.outcome !== undefined;
  await db.insert(routingDecisions).values({
    conversationId: conversation.id,
    shadow: false,
    stage: decided ? 'decided' : 'holding',
    ...(decided ? { decidedAt: windowEndsAt } : {}),
    ...values,
    startedAt,
    windowEndsAt,
  });
  return conversation;
}

async function event(
  conversationId: string,
  values: Partial<typeof conversationEvents.$inferInsert> & { type: string },
) {
  await db.insert(conversationEvents).values({ conversationId, ...values });
}

async function run(
  conversationId: string,
  outcome: CategoryOutcome,
  createdAt: Date,
  runLabel = 'live',
) {
  await db.insert(aiCategoryRuns).values({
    conversationId,
    messageCreatedAt: at(createdAt, -MINUTE),
    runLabel,
    mode: 'apply',
    requestFingerprint: 'q-1',
    outcome,
    predictedKey: outcome === 'failed' ? null : 'unknown',
    error: outcome === 'failed' ? 'refused' : null,
    channel: 'webchat',
    createdAt,
  });
}

const sliceOf = <T extends { channelId: string | null; shadow: boolean }>(
  rows: T[],
  channelId: string | null,
  shadow = false,
) => rows.find((row) => row.channelId === channelId && row.shadow === shadow);

describe('routingOutcomes', () => {
  it('files a row on the Cairo day it entered routing, the autumn day’s repeated hour included', async () => {
    const firstHalfHour = cairo('2026-10-29T23:30');
    // The same wall-clock half hour an hour later, after the clocks went back.
    const secondHalfHour = at(firstHalfHour, 60 * MINUTE);
    expect(inCairo(secondHalfHour)).toBe('2026-10-29T23:30');

    // A channel row each, so the answer says which rows are in rather than how
    // many: a count lets a UTC cut that drops one edge and gains the other pass.
    const rows: [string, Date][] = [
      ['the minute before', cairo('2026-10-22T23:59')],
      ['the first midnight', cairo('2026-10-23T00:00')],
      ['the first 23:30', firstHalfHour],
      ['the second 23:30', secondHalfHour],
      ['ten past the last midnight', cairo('2026-10-30T00:10')],
    ];
    for (const [name, startedAt] of rows) {
      await decision({ channelId: await channel({ name }), startedAt, outcome: 'fallback' });
    }

    const slices = await routingOutcomes(WEEK, NOW);
    expect(slices.map((slice) => slice.channelName)).toEqual([
      'the first 23:30',
      'the first midnight',
      'the second 23:30',
    ]);
  });

  it('reads nothing that started after the page’s now', async () => {
    const id = await channel();
    await decision({ channelId: id, startedAt: cairo('2026-10-30T11:00'), outcome: 'fallback' });
    await decision({ channelId: id, startedAt: cairo('2026-10-30T13:00'), outcome: 'fallback' });

    const today: ReportWindow = { from: '2026-10-30', to: '2026-10-30', zone: ZONE };
    const [slice] = await routingOutcomes(today, NOW);
    expect(slice!.entered).toBe(1);
  });

  it('keeps live and shadow apart for the same channel', async () => {
    const id = await channel();
    await decision({ channelId: id, outcome: 'category' });
    await decision({ channelId: id, outcome: 'category' });
    await decision({ channelId: id, outcome: 'taken' });
    await decision({ channelId: id, shadow: true, outcome: 'category' });
    await decision({ channelId: id, shadow: true, outcome: 'fallback' });

    const slices = await routingOutcomes(WEEK, NOW);
    expect(slices.map((slice) => slice.shadow)).toEqual([false, true]);
    expect(sliceOf(slices, id)!.outcomes).toMatchObject({ category: 2, taken: 1, fallback: 0 });
    expect(sliceOf(slices, id, true)!.outcomes).toMatchObject({
      category: 1,
      taken: 0,
      fallback: 1,
    });
  });

  it('pivots every outcome into its column, and entered is decided, deciding and stranded', async () => {
    const id = await channel();
    for (const outcome of ROUTING_OUTCOMES) await decision({ channelId: id, outcome });
    // Still in its window.
    await decision({
      channelId: id,
      startedAt: at(NOW, -MINUTE),
      windowEndsAt: at(NOW, 4 * MINUTE),
    });
    // Phase one has written its outcome; phase three has not run. Not decided.
    await decision({
      channelId: id,
      startedAt: at(NOW, -6 * MINUTE),
      windowEndsAt: at(NOW, -MINUTE),
      stage: 'holding',
      outcome: 'category',
      phaseOneAt: at(NOW, -MINUTE),
      decidedAt: null,
    });
    // Its grace long gone.
    await decision({ channelId: id });

    const today: ReportWindow = { from: '2026-10-23', to: '2026-10-30', zone: ZONE };
    const [slice] = await routingOutcomes(today, NOW);
    expect(slice!.outcomes).toEqual(
      Object.fromEntries(ROUTING_OUTCOMES.map((outcome) => [outcome, 1])),
    );
    expect(slice).toMatchObject({ entered: 11, decided: 8, deciding: 2, stranded: 1 });
    expect(slice!.decided + slice!.deciding + slice!.stranded).toBe(slice!.entered);
  });

  it('splits deciding from stranded at the instant the grace runs out, as isHeld does', async () => {
    const id = await channel();
    const graceOver = at(NOW, -ROUTING_GRACE_MS);
    const stranded = await decision({ channelId: id, windowEndsAt: graceOver });
    const deciding = await decision({ channelId: id, windowEndsAt: at(graceOver, 1) });

    const [slice] = await routingOutcomes(WEEK, NOW);
    expect(slice).toMatchObject({ deciding: 1, stranded: 1 });

    const listed = await strandedRouting(NOW);
    expect(listed.rows.map((row) => row.number)).toEqual([stranded.number]);
    expect(listed.rows.map((row) => row.number)).not.toContain(deciding.number);
  });

  it('groups every deleted channel’s rows as one line', async () => {
    const first = await channel();
    const second = await channel();
    await decision({ channelId: first, outcome: 'fallback' });
    await decision({ channelId: second, outcome: 'category' });
    await db.delete(channels).where(eq(channels.id, first));
    await db.delete(channels).where(eq(channels.id, second));

    const slices = await routingOutcomes(WEEK, NOW);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ channelId: null, channelName: null, entered: 2 });
  });

  it('names each line’s channel row, deleted ones last', async () => {
    const webChat = await channel({ name: 'Web chat', type: 'webchat' });
    const gone = await channel();
    await decision({ channelId: gone, outcome: 'fallback' });
    await decision({ channelId: webChat, outcome: 'fallback' });
    await db.delete(channels).where(eq(channels.id, gone));

    const slices = await routingOutcomes(WEEK, NOW);
    expect(slices.map((slice) => [slice.channelName, slice.channelType])).toEqual([
      ['Web chat', 'webchat'],
      [null, null],
    ]);
  });
});

describe('the shares', () => {
  it('reads the fallback and taken shares over the router’s own decisions', async () => {
    const webchat = await channel();
    const email = await channel({ type: 'email' });
    // Every hold ended by a rule, as production's web chat on_create rules do.
    for (let i = 0; i < 4; i += 1) await decision({ channelId: webchat, outcome: 'rule' });
    for (const outcome of [
      'category',
      'category',
      'fallback',
      'taken',
      'manual',
      'released',
    ] as const) {
      await decision({ channelId: email, outcome });
    }

    const slices = await routingOutcomes(WEEK, NOW);
    const chat = sliceOf(slices, webchat)!;
    // Nothing the router decided: no share to print, not a perfect 0%.
    expect(routerDecided(chat.outcomes)).toBe(0);
    expect(decidedFirst(chat.outcomes)).toBe(4);

    const mail = sliceOf(slices, email)!;
    expect(routerDecided(mail.outcomes)).toBe(4);
    expect(decidedFirst(mail.outcomes)).toBe(1);
    expect(mail.decided).toBe(6);
  });
});

describe('decisionTiming', () => {
  it('times a decision by when its outcome was recorded, so a resumed one does not move it', async () => {
    const id = await channel();
    for (let seconds = 10; seconds <= 100; seconds += 10) {
      const recorded = at(IN_WEEK, seconds * 1000);
      await decision({
        channelId: id,
        outcome: seconds % 20 === 0 ? 'category' : 'no_route_for_category',
        phaseOneAt: recorded,
        // The slowest was completed by settle_routing twenty minutes on, its
        // caller having died between the phases.
        decidedAt: seconds === 100 ? at(IN_WEEK, 20 * MINUTE) : recorded,
      });
    }
    // Neither of these is a category settling.
    await decision({ channelId: id, outcome: 'fallback' });
    await decision({ channelId: id, outcome: 'manual', decidedAt: at(IN_WEEK, 30 * 1000) });

    const [timing] = await decisionTiming(WEEK, NOW);
    expect(timing).toMatchObject({ settled: 10, settledP50: 55, settledInWindow: 10 });
    // 90 + 0.1 × (100 − 90); read off decided_at it would be 90 + 0.1 × (1200 − 90).
    expect(timing!.settledP90).toBeCloseTo(91, 6);
  });

  it('counts a category routed on at the settle as outside the window', async () => {
    const id = await channel();
    await decision({ channelId: id, outcome: 'category', decidedAt: at(IN_WEEK, MINUTE) });
    // A rule's set_category during the hold, routed by settle_routing at the end.
    await decision({ channelId: id, outcome: 'category' });

    const [timing] = await decisionTiming(WEEK, NOW);
    expect(timing).toMatchObject({ settled: 2, settledInWindow: 1 });
  });

  it('returns every window length in force', async () => {
    const id = await channel();
    await decision({ channelId: id, outcome: 'fallback' });
    await decision({ channelId: id, outcome: 'fallback', windowEndsAt: at(IN_WEEK, 10 * MINUTE) });
    await decision({ channelId: id });

    const [timing] = await decisionTiming(WEEK, NOW);
    expect(timing!.windowMinutes).toEqual([5, 10]);
  });

  it('measures a person or rule apart, and the settle job’s lag past the window', async () => {
    const id = await channel();
    await decision({ channelId: id, outcome: 'manual', decidedAt: at(IN_WEEK, MINUTE) });
    await decision({ channelId: id, outcome: 'rule', decidedAt: at(IN_WEEK, 3 * MINUTE) });
    const windowEndsAt = at(IN_WEEK, 5 * MINUTE);
    await decision({
      channelId: id,
      outcome: 'fallback',
      decidedByLabel: SETTLE_ACTOR,
      decidedAt: at(windowEndsAt, 5_000),
    });
    await decision({
      channelId: id,
      outcome: 'fallback',
      decidedByLabel: SETTLE_ACTOR,
      phaseOneAt: at(windowEndsAt, 15_000),
      // Resumed: the lag is to the decision, not to the resume.
      decidedAt: at(windowEndsAt, 10 * MINUTE),
    });

    const [timing] = await decisionTiming(WEEK, NOW);
    expect(timing).toMatchObject({
      settled: 0,
      settledP50: null,
      decidedFirst: 2,
      decidedFirstP50: 120,
      settledByJob: 2,
      settleLagMax: 15,
    });
    expect(timing!.settleLagP90).toBeCloseTo(14, 6);
  });

  it('reads routed as assigned only when an assignment followed the decision', async () => {
    const id = await channel();
    const decidedAt = at(IN_WEEK, MINUTE);
    const followed = await decision({ channelId: id, outcome: 'category', decidedAt });
    await event(followed.id, { type: 'assigned', createdAt: at(decidedAt, 30_000) });
    await event(followed.id, { type: 'assigned', createdAt: at(decidedAt, 90_000) });
    const before = await decision({ channelId: id, outcome: 'category', decidedAt });
    await event(before.id, { type: 'assigned', createdAt: at(decidedAt, -1) });
    const shadow = await decision({ channelId: id, shadow: true, outcome: 'category', decidedAt });
    await event(shadow.id, { type: 'assigned', createdAt: at(decidedAt, 1_000) });

    const rows = await decisionTiming(WEEK, NOW);
    expect(sliceOf(rows, id)).toMatchObject({
      routed: 2,
      routedAssigned: 1,
      routedAssignedP50: 30,
    });
    // A shadow `category` moved nothing, so nothing was routed to be assigned.
    expect(sliceOf(rows, id, true)).toMatchObject({ routed: 0, routedAssigned: 0 });
  });
});

describe('fallbackReasons', () => {
  it('finds a category that arrived after the decision, and not one before it', async () => {
    const id = await channel();
    const person = await agent();
    const sales = await categoryId('sales');
    const decidedAt = at(IN_WEEK, 5 * MINUTE);

    const jev = await decision({ channelId: id, outcome: 'fallback' });
    await event(jev.id, {
      type: 'category_changed',
      actorLabel: CATEGORY_AI_ACTOR,
      data: { from: null, to: sales },
      createdAt: at(decidedAt, 3 * MINUTE),
    });
    const byPerson = await decision({ channelId: id, outcome: 'fallback' });
    await event(byPerson.id, {
      type: 'category_changed',
      actorAgentId: person,
      data: { from: null, to: sales },
      createdAt: at(decidedAt, 10 * MINUTE),
    });
    const byRule = await decision({ channelId: id, outcome: 'fallback' });
    await event(byRule.id, {
      type: 'category_changed',
      actorLabel: 'automation:file it',
      data: { from: null, to: sales },
      createdAt: at(decidedAt, MINUTE),
    });
    const before = await decision({ channelId: id, outcome: 'fallback' });
    // Filed and cleared inside the window: neither is late, and a clearing
    // after the decision names no category.
    await event(before.id, {
      type: 'category_changed',
      actorAgentId: person,
      data: { from: null, to: sales },
      createdAt: at(decidedAt, -MINUTE),
    });
    await event(before.id, {
      type: 'category_changed',
      actorAgentId: person,
      data: { from: sales, to: null },
      createdAt: at(decidedAt, MINUTE),
    });

    const [reasons] = await fallbackReasons(WEEK, NOW);
    expect(reasons).toMatchObject({
      fallbacks: 4,
      late: 3,
      lateJev: 1,
      lateJevP50PastWindow: 180,
      latePerson: 1,
      latePersonP50PastWindow: 600,
    });
  });

  it('says what Jev had said by the decision', async () => {
    const id = await channel();
    const decidedAt = at(IN_WEEK, 5 * MINUTE);
    const before = at(decidedAt, -MINUTE);

    await decision({ channelId: id, outcome: 'fallback' });
    const unsure = await decision({ channelId: id, outcome: 'fallback' });
    await run(unsure.id, 'below_threshold', before);
    await run(unsure.id, 'unknown', at(before, 1_000));
    const failed = await decision({ channelId: id, outcome: 'fallback' });
    await run(failed.id, 'failed', before);
    const unsureBesideAFailure = await decision({ channelId: id, outcome: 'fallback' });
    await run(unsureBesideAFailure.id, 'failed', before);
    await run(unsureBesideAFailure.id, 'unknown', at(before, 1_000));
    const answeredLate = await decision({ channelId: id, outcome: 'fallback' });
    await run(answeredLate.id, 'unknown', at(decidedAt, 1_000));
    const backfilled = await decision({ channelId: id, outcome: 'fallback' });
    await run(backfilled.id, 'unknown', before, 'backfill-1');
    const capped = await decision({ channelId: id, outcome: 'fallback' });
    await run(capped.id, 'capped', before);

    const [reasons] = await fallbackReasons(WEEK, NOW);
    // The capped one is none of the three.
    expect(reasons).toMatchObject({ fallbacks: 7, notAsked: 3, unsure: 2, failed: 1 });
  });
});

describe('takenTickets', () => {
  it('names every live taken ticket in the range, with the total', async () => {
    const id = await channel();
    const taken = await decision({ channelId: id, outcome: 'taken' });
    await decision({ channelId: id, outcome: 'taken', startedAt: cairo('2026-10-20T10:00') });
    await decision({ channelId: id, outcome: 'category' });

    const listed = await takenTickets(WEEK, NOW);
    expect(listed.total).toBe(1);
    expect(listed.tickets).toEqual([
      expect.objectContaining({ number: taken.number, channel: 'webchat' }),
    ]);
  });
});

describe('routedStillUnassigned', () => {
  it('leaves out a ticket somebody was assigned after it entered routing, whatever unassigned it since', async () => {
    const id = await channel();
    const holder = await agent();
    const late = at(NOW, -STILL_UNASSIGNED_AFTER_MS - MINUTE);
    const never = await decision({ channelId: id, outcome: 'category', decidedAt: late });
    // Assigned by the rota as its hold ended three weeks ago; reclaimed yesterday.
    const reclaimed = await decision({
      channelId: id,
      outcome: 'category',
      startedAt: cairo('2026-10-08T10:00'),
    });
    await event(reclaimed.id, {
      type: 'assigned',
      actorLabel: 'auto_assign',
      data: { to: holder },
      createdAt: cairo('2026-10-08T10:06'),
    });
    await event(reclaimed.id, {
      type: 'assignment_reclaimed',
      actorLabel: 'assign_sweep',
      data: { from: holder },
      createdAt: cairo('2026-10-29T09:00'),
    });
    // Taken during its hold, then unassigned and left.
    const taken = await decision({ channelId: id, outcome: 'taken', decidedAt: late });
    await event(taken.id, {
      type: 'assigned',
      actorLabel: 'assign_sweep',
      data: { to: holder },
      createdAt: at(late, -MINUTE),
    });
    await event(taken.id, {
      type: 'unassigned',
      actorAgentId: holder,
      data: { to: null },
      createdAt: at(late, MINUTE),
    });
    // A person's assignment ended the hold: its event carries the
    // transaction's start, a moment before the decided_at endHold wrote.
    const manual = await decision({ channelId: id, outcome: 'manual', decidedAt: late });
    await event(manual.id, {
      type: 'assigned',
      actorAgentId: holder,
      data: { to: holder },
      createdAt: at(late, -5),
    });
    await event(manual.id, {
      type: 'unassigned',
      actorAgentId: holder,
      data: { to: null },
      createdAt: at(late, MINUTE),
    });

    const rows = await routedStillUnassigned(NOW);
    expect(rows.flatMap((row) => row.numbers)).toEqual([never.number]);
  });

  it('counts a routed ticket nobody holds ten minutes after its hold ended, whenever it routed', async () => {
    const id = await channel();
    const sales = await group('Sales', 'manual');
    const late = at(NOW, -STILL_UNASSIGNED_AFTER_MS - MINUTE);
    const routed = await decision({
      channelId: id,
      outcome: 'category',
      decidedAt: late,
      ticket: { groupId: sales },
    });
    // Sixty days ago: no range could reach it, and it matters most.
    const old = await decision({
      channelId: id,
      outcome: 'category',
      startedAt: cairo('2026-08-31T10:00'),
      ticket: { groupId: sales },
    });
    const fellBack = await decision({ channelId: id, outcome: 'fallback', decidedAt: late });

    const resolved = await statusId('Resolved');
    const holder = await agent();
    const other = await ticket();
    const excluded: Decision[] = [
      { outcome: 'category', decidedAt: late, ticket: { statusId: resolved } },
      { outcome: 'category', decidedAt: late, ticket: { isSpam: true } },
      { outcome: 'category', decidedAt: late, ticket: { mergedIntoId: other.id } },
      { outcome: 'category', decidedAt: late, ticket: { deletedAt: late } },
      { outcome: 'category', decidedAt: late, ticket: { assigneeAgentId: holder } },
      { outcome: 'category', decidedAt: late, ticket: { channel: 'whatsapp_bot' } },
      { outcome: 'not_open', decidedAt: late },
      { outcome: 'category', decidedAt: late, shadow: true },
      // Nine minutes: the sweep has not had its two chances yet.
      { outcome: 'category', decidedAt: at(NOW, -9 * MINUTE) },
      // Undecided: the router's business, not assignment's.
      { stage: 'holding', startedAt: at(NOW, -MINUTE), windowEndsAt: at(NOW, 4 * MINUTE) },
    ];
    for (const values of excluded) await decision({ channelId: id, ...values });

    const rows = await routedStillUnassigned(NOW);
    expect(rows).toEqual([
      {
        groupId: sales,
        groupName: 'Sales',
        strategy: 'manual',
        outcome: 'category',
        tickets: 2,
        // Longest waiting first.
        numbers: [old.number, routed.number],
      },
      {
        groupId: null,
        groupName: null,
        strategy: null,
        outcome: 'fallback',
        tickets: 1,
        numbers: [fellBack.number],
      },
    ]);
  });
});

describe('strandedRouting', () => {
  // Read on every load whatever the range, so it must not grow with the table:
  // the partial index holds only the undecided rows. An empty table is cheapest
  // read whole, so the plan is asked with sequential scans forbidden, which
  // makes it name the index that serves the statement, or none.
  it('reads the stranded rows through the undecided index, whatever the table holds', async () => {
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`explain ${strandedStatement(NOW)}`);
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'routing_decisions_undecided_idx',
    );
  });

  it('lists undecided rows past the grace, live and shadow apart, whenever they started', async () => {
    const id = await channel();
    const live = await decision({ channelId: id, startedAt: cairo('2026-09-01T10:00') });
    const liveToo = await decision({ channelId: id });
    const shadow = await decision({ channelId: id, shadow: true, stage: 'pending' });
    await decision({ channelId: id, outcome: 'fallback' });
    await decision({
      channelId: id,
      startedAt: at(NOW, -MINUTE),
      windowEndsAt: at(NOW, 4 * MINUTE),
    });

    const stranded = await strandedRouting(NOW);
    expect(stranded).toMatchObject({ live: 2, shadow: 1 });
    expect(stranded.rows.map((row) => [row.number, row.shadow])).toEqual([
      [live.number, false],
      [liveToo.number, false],
      [shadow.number, true],
    ]);
  });
});

describe('shadowAgainstPeople', () => {
  it('reads each would-be decision against the group a person moved the ticket to', async () => {
    const id = await channel();
    const person = await agent();
    const support = await group('Front desk');
    const sales = await group('Sales');
    const care = await group('Care');
    const decidedAt = at(IN_WEEK, 5 * MINUTE);
    const after = at(decidedAt, MINUTE);
    const moved = (to: unknown, createdAt = after, actorAgentId: string | null = person) => ({
      type: 'group_changed',
      actorAgentId,
      data: { to },
      createdAt,
    });

    const shadow = (outcome: RoutingOutcome, toGroupId: string) =>
      decision({ channelId: id, shadow: true, outcome, fromGroupId: support, toGroupId });

    // Would move to Sales…
    const there = await shadow('category', sales);
    await event(there.id, moved(sales));
    const thereInTheEnd = await shadow('category', sales);
    await event(thereInTheEnd.id, moved(care));
    await event(thereInTheEnd.id, moved(sales, at(after, MINUTE)));
    const elsewhere = await shadow('category', sales);
    await event(elsewhere.id, moved(care));
    // Written by hand, its `to` no group id at all: compared as text, it must
    // read as somewhere else rather than refuse the page.
    const handWritten = await shadow('category', sales);
    await event(handWritten.id, moved('Sales team'));
    await shadow('category', sales);
    const movedBefore = await shadow('category', sales);
    await event(movedBefore.id, moved(sales, at(decidedAt, -MINUTE)));
    const byRule = await shadow('category', sales);
    await event(byRule.id, moved(sales, after, null));

    // …or keep it in the front desk.
    const missed = await shadow('fallback', support);
    await event(missed.id, moved(care));
    await shadow('no_route_for_category', support);
    const backWhereItWas = await shadow('fallback', support);
    await event(backWhereItWas.id, moved(support));

    await shadow('manual', care);
    await shadow('rule', care);
    await shadow('released', support);
    // A live decision is no would-be.
    const live = await decision({ channelId: id, outcome: 'category', toGroupId: sales });
    await event(live.id, moved(sales));

    const [comparison] = await shadowAgainstPeople(WEEK, NOW);
    expect(comparison).toEqual({
      channelId: id,
      channelName: expect.any(String),
      channelType: 'webchat',
      wouldMove: 7,
      movedThere: 2,
      movedElsewhere: 2,
      notMoved: 3,
      wouldKeep: 3,
      missed: 1,
      kept: 2,
      manual: 1,
      rule: 1,
    });
  });
});

describe('routingHistory', () => {
  it('is empty before anything routed, and spans every row up to now', async () => {
    expect(await routingHistory(NOW)).toEqual({ first: null, last: null });

    const id = await channel();
    await decision({ channelId: id, startedAt: cairo('2026-09-01T10:00'), outcome: 'fallback' });
    await decision({ channelId: id, startedAt: IN_WEEK, outcome: 'fallback' });
    await decision({ channelId: id, startedAt: at(NOW, MINUTE) });

    const history = await routingHistory(NOW);
    expect(inCairo(history.first)).toBe('2026-09-01T10:00');
    expect(history.last).toEqual(IN_WEEK);
  });
});

describe('routingChannels', () => {
  it('reads each channel’s mode through routingModeOf, never off the column', async () => {
    const email = await channel({ type: 'email', name: 'Mail', routingMode: 'category' });
    const coexistence = await channel({
      type: 'whatsapp',
      name: 'Business app',
      routingMode: 'category',
      config: {
        phoneNumberId: '1092',
        coexistence: { onboardedAt: '2026-09-01T10:00:00.000Z', wabaId: 'waba-1' },
      },
    });

    const rows = await routingChannels();
    expect(rows.find((row) => row.id === email)!.mode).toBe('category');
    expect(rows.find((row) => row.id === coexistence)!.mode).toBe('default_group');
    expect(rows.find((row) => row.type === 'whatsapp_bot')!.mode).toBe('default_group');
  });

  it('files a kind under its oldest row to the microsecond, and lists the rows by name', async () => {
    // A tenth of a millisecond apart is no time apart to a JavaScript Date,
    // and the ids run the other way: judged on the Date with the id breaking
    // the tie, the newer row would be the one its kind is filed under.
    const older = await channel({
      id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      name: 'Zed web chat',
      routingMode: 'category',
    });
    const newer = await channel({
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Ada web chat',
      routingMode: 'category',
    });
    for (const [id, at] of [
      [older, '2026-01-01 00:00:00.0001+00'],
      [newer, '2026-01-01 00:00:00.0002+00'],
    ] as const) {
      await db
        .update(channels)
        .set({ createdAt: sql`${at}::timestamptz` })
        .where(eq(channels.id, id));
    }

    const rows = (await routingChannels()).filter((row) => row.type === 'webchat');
    expect(rows.map((row) => [row.name, row.files])).toEqual([
      ['Ada web chat', false],
      ['Zed web chat', true],
    ]);
  });
});

describe('the statements', () => {
  it('bind every instant as text behind its cast, never a raw Date', () => {
    const dialect = new PgDialect();
    const graceOver = at(NOW, -ROUTING_GRACE_MS).toISOString();
    const statements: [SQL, string][] = [
      [outcomesStatement(WEEK, NOW), graceOver],
      [timingStatement(WEEK, NOW), NOW.toISOString()],
      [fallbackStatement(WEEK, NOW), NOW.toISOString()],
      [takenStatement(WEEK, NOW), NOW.toISOString()],
      [stillUnassignedStatement(NOW), at(NOW, -STILL_UNASSIGNED_AFTER_MS).toISOString()],
      [strandedStatement(NOW), graceOver],
      [shadowStatement(WEEK, NOW), NOW.toISOString()],
      [historyStatement(NOW), NOW.toISOString()],
    ];
    for (const [statement, instant] of statements) {
      const { sql: text, params } = dialect.sqlToQuery(statement);
      expect(params.some((param) => param instanceof Date)).toBe(false);
      expect(params).toContain(instant);
      expect(text).toContain('::timestamptz');
    }
  });
});
