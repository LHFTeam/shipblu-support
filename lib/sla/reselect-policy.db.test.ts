import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  businessHours,
  contacts,
  conversationEvents,
  conversations,
  groups,
  slaPolicies,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { runAutomations } from '@/lib/automations';
import { setConversationCategory } from '@/lib/categories/write';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { createTicket } from '@/lib/portal/tickets';
import { withCleanDatabase } from '@/lib/testing/db';
import { afterRoutingChanged, applySlaOnCreate, onAgentReply } from './index';

/**
 * Choosing the policy again when the category or the group changes before the
 * first response (`plans/ticket-category-routing.md`, decision 3).
 *
 * What only a database shows: that the policy column moves with the clocks,
 * that the clocks are counted from the ticket's own anchors with its finished
 * pauses credited, that a ticket nobody gave a clock gets one, and that the
 * category writer and the automation engine both reach it — and that an
 * `on_create` rule, or `createTicket` filing the category in its insert, leaves
 * the choice to `applySlaOnCreate`.
 */

withCleanDatabase();

const MINUTE = 60_000;

/** Round the clock, so a target is a fixed number of wall-clock minutes. */
const target = (firstResponseMins: number, resolutionMins: number) => {
  const row = { firstResponseMins, nextResponseMins: firstResponseMins, resolutionMins };
  return { low: row, medium: row, high: row, urgent: row };
};

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  return row!.id;
}

/** A default policy (120/480) and, above it, one for sales (30/240). */
async function policies(withDefault = true): Promise<{ sales: string; standard?: string }> {
  const [sales] = await db
    .insert(slaPolicies)
    .values({
      name: 'Sales',
      hoursSource: 'round_the_clock',
      targets: target(30, 240),
      position: 0,
      conditions: { field: 'category.id', op: 'eq', value: await categoryId('sales') },
    })
    .returning({ id: slaPolicies.id });
  if (!withDefault) return { sales: sales!.id };
  const [standard] = await db
    .insert(slaPolicies)
    .values({
      name: 'Standard',
      hoursSource: 'round_the_clock',
      targets: target(120, 480),
      position: 1,
      isDefault: true,
    })
    .returning({ id: slaPolicies.id });
  return { sales: sales!.id, standard: standard!.id };
}

async function ticket(
  values: Partial<typeof conversations.$inferInsert> = {},
): Promise<{ id: string; createdAt: Date }> {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  // Two hours old, so a re-selection that counted from now rather than from
  // the anchor would show.
  const createdAt = new Date(Date.now() - 120 * MINUTE);
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: status!.id,
      channel: 'whatsapp',
      createdAt,
      ...values,
    })
    .returning({ id: conversations.id });
  await applySlaOnCreate(row!.id);
  return { id: row!.id, createdAt };
}

async function sla(id: string) {
  const [row] = await db
    .select({
      slaPolicyId: conversations.slaPolicyId,
      firstResponseDueAt: conversations.firstResponseDueAt,
      nextResponseDueAt: conversations.nextResponseDueAt,
      resolutionDueAt: conversations.resolutionDueAt,
      firstResponseBreached: conversations.firstResponseBreached,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function events(id: string, type: string) {
  return db
    .select({
      data: conversationEvents.data,
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
    })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)))
    .orderBy(asc(conversationEvents.createdAt));
}

const at = (from: Date, minutes: number) => new Date(from.getTime() + minutes * MINUTE);

/**
 * A ticket opened through `createTicket` with a category, credited to a form
 * as its default is: the one writer that files the category in the insert, so
 * everything `afterInboundMessage` runs on creation reads it from the row.
 */
async function opened(categoryId: string) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const { conversationId } = await createTicket(contact!.id, {
    subject: 'Rates',
    body: 'How much to ship 200 parcels a month?',
    category: { id: categoryId, chosenBy: { label: 'form:x' } },
  });
  const [row] = await db
    .select({ categoryId: conversations.categoryId, createdAt: conversations.createdAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return { id: conversationId, ...row! };
}

// Private to `lib/sla`, so a writer cannot call one half of the follow-up;
// reached here as every writer reaches it, for a category change.
describe('reselectPolicyBeforeFirstResponse', () => {
  it('holds a ticket filed under a category to that category’s policy, from its arrival', async () => {
    const { sales, standard } = await policies();
    const { id, createdAt } = await ticket();
    expect((await sla(id)).slaPolicyId).toBe(standard);

    await setConversationCategory(id, await categoryId('sales'), { label: 'automation:test' });
    await afterRoutingChanged(id, { category: true, group: false });

    expect(await sla(id)).toMatchObject({
      slaPolicyId: sales,
      firstResponseDueAt: at(createdAt, 30),
      resolutionDueAt: at(createdAt, 240),
      nextResponseDueAt: null,
      // Thirty minutes from an arrival two hours ago is in the past: the sweep
      // records that breach, not this.
      firstResponseBreached: false,
    });
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({
        reason: 'policy',
        cause: 'category',
        policy: 'Sales',
        previousPolicy: 'Standard',
      }),
    ]);
  });

  it('does nothing when the same policy wins again', async () => {
    const { standard } = await policies();
    const { id } = await ticket();
    const before = await sla(id);

    await setConversationCategory(id, await categoryId('merchant_support'), { label: 'x' });
    await afterRoutingChanged(id, { category: true, group: false });

    expect(await sla(id)).toEqual(before);
    expect(before.slaPolicyId).toBe(standard);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('keeps the policy once somebody has answered', async () => {
    const { standard } = await policies();
    const { id } = await ticket();
    await onAgentReply(id);

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await afterRoutingChanged(id, { category: true, group: false });

    expect((await sla(id)).slaPolicyId).toBe(standard);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('gives clocks to a ticket whose first selection found no policy', async () => {
    const { sales } = await policies(false);
    const { id, createdAt } = await ticket();
    expect(await sla(id)).toMatchObject({ slaPolicyId: null, firstResponseDueAt: null });

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await afterRoutingChanged(id, { category: true, group: false });

    expect(await sla(id)).toMatchObject({
      slaPolicyId: sales,
      firstResponseDueAt: at(createdAt, 30),
      resolutionDueAt: at(createdAt, 240),
    });
  });

  it('credits the time the ticket already spent on a finished pause', async () => {
    const { sales } = await policies();
    const { id, createdAt } = await ticket();
    await db.insert(conversationEvents).values([
      { conversationId: id, type: 'sla_paused', actorLabel: 'sla', createdAt: at(createdAt, 10) },
      {
        conversationId: id,
        type: 'sla_resumed',
        actorLabel: 'sla',
        createdAt: at(createdAt, 40),
        data: { pausedMinutes: 30, from: at(createdAt, 10).toISOString() },
      },
    ]);

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await afterRoutingChanged(id, { category: true, group: false });

    expect(await sla(id)).toMatchObject({
      slaPolicyId: sales,
      firstResponseDueAt: at(createdAt, 30 + 30),
      resolutionDueAt: at(createdAt, 240 + 30),
    });
  });

  // Switching a policy off leaves its tickets on it, and the loaded policies
  // are the active ones only.
  it('names the policy a ticket moves off, even one switched off since', async () => {
    const [legacy] = await db
      .insert(slaPolicies)
      .values({
        name: 'Legacy',
        hoursSource: 'round_the_clock',
        targets: target(120, 480),
        isDefault: true,
      })
      .returning({ id: slaPolicies.id });
    const { id } = await ticket();
    expect((await sla(id)).slaPolicyId).toBe(legacy!.id);
    await db
      .update(slaPolicies)
      .set({ isActive: false, isDefault: false })
      .where(eq(slaPolicies.id, legacy!.id));
    const { sales } = await policies(false);

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await afterRoutingChanged(id, { category: true, group: false });

    expect((await sla(id)).slaPolicyId).toBe(sales);
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({
        policy: 'Sales',
        previousPolicyId: legacy!.id,
        previousPolicy: 'Legacy',
      }),
    ]);
  });

  it('clears a breach the new policy’s later target has not reached', async () => {
    const [sales] = await db
      .insert(slaPolicies)
      .values({
        name: 'Generous sales',
        hoursSource: 'round_the_clock',
        targets: target(600, 1200),
        position: 0,
        conditions: { field: 'category.id', op: 'eq', value: await categoryId('sales') },
      })
      .returning({ id: slaPolicies.id });
    await db.insert(slaPolicies).values({
      name: 'Standard',
      hoursSource: 'round_the_clock',
      targets: target(60, 480),
      position: 1,
      isDefault: true,
    });
    const { id } = await ticket();
    await db
      .update(conversations)
      .set({ firstResponseBreached: true })
      .where(eq(conversations.id, id));

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await afterRoutingChanged(id, { category: true, group: false });

    expect(await sla(id)).toMatchObject({ slaPolicyId: sales!.id, firstResponseBreached: false });
  });

  // A resolved ticket's clocks are a record of what it was held to. Changed
  // under them, a reopen shifted the old policy's resolution deadline (or none)
  // under the new policy's name.
  it('leaves a resolved or closed ticket’s policy and clocks alone', async () => {
    const { standard } = await policies();
    for (const name of ['Resolved', 'Closed']) {
      const { id } = await ticket();
      const [status] = await db
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.name, name));
      await db
        .update(conversations)
        .set({ statusId: status!.id, resolvedAt: new Date() })
        .where(eq(conversations.id, id));
      const before = await sla(id);

      await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
      await afterRoutingChanged(id, { category: true, group: false });

      expect(await sla(id)).toEqual(before);
      expect(before.slaPolicyId).toBe(standard);
      expect(await events(id, 'sla_recalculated')).toEqual([]);
    }
  });

  it('never reaches the bot channel, an imported history, or a ticket no SLA measures', async () => {
    await policies();
    const bot = await ticket({ channel: 'whatsapp_bot' });
    const imported = await ticket({ sourceSystem: 'import' });
    const spam = await ticket({ isSpam: true });
    const deleted = await ticket({ deletedAt: new Date() });
    const survivor = await ticket();
    const merged = await ticket({ mergedIntoId: survivor.id });

    for (const { id } of [bot, imported, spam, deleted, merged]) {
      await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
      await afterRoutingChanged(id, { category: true, group: false });
      expect(await events(id, 'sla_recalculated')).toEqual([]);
    }
  });
});

describe('afterRoutingChanged', () => {
  // What every routing writer calls once its write has committed (Stage 4.0).
  // A writer that changed nothing owes nothing, even where a re-selection
  // would choose another policy: the answer that said so is what it is handed.
  it('owes nothing when nothing changed, and chooses once when something did', async () => {
    const { sales, standard } = await policies();
    const { id } = await ticket();
    // Filed without the follow-up, so only the call below can move the policy.
    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });

    await afterRoutingChanged(id, { category: false, group: false });
    expect((await sla(id)).slaPolicyId).toBe(standard);
    expect(await events(id, 'sla_recalculated')).toEqual([]);

    await afterRoutingChanged(id, { category: true, group: false });
    expect((await sla(id)).slaPolicyId).toBe(sales);
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'policy', cause: 'category', policy: 'Sales' }),
    ]);
  });

  it('chooses once for a category and a group changed together, named by the category', async () => {
    const { sales } = await policies();
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care' })
      .returning({ id: groups.id });
    const { id } = await ticket();
    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await db
      .update(conversations)
      .set({ groupId: merchantCare!.id })
      .where(eq(conversations.id, id));

    await afterRoutingChanged(id, { category: true, group: true });

    expect((await sla(id)).slaPolicyId).toBe(sales);
    // One line, named by the category rather than the group. Both policies run
    // round the clock, so this pins the cause and not the order; the engine's
    // "re-times a rule's move" below pins the order.
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'policy', cause: 'category', policy: 'Sales' }),
    ]);
  });

  // The other half: a move the policy survives is still re-timed on the new
  // group's hours. A re-selection that finds the same policy does nothing, so
  // without `onGroupChanged` a group keeping its own calendar would never move
  // the ticket's deadlines onto it.
  it('re-times a move the same policy survives, on the new group’s hours', async () => {
    const [sundays] = await db
      .insert(businessHours)
      .values({
        name: 'An hour on Sundays',
        schedule: {
          sun: [{ start: '00:00', end: '01:00' }],
          mon: [],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
        },
      })
      .returning({ id: businessHours.id });
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care', businessHoursId: sundays!.id })
      .returning({ id: groups.id });
    forgetHoursCatalog();
    const [standard] = await db
      .insert(slaPolicies)
      .values({
        name: 'Standard',
        hoursSource: 'group',
        targets: target(120, 480),
        position: 0,
        isDefault: true,
      })
      .returning({ id: slaPolicies.id });
    const { id } = await ticket();
    const before = await sla(id);
    await db
      .update(conversations)
      .set({ groupId: merchantCare!.id })
      .where(eq(conversations.id, id));

    await afterRoutingChanged(id, { category: false, group: true });

    const after = await sla(id);
    expect(after.slaPolicyId).toBe(standard!.id);
    expect(after.firstResponseDueAt!.getTime()).toBeGreaterThan(
      before.firstResponseDueAt!.getTime(),
    );
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'group_hours' }),
    ]);
  });
});

describe('the automation engine', () => {
  it('files the ticket and chooses its policy once the pass is over', async () => {
    const { sales } = await policies();
    const { id } = await ticket();
    await db.insert(automationRules).values({
      name: 'Merchant number is sales',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'set_category', categoryId: await categoryId('sales') }],
    });

    await runAutomations('on_update', id);
    // A second pass finds it filed already and writes nothing.
    await runAutomations('on_update', id);

    expect((await sla(id)).slaPolicyId).toBe(sales);
    expect(await events(id, 'category_changed')).toEqual([
      expect.objectContaining({
        actorAgentId: null,
        actorLabel: 'automation:Merchant number is sales',
        data: expect.objectContaining({ key: 'sales', label: 'Sales', from: null }),
      }),
    ]);
  });

  it('chooses the policy for a group a rule moved a fresh ticket to', async () => {
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care' })
      .returning({ id: groups.id });
    const [care] = await db
      .insert(slaPolicies)
      .values({
        name: 'Merchant Care',
        hoursSource: 'round_the_clock',
        targets: target(45, 300),
        position: 0,
        conditions: { field: 'group.id', op: 'eq', value: merchantCare!.id },
      })
      .returning({ id: slaPolicies.id });
    await policies();
    const { id } = await ticket();
    await db.insert(automationRules).values({
      name: 'To Merchant Care',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'assign_group', groupId: merchantCare!.id }],
    });

    await runAutomations('on_update', id);

    expect((await sla(id)).slaPolicyId).toBe(care!.id);
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'policy', cause: 'group', policy: 'Merchant Care' }),
    ]);
  });

  it('leaves an on_create rule’s category to applySlaOnCreate, which reads it', async () => {
    const { sales } = await policies();
    await db.insert(automationRules).values({
      name: 'Everything is sales',
      trigger: 'on_create',
      conditions: {},
      actions: [{ type: 'set_category', categoryId: await categoryId('sales') }],
    });
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
      .values({ requesterContactId: contact!.id, statusId: status!.id, channel: 'whatsapp' })
      .returning({ id: conversations.id });

    // The order `afterInboundMessage` runs them in.
    await runAutomations('on_create', row!.id);
    expect((await sla(row!.id)).slaPolicyId).toBeNull();
    await applySlaOnCreate(row!.id);

    expect((await sla(row!.id)).slaPolicyId).toBe(sales);
    expect(await events(row!.id, 'sla_recalculated')).toEqual([]);
  });

  // The same reading, for a category a form or the console's chooser files at
  // creation. Written after `createTicket` returned, it would reach the first
  // selection too late, and the re-selection that then caught up would record
  // a move off a policy the ticket held for a second; in the insert, the first
  // selection is the only one.
  it('chooses the policy for a category a ticket is created with at the first selection', async () => {
    const { sales } = await policies();
    const salesId = await categoryId('sales');

    const { id, createdAt } = await opened(salesId);

    expect(await sla(id)).toMatchObject({
      slaPolicyId: sales,
      firstResponseDueAt: at(createdAt, 30),
      resolutionDueAt: at(createdAt, 240),
    });
    expect(await events(id, 'sla_recalculated')).toEqual([]);
    expect(await events(id, 'category_changed')).toEqual([
      {
        actorAgentId: null,
        actorLabel: 'form:x',
        data: { from: null, to: salesId, key: 'sales', label: 'Sales' },
      },
    ]);
  });

  // "Defaults, not overrides" (`NewTicket`): an on_create rule still has the
  // last word over the category a form filed, and the policy is the rule's.
  // Keyed on the category the ticket was created with, so the rule firing at
  // all is the on_create facts reading the insert — one written after
  // `createTicket` returned would leave this ticket on Sales.
  it('lets an on_create rule re-file a ticket created with a category, and the policy follows the rule', async () => {
    await policies();
    const salesId = await categoryId('sales');
    const merchantId = await categoryId('merchant_support');
    const [merchant] = await db
      .insert(slaPolicies)
      .values({
        name: 'Merchant support',
        hoursSource: 'round_the_clock',
        targets: target(45, 300),
        position: 0,
        conditions: { field: 'category.id', op: 'eq', value: merchantId },
      })
      .returning({ id: slaPolicies.id });
    await db.insert(automationRules).values({
      name: 'Sales enquiries are merchant support',
      trigger: 'on_create',
      conditions: { field: 'category.id', op: 'eq', value: salesId },
      actions: [{ type: 'set_category', categoryId: merchantId }],
    });

    const { id, categoryId: filed, createdAt } = await opened(salesId);

    expect(filed).toBe(merchantId);
    expect(await sla(id)).toMatchObject({
      slaPolicyId: merchant!.id,
      firstResponseDueAt: at(createdAt, 45),
      resolutionDueAt: at(createdAt, 300),
    });
    expect(await events(id, 'sla_recalculated')).toEqual([]);
    // Two lines, each crediting whoever made it: the form's default at
    // creation, then the rule's change from it.
    expect(await events(id, 'category_changed')).toEqual([
      {
        actorAgentId: null,
        actorLabel: 'form:x',
        data: { from: null, to: salesId, key: 'sales', label: 'Sales' },
      },
      {
        actorAgentId: null,
        actorLabel: 'automation:Sales enquiries are merchant support',
        data: { from: salesId, to: merchantId, key: 'merchant_support', label: 'Merchant support' },
      },
    ]);
  });

  // A rule naming the group a ticket is already in matches on every pass. Once
  // something else has changed since the policy was chosen — here a raised
  // priority, which keeps its policy (`onPriorityChanged`) — a second look
  // owed for a move that never happened switched it.
  it('owes nothing for a group rule that leaves the ticket where it is', async () => {
    const [care] = await db
      .insert(groups)
      .values({ name: 'Customer Care' })
      .returning({ id: groups.id });
    await db.insert(slaPolicies).values({
      name: 'Urgent',
      hoursSource: 'round_the_clock',
      targets: target(15, 120),
      position: 0,
      conditions: { field: 'priority', op: 'in', value: ['urgent'] },
    });
    const { standard } = await policies();
    const inCare = await ticket({ groupId: care!.id });
    const inNone = await ticket();
    expect((await sla(inCare.id)).slaPolicyId).toBe(standard);
    await db.update(conversations).set({ priority: 'urgent' });
    await db.insert(automationRules).values([
      {
        name: 'Care keeps care',
        trigger: 'on_update',
        conditions: { field: 'group.id', op: 'eq', value: care!.id },
        actions: [{ type: 'assign_group', groupId: care!.id }],
      },
      {
        name: 'Ungrouped stays ungrouped',
        trigger: 'on_update',
        conditions: { field: 'group.id', op: 'is_empty' },
        actions: [{ type: 'assign_group', groupId: null }],
      },
    ]);

    for (const { id } of [inCare, inNone]) {
      await runAutomations('on_update', id);

      expect((await sla(id)).slaPolicyId).toBe(standard);
      expect(await events(id, 'sla_recalculated')).toEqual([]);
      expect(await events(id, 'group_changed')).toEqual([]);
    }
  });

  it('owes nothing for an auto_assign the rota did not move', async () => {
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care' })
      .returning({ id: groups.id });
    await db.insert(slaPolicies).values({
      name: 'Urgent',
      hoursSource: 'round_the_clock',
      targets: target(15, 120),
      position: 0,
      conditions: { field: 'priority', op: 'in', value: ['urgent'] },
    });
    const { standard } = await policies();
    const [holder] = await db
      .insert(agents)
      .values({ name: 'Bob', email: 'bob@shipblu.test', role: 'agent' })
      .returning({ id: agents.id });
    // Held by somebody who is not its number's owner: a rule has never moved
    // their ticket (`assignConversation`). Raised since its policy was chosen,
    // so a second look owed for the move that did not happen would switch it.
    const { id } = await ticket({ assigneeAgentId: holder!.id, assignedAt: new Date() });
    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));
    await db.insert(automationRules).values({
      name: 'Route to Merchant Care',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'auto_assign', groupId: merchantCare!.id, strategy: 'group_default' }],
    });

    await runAutomations('on_update', id);

    expect(await sla(id)).toMatchObject({ slaPolicyId: standard });
    expect(await events(id, 'sla_recalculated')).toEqual([]);
    expect(await events(id, 'group_changed')).toEqual([]);
  });

  // The move commits before the pick runs, so a failure after it — here the
  // timeline line, refused by a trigger — still owes the clocks the new
  // group's calendar. Read off the call's answer, the throw took it along.
  it('re-times an auto_assign’s move when the call fails after it', async () => {
    const [sundays] = await db
      .insert(businessHours)
      .values({
        name: 'An hour on Sundays',
        schedule: {
          sun: [{ start: '00:00', end: '01:00' }],
          mon: [],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
        },
      })
      .returning({ id: businessHours.id });
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care', businessHoursId: sundays!.id })
      .returning({ id: groups.id });
    forgetHoursCatalog();
    await db.insert(slaPolicies).values({
      name: 'Standard',
      hoursSource: 'group',
      targets: target(120, 480),
      position: 0,
      isDefault: true,
    });
    const { id } = await ticket();
    const before = await sla(id);
    await db.insert(automationRules).values({
      name: 'Route to Merchant Care',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'auto_assign', groupId: merchantCare!.id, strategy: 'group_default' }],
    });

    await db.execute(sql`
      create function refuse_group_changed() returns trigger language plpgsql
      as $$ begin raise exception 'refused for the test'; end $$`);
    await db.execute(sql`
      create trigger refuse_group_changed before insert on conversation_events
      for each row when (new.type = 'group_changed') execute function refuse_group_changed()`);
    try {
      await runAutomations('on_update', id);
    } finally {
      await db.execute(sql`drop trigger refuse_group_changed on conversation_events`);
      await db.execute(sql`drop function refuse_group_changed()`);
    }

    const [row] = await db
      .select({ groupId: conversations.groupId })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.groupId).toBe(merchantCare!.id);
    expect(await events(id, 'group_changed')).toEqual([]);
    expect((await sla(id)).firstResponseDueAt!.getTime()).toBeGreaterThan(
      before.firstResponseDueAt!.getTime(),
    );
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'group_hours' }),
    ]);
  });

  // The order inside `afterRoutingChanged`, through the engine's pass: the
  // policy first, then the calendar. The engine once re-timed first, so a move
  // to a group with other hours re-timed the old policy's clocks there and then
  // replaced them — two timeline lines for one move, the first naming
  // deadlines that never held.
  it('re-times a rule’s move to a group with other hours once, under the policy it chose', async () => {
    const [sundays] = await db
      .insert(businessHours)
      .values({
        name: 'An hour on Sundays',
        schedule: {
          sun: [{ start: '00:00', end: '01:00' }],
          mon: [],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
        },
      })
      .returning({ id: businessHours.id });
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care', businessHoursId: sundays!.id })
      .returning({ id: groups.id });
    forgetHoursCatalog();
    // On the group's hours, both of them: the default's clocks would move to
    // the new calendar if anything re-timed them before the re-selection.
    const [care] = await db
      .insert(slaPolicies)
      .values({
        name: 'Merchant Care',
        hoursSource: 'group',
        targets: target(45, 300),
        position: 0,
        conditions: { field: 'group.id', op: 'eq', value: merchantCare!.id },
      })
      .returning({ id: slaPolicies.id });
    await db.insert(slaPolicies).values({
      name: 'Standard',
      hoursSource: 'group',
      targets: target(120, 480),
      position: 1,
      isDefault: true,
    });
    const { id } = await ticket();
    await db.insert(automationRules).values({
      name: 'To Merchant Care',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'assign_group', groupId: merchantCare!.id }],
    });

    await runAutomations('on_update', id);

    expect((await sla(id)).slaPolicyId).toBe(care!.id);
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'policy', cause: 'group', policy: 'Merchant Care' }),
    ]);
  });

  // The group moves first, to a group with a policy of its own, and the
  // category lands after it, keyed to a policy ranked above both. Chosen per
  // action, the ticket would take the group's policy and then the category's,
  // two timeline lines; chosen once, from where the pass left it, one.
  it('chooses one policy for a pass that moves the ticket and then files it', async () => {
    const [merchantCare] = await db
      .insert(groups)
      .values({ name: 'Merchant Care' })
      .returning({ id: groups.id });
    const [sales] = await db
      .insert(slaPolicies)
      .values([
        {
          name: 'Sales',
          hoursSource: 'round_the_clock',
          targets: target(30, 240),
          position: 0,
          conditions: { field: 'category.id', op: 'eq', value: await categoryId('sales') },
        },
        {
          name: 'Merchant Care',
          hoursSource: 'round_the_clock',
          targets: target(45, 300),
          position: 1,
          conditions: { field: 'group.id', op: 'eq', value: merchantCare!.id },
        },
        {
          name: 'Standard',
          hoursSource: 'round_the_clock',
          targets: target(120, 480),
          position: 2,
          isDefault: true,
        },
      ])
      .returning({ id: slaPolicies.id });
    const { id } = await ticket();
    await db.insert(automationRules).values([
      {
        name: 'To Merchant Care',
        trigger: 'on_update',
        conditions: {},
        position: 0,
        actions: [{ type: 'assign_group', groupId: merchantCare!.id }],
      },
      {
        name: 'Merchant number is sales',
        trigger: 'on_update',
        conditions: {},
        position: 1,
        actions: [{ type: 'set_category', categoryId: await categoryId('sales') }],
      },
    ]);

    await runAutomations('on_update', id);

    expect((await sla(id)).slaPolicyId).toBe(sales!.id);
    expect(await events(id, 'group_changed')).toHaveLength(1);
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'policy', cause: 'category', policy: 'Sales' }),
    ]);
  });

  it('skips a retired category, and says nothing on the timeline', async () => {
    await policies();
    const { id } = await ticket();
    const sales = await categoryId('sales');
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.id, sales));
    await db.insert(automationRules).values({
      name: 'Old rule',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'set_category', categoryId: sales }],
    });

    await runAutomations('on_update', id);

    expect(await events(id, 'category_changed')).toEqual([]);
  });
});

describe('setConversationCategory', () => {
  it('writes nothing when the ticket already carries the category', async () => {
    const { id } = await ticket();
    const sales = await categoryId('sales');

    expect(await setConversationCategory(id, sales, { label: 'x' })).toEqual({
      outcome: 'changed',
      from: null,
      to: sales,
    });
    expect(await setConversationCategory(id, sales, { label: 'x' })).toEqual({
      outcome: 'unchanged',
    });
    expect(await events(id, 'category_changed')).toHaveLength(1);
  });

  it('refuses a category that is gone or retired, and clears to none', async () => {
    const { id } = await ticket();
    const courier = await categoryId('courier_jobs');
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.id, courier));

    expect(await setConversationCategory(id, courier, { label: 'x' })).toEqual({
      outcome: 'retired_category',
    });
    expect(
      await setConversationCategory(id, '00000000-0000-0000-0000-000000000000', { label: 'x' }),
    ).toEqual({ outcome: 'unknown_category' });

    const sales = await categoryId('sales');
    await setConversationCategory(id, sales, { label: 'x' });
    expect(await setConversationCategory(id, null, { label: 'y' })).toEqual({
      outcome: 'changed',
      from: sales,
      to: null,
    });
    expect((await events(id, 'category_changed')).map((e) => e.data)).toEqual([
      expect.objectContaining({ from: null, to: sales, key: 'sales' }),
      expect.objectContaining({ from: sales, to: null, key: null, label: null }),
    ]);
  });
});
