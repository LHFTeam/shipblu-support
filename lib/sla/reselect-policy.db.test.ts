import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  automationRules,
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
import { withCleanDatabase } from '@/lib/testing/db';
import { applySlaOnCreate, onAgentReply, reselectPolicyBeforeFirstResponse } from './index';

/**
 * Choosing the policy again when the category or the group changes before the
 * first response (`plans/ticket-category-routing.md`, decision 3).
 *
 * What only a database shows: that the policy column moves with the clocks,
 * that the clocks are counted from the ticket's own anchors with its finished
 * pauses credited, that a ticket nobody gave a clock gets one, and that the
 * category writer and the automation engine both reach it — and that an
 * `on_create` rule leaves the choice to `applySlaOnCreate`.
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

describe('reselectPolicyBeforeFirstResponse', () => {
  it('holds a ticket filed under a category to that category’s policy, from its arrival', async () => {
    const { sales, standard } = await policies();
    const { id, createdAt } = await ticket();
    expect((await sla(id)).slaPolicyId).toBe(standard);

    await setConversationCategory(id, await categoryId('sales'), { label: 'automation:test' });
    await reselectPolicyBeforeFirstResponse(id, 'category');

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
    await reselectPolicyBeforeFirstResponse(id, 'category');

    expect(await sla(id)).toEqual(before);
    expect(before.slaPolicyId).toBe(standard);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('keeps the policy once somebody has answered', async () => {
    const { standard } = await policies();
    const { id } = await ticket();
    await onAgentReply(id);

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await reselectPolicyBeforeFirstResponse(id, 'category');

    expect((await sla(id)).slaPolicyId).toBe(standard);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('gives clocks to a ticket whose first selection found no policy', async () => {
    const { sales } = await policies(false);
    const { id, createdAt } = await ticket();
    expect(await sla(id)).toMatchObject({ slaPolicyId: null, firstResponseDueAt: null });

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await reselectPolicyBeforeFirstResponse(id, 'category');

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
    await reselectPolicyBeforeFirstResponse(id, 'category');

    expect(await sla(id)).toMatchObject({
      slaPolicyId: sales,
      firstResponseDueAt: at(createdAt, 30 + 30),
      resolutionDueAt: at(createdAt, 240 + 30),
    });
  });

  it('re-times a running reply clock from the customer’s newest message', async () => {
    const { sales } = await policies();
    const { id, createdAt } = await ticket();
    const wrote = at(createdAt, 50);
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: wrote, nextResponseDueAt: at(wrote, 120) })
      .where(eq(conversations.id, id));

    await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
    await reselectPolicyBeforeFirstResponse(id, 'category');

    expect(await sla(id)).toMatchObject({ slaPolicyId: sales, nextResponseDueAt: at(wrote, 30) });
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
    await reselectPolicyBeforeFirstResponse(id, 'category');

    expect(await sla(id)).toMatchObject({ slaPolicyId: sales!.id, firstResponseBreached: false });
  });

  it('never reaches the bot channel or an imported history', async () => {
    await policies();
    const bot = await ticket({ channel: 'whatsapp_bot' });
    const imported = await ticket({ sourceSystem: 'import' });

    for (const { id } of [bot, imported]) {
      await setConversationCategory(id, await categoryId('sales'), { label: 'x' });
      await reselectPolicyBeforeFirstResponse(id, 'category');
      expect(await events(id, 'sla_recalculated')).toEqual([]);
    }
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
