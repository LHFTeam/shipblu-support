import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  businessHours,
  contacts,
  conversationEvents,
  conversations,
  groups,
  messages,
  slaPolicies,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import {
  afterRoutingChanged,
  applySlaOnCreate,
  onAgentReply,
  onCustomerReply,
  onPriorityChanged,
  onStatusChanged,
} from './index';

/**
 * A clock writer that waited for the ticket's row lock reads the ticket as the
 * writer it waited on left it.
 *
 * Every clock writer reads the ticket under its row lock (`withTicketLocked`),
 * and that read was once one statement joining the ticket to its status, its
 * requester and its form, locking the ticket's row alone. Under READ COMMITTED
 * a locked read that waits re-checks the newest version of the row it waited
 * for against the rows it had joined before waiting. So a writer that moved the
 * ticket to another status — an agent's reply that resolves it or sets it
 * pending, a `set_status` rule, a merge — failed the join to the old status,
 * the read answered no row, and the clock writer did nothing: the re-time it
 * owed was lost, and the ticket kept due dates computed for its old priority,
 * group or policy. A writer that changed the requester did not lose the row;
 * it null-extended the join to `contacts`, so a policy keyed on the requester's
 * address was chosen against a requester with none.
 *
 * What only a database shows, and only with a second writer holding the lock
 * at the right moment: one case for each writer that reads under the lock, and
 * one each for the requester and for a status added while the read waited.
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

/** The same target at every priority. */
const flat = (firstResponseMins: number, resolutionMins: number) => {
  const row = { firstResponseMins, nextResponseMins: firstResponseMins, resolutionMins };
  return { low: row, medium: row, high: row, urgent: row };
};

type TicketValues = Partial<typeof conversations.$inferInsert>;

/**
 * A read waiting on a row, which can only be one that locks rows: a plain read
 * never waits on a row. Matched at the start of the statement, because
 * `pg_stat_activity` keeps only its first kilobyte by default
 * (`track_activity_query_size`), and a read of the whole ticket joined to its
 * status is longer than that — its `for update` is cut off.
 */
const LOCKED_READ = '^\\s*select\\M';

async function statusNamed(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  return row!.id;
}

/**
 * The default policy, round the clock so a target is a fixed number of
 * wall-clock minutes whatever the time of day the suite runs at. At position 1,
 * below every keyed policy a case adds at 0: its empty conditions match every
 * ticket, and a tie at one position would be settled by the order Postgres
 * happens to return the rows in.
 */
async function defaultPolicy(): Promise<string> {
  const [row] = await db
    .insert(slaPolicies)
    .values({
      name: 'Live support',
      hoursSource: 'round_the_clock',
      targets: TARGETS,
      position: 1,
      isDefault: true,
    })
    .returning({ id: slaPolicies.id });
  return row!.id;
}

/** An open ticket; given its first clocks unless `clocked` is false. */
async function ticket(values: TicketValues = {}, { clocked = true } = {}): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: await statusNamed('Open'),
      channel: 'whatsapp',
      ...values,
    })
    .returning({ id: conversations.id });
  if (clocked) await applySlaOnCreate(row!.id);
  return row!.id;
}

async function sla(id: string) {
  const [row] = await db
    .select({
      slaPolicyId: conversations.slaPolicyId,
      createdAt: conversations.createdAt,
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
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)));
}

/**
 * Runs `waiter` behind another transaction that has written `write` to the
 * ticket and not committed, and lets that transaction commit only once
 * `waiter` is queued on its row lock — the order an agent's reply that sets the
 * ticket pending and an SLA hook arriving a moment later meet in. `thenWrite`,
 * when given, is asked once the waiter is queued and its values written last,
 * so a row created during the wait can be what the ticket is moved to.
 *
 * That the waiter queued in a locked read is asserted rather than assumed:
 * `untilWaitingOnALock` gives up quietly, and a waiter that read the ticket
 * without the lock queues anyway, on its UPDATE, having read the ticket as it
 * was before the write — most of these cases would then pass without ever
 * meeting the re-check this file is about.
 */
async function behindAWriter(
  id: string,
  write: TicketValues,
  waiter: () => Promise<unknown>,
  thenWrite?: () => Promise<TicketValues>,
): Promise<void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  let last: TicketValues | undefined;
  const writer = db.transaction(async (tx) => {
    await tx.update(conversations).set(write).where(eq(conversations.id, id));
    locked();
    await held;
    if (last) await tx.update(conversations).set(last).where(eq(conversations.id, id));
  });
  await Promise.race([lockTaken, writer]);

  const waiting = waiter();
  let queued = false;
  try {
    queued = await untilWaitingOnALock(db, { rowLockIn: LOCKED_READ });
    if (thenWrite) last = await thenWrite();
  } finally {
    release();
    await writer;
    await waiting;
  }
  expect(queued).toBe(true);
}

describe('a clock writer that waited on a writer moving the ticket to another status', () => {
  it('writes a new ticket’s first clocks', async () => {
    const policy = await defaultPolicy();
    const id = await ticket({}, { clocked: false });

    await behindAWriter(id, { statusId: await statusNamed('Pending') }, () => applySlaOnCreate(id));

    const after = await sla(id);
    expect(after.slaPolicyId).toBe(policy);
    expect(after.firstResponseDueAt!.getTime()).toBe(after.createdAt.getTime() + 120 * MINUTE);
    expect(after.resolutionDueAt!.getTime()).toBe(after.createdAt.getTime() + 480 * MINUTE);
  });

  it('re-times the clocks for a priority committed before it', async () => {
    await defaultPolicy();
    const id = await ticket();
    const before = await sla(id);
    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));

    await behindAWriter(id, { statusId: await statusNamed('Pending') }, () =>
      onPriorityChanged(id),
    );

    const after = await sla(id);
    expect(after.firstResponseDueAt!.getTime()).toBe(
      before.firstResponseDueAt!.getTime() - 60 * MINUTE,
    );
    expect(after.resolutionDueAt!.getTime()).toBe(before.resolutionDueAt!.getTime() - 240 * MINUTE);
    expect((await events(id, 'sla_recalculated')).map((event) => event.data)).toEqual([
      expect.objectContaining({ reason: 'priority', priority: 'urgent' }),
    ]);
  });

  it('chooses the policy again for a category committed before it', async () => {
    const [sales] = await db
      .insert(slaPolicies)
      .values({
        name: 'Sales',
        hoursSource: 'round_the_clock',
        targets: flat(30, 240),
        position: 0,
        conditions: { field: 'category.id', op: 'eq', value: await categoryId('sales') },
      })
      .returning({ id: slaPolicies.id });
    await defaultPolicy();
    const id = await ticket();
    await db
      .update(conversations)
      .set({ categoryId: await categoryId('sales') })
      .where(eq(conversations.id, id));

    // Pending is still a ticket whose policy may be chosen again, so the only
    // thing that can stop the re-selection here is the read under the lock.
    await behindAWriter(id, { statusId: await statusNamed('Pending') }, () =>
      afterRoutingChanged(id, { category: true, group: false }),
    );

    const after = await sla(id);
    expect(after.slaPolicyId).toBe(sales!.id);
    expect(after.firstResponseDueAt!.getTime()).toBe(after.createdAt.getTime() + 30 * MINUTE);
  });

  it('moves an answered ticket’s clocks onto the hours of a group committed before it', async () => {
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
      targets: TARGETS,
      isDefault: true,
    });
    const id = await ticket();
    // Answered, so the policy is kept and the move is `onGroupChanged`'s alone:
    // the re-selection returns before taking any lock.
    await onAgentReply(id);
    const before = await sla(id);
    await db
      .update(conversations)
      .set({ groupId: merchantCare!.id })
      .where(eq(conversations.id, id));

    await behindAWriter(id, { statusId: await statusNamed('Pending') }, () =>
      afterRoutingChanged(id, { category: false, group: true }),
    );

    const after = await sla(id);
    expect(after.resolutionDueAt!.getTime()).toBeGreaterThan(before.resolutionDueAt!.getTime());
    expect((await events(id, 'sla_recalculated')).map((event) => event.data)).toEqual([
      expect.objectContaining({ reason: 'group_hours' }),
    ]);
  });

  it('resumes a paused clock whose resume was owed before the move', async () => {
    await defaultPolicy();
    const id = await ticket();
    const open = await statusNamed('Open');
    const pending = await statusNamed('Pending');
    // Opened an hour ago and parked on Pending half an hour ago, so the whole
    // pause falls inside the ticket's life and credits its clocks.
    await db
      .update(conversations)
      .set({ createdAt: new Date(Date.now() - 60 * MINUTE) })
      .where(eq(conversations.id, id));
    await db.insert(conversationEvents).values({
      conversationId: id,
      type: 'sla_paused',
      actorLabel: 'sla',
      createdAt: new Date(Date.now() - 30 * MINUTE),
    });
    const before = await sla(id);
    // Back to Open, committed, its resume owed — and set Pending again before
    // that resume lands. Lost, the pause would stay open across the half hour
    // the ticket was Open, and the next resume would credit all of it.
    await db.update(conversations).set({ statusId: open }).where(eq(conversations.id, id));

    await behindAWriter(id, { statusId: pending }, () => onStatusChanged(id, false));

    expect(await events(id, 'sla_resumed')).toHaveLength(1);
    const after = await sla(id);
    const shifted = before.firstResponseDueAt!.getTime() + 30 * MINUTE;
    expect(Math.abs(after.firstResponseDueAt!.getTime() - shifted)).toBeLessThan(MINUTE);
  });

  it('starts the reply clock for a customer message committed before it', async () => {
    await defaultPolicy();
    const id = await ticket();
    await onAgentReply(id);
    const wrote = new Date();
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: wrote })
      .where(eq(conversations.id, id));

    await behindAWriter(id, { statusId: await statusNamed('Pending') }, () =>
      onCustomerReply(id, wrote),
    );

    expect((await sla(id)).nextResponseDueAt).toEqual(new Date(wrote.getTime() + 60 * MINUTE));
  });
});

describe('a clock writer that waited on a writer changing the requester', () => {
  // A contact merge, or a comment thread's root arriving after a reply opened
  // the ticket (`adoptRootAuthor`), moves the requester while the first clocks
  // wait for the lock. The policy is chosen against the requester the ticket
  // now has; joined in the locked read, the wait re-checked the old contact's
  // row against the new requester and left the address empty.
  it('chooses the first policy against the requester the ticket now has', async () => {
    const [merchants] = await db
      .insert(slaPolicies)
      .values({
        name: 'Merchants',
        hoursSource: 'round_the_clock',
        targets: flat(30, 240),
        position: 0,
        conditions: { field: 'requester.email', op: 'ends_with', value: '@merchant.example' },
      })
      .returning({ id: slaPolicies.id });
    await defaultPolicy();
    const id = await ticket({}, { clocked: false });
    const [merchant] = await db
      .insert(contacts)
      .values({ name: 'Sara', primaryEmail: 'sara@merchant.example' })
      .returning({ id: contacts.id });

    await behindAWriter(id, { requesterContactId: merchant!.id }, () => applySlaOnCreate(id));

    expect((await sla(id)).slaPolicyId).toBe(merchants!.id);
  });
});

describe('a clock writer that waited on a writer moving the ticket to a status added meanwhile', () => {
  // The read that answers the clock writer begins after the lock is held, so
  // it sees a status created while it waited. A status read inside the locked
  // statement — a join, or a subquery in that statement's snapshot — cannot,
  // and a pending ticket would read as one whose policy may not be chosen.
  it('chooses the policy again on the status it was moved to', async () => {
    const [sales] = await db
      .insert(slaPolicies)
      .values({
        name: 'Sales',
        hoursSource: 'round_the_clock',
        targets: flat(30, 240),
        position: 0,
        conditions: { field: 'category.id', op: 'eq', value: await categoryId('sales') },
      })
      .returning({ id: slaPolicies.id });
    await defaultPolicy();
    const id = await ticket();
    await db
      .update(conversations)
      .set({ categoryId: await categoryId('sales') })
      .where(eq(conversations.id, id));

    await behindAWriter(
      id,
      { subject: 'Where is my parcel?' },
      () => afterRoutingChanged(id, { category: true, group: false }),
      async () => {
        const [status] = await db
          .insert(ticketStatuses)
          .values({ name: 'Waiting on the warehouse', category: 'pending', stopsSlaClock: true })
          .returning({ id: ticketStatuses.id });
        return { statusId: status!.id };
      },
    );

    expect((await sla(id)).slaPolicyId).toBe(sales!.id);
  });
});

describe('a row inserted for the ticket, while a clock writer holds it', () => {
  // A message, a reaction or an event inserted for a ticket takes KEY SHARE on
  // the ticket's row through its foreign key. FOR UPDATE conflicts with that,
  // NO KEY UPDATE does not (`docs/PROJECT-STATE.md` §6.106): the clock
  // writer's lock serialises it against every other writer of the row, and
  // must not make an insert wait for a re-time to commit. An ingest that then
  // updates the ticket still waits there, as any writer of the row does; that
  // is not what this holds.
  it('goes in without waiting for the re-time to commit', async () => {
    await defaultPolicy();
    const id = await ticket();
    await db.update(conversations).set({ priority: 'urgent' }).where(eq(conversations.id, id));

    // The re-time held open after its last statement, its lock still taken.
    const hold = holdNextTransaction('after');
    const retiming = onPriorityChanged(id);
    let refused: unknown = null;
    try {
      await hold.atHold;
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.insert(messages).values({
          conversationId: id,
          direction: 'inbound',
          kind: 'reply',
          bodyText: 'Hello? Anybody there?',
        });
      });
    } catch (error) {
      refused = error;
    } finally {
      hold.release();
      await retiming;
    }

    expect(refused).toBeNull();
    expect(await events(id, 'sla_recalculated')).toHaveLength(1);
  });
});
