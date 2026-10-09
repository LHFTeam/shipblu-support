import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversationEvents,
  conversations,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import { appendReply } from '@/lib/portal/tickets';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import {
  applySlaOnCreate,
  onAgentReply,
  onCustomerReply,
  onPriorityChanged,
  onStatusChanged,
} from './index';

/**
 * Paused time, against the seeded Cairo calendar: Sunday to Thursday, 09:00 to
 * 17:00, Friday and Saturday shut.
 *
 * The calendar is the point, which is why these policies are not round the
 * clock as the other SLA tests' are: a pause is credited in the hours the clock
 * counts, and only a calendar with closed hours can tell working minutes from
 * wall-clock ones. Thursday 8 October 2026 is a working day, the 9th and 10th
 * are the weekend, and Sunday the 11th opens the next week.
 */

withCleanDatabase();

/** The same targets for every priority, so a re-time to another one moves nothing. */
const TARGET = { firstResponseMins: 60, nextResponseMins: 60, resolutionMins: 240 };
const TARGETS = { low: TARGET, medium: TARGET, high: TARGET, urgent: TARGET };

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function ticket(createdAt: Date): Promise<{ id: string; contactId: string; number: number }> {
  await db.insert(slaPolicies).values({ name: 'Office hours', targets: TARGETS, isDefault: true });
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: await statusId('Open'),
      channel: 'portal',
      createdAt,
    })
    .returning({ id: conversations.id, number: conversations.number });
  await applySlaOnCreate(row!.id);
  return { id: row!.id, contactId: contact!.id, number: row!.number };
}

async function clocks(id: string) {
  const [row] = await db
    .select({
      firstResponseDueAt: conversations.firstResponseDueAt,
      nextResponseDueAt: conversations.nextResponseDueAt,
      resolutionDueAt: conversations.resolutionDueAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function events(id: string, type: string) {
  return db
    .select({ createdAt: conversationEvents.createdAt, data: conversationEvents.data })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)))
    .orderBy(asc(conversationEvents.createdAt));
}

describe('a pause is credited in working minutes', () => {
  // Parked over the weekend: 66 hours on the clock, two working hours.
  it('moves a deadline by the working time the ticket was parked, not the wall-clock time', async () => {
    const { id } = await ticket(cairo('2026-10-08T15:00'));
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-11T11:00'));

    await onStatusChanged(id, true, cairo('2026-10-08T16:00'));
    await onStatusChanged(id, false, cairo('2026-10-11T10:00'));

    // An hour of work before the pause, three after it from Sunday 10:00.
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-11T13:00'));
  });

  it('agrees with a re-time afterwards, which moves nothing and says nothing', async () => {
    const { id } = await ticket(cairo('2026-10-08T15:00'));
    await onStatusChanged(id, true, cairo('2026-10-08T16:00'));
    await onStatusChanged(id, false, cairo('2026-10-11T10:00'));
    const resumed = await clocks(id);

    await db.update(conversations).set({ priority: 'low' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);

    expect(await clocks(id)).toEqual(resumed);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('credits the reply clock only the working time after the customer wrote', async () => {
    const { id } = await ticket(cairo('2026-10-08T15:00'));
    await onAgentReply(id, cairo('2026-10-08T15:30'));
    await db
      .update(conversations)
      .set({ statusId: await statusId('Pending') })
      .where(eq(conversations.id, id));
    await onStatusChanged(id, true, cairo('2026-10-08T16:00'));

    // The customer writes on Friday, a closed day, to the parked ticket: the
    // reply is owed an hour of Sunday morning.
    const wrote = cairo('2026-10-09T12:00');
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: wrote })
      .where(eq(conversations.id, id));
    await onCustomerReply(id, wrote);
    expect((await clocks(id)).nextResponseDueAt).toEqual(cairo('2026-10-11T10:00'));

    // Parked until 10:30 Sunday: ninety working minutes after the customer wrote.
    await onStatusChanged(id, false, cairo('2026-10-11T10:30'));

    expect((await clocks(id)).nextResponseDueAt).toEqual(cairo('2026-10-11T11:30'));
  });

  // Every resume recorded before this change carries only its wall-clock minutes.
  it('rebuilds a resume recorded without its start from the pause that opened it', async () => {
    const modern = await ticket(cairo('2026-10-08T15:00'));
    await onStatusChanged(modern.id, true, cairo('2026-10-08T16:00'));
    await onStatusChanged(modern.id, false, cairo('2026-10-11T10:00'));

    await db.delete(slaPolicies);
    const legacy = await ticket(cairo('2026-10-08T15:00'));
    await db.insert(conversationEvents).values([
      {
        conversationId: legacy.id,
        type: 'sla_paused',
        actorLabel: 'sla',
        createdAt: cairo('2026-10-08T16:00'),
      },
      {
        conversationId: legacy.id,
        type: 'sla_resumed',
        actorLabel: 'sla',
        createdAt: cairo('2026-10-11T10:00'),
        data: { pausedMinutes: 66 * 60 },
      },
    ]);

    // Re-timed from its anchors, the legacy ticket lands where the modern one did.
    await db
      .update(conversations)
      .set({ priority: 'high', resolutionDueAt: cairo('2026-10-11T11:00') })
      .where(eq(conversations.id, legacy.id));
    await onPriorityChanged(legacy.id);

    expect((await clocks(legacy.id)).resolutionDueAt).toEqual(
      (await clocks(modern.id)).resolutionDueAt,
    );
  });
});

describe('a reopened ticket’s pause', () => {
  /** Answered, then resolved at 12:00 on Thursday, which pauses the clock. */
  async function resolvedTicket() {
    const created = await ticket(cairo('2026-10-08T10:00'));
    await onAgentReply(created.id, cairo('2026-10-08T10:30'));
    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved'), resolvedAt: cairo('2026-10-08T12:00') })
      .where(eq(conversations.id, created.id));
    await onStatusChanged(created.id, true, cairo('2026-10-08T12:00'));
    return created;
  }

  /** What `reopenResolved` writes, at a chosen instant. */
  async function reopen(id: string, at: Date) {
    await db
      .update(conversations)
      .set({ statusId: await statusId('Open'), resolvedAt: null })
      .where(eq(conversations.id, id));
    await db.insert(conversationEvents).values({
      conversationId: id,
      type: 'reopened',
      actorLabel: 'portal',
      createdAt: at,
      data: { reason: 'customer_replied' },
    });
  }

  it('ends when the ticket reopened, and credits the time it sat resolved', async () => {
    const { id } = await resolvedTicket();
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-08T14:00'));

    await reopen(id, cairo('2026-10-11T10:00'));
    await onCustomerReply(id, cairo('2026-10-11T10:05'));

    const resumed = await events(id, 'sla_resumed');
    expect(resumed.map((event) => event.createdAt)).toEqual([cairo('2026-10-11T10:00')]);
    // Two hours of work were left at 12:00 Thursday; they run from 10:00 Sunday.
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-11T12:00'));
  });

  it('lets a later Pending credit only its own pause', async () => {
    const { id } = await resolvedTicket();
    await reopen(id, cairo('2026-10-11T10:00'));
    await onCustomerReply(id, cairo('2026-10-11T10:05'));

    await onStatusChanged(id, true, cairo('2026-10-11T10:30'));
    await onStatusChanged(id, false, cairo('2026-10-11T11:00'));

    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-11T12:30'));
    expect(await events(id, 'sla_paused')).toHaveLength(2);
  });

  it('is left alone when the customer writes to a ticket parked on Pending', async () => {
    const { id } = await ticket(cairo('2026-10-08T10:00'));
    await onAgentReply(id, cairo('2026-10-08T10:30'));
    await db
      .update(conversations)
      .set({ statusId: await statusId('Pending') })
      .where(eq(conversations.id, id));
    await onStatusChanged(id, true, cairo('2026-10-08T12:00'));

    await onCustomerReply(id, cairo('2026-10-08T13:00'));

    expect(await events(id, 'sla_resumed')).toEqual([]);
  });

  it('is closed by a real reopen, a portal reply on a resolved ticket', async () => {
    const created = await ticket(new Date(Date.now() - 2 * 60 * 60_000));
    await onAgentReply(created.id, new Date(Date.now() - 90 * 60_000));
    await db
      .update(conversations)
      .set({ statusId: await statusId('Resolved'), resolvedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(conversations.id, created.id));
    await onStatusChanged(created.id, true, new Date(Date.now() - 60 * 60_000));

    expect(
      await appendReply(created.contactId, created.number, 'it came back broken'),
    ).not.toBeNull();

    // The reopen is stamped when its transaction commits, a moment after the
    // reply it reopened for; the pause ends at the reply.
    const [ticketRow] = await db
      .select({ wrote: conversations.lastCustomerMessageAt })
      .from(conversations)
      .where(eq(conversations.id, created.id));
    const resumed = await events(created.id, 'sla_resumed');
    expect(resumed.map((event) => event.createdAt)).toEqual([ticketRow!.wrote]);
  });

  it('ends at the customer’s message when the reopen was written after it', async () => {
    const { id } = await resolvedTicket();
    // A delayed delivery: the mail reached us at 10:00, the reopen committed at 10:40.
    await reopen(id, cairo('2026-10-11T10:40'));
    const wrote = cairo('2026-10-11T10:00');
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: wrote })
      .where(eq(conversations.id, id));
    await onCustomerReply(id, wrote);
    const live = await clocks(id);

    expect((await events(id, 'sla_resumed')).map((event) => event.createdAt)).toEqual([wrote]);

    await db.update(conversations).set({ priority: 'low' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);
    expect(await clocks(id)).toEqual(live);
  });

  // A burst of messages to a resolved ticket: each delivery is its own job.
  it('is closed once when several messages arrive together', async () => {
    const { id } = await resolvedTicket();
    await reopen(id, cairo('2026-10-11T10:00'));

    await Promise.all([
      onCustomerReply(id, cairo('2026-10-11T10:05')),
      onCustomerReply(id, cairo('2026-10-11T10:06')),
      onCustomerReply(id, cairo('2026-10-11T10:07')),
    ]);

    expect(await events(id, 'sla_resumed')).toHaveLength(1);
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-11T12:00'));

    await db.update(conversations).set({ priority: 'low' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-11T12:00'));
  });
});

describe('a pause with no working time in it', () => {
  it('moves no deadline, even one sitting at closing time', async () => {
    // Due at 17:00 Thursday, the close; parked from 17:30 to 18:00, all after hours.
    const { id } = await ticket(cairo('2026-10-08T13:00'));
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-08T17:00'));

    await onStatusChanged(id, true, cairo('2026-10-08T17:30'));
    await onStatusChanged(id, false, cairo('2026-10-08T18:00'));
    expect((await clocks(id)).resolutionDueAt).toEqual(cairo('2026-10-08T17:00'));

    await db.update(conversations).set({ priority: 'low' }).where(eq(conversations.id, id));
    await onPriorityChanged(id);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });
});
