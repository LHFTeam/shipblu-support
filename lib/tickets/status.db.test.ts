import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  routingDecisions,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { changeStatus, type StatusTarget } from './status';

/**
 * The status write both console paths share. What it must get right is which
 * stamps each category writes and clears: a resolve records who resolved,
 * moving back to Open keeps that record for the reopen to read, and a close
 * keeps the resolve it follows — a ticket closed straight from Open gets none
 * (`resolveStamp`, docs/PROJECT-STATE.md §6.98). And where its line sorts when
 * the write waited on somebody else's.
 */

withCleanDatabase();

async function status(name: string): Promise<StatusTarget> {
  const [row] = await db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      category: ticketStatuses.category,
      stopsSlaClock: ticketStatuses.stopsSlaClock,
    })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row;
}

async function openTicket() {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      statusId: (await status('Open')).id,
      requesterContactId: contact!.id,
    })
    .returning({ id: conversations.id });
  return { id: row!.id, agentId: agent!.id };
}

async function stamps(id: string) {
  const [row] = await db
    .select({
      statusId: conversations.statusId,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
      closedAt: conversations.closedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

/** The stamp as Postgres holds it, to the microsecond a `Date` would round away. */
async function resolvedAtText(id: string): Promise<string | null> {
  const [row] = await db
    .select({ at: sql<string | null>`${conversations.resolvedAt}::text` })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.at;
}

async function statusEvents(id: string) {
  return db
    .select({
      type: conversationEvents.type,
      actor: conversationEvents.actorAgentId,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, 'status_changed')),
    );
}

describe('changeStatus', () => {
  it('resolves: stamps when and by whom, and records the event', async () => {
    const { id, agentId } = await openTicket();
    const resolved = await status('Resolved');

    await changeStatus(agentId, id, resolved);

    const row = await stamps(id);
    expect(row).toMatchObject({
      statusId: resolved.id,
      resolvedByAgentId: agentId,
      closedAt: null,
    });
    expect(row.resolvedAt).toBeInstanceOf(Date);
    expect(await statusEvents(id)).toEqual([
      {
        type: 'status_changed',
        actor: agentId,
        data: { to: 'Resolved', category: 'resolved' },
      },
    ]);
    // A resolved status stops the clock, so the SLA hook ran after the write.
    expect(
      await db
        .select({ id: conversationEvents.id })
        .from(conversationEvents)
        .where(
          and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, 'sla_paused')),
        ),
    ).toHaveLength(1);
  });

  it('names the path on the event when it is not the picker', async () => {
    const { id, agentId } = await openTicket();

    await changeStatus(agentId, id, await status('Resolved'), 'reply_and_resolve');

    expect((await statusEvents(id))[0]!.data).toEqual({
      to: 'Resolved',
      category: 'resolved',
      via: 'reply_and_resolve',
    });
  });

  it('back to Open clears the resolve time but keeps who resolved it', async () => {
    const { id, agentId } = await openTicket();
    await changeStatus(agentId, id, await status('Resolved'));

    await changeStatus(agentId, id, await status('Open'));

    expect(await stamps(id)).toMatchObject({
      resolvedAt: null,
      resolvedByAgentId: agentId,
      closedAt: null,
    });
  });

  it('closes straight from Open: dated by closedAt, with no resolve stamps', async () => {
    const { id, agentId } = await openTicket();

    await changeStatus(agentId, id, await status('Closed'));

    const row = await stamps(id);
    expect(row).toMatchObject({ resolvedAt: null, resolvedByAgentId: null });
    expect(row.closedAt).toBeInstanceOf(Date);
  });

  // §6.98: the close used to clear it, and the rollup's next recompute of the
  // resolve's day then lost the resolution.
  it('closes a resolved ticket keeping the resolve it follows, and who made it', async () => {
    const { id, agentId } = await openTicket();
    await changeStatus(agentId, id, await status('Resolved'));
    const resolvedAt = await resolvedAtText(id);

    await changeStatus(agentId, id, await status('Closed'));

    expect(await resolvedAtText(id)).toBe(resolvedAt);
    const row = await stamps(id);
    expect(row.resolvedByAgentId).toBe(agentId);
    expect(row.closedAt).toBeInstanceOf(Date);
  });

  it('keeps it through a move from one closed status to another', async () => {
    const { id, agentId } = await openTicket();
    const [archived] = await db
      .insert(ticketStatuses)
      .values({ name: 'Archived', category: 'closed', stopsSlaClock: true, position: 99 })
      .returning({ id: ticketStatuses.id });
    await changeStatus(agentId, id, await status('Resolved'));
    const resolvedAt = await resolvedAtText(id);
    await changeStatus(agentId, id, await status('Closed'));

    await changeStatus(agentId, id, await status('Archived'));

    expect((await stamps(id)).statusId).toBe(archived!.id);
    expect(await resolvedAtText(id)).toBe(resolvedAt);
  });

  it.each(['Open', 'Pending'])('clears it when a closed ticket goes back to %s', async (back) => {
    const { id, agentId } = await openTicket();
    await changeStatus(agentId, id, await status('Resolved'));
    await changeStatus(agentId, id, await status('Closed'));

    await changeStatus(agentId, id, await status(back));

    expect(await stamps(id)).toMatchObject({
      resolvedAt: null,
      resolvedByAgentId: agentId,
      closedAt: null,
    });
  });

  it('stamps a fresh resolve when a closed ticket is resolved again', async () => {
    const { id, agentId } = await openTicket();
    await changeStatus(agentId, id, await status('Resolved'));
    const first = await resolvedAtText(id);
    await changeStatus(agentId, id, await status('Closed'));

    await changeStatus(agentId, id, await status('Resolved'));

    const again = await resolvedAtText(id);
    expect(again).not.toBeNull();
    expect(again).not.toBe(first);
    expect((await stamps(id)).closedAt).toBeNull();
  });
});

/**
 * Runs `write` while another session holds the ticket's row, and lets that
 * session change the priority — its line stamped when written, as every
 * writer of the column stamps it — and commit once `write` waits on it.
 */
async function behindAWriter(id: string, write: () => Promise<unknown>): Promise<void> {
  const other = postgres(process.env.TEST_DATABASE_URL!, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  try {
    const writer = other.begin(async (tx) => {
      await tx`select id from conversations where id = ${id} for no key update`;
      locked();
      await gate;
      await tx`update conversations set priority = 'urgent' where id = ${id}`;
      await tx`insert into conversation_events (conversation_id, type, actor_label, data, created_at)
               values (${id}, 'priority_changed', 'agent', '{"to":"urgent"}', clock_timestamp())`;
    });
    await isLocked;
    const writing = write();
    await untilWaitingOnALock(db);
    release();
    await writer;
    await writing;
  } finally {
    await other.end();
  }
}

/** The two lines as the ticket page draws them: by `created_at`, as Postgres holds it. */
async function lineOrder(id: string) {
  const lines = await db
    .select({ type: conversationEvents.type })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, id),
        inArray(conversationEvents.type, ['priority_changed', 'status_changed']),
      ),
    )
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
  return lines.map((line) => line.type);
}

/**
 * A decision in flight on the ticket: phase one written, its pass claimed, the
 * hold not yet ended (`lib/routing/apply.ts`) — the row `deferToRouter` reads.
 */
async function decisionInFlight(conversationId: string) {
  const now = new Date();
  await db.insert(routingDecisions).values({
    conversationId,
    shadow: false,
    stage: 'holding',
    outcome: 'fallback',
    windowEndsAt: new Date(now.getTime() + 5 * 60_000),
    phaseOneAt: now,
    rulesClaimedAt: now,
  });
}

async function passClaimed(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ claimedAt: routingDecisions.rulesClaimedAt })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId));
  return row!.claimedAt !== null;
}

// The console's status picker hands its `on_update` pass to the router when
// the move lands on a decision in flight, so a rule keyed on the new status
// runs before the router assigns anybody. Only the picker, and only a move
// the router still owes a pass: a resolve handed over is given up on the
// resolved ticket the router finds, and its rules never run.
describe('changeStatus on a decision in flight', () => {
  it('hands the pass to the router for a move to Pending, when asked', async () => {
    const { id, agentId } = await openTicket();
    await decisionInFlight(id);

    expect(
      await changeStatus(agentId, id, await status('Pending'), undefined, { deferToRouter: true }),
    ).toBe(true);
    expect(await passClaimed(id)).toBe(false);
  });

  // "Reply and resolve" and every other caller: the default is the caller's
  // own pass, which the caller then runs.
  it('leaves the router’s pass alone when not asked', async () => {
    const { id, agentId } = await openTicket();
    await decisionInFlight(id);

    expect(await changeStatus(agentId, id, await status('Pending'))).toBe(false);
    expect(await passClaimed(id)).toBe(true);
  });

  it.each(['Resolved', 'Closed'])('keeps the pass of a move to %s, asked or not', async (to) => {
    const { id, agentId } = await openTicket();
    await decisionInFlight(id);

    expect(
      await changeStatus(agentId, id, await status(to), undefined, { deferToRouter: true }),
    ).toBe(false);
    expect(await passClaimed(id)).toBe(true);
  });

  // Open, but nobody's work: the router gives its pass up on it all the same.
  it('keeps the pass of a ticket marked spam, though the move is to Open', async () => {
    const { id, agentId } = await openTicket();
    await db.update(conversations).set({ isSpam: true }).where(eq(conversations.id, id));
    await decisionInFlight(id);

    expect(
      await changeStatus(agentId, id, await status('Open'), undefined, { deferToRouter: true }),
    ).toBe(false);
    expect(await passClaimed(id)).toBe(true);
  });
});

// The router's phase one, an agent's priority: another writer can hold the
// ticket's row as the status change's transaction begins. Stamped with that
// start, the change's line sorted before the one committed while it waited,
// though the move could not be made until then (`CHANGE_STAMP`).
describe('changeStatus after a wait on the ticket', () => {
  it('sorts its line after the change it waited for', async () => {
    const { id, agentId } = await openTicket();
    const pending = await status('Pending');

    await behindAWriter(id, () => changeStatus(agentId, id, pending));

    expect(await stamps(id)).toMatchObject({ statusId: pending.id });
    expect(await lineOrder(id)).toEqual(['priority_changed', 'status_changed']);
  });
});
