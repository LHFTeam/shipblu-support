import { asc, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
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
  ticketStatuses,
} from '@/db/schema';
import { runAutomations } from '@/lib/automations';
import { computeAgentDay } from '@/lib/reports/agent-rollup';
import { changeStatus } from '@/lib/tickets/status';
import { reportingContext } from '@/lib/reports/rollup';
import { withCleanDatabase } from '@/lib/testing/db';
import { alignAccountable, handOverNumber, numberOwnership } from './number-owner';

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
    const number = await phone('Nayera Mohamed', nayera);

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
    const number = await phone('Nayera Mohamed', nayera);
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
});

describe('alignAccountable', () => {
  it('moves a ticket to the number’s owner, and its work only off the previous one', async () => {
    const nayera = await agent('Nayera Mohamed');
    const ali = await agent('Ali Nasser');
    const bob = await agent('Bob Supervisor');
    const number = await phone('Nayera Mohamed', ali);
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

  it('moves nothing on any other move: resolving, closing, or out of Closed', async () => {
    const { admin, nayera, number } = await handedOver();
    const open = await ticket(number, 'Open', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });
    const closed = await ticket(number, 'Closed', {
      accountableAgentId: nayera,
      assigneeAgentId: nayera,
    });
    // The handover moved the open one already; put it back to test the move.
    await db
      .update(conversations)
      .set({ accountableAgentId: nayera, assigneeAgentId: nayera })
      .where(eq(conversations.id, open));

    await changeStatus(admin, open, await status('Pending'));
    await changeStatus(admin, closed, await status('Open'));

    for (const id of [open, closed]) {
      expect(await holders(id)).toEqual({ accountable: nayera, assignee: nayera });
    }
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
