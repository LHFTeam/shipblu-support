import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  channelOwnerChanges,
  channels,
  contacts,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { runAutomations } from '@/lib/automations';
import { computeAgentDay } from '@/lib/reports/agent-rollup';
import { changeStatus } from '@/lib/tickets/status';
import { reportingContext } from '@/lib/reports/rollup';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import {
  alignAccountable,
  handOverNumber,
  numberOwnership,
  reopenWithOwner,
  type Handover,
} from './number-owner';

/**
 * Handing a WhatsApp number over, against Postgres: which of its tickets move,
 * what is refused, and what is written down — including what is deliberately
 * not, so a handover never reads as the admin having worked ninety tickets.
 */

withCleanDatabase();

async function agent(name: string, values: Partial<typeof agents.$inferInsert> = {}) {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@shipblu.test`, ...values })
    .returning({ id: agents.id });
  return row!.id;
}

async function phone(name: string, ownerAgentId: string | null = null) {
  const [row] = await db
    .insert(channels)
    .values({
      type: 'whatsapp',
      name,
      ownerAgentId,
      config: {
        phoneNumberId: `pn-${name}`,
        coexistence: {
          onboardedAt: '2026-09-19T08:00:00.000Z',
          wabaId: `waba-${name}`,
          displayPhoneNumber: '+20 12 78707918',
          syncs: {},
        },
      },
    })
    .returning({ id: channels.id });
  return row!.id;
}

/**
 * A number answered through the console: a ticket on it is the team's to see,
 * so somebody deliberately given one keeps it across a handover. `phone()` is
 * a coexistence number, whose tickets nobody but its owner may be left with.
 */
async function teamPhone(name: string, ownerAgentId: string | null = null) {
  const [row] = await db
    .insert(channels)
    .values({ type: 'whatsapp', name, ownerAgentId, config: { phoneNumberId: `pn-${name}` } })
    .returning({ id: channels.id });
  return row!.id;
}

async function statusId(name: 'Open' | 'Pending' | 'Resolved' | 'Closed') {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function ticket(
  channelId: string | null,
  status: 'Open' | 'Pending' | 'Resolved' | 'Closed',
  values: Partial<typeof conversations.$inferInsert> = {},
) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'whatsapp',
      channelId,
      statusId: await statusId(status),
      requesterContactId: contact!.id,
      subject: 'Where is my parcel?',
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function holders(id: string) {
  const [row] = await db
    .select({
      accountable: conversations.accountableAgentId,
      assignee: conversations.assigneeAgentId,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function eventsOf(id: string) {
  return db
    .select({
      type: conversationEvents.type,
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, id))
    .orderBy(asc(conversationEvents.type));
}

/** What the session `behindAWriter` holds the ticket with writes before it commits. */
type HeldWrite = (tx: postgres.TransactionSql) => Promise<unknown>;

/**
 * A priority change, its line stamped when written, as every writer of the
 * column stamps it.
 */
const raisePriority =
  (id: string): HeldWrite =>
  async (tx) => {
    await tx`update conversations set priority = 'urgent' where id = ${id}`;
    await tx`insert into conversation_events (conversation_id, type, actor_label, data, created_at)
             values (${id}, 'priority_changed', 'agent', '{"to":"urgent"}', clock_timestamp())`;
  };

/**
 * Runs `write` while another session holds the ticket's row, and lets that
 * session make its change — a priority change unless told otherwise — and
 * commit once `write` waits on it.
 *
 * That `write` queued in a read that locks rows is asserted rather than
 * assumed: `untilWaitingOnALock` gives up quietly, and the races these cases
 * are about — a locked read re-checking the row it waited for — happen only
 * there. A select waiting on a row can only be one that locks rows, and it is
 * matched at the start of the statement because `pg_stat_activity` keeps only
 * the first kilobyte (`docs/PROJECT-STATE.md` §6.114).
 */
async function behindAWriter(
  id: string,
  write: () => Promise<unknown>,
  change: HeldWrite = raisePriority(id),
): Promise<void> {
  const other = postgres(process.env.TEST_DATABASE_URL!, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  let queued = false;
  try {
    const writer = other.begin(async (tx) => {
      await tx`select id from conversations where id = ${id} for no key update`;
      locked();
      await gate;
      await change(tx);
    });
    await isLocked;
    const writing = write();
    try {
      queued = await untilWaitingOnALock(db, { rowLockIn: '^\\s*select\\M' });
    } finally {
      release();
      await writer;
      await writing;
    }
  } finally {
    await other.end();
  }
  expect(queued).toBe(true);
}

/** The owner's assignment and that change, as the ticket page draws them: by `created_at`. */
async function lineOrder(id: string) {
  const lines = await db
    .select({ type: conversationEvents.type })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, id),
        inArray(conversationEvents.type, ['assigned', 'priority_changed']),
      ),
    )
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
  return lines.map((line) => line.type);
}

async function ownerOf(channelId: string) {
  const [row] = await db
    .select({ owner: channels.ownerAgentId })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row!.owner;
}

describe('handOverNumber', () => {
  it("moves the number's open and pending native tickets, and nothing else", async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await phone('Nayera Mohamed');
    const other = await phone('ShipBlu Admin');

    const open = await ticket(number, 'Open');
    const pending = await ticket(number, 'Pending');
    const resolved = await ticket(number, 'Resolved');
    const closed = await ticket(number, 'Closed');
    const imported = await ticket(number, 'Resolved', { sourceSystem: 'import' });
    const importedOpen = await ticket(number, 'Open', { sourceSystem: 'import' });
    const deleted = await ticket(number, 'Open', { deletedAt: new Date() });
    const spam = await ticket(number, 'Open', { isSpam: true });
    const merged = await ticket(number, 'Open', { mergedIntoId: open });
    const elsewhere = await ticket(other, 'Open');
    const noRow = await ticket(null, 'Open');

    const result = await handOverNumber({
      channelId: number,
      toAgentId: nayera,
      actor: { id: admin, label: 'Mona Admin' },
    });

    expect(result).toEqual({
      ok: true,
      changed: true,
      channelName: 'Nayera Mohamed',
      displayNumber: '+20 12 78707918',
      to: { id: nayera, label: 'Nayera Mohamed' },
      ticketsMoved: 2,
      ticketsReassigned: 2,
      ticketsUnassigned: 0,
      ownerOnly: true,
    });
    expect(await ownerOf(number)).toBe(nayera);

    for (const id of [open, pending]) {
      expect(await holders(id)).toEqual({ accountable: nayera, assignee: nayera });
    }
    for (const id of [
      resolved,
      closed,
      imported,
      importedOpen,
      deleted,
      spam,
      merged,
      elsewhere,
      noRow,
    ]) {
      expect(await holders(id)).toEqual({ accountable: null, assignee: null });
      expect(await eventsOf(id)).toEqual([]);
    }
  });

  it('records the handover once, and on each ticket as nobody’s act but naming the admin', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await phone('Nayera Mohamed');
    const open = await ticket(number, 'Open');

    await handOverNumber({
      channelId: number,
      toAgentId: nayera,
      actor: { id: admin, label: 'Mona Admin' },
    });

    const changes = await db.select().from(channelOwnerChanges);
    expect(changes).toEqual([
      expect.objectContaining({
        channelId: number,
        channelName: 'Nayera Mohamed',
        displayNumber: '+20 12 78707918',
        fromAgentId: null,
        fromLabel: null,
        toAgentId: nayera,
        toLabel: 'Nayera Mohamed',
        changedByAgentId: admin,
        changedByLabel: 'Mona Admin',
        ticketsMoved: 1,
        ticketsReassigned: 1,
      }),
    ]);

    const stamp = {
      channelId: number,
      reason: 'number_handover',
      by: admin,
      changeId: changes[0]!.id,
    };
    expect(await eventsOf(open)).toEqual([
      {
        type: 'accountable_changed',
        actorAgentId: null,
        actorLabel: 'number_handover',
        data: { from: null, to: nayera, ...stamp },
      },
      {
        type: 'assigned',
        actorAgentId: null,
        actorLabel: 'number_handover',
        data: { to: nayera, ...stamp },
      },
    ]);
  });

  it('moves the work only off the previous owner or nobody; the breach moves regardless', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const bob = await agent('Bob Supervisor');
    const number = await teamPhone('Nayera Mohamed', nayera);

    const hers = await ticket(number, 'Open', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });
    const unheld = await ticket(number, 'Open', { accountableAgentId: nayera });
    const bobs = await ticket(number, 'Pending', {
      accountableAgentId: nayera,
      assigneeAgentId: bob,
    });
    const alisAlready = await ticket(number, 'Open', {
      accountableAgentId: nayera,
      assigneeAgentId: ali,
    });

    const result = await handOverNumber({
      channelId: number,
      toAgentId: ali,
      actor: { id: admin, label: 'Mona Admin' },
    });

    expect(result).toMatchObject({ ok: true, ticketsMoved: 4, ticketsReassigned: 2 });
    expect(await holders(hers)).toEqual({ accountable: ali, assignee: ali });
    expect(await holders(unheld)).toEqual({ accountable: ali, assignee: ali });
    expect(await holders(bobs)).toEqual({ accountable: ali, assignee: bob });
    expect(await holders(alisAlready)).toEqual({ accountable: ali, assignee: ali });

    // Ali already held it, so nothing about who holds it changed.
    expect((await eventsOf(alisAlready)).map((e) => e.type)).toEqual(['accountable_changed']);
    expect((await eventsOf(bobs)).map((e) => [e.type, e.data.from])).toEqual([
      ['accountable_changed', nayera],
    ]);

    const [change] = await db.select().from(channelOwnerChanges);
    expect(change).toMatchObject({ fromAgentId: nayera, fromLabel: 'Nayera Mohamed' });
  });

  it('hands a number to nobody: accountability clears and the work stays where it is', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await teamPhone('Nayera Mohamed', nayera);
    const hers = await ticket(number, 'Open', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });

    const result = await handOverNumber({
      channelId: number,
      toAgentId: null,
      actor: { id: admin, label: 'Mona Admin' },
    });

    expect(result).toMatchObject({ ok: true, changed: true, to: null, ticketsMoved: 1 });
    expect(await ownerOf(number)).toBeNull();
    expect(await holders(hers)).toEqual({ accountable: null, assignee: nayera });
    expect((await eventsOf(hers)).map((e) => [e.type, e.data.to])).toEqual([
      ['accountable_changed', null],
    ]);
    expect(await db.select().from(channelOwnerChanges)).toEqual([
      expect.objectContaining({ fromAgentId: nayera, toAgentId: null, toLabel: null }),
    ]);
  });

  // A coexistence number's tickets are hidden from everybody but its owner and
  // the agents who see every ticket, so a handover leaves none with anybody
  // else: held by somebody who cannot open it, a ticket is in nobody's list
  // and reads as taken to everybody who can.
  describe('of a coexistence number', () => {
    it('moves the work off anybody its tickets are hidden from, to the new owner', async () => {
      const admin = await agent('Mona Admin', { role: 'admin' });
      const nayera = await agent('Nayera Mohamed');
      const ali = await agent('Ali Nasser');
      const bob = await agent('Bob Agent');
      const sara = await agent('Sara Supervisor', { role: 'supervisor' });
      // A supervisor whose own override takes every ticket away again.
      const omar = await agent('Omar Supervisor', {
        role: 'supervisor',
        permissions: { 'ticket.view.all': false },
      });
      const number = await phone('Nayera Mohamed', nayera);

      const held = { accountableAgentId: nayera };
      const bobs = await ticket(number, 'Open', { ...held, assigneeAgentId: bob });
      const saras = await ticket(number, 'Pending', { ...held, assigneeAgentId: sara });
      const omars = await ticket(number, 'Open', { ...held, assigneeAgentId: omar });

      const result = await handOverNumber({
        channelId: number,
        toAgentId: ali,
        actor: { id: admin, label: 'Mona Admin' },
      });

      expect(result).toMatchObject({ ticketsMoved: 3, ticketsReassigned: 2, ticketsUnassigned: 0 });
      expect(await holders(bobs)).toEqual({ accountable: ali, assignee: ali });
      expect(await holders(omars)).toEqual({ accountable: ali, assignee: ali });
      // She sees every ticket, so what she was given stays with her.
      expect(await holders(saras)).toEqual({ accountable: ali, assignee: sara });
    });

    it('unassigns them when the number goes to nobody, and says so on each', async () => {
      const admin = await agent('Mona Admin', { role: 'admin' });
      const nayera = await agent('Nayera Mohamed');
      const sara = await agent('Sara Supervisor', { role: 'supervisor' });
      const number = await phone('Nayera Mohamed', nayera);

      const held = { accountableAgentId: nayera };
      const hers = await ticket(number, 'Open', { ...held, assigneeAgentId: nayera });
      const saras = await ticket(number, 'Open', { ...held, assigneeAgentId: sara });
      // Not hers to lose: a handover moves only open and pending tickets.
      const resolved = await ticket(number, 'Resolved', { ...held, assigneeAgentId: nayera });

      const result = await handOverNumber({
        channelId: number,
        toAgentId: null,
        actor: { id: admin, label: 'Mona Admin' },
      });

      expect(result).toMatchObject({
        to: null,
        ticketsMoved: 2,
        ticketsReassigned: 0,
        ticketsUnassigned: 1,
        ownerOnly: true,
      });
      expect(await holders(hers)).toEqual({ accountable: null, assignee: null });
      expect(await holders(saras)).toEqual({ accountable: null, assignee: sara });
      expect(await holders(resolved)).toEqual({ accountable: nayera, assignee: nayera });

      const [change] = await db.select({ id: channelOwnerChanges.id }).from(channelOwnerChanges);
      expect(await eventsOf(hers)).toEqual([
        expect.objectContaining({ type: 'accountable_changed' }),
        {
          type: 'unassigned',
          actorAgentId: null,
          actorLabel: 'number_handover',
          data: {
            to: null,
            from: nayera,
            channelId: number,
            reason: 'owner_only',
            by: admin,
            changeId: change!.id,
          },
        },
      ]);
    });
  });

  it('writes nothing when the number already belongs to that person', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await phone('Nayera Mohamed', nayera);
    const open = await ticket(number, 'Open');

    const result = await handOverNumber({
      channelId: number,
      toAgentId: nayera,
      actor: { id: admin, label: 'Mona Admin' },
    });

    expect(result).toMatchObject({ ok: true, changed: false, ticketsMoved: 0 });
    expect(await db.select().from(channelOwnerChanges)).toEqual([]);
    expect(await holders(open)).toEqual({ accountable: null, assignee: null });
    expect(await eventsOf(open)).toEqual([]);

    // A team number handed to nobody is the same no-op.
    const team = await phone('WhatsApp Support');
    expect(
      await handOverNumber({ channelId: team, toAgentId: null, actor: { id: admin, label: 'M' } }),
    ).toMatchObject({ ok: true, changed: false });
    expect(await db.select().from(channelOwnerChanges)).toEqual([]);
  });

  it('refuses a channel that is gone or not a plain number, and an owner who cannot sign in', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const gone = await agent('Former Agent', { isActive: false });
    const number = await phone('Nayera Mohamed');
    const actor = { id: admin, label: 'Mona Admin' };

    const [bot] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.type, 'whatsapp_bot'));

    expect(
      await handOverNumber({
        channelId: '00000000-0000-4000-8000-000000000000',
        toAgentId: nayera,
        actor,
      }),
    ).toEqual({ ok: false, error: 'That channel no longer exists.' });
    expect(await handOverNumber({ channelId: bot!.id, toAgentId: nayera, actor })).toEqual({
      ok: false,
      error:
        'Only a WhatsApp number can belong to a person. The bot and the shared inboxes are answered by the whole team.',
    });
    expect(
      await handOverNumber({
        channelId: number,
        toAgentId: '00000000-0000-4000-8000-000000000000',
        actor,
      }),
    ).toEqual({ ok: false, error: 'That agent no longer exists.' });
    expect(await handOverNumber({ channelId: number, toAgentId: gone, actor })).toEqual({
      ok: false,
      error: 'Former Agent is deactivated. Reactivate them before handing them a number.',
    });

    expect(await ownerOf(number)).toBeNull();
    expect(await db.select().from(channelOwnerChanges)).toEqual([]);
  });

  // The agent rollup counts every event an agent is the actor of as a ticket
  // they touched. A handover's events name the admin in `by` instead, so the
  // admin's day does not gain one touched ticket per ticket on the number.
  it('does not count the handover as the admin touching every ticket on the number', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await phone('Nayera Mohamed');
    await ticket(number, 'Open');
    await ticket(number, 'Pending');
    const worked = await ticket(number, 'Open');

    await handOverNumber({
      channelId: number,
      toAgentId: nayera,
      actor: { id: admin, label: 'Mona Admin' },
    });
    // Something the admin did do, so the query is shown to count an actor.
    await db
      .insert(conversationEvents)
      .values({ conversationId: worked, type: 'status_changed', actorAgentId: admin, data: {} });

    const context = await reportingContext();
    const day = DateTime.now().setZone(context.zone).toISODate()!;
    const rows = await computeAgentDay(day, context);
    const of = (id: string) => rows.find((row) => row.agentId === id)!;

    expect(of(admin).touchedCount).toBe(1);
    expect(of(nayera).touchedCount).toBe(0);
    expect(of(nayera).assignedCount).toBe(3);
  });

  // The handover locks the number's tickets before it writes their lines, and
  // a ticket another writer holds makes it wait there. Stamped with `now`,
  // taken before the transaction, the new owner's assignment sorted before the
  // change committed while it waited (`CHANGE_STAMP`).
  it('sorts the new owner’s assignment after a change it waited for', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await phone('Nayera Mohamed');
    const open = await ticket(number, 'Open');

    await behindAWriter(open, () =>
      handOverNumber({ channelId: number, toAgentId: nayera, actor: { id: admin, label: 'M' } }),
    );

    expect(await holders(open)).toEqual({ accountable: nayera, assignee: nayera });
    expect(await lineOrder(open)).toEqual(['priority_changed', 'assigned']);
  });

  // The writer the handover waits on can move the ticket's status, and an
  // agent setting it pending is the common case: the agent's write takes no
  // lock on the number, since only a ticket coming out of resolved or closed
  // asks who owns it. Read through a join to the status — an IN (select …),
  // planned as one — the handover re-checked the ticket against the Open it
  // read before waiting, left it out, and it stayed with the previous owner
  // for good (`docs/PROJECT-STATE.md` §6.114, #490).
  describe('against a writer moving a ticket’s status while it waits', () => {
    async function numberHandedOver(change: (open: string) => HeldWrite) {
      const admin = await agent('Mona Admin', { role: 'admin' });
      const nayera = await agent('Nayera Mohamed');
      const ali = await agent('Ali Nasser');
      const number = await phone('Nayera Mohamed', ali);
      const open = await ticket(number, 'Open', { accountableAgentId: ali, assigneeAgentId: ali });
      let done: Handover | undefined;
      await behindAWriter(
        open,
        async () => {
          done = await handOverNumber({
            channelId: number,
            toAgentId: nayera,
            actor: { id: admin, label: 'Mona Admin' },
          });
        },
        change(open),
      );
      return { done, open, nayera, ali };
    }

    it('moves a ticket set pending', async () => {
      const pending = await statusId('Pending');
      const t = await numberHandedOver(
        (open) => (tx) => tx`update conversations set status_id = ${pending} where id = ${open}`,
      );

      expect(t.done).toMatchObject({ ok: true, ticketsMoved: 1, ticketsReassigned: 1 });
      expect(await holders(t.open)).toEqual({ accountable: t.nayera, assignee: t.nayera });
    });

    // A status created while the handover waited is not in the snapshot its
    // locked read began with, so the read cannot tell what it is: the
    // handover reads it again once the lock is held.
    it('moves a ticket moved to a pending status added meanwhile', async () => {
      const t = await numberHandedOver((open) => async (tx) => {
        const [status] = await tx<{ id: string }[]>`
          insert into ticket_statuses (name, category) values ('Waiting on the warehouse', 'pending')
          returning id`;
        await tx`update conversations set status_id = ${status!.id} where id = ${open}`;
      });

      expect(t.done).toMatchObject({ ok: true, ticketsMoved: 1 });
      expect(await holders(t.open)).toEqual({ accountable: t.nayera, assignee: t.nayera });
    });

    it('leaves a ticket moved to a resolved status added meanwhile', async () => {
      const t = await numberHandedOver((open) => async (tx) => {
        const [status] = await tx<{ id: string }[]>`
          insert into ticket_statuses (name, category) values ('Settled by phone', 'resolved')
          returning id`;
        await tx`update conversations set status_id = ${status!.id} where id = ${open}`;
      });

      expect(t.done).toMatchObject({ ok: true, ticketsMoved: 0, ticketsReassigned: 0 });
      expect(await holders(t.open)).toEqual({ accountable: t.ali, assignee: t.ali });
    });
  });

  // A row inserted for a ticket — a message, a reaction, an event — takes KEY
  // SHARE on the ticket's row through its foreign key. The handover's lock on
  // the tickets it moves must not make that insert wait: FOR UPDATE does, FOR
  // NO KEY UPDATE does not, and the handover writes no key (§6.106). An
  // ingest that goes on to update the ticket still waits there, as any writer
  // of the row does; that is not what this holds.
  it('lets a row inserted for a ticket it moves go in while it runs', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await phone('Nayera Mohamed');
    const open = await ticket(number, 'Open');

    // The handover held open after its last statement, every lock still taken.
    const hold = holdNextTransaction('after');
    const handing = handOverNumber({
      channelId: number,
      toAgentId: nayera,
      actor: { id: admin, label: 'Mona Admin' },
    });
    let refused: unknown = null;
    try {
      await hold.atHold;
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.insert(messages).values({
          conversationId: open,
          direction: 'inbound',
          kind: 'reply',
          bodyText: 'Hello? Is this still the right number?',
        });
      });
    } catch (error) {
      refused = error;
    } finally {
      hold.release();
      await handing;
    }

    expect(refused).toBeNull();
    expect(await holders(open)).toEqual({ accountable: nayera, assignee: nayera });
  });
});

describe('alignAccountable', () => {
  it('moves a ticket to the number’s owner, and its work only off the previous one', async () => {
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const bob = await agent('Bob Supervisor');
    const number = await teamPhone('Nayera Mohamed', ali);
    const hers = await ticket(number, 'Open', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });
    const bobs = await ticket(number, 'Open', { accountableAgentId: nayera, assigneeAgentId: bob });

    const align = (conversationId: string, ownerId: string | null) =>
      db.transaction((tx) =>
        alignAccountable(tx, {
          conversationId,
          ownerId,
          channelId: number,
          reason: 'reopened_after_handover',
        }),
      );

    expect(await align(hers, ali)).toEqual({ changed: true, reassigned: true });
    expect(await holders(hers)).toEqual({ accountable: ali, assignee: ali });
    expect(await eventsOf(hers)).toEqual([
      {
        type: 'accountable_changed',
        actorAgentId: null,
        actorLabel: 'number_owner',
        data: { from: nayera, to: ali, channelId: number, reason: 'reopened_after_handover' },
      },
      {
        type: 'assigned',
        actorAgentId: null,
        actorLabel: 'number_owner',
        data: { to: ali, reason: 'number_owner', channelId: number },
      },
    ]);

    expect(await align(bobs, ali)).toEqual({ changed: true, reassigned: false });
    expect(await holders(bobs)).toEqual({ accountable: ali, assignee: bob });

    // Already in line: nothing written.
    expect(await align(hers, ali)).toEqual({ changed: false, reassigned: false });
    expect(await eventsOf(hers)).toHaveLength(2);

    // The number gone to nobody: accountability clears, the holder keeps it.
    expect(await align(hers, null)).toEqual({ changed: true, reassigned: false });
    expect(await holders(hers)).toEqual({ accountable: null, assignee: ali });
  });

  // On a coexistence number a reopened ticket is left with nobody it is hidden
  // from: the previous owner, or a colleague it was given to.
  it('leaves a coexistence number’s ticket only with somebody who can see it', async () => {
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const bob = await agent('Bob Agent');
    const sara = await agent('Sara Supervisor', { role: 'supervisor' });
    const number = await phone('Nayera Mohamed', ali);
    const held = { accountableAgentId: nayera };
    const bobs = await ticket(number, 'Open', { ...held, assigneeAgentId: bob });
    const saras = await ticket(number, 'Open', { ...held, assigneeAgentId: sara });
    const orphan = await ticket(number, 'Open', { ...held, assigneeAgentId: nayera });
    const orphanSeen = await ticket(number, 'Open', { ...held, assigneeAgentId: sara });

    const align = (conversationId: string, ownerId: string | null) =>
      db.transaction((tx) =>
        alignAccountable(tx, {
          conversationId,
          ownerId,
          channelId: number,
          reason: 'reopened_after_handover',
        }),
      );

    expect(await align(bobs, ali)).toEqual({ changed: true, reassigned: true });
    expect(await holders(bobs)).toEqual({ accountable: ali, assignee: ali });
    expect(await align(saras, ali)).toEqual({ changed: true, reassigned: false });
    expect(await holders(saras)).toEqual({ accountable: ali, assignee: sara });

    // The number is nobody's now: unassigned, where a supervisor finds it.
    expect(await align(orphan, null)).toEqual({ changed: true, reassigned: false });
    expect(await holders(orphan)).toEqual({ accountable: null, assignee: null });
    expect((await eventsOf(orphan)).map((e) => [e.type, e.data.from])).toEqual([
      ['accountable_changed', nayera],
      ['unassigned', nayera],
    ]);
    expect(await align(orphanSeen, null)).toEqual({ changed: true, reassigned: false });
    expect(await holders(orphanSeen)).toEqual({ accountable: null, assignee: sara });
  });

  // Its locked read can wait on another writer, and its `assigned` line is
  // `recordOwnerAssigned`'s, stamped as it is written: with the
  // transaction's start, the owner's assignment sorted before the change
  // committed while it waited, where the rota's sorts after it.
  it('sorts the owner’s assignment after a change it waited for', async () => {
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const number = await phone('Nayera Mohamed', ali);
    const hers = await ticket(number, 'Open', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });

    await behindAWriter(hers, () =>
      db.transaction((tx) =>
        alignAccountable(tx, {
          conversationId: hers,
          ownerId: ali,
          channelId: number,
          reason: 'reopened_after_handover',
        }),
      ),
    );

    expect(await holders(hers)).toEqual({ accountable: ali, assignee: ali });
    expect(await lineOrder(hers)).toEqual(['priority_changed', 'assigned']);
  });
});

// The customer writing again is ingest's reopen. These are the other two: an
// agent's status picker and a rule's set_status. Left out, a ticket resolved
// across a handover and reopened by hand stayed with the previous owner for good.
describe('a resolved ticket reopened by an agent or a rule', () => {
  async function handedOver() {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const number = await phone('Nayera Mohamed', nayera);
    const resolved = await ticket(number, 'Resolved', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });
    await handOverNumber({
      channelId: number,
      toAgentId: ali,
      actor: { id: admin, label: 'Mona' },
    });
    // Resolved, so the handover left it.
    expect(await holders(resolved)).toEqual({ accountable: nayera, assignee: nayera });
    return { admin, nayera, ali, number, resolved };
  }

  async function status(name: 'Open' | 'Pending' | 'Resolved' | 'Closed') {
    const [row] = await db
      .select({
        id: ticketStatuses.id,
        name: ticketStatuses.name,
        category: ticketStatuses.category,
        stopsSlaClock: ticketStatuses.stopsSlaClock,
      })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, name));
    return row!;
  }

  it("brings it over to the number's owner when an agent moves it back to Open", async () => {
    const { admin, nayera, ali, number, resolved } = await handedOver();

    await changeStatus(admin, resolved, await status('Open'));

    expect(await holders(resolved)).toEqual({ accountable: ali, assignee: ali });
    expect((await eventsOf(resolved)).find((e) => e.type === 'accountable_changed')?.data).toEqual({
      from: nayera,
      to: ali,
      channelId: number,
      reason: 'reopened_by_status',
    });
  });

  it('brings it over when a rule reopens it', async () => {
    const { ali, resolved } = await handedOver();
    await db.insert(automationRules).values({
      name: 'Reopen on update',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'set_status', category: 'open' }],
      position: 0,
    });

    await runAutomations('on_update', resolved);

    expect(await holders(resolved)).toEqual({ accountable: ali, assignee: ali });
  });

  // Closed counts too: a handover leaves it, but one brought back is live work
  // on a phone the previous owner no longer holds, and nothing else could ever
  // move it — Unassign would hand it back to them and a second handover is a
  // no-op.
  it('brings a closed ticket over when an agent reopens it', async () => {
    const { admin, nayera, ali, number } = await handedOver();
    const closed = await ticket(number, 'Closed', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });

    await changeStatus(admin, closed, await status('Open'));

    expect(await holders(closed)).toEqual({ accountable: ali, assignee: ali });
  });

  it('moves nothing on any other move: to pending, to resolved, to closed', async () => {
    const { admin, nayera, number } = await handedOver();
    const open = await ticket(number, 'Open');
    const resolving = await ticket(number, 'Open');
    const closing = await ticket(number, 'Open');
    // The handover moved the live ones already; put them back to test the moves.
    await db
      .update(conversations)
      .set({ accountableAgentId: nayera, assigneeAgentId: nayera })
      .where(inArray(conversations.id, [open, resolving, closing]));

    await changeStatus(admin, open, await status('Pending'));
    await changeStatus(admin, resolving, await status('Resolved'));
    await changeStatus(admin, closing, await status('Closed'));

    for (const id of [open, resolving, closing]) {
      expect(await holders(id)).toEqual({ accountable: nayera, assignee: nayera });
    }
  });

  // `reopenResolved` answers false and writes nothing when no open status
  // exists; a realignment after it would move a ticket that stayed resolved
  // and say "when the customer wrote again" of a reopen that never happened.
  it('realigns nothing when the write did not happen', async () => {
    const { nayera, resolved } = await handedOver();

    const written = await db.transaction((tx) =>
      reopenWithOwner(tx, resolved, 'open', 'reopened_after_handover', async () => false),
    );

    expect(written).toBe(false);
    expect(await holders(resolved)).toEqual({ accountable: nayera, assignee: nayera });
    expect((await eventsOf(resolved)).map((e) => e.type)).not.toContain('accountable_changed');
  });
});

describe('numberOwnership', () => {
  it("names each number's owner, what a handover would move, and who held it before", async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const number = await phone('Nayera Mohamed');
    const team = await phone('WhatsApp Support');
    await ticket(number, 'Open');
    await ticket(number, 'Pending');
    await ticket(number, 'Resolved');
    await ticket(team, 'Open');
    const actor = { id: admin, label: 'Mona Admin' };

    await handOverNumber({ channelId: number, toAgentId: nayera, actor });
    await handOverNumber({ channelId: number, toAgentId: ali, actor });
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, ali));

    const ownership = await numberOwnership();
    expect(ownership).toEqual([
      {
        channelId: number,
        owner: { id: ali, label: 'Ali Nasser', active: false },
        movableTickets: 2,
        current: expect.objectContaining({
          fromLabel: 'Nayera Mohamed',
          toLabel: 'Ali Nasser',
          changedByLabel: 'Mona Admin',
          ticketsMoved: 2,
          ticketsReassigned: 2,
          createdAt: expect.any(Date),
        }),
        earlier: [expect.objectContaining({ fromLabel: null, toLabel: 'Nayera Mohamed' })],
      },
      { channelId: team, owner: null, movableTickets: 1, current: null, earlier: [] },
    ]);
  });

  it('dates a team number from the handover that cleared it', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const number = await phone('Nayera Mohamed');
    const actor = { id: admin, label: 'Mona Admin' };

    await handOverNumber({ channelId: number, toAgentId: nayera, actor });
    await handOverNumber({ channelId: number, toAgentId: null, actor });

    const [ownership] = await numberOwnership();
    expect(ownership).toMatchObject({
      owner: null,
      current: { fromLabel: 'Nayera Mohamed', toLabel: null, changedByLabel: 'Mona Admin' },
      earlier: [{ fromLabel: null, toLabel: 'Nayera Mohamed' }],
    });
  });

  // "Since 14 Oct, set by Mona" must not date a state the number is not in.
  it('dates nothing when the newest handover no longer describes the number', async () => {
    const admin = await agent('Mona Admin', { role: 'admin' });
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const byHand = await phone('Set by hand');
    const deleted = await phone('Owner deleted');
    const actor = { id: admin, label: 'Mona Admin' };

    // An owner written straight into the row leaves the record naming somebody else.
    await handOverNumber({ channelId: byHand, toAgentId: nayera, actor });
    await db.update(channels).set({ ownerAgentId: ali }).where(eq(channels.id, byHand));

    // A deleted owner leaves a row naming nobody and a record still naming them.
    await handOverNumber({ channelId: deleted, toAgentId: nayera, actor });
    await db.delete(agents).where(eq(agents.id, nayera));

    const ownership = await numberOwnership();
    expect(ownership.find((row) => row.channelId === byHand)).toMatchObject({
      owner: { id: ali, label: 'Ali Nasser', active: true },
      current: null,
      earlier: [{ toLabel: 'Nayera Mohamed' }],
    });
    expect(ownership.find((row) => row.channelId === deleted)).toMatchObject({
      owner: null,
      current: null,
      earlier: [{ toLabel: 'Nayera Mohamed' }],
    });
  });
});
