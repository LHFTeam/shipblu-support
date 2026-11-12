import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, channels, contacts, conversations, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  admits,
  assignTicket,
  assignTickets,
  fileUnderNumber,
  lockHolders,
  lockHoldersOf,
  unassignTicket,
} from './assignee';

/**
 * The one writer of a ticket's assignee, asked directly: who it admits on a
 * coexistence number, and what it writes. Each writer that calls it is tested
 * where it lives (`owner-only.db.test.ts`, `number-owner.db.test.ts`,
 * `ingest-whatsapp.db.test.ts`, `assign-sweep.db.test.ts`).
 */

withCleanDatabase();

let people = 0;

async function agent(values: Partial<typeof agents.$inferInsert> = {}) {
  people += 1;
  const [row] = await db
    .insert(agents)
    .values({ name: `Agent ${people}`, email: `holder${people}@shipblu.test`, ...values })
    .returning({ id: agents.id });
  return row!.id;
}

async function number(config: Record<string, unknown>, ownerAgentId: string | null = null) {
  people += 1;
  const [row] = await db
    .insert(channels)
    .values({ type: 'whatsapp', name: `Number ${people}`, ownerAgentId, config })
    .returning({ id: channels.id });
  return row!.id;
}

const phone = (ownerAgentId: string | null = null) =>
  number({ coexistence: { onboardedAt: '2026-10-01T09:00:00.000Z', wabaId: '1' } }, ownerAgentId);

async function ticket(
  channelId: string | null,
  values: Partial<typeof conversations.$inferInsert> = {},
) {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'whatsapp',
      channelId,
      statusId: open!.id,
      requesterContactId: contact!.id,
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function held(id: string) {
  const [row] = await db
    .select({
      channelId: conversations.channelId,
      assigneeAgentId: conversations.assigneeAgentId,
      assignedAt: conversations.assignedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

const AT = new Date('2026-11-12T09:00:00Z');

describe('who a number admits', () => {
  it('admits anybody off a coexistence number, and on no number at all', async () => {
    const bob = await agent();
    const left = await agent({ isActive: false });

    await db.transaction(async (tx) => {
      for (const channelId of [null, await number({})]) {
        const holders = await lockHolders(tx, channelId);
        expect(holders.ownerOnly).toBeNull();
        expect(await admits(tx, holders, bob)).toBe(true);
        // Whether somebody deactivated may be given work is each writer's own
        // question; this one is only about who can see the ticket.
        expect(await admits(tx, holders, left)).toBe(true);
      }
    });
  });

  it('admits the number’s owner and an agent who sees every ticket, and nobody else', async () => {
    const nayera = await agent();
    const bob = await agent();
    const sara = await agent({ role: 'supervisor' });
    const granted = await agent({ permissions: { 'ticket.view.all': true } });
    const revoked = await agent({ role: 'supervisor', permissions: { 'ticket.view.all': false } });
    const channelId = await phone(nayera);

    await db.transaction(async (tx) => {
      const holders = await lockHolders(tx, channelId);
      expect(holders.ownerOnly).toEqual({ ownerId: nayera });
      expect(await admits(tx, holders, nayera)).toBe(true);
      expect(await admits(tx, holders, sara)).toBe(true);
      expect(await admits(tx, holders, granted)).toBe(true);
      expect(await admits(tx, holders, bob)).toBe(false);
      expect(await admits(tx, holders, revoked)).toBe(false);
    });
  });

  // Somebody who cannot sign in sees nothing, whatever their role: the answer
  // a handover gives (`agentsWhoSeeEveryTicket`), so every writer gives it.
  it('counts a deactivated owner as nobody, and admits nobody who is deactivated', async () => {
    const leftOwner = await agent({ isActive: false });
    const leftSupervisor = await agent({ role: 'supervisor', isActive: false });
    const channelId = await phone(leftOwner);

    await db.transaction(async (tx) => {
      const holders = await lockHolders(tx, channelId);
      expect(holders.ownerOnly).toEqual({ ownerId: null });
      expect(await admits(tx, holders, leftOwner)).toBe(false);
      expect(await admits(tx, holders, leftSupervisor)).toBe(false);
    });
  });
});

// The answer holds until the transaction ends because the row is locked, a
// plain one included: the onboarding that makes a plain number a coexistence
// one takes FOR UPDATE first and so waits, where locking only coexistence rows
// let an assignment read while the row was plain commit after it became one.
describe('the lock lockHolders takes', () => {
  it('holds a plain row and a coexistence row against FOR UPDATE until it commits', async () => {
    const other = postgres(process.env.TEST_DATABASE_URL!, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      for (const channelId of [await number({}), await phone(await agent())]) {
        const forUpdate = () =>
          other`select id from channels where id = ${channelId} for update nowait`;
        await db.transaction(async (tx) => {
          await lockHolders(tx, channelId);
          await expect(forUpdate()).rejects.toMatchObject({ code: '55P03' });
        });
        await expect(forUpdate()).resolves.toHaveLength(1);
      }
    } finally {
      await other.end();
    }
  });

  it('answers the owner of any number, and owner-only only on a coexistence one', async () => {
    const nayera = await agent();
    const left = await agent({ isActive: false });
    const answers = await db.transaction(async (tx) => [
      await lockHolders(tx, await number({}, nayera)),
      await lockHolders(tx, await phone(nayera)),
      await lockHolders(tx, await number({}, left)),
    ]);
    expect(answers.map((h) => [h.ownerId, h.ownerOnly])).toEqual([
      [nayera, null],
      [nayera, { ownerId: nayera }],
      [null, null],
    ]);
  });
});

describe('assignTicket', () => {
  it('writes the assignee and when, off a coexistence number', async () => {
    const bob = await agent();
    const id = await ticket(null);

    const written = await db.transaction(async (tx) =>
      assignTicket(tx, await lockHolders(tx, null), { conversationId: id, to: bob, at: AT }),
    );

    expect(written).toBe('assigned');
    expect(await held(id)).toMatchObject({ assigneeAgentId: bob, assignedAt: AT });
  });

  it('refuses an agent a coexistence number’s ticket is hidden from, and writes nothing', async () => {
    const nayera = await agent();
    const bob = await agent();
    const channelId = await phone(nayera);
    const id = await ticket(channelId);

    const answers = await db.transaction(async (tx) => {
      const holders = await lockHolders(tx, channelId);
      return [
        await assignTicket(tx, holders, { conversationId: id, to: bob, at: AT }),
        await assignTickets(tx, holders, { conversationIds: [id], to: bob, at: AT }),
      ];
    });

    expect(answers).toEqual(['hidden', { refused: 'hidden', written: [] }]);
    expect(await held(id)).toMatchObject({ assigneeAgentId: null, assignedAt: null });
  });

  // The answer was about one number. A ticket filed under another between
  // the question and the write is not the ticket the question was asked of.
  it('writes nothing for a ticket no longer on the number it asked about', async () => {
    const nayera = await agent();
    const bob = await agent();
    const channelId = await phone(nayera);
    const id = await ticket(channelId);

    const answers = await db.transaction(async (tx) => {
      const holders = await lockHolders(tx, null);
      return [
        await assignTicket(tx, holders, { conversationId: id, to: bob, at: AT }),
        await assignTickets(tx, holders, { conversationIds: [id], to: bob, at: AT }),
      ];
    });

    expect(answers).toEqual(['missed', { refused: null, written: [] }]);
    expect(await held(id)).toMatchObject({ assigneeAgentId: null });
  });

  // A writer holding a copy of the ticket from before it was filed asks the
  // ticket, not the copy: `lockHoldersOf` reads the number it is on now.
  it('asks the number a ticket is on now, for a writer that has only its id', async () => {
    const nayera = await agent();
    const bob = await agent();
    const channelId = await phone(nayera);
    const id = await ticket(channelId);

    const answers = await db.transaction(async (tx) => {
      const holders = await lockHoldersOf(tx, id);
      return [
        holders.channelId,
        await assignTicket(tx, holders, { conversationId: id, to: bob, at: AT }),
        await assignTicket(tx, holders, { conversationId: id, to: nayera, at: AT }),
      ];
    });

    expect(answers).toEqual([channelId, 'hidden', 'assigned']);
    expect(await held(id)).toMatchObject({ assigneeAgentId: nayera });
  });

  it('applies the caller’s own guard, and gives a ticket to nobody whatever its number', async () => {
    const nayera = await agent();
    const sara = await agent({ role: 'supervisor' });
    const channelId = await phone(nayera);
    const id = await ticket(channelId, { assigneeAgentId: sara, assignedAt: AT });

    const guarded = await db.transaction(async (tx) =>
      assignTicket(tx, await lockHolders(tx, channelId), {
        conversationId: id,
        to: nayera,
        at: AT,
        onlyIf: eq(conversations.assigneeAgentId, nayera),
      }),
    );
    expect(guarded).toBe('missed');
    expect(await held(id)).toMatchObject({ assigneeAgentId: sara });

    expect(
      await unassignTicket(db, {
        conversationId: id,
        onlyIf: eq(conversations.assigneeAgentId, nayera),
      }),
    ).toBe(false);
    expect(await unassignTicket(db, { conversationId: id })).toBe(true);
    expect(await held(id)).toMatchObject({ assigneeAgentId: null, assignedAt: null });
  });
});

describe('fileUnderNumber', () => {
  it('files a ticket under no row, and leaves one already on a row alone', async () => {
    const bob = await agent();
    const plain = await number({});
    const other = await number({});
    const unfiled = await ticket(null, { assigneeAgentId: bob });
    const placed = await ticket(other, { assigneeAgentId: bob });

    const answers = await db.transaction(async (tx) => [
      await fileUnderNumber(tx, { conversationId: unfiled, channelId: plain }),
      await fileUnderNumber(tx, { conversationId: placed, channelId: plain }),
    ]);

    expect(answers).toEqual([
      { filed: true, unassigned: false },
      { filed: false, unassigned: false },
    ]);
    expect(await held(unfiled)).toMatchObject({ channelId: plain, assigneeAgentId: bob });
    expect(await held(placed)).toMatchObject({ channelId: other, assigneeAgentId: bob });
  });
});
