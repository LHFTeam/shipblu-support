import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, routingDecisions, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `routing_decisions_decided_complete` from db/sql/003: a row at `decided`
 * carries its outcome and its `decided_at`, whatever wrote it.
 *
 * Every writer in `lib/routing` sets the three together and has its own
 * tests. These are the half that also holds for a hand-written UPDATE — a
 * repair of a stuck window — which is what the CHECK is for: a decided row
 * missing either is left out of the routing report without a word.
 */

withCleanDatabase();

const WINDOW_ENDS = new Date('2026-10-28T10:05:00.000Z');
const DECIDED = new Date('2026-10-28T10:05:01.000Z');

async function ticket(): Promise<string> {
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
    .values({ channel: 'webchat', statusId: status!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

async function pending(): Promise<string> {
  const [row] = await db
    .insert(routingDecisions)
    .values({ conversationId: await ticket(), shadow: false, windowEndsAt: WINDOW_ENDS })
    .returning({ id: routingDecisions.id });
  return row!.id;
}

/** The constraint's refusal, as postgres.js reports it underneath drizzle's wrapper. */
const refusedByCheck = {
  cause: { code: '23514', constraint_name: 'routing_decisions_decided_complete' },
};

describe('routing_decisions_decided_complete', () => {
  it('is on the table, as the replay of db/sql left it', async () => {
    const rows = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname = 'routing_decisions_decided_complete'
         and conrelid = 'public.routing_decisions'::regclass`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.definition).toMatch(/stage <> 'decided'/);
  });

  it('lets an undecided row carry neither, and a decided one carry both', async () => {
    const id = await pending();

    await db.update(routingDecisions).set({ stage: 'holding' }).where(eq(routingDecisions.id, id));
    await db
      .update(routingDecisions)
      .set({ stage: 'decided', outcome: 'fallback', decidedAt: DECIDED })
      .where(eq(routingDecisions.id, id));

    const [row] = await db
      .select({ stage: routingDecisions.stage, outcome: routingDecisions.outcome })
      .from(routingDecisions)
      .where(eq(routingDecisions.id, id));
    expect(row).toEqual({ stage: 'decided', outcome: 'fallback' });
  });

  it('refuses a row decided without an outcome or without a decided_at', async () => {
    const id = await pending();

    await expect(
      db
        .update(routingDecisions)
        .set({ stage: 'decided', decidedAt: DECIDED })
        .where(eq(routingDecisions.id, id)),
    ).rejects.toMatchObject(refusedByCheck);
    await expect(
      db
        .update(routingDecisions)
        .set({ stage: 'decided', outcome: 'manual' })
        .where(eq(routingDecisions.id, id)),
    ).rejects.toMatchObject(refusedByCheck);

    // Inserted that way too: nothing does, which is what a CHECK is for.
    await expect(
      db.insert(routingDecisions).values({
        conversationId: await ticket(),
        shadow: true,
        stage: 'decided',
        windowEndsAt: WINDOW_ENDS,
      }),
    ).rejects.toMatchObject(refusedByCheck);
  });

  // Phase one writes the outcome and leaves the row `holding` while the rules
  // run, so an outcome without `decided_at` is a row in flight, not a broken one.
  it('lets a row in flight carry its outcome before it is decided', async () => {
    const id = await pending();

    await db
      .update(routingDecisions)
      .set({ stage: 'holding', outcome: 'category', phaseOneAt: DECIDED })
      .where(eq(routingDecisions.id, id));
  });
});
