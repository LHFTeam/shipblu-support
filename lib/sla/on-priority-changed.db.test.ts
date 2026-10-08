import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  automationRules,
  contacts,
  conversationEvents,
  conversations,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import { runAutomations } from '@/lib/automations';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  applySlaOnCreate,
  onAgentReply,
  onCustomerReply,
  onPriorityChanged,
  onStatusChanged,
} from './index';

/**
 * A priority change re-times the clocks still owed.
 *
 * Before `onPriorityChanged`, the policy's per-priority targets were read once,
 * at creation, so raising a ticket to urgent changed the badge and left
 * medium's deadline. What only a database shows: which columns move, which do
 * not, and that the automation path reaches it.
 */

withCleanDatabase();

const MINUTE = 60_000;

/** Every clock half as long for high and urgent, as the production policies are. */
const TARGETS = {
  low: { firstResponseMins: 120, nextResponseMins: 60, resolutionMins: 480 },
  medium: { firstResponseMins: 120, nextResponseMins: 60, resolutionMins: 480 },
  high: { firstResponseMins: 60, nextResponseMins: 30, resolutionMins: 240 },
  urgent: { firstResponseMins: 60, nextResponseMins: 30, resolutionMins: 240 },
};

async function ticketUnderPolicy(): Promise<string> {
  await db.insert(slaPolicies).values({ name: 'Live support', targets: TARGETS, isDefault: true });
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
    .values({ requesterContactId: contact!.id, statusId: status!.id, channel: 'facebook' })
    .returning({ id: conversations.id });
  await applySlaOnCreate(row!.id);
  return row!.id;
}

async function clocks(id: string) {
  const [row] = await db
    .select({
      firstResponseDueAt: conversations.firstResponseDueAt,
      resolutionDueAt: conversations.resolutionDueAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

describe('onPriorityChanged', () => {
  it('moves every owed clock to the new priority’s target, and says why', async () => {
    const id = await ticketUnderPolicy();
    const before = await clocks(id);

    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    const after = await clocks(id);
    expect(after.firstResponseDueAt!.getTime()).toBe(
      before.firstResponseDueAt!.getTime() - 60 * MINUTE,
    );
    expect(after.resolutionDueAt!.getTime()).toBe(before.resolutionDueAt!.getTime() - 240 * MINUTE);

    const events = await db
      .select({ data: conversationEvents.data })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, id),
          eq(conversationEvents.type, 'sla_recalculated'),
        ),
      );
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ reason: 'priority', priority: 'urgent' }),
    ]);
  });

  it('leaves a clock that has already been met', async () => {
    const id = await ticketUnderPolicy();
    await onAgentReply(id);
    const before = await clocks(id);

    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    expect((await clocks(id)).firstResponseDueAt).toEqual(before.firstResponseDueAt);
  });

  it('writes nothing when the new priority has the same targets', async () => {
    const id = await ticketUnderPolicy();
    await db.update(conversations).set({ priority: 'low' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    const events = await db
      .select()
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, id),
          eq(conversationEvents.type, 'sla_recalculated'),
        ),
      );
    expect(events).toEqual([]);
  });

  it('is reached by an automation raising priority on a live ticket', async () => {
    const id = await ticketUnderPolicy();
    const before = await clocks(id);
    await db.insert(automationRules).values({
      name: 'Escalate',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'set_priority', value: 'urgent' }],
    });

    await runAutomations('on_update', id);

    expect((await clocks(id)).firstResponseDueAt!.getTime()).toBe(
      before.firstResponseDueAt!.getTime() - 60 * MINUTE,
    );
  });
});

describe('onPriorityChanged around pauses', () => {
  async function pauseFor(id: string, from: Date, minutes: number) {
    await db.insert(conversationEvents).values([
      { conversationId: id, type: 'sla_paused', actorLabel: 'sla', createdAt: from },
      {
        conversationId: id,
        type: 'sla_resumed',
        actorLabel: 'sla',
        data: { pausedMinutes: minutes },
        createdAt: new Date(from.getTime() + minutes * MINUTE),
      },
    ]);
  }

  it('does not excuse the reply clock for a pause that ended before the customer last wrote', async () => {
    const lastWrote = new Date(Date.now() - 5 * MINUTE);

    /** Answered, reopened, the customer wrote five minutes ago; raised to urgent. */
    async function raisedReplyClock(parkedBefore: boolean): Promise<number> {
      const id = await ticketUnderPolicy();
      const created = (await clocks(id)).createdAt;
      await onAgentReply(id, created);
      if (parkedBefore) {
        // Two days on Pending, finished a day before the customer wrote.
        await pauseFor(id, new Date(lastWrote.getTime() - 3 * 24 * 60 * MINUTE), 2 * 24 * 60);
      }
      await db
        .update(conversations)
        .set({ lastCustomerMessageAt: lastWrote, nextResponseDueAt: lastWrote })
        .where(eq(conversations.id, id));
      await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));
      await onPriorityChanged(id);

      const [row] = await db
        .select({ due: conversations.nextResponseDueAt })
        .from(conversations)
        .where(eq(conversations.id, id));
      return row!.due!.getTime();
    }

    // The policy is shared, so the second ticket creates its own default; only
    // one may be the default at a time, which is why each is read in turn.
    const without = await raisedReplyClock(false);
    await db.delete(slaPolicies);
    const withPause = await raisedReplyClock(true);

    expect(withPause).toBe(without);
  });

  it('does not credit a pause still open, which the resume credits in full', async () => {
    const id = await ticketUnderPolicy();
    const before = await clocks(id);
    await db.insert(conversationEvents).values({
      conversationId: id,
      type: 'sla_paused',
      actorLabel: 'sla',
      createdAt: new Date(Date.now() - 30 * MINUTE),
    });

    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    expect((await clocks(id)).resolutionDueAt!.getTime()).toBe(
      before.resolutionDueAt!.getTime() - 240 * MINUTE,
    );
  });

  it('agrees with the resume about a pause the customer wrote in the middle of', async () => {
    const id = await ticketUnderPolicy();
    // Opened six hours ago, so the pause below falls inside its life.
    const created = new Date(Date.now() - 6 * 60 * MINUTE);
    await db.update(conversations).set({ createdAt: created }).where(eq(conversations.id, id));
    await applySlaOnCreate(id);
    await onAgentReply(id, new Date(created.getTime() + 30 * MINUTE));

    // Parked, the customer writes while it is parked, then it is reopened now.
    const parkedAt = new Date(Date.now() - 4 * 60 * MINUTE);
    const wroteAt = new Date(Date.now() - 2 * 60 * MINUTE);
    await db
      .insert(conversationEvents)
      .values({ conversationId: id, type: 'sla_paused', actorLabel: 'sla', createdAt: parkedAt });
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: wroteAt })
      .where(eq(conversations.id, id));
    await onCustomerReply(id, wroteAt);
    await onStatusChanged(id, false);

    const [resumed] = await db
      .select({ due: conversations.nextResponseDueAt })
      .from(conversations)
      .where(eq(conversations.id, id));

    // Same targets as medium: a re-time must change nothing and say nothing.
    await db.update(conversations).set({ priority: 'low' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    const [after] = await db
      .select({ due: conversations.nextResponseDueAt })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(after!.due).toEqual(resumed!.due);
    const recalculated = await db
      .select()
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, id),
          eq(conversationEvents.type, 'sla_recalculated'),
        ),
      );
    expect(recalculated.map((r) => r.data)).toEqual([]);
  });
});
