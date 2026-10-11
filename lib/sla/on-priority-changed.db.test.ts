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
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
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
  // Round the clock, so a target is a fixed number of wall-clock minutes. Under
  // the seeded Cairo calendar, 60 and 120 working minutes from 15:30 land either
  // side of the 17:00 close, and the assertions would hold or not by time of day.
  await db.insert(slaPolicies).values({
    name: 'Live support',
    hoursSource: 'round_the_clock',
    targets: TARGETS,
    isDefault: true,
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
    .values({ requesterContactId: contact!.id, statusId: status!.id, channel: 'facebook' })
    .returning({ id: conversations.id });
  await applySlaOnCreate(row!.id);
  return row!.id;
}

async function pendingStatus(): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Pending'));
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

describe('onPriorityChanged against another priority change', () => {
  it('does not write one priority’s deadlines over a newer priority’s', async () => {
    const id = await ticketUnderPolicy();
    const { createdAt } = await clocks(id);
    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));

    // Another writer holds the row: it moves the priority back to medium and
    // re-times the ticket for it, while this re-time — computed from urgent —
    // is waiting to write.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const other = db.transaction(async (tx) => {
      await tx.select().from(conversations).where(eq(conversations.id, id)).for('update');
      locked();
      await held;
      await tx
        .update(conversations)
        .set({
          priority: 'medium',
          firstResponseDueAt: new Date(createdAt.getTime() + 120 * MINUTE),
          resolutionDueAt: new Date(createdAt.getTime() + 480 * MINUTE),
        })
        .where(eq(conversations.id, id));
    });
    await lockTaken;

    const stale = onPriorityChanged(id);
    // Until it is queued behind the lock.
    await untilWaitingOnALock(db);
    release();
    await other;
    await stale;

    const after = await clocks(id);
    expect(after.firstResponseDueAt!.getTime()).toBe(createdAt.getTime() + 120 * MINUTE);
    expect(after.resolutionDueAt!.getTime()).toBe(createdAt.getTime() + 480 * MINUTE);
  });
});

describe('onPriorityChanged against a resume', () => {
  it('credits a pause whose resume it waited on', async () => {
    // The resume has shifted the clocks for half an hour on Pending and not yet
    // committed. A re-time that read the timeline before the resume's event
    // existed would rebuild the clocks with no pause in them and write over the
    // shift — the half hour handed back to nobody.
    const id = await ticketUnderPolicy();
    // Opened an hour ago, so the whole pause falls inside the ticket's life.
    const createdAt = new Date(Date.now() - 60 * MINUTE);
    await db
      .update(conversations)
      .set({ createdAt, priority: 'urgent' })
      .where(eq(conversations.id, id));
    await db.insert(conversationEvents).values({
      conversationId: id,
      type: 'sla_paused',
      actorLabel: 'sla',
      createdAt: new Date(Date.now() - 30 * MINUTE),
    });

    const hold = holdNextTransaction('after');
    const resume = onStatusChanged(id, false);
    await hold.atHold;
    const retime = onPriorityChanged(id);
    await untilWaitingOnALock(db);
    hold.release();
    await Promise.all([resume, retime]);

    const after = await clocks(id);
    const urgentPlusPause = createdAt.getTime() + (60 + 30) * MINUTE;
    expect(Math.abs(after.firstResponseDueAt!.getTime() - urgentPlusPause)).toBeLessThan(MINUTE);
  });
});

describe('onPriorityChanged and a missed target', () => {
  /** A ticket opened 90 minutes ago at `priority`, its clocks as the policy set them. */
  async function ninetyMinutesOld(priority: 'medium' | 'urgent', breached: boolean) {
    const id = await ticketUnderPolicy();
    const createdAt = new Date(Date.now() - 90 * MINUTE);
    const target = TARGETS[priority];
    await db
      .update(conversations)
      .set({
        priority,
        createdAt,
        firstResponseDueAt: new Date(createdAt.getTime() + target.firstResponseMins * MINUTE),
        resolutionDueAt: new Date(createdAt.getTime() + target.resolutionMins * MINUTE),
        firstResponseBreached: breached,
      })
      .where(eq(conversations.id, id));
    return id;
  }

  async function breachedFlags(id: string) {
    const [row] = await db
      .select({
        firstResponse: conversations.firstResponseBreached,
        resolution: conversations.resolutionBreached,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  it('clears the breach of a target the ticket is no longer held to', async () => {
    // Urgent's hour passed and the sweep flagged it; lowered to medium, the
    // ticket is owed its first response in half an hour, not an hour ago.
    const id = await ninetyMinutesOld('urgent', true);
    await db.update(conversations).set({ priority: 'medium' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    expect(await breachedFlags(id)).toEqual({ firstResponse: false, resolution: false });
    const [event] = await db
      .select({ data: conversationEvents.data })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, id),
          eq(conversationEvents.type, 'sla_recalculated'),
        ),
      );
    expect(event!.data).toMatchObject({ clearedBreaches: ['first_response'] });
  });

  it('leaves a raise into the past for the sweep to flag, with its event', async () => {
    const id = await ninetyMinutesOld('medium', false);
    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    expect(await breachedFlags(id)).toEqual({ firstResponse: false, resolution: false });
    expect((await clocks(id)).firstResponseDueAt!.getTime()).toBeLessThan(Date.now());
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
    // Parked on Pending, which stops the clock: a pause on an Open ticket is
    // one `onCustomerReply` closes as stray.
    await db
      .update(conversations)
      .set({ statusId: await pendingStatus() })
      .where(eq(conversations.id, id));
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

  it('rebuilds the pause the resume credited, not one ending when its event was written', async () => {
    // The resume's shift is computed from `at`, taken when the call starts; its
    // event used to be stamped by the database rounds later. A re-time rebuilt
    // the pause to the stamp, so it disagreed by however far apart the two
    // were — a minute, across a rounding boundary. Ten here, to see it at all.
    const id = await ticketUnderPolicy();
    const created = new Date(Date.now() - 6 * 60 * MINUTE);
    await db.update(conversations).set({ createdAt: created }).where(eq(conversations.id, id));
    await applySlaOnCreate(id);
    await onAgentReply(id, new Date(created.getTime() + 30 * MINUTE));

    const parkedAt = new Date(Date.now() - 4 * 60 * MINUTE);
    const wroteAt = new Date(Date.now() - 2 * 60 * MINUTE);
    const resumedAt = new Date(Date.now() - 10 * MINUTE);
    // Parked on Pending, which stops the clock: a pause on an Open ticket is
    // one `onCustomerReply` closes as stray.
    await db
      .update(conversations)
      .set({ statusId: await pendingStatus() })
      .where(eq(conversations.id, id));
    await db
      .insert(conversationEvents)
      .values({ conversationId: id, type: 'sla_paused', actorLabel: 'sla', createdAt: parkedAt });
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: wroteAt })
      .where(eq(conversations.id, id));
    await onCustomerReply(id, wroteAt);
    await onStatusChanged(id, false, resumedAt);

    const [resumed] = await db
      .select({ due: conversations.nextResponseDueAt })
      .from(conversations)
      .where(eq(conversations.id, id));

    await db.update(conversations).set({ priority: 'low' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    const [after] = await db
      .select({ due: conversations.nextResponseDueAt })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(after!.due).toEqual(resumed!.due);
  });
});
