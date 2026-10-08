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
import { applySlaOnCreate, onAgentReply, onPriorityChanged } from './index';

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
