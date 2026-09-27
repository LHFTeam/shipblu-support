import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversationWatchers,
  conversations,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { slaSweep } from './sla-sweep';

/**
 * The breach sweep against Postgres, where its idempotency lives: the breach
 * flags and the `sla_escalated` event rows are the record of what has already
 * been reported, and nothing without a database can show that a second run
 * reads them.
 *
 * The sweep takes its clock from `new Date()`, so a ticket is placed in time by
 * its due dates, relative to now. Time passing between two runs is a due date
 * moved further into the past; nothing else about the row changes.
 */

withCleanDatabase();

const MINUTE = 60_000;
const TARGET = { firstResponseMins: 60, nextResponseMins: null, resolutionMins: 1440 };
const TARGETS = { low: TARGET, medium: TARGET, high: TARGET, urgent: TARGET };

function minutesAgo(mins: number): Date {
  return new Date(Date.now() - mins * MINUTE);
}

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status named ${name}`);
  return row.id;
}

async function supervisor(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona', email: 'mona@shipblu.test', role: 'supervisor' })
    .returning({ id: agents.id });
  return row!.id;
}

async function policyEscalatingTo(agentId: string, afterMins: number): Promise<string> {
  const [row] = await db
    .insert(slaPolicies)
    .values({
      name: 'Live support',
      targets: TARGETS,
      isDefault: true,
      escalations: {
        firstResponse: { afterMins, agentIds: [agentId] },
        resolution: { afterMins, agentIds: [agentId] },
      },
    })
    .returning({ id: slaPolicies.id });
  return row!.id;
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: await statusId('Open'),
      channel: 'email',
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function flags(id: string) {
  const [row] = await db
    .select({
      firstResponseBreached: conversations.firstResponseBreached,
      resolutionBreached: conversations.resolutionBreached,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row;
}

async function events(id: string, type: 'sla_breached' | 'sla_escalated') {
  return db
    .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)))
    .orderBy(asc(conversationEvents.createdAt));
}

async function watchers(id: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: conversationWatchers.agentId })
    .from(conversationWatchers)
    .where(eq(conversationWatchers.conversationId, id));
  return rows.map((row) => row.agentId);
}

describe('slaSweep: breaches', () => {
  it('records a missed first response once, however often it runs', async () => {
    const dueAt = minutesAgo(10);
    const id = await ticket({ firstResponseDueAt: dueAt });

    await slaSweep();
    await slaSweep();

    expect(await flags(id)).toEqual({ firstResponseBreached: true, resolutionBreached: false });
    const breached = await events(id, 'sla_breached');
    expect(breached).toHaveLength(1);
    expect(breached[0]!.actorLabel).toBe('sla_sweep');
    expect(breached[0]!.data).toMatchObject({ kind: 'first_response', dueAt: dueAt.toISOString() });
    // Measured by the sweep's own clock, which is a few milliseconds behind
    // the test's by the time it reads it.
    const late = (breached[0]!.data as { breachedBySeconds: number }).breachedBySeconds;
    expect(late).toBeGreaterThanOrEqual(600);
    expect(late).toBeLessThan(660);
  });

  it('records a missed resolution on its own flag and its own event', async () => {
    const id = await ticket({ resolutionDueAt: minutesAgo(10) });

    await slaSweep();

    expect(await flags(id)).toEqual({ firstResponseBreached: false, resolutionBreached: true });
    const breached = await events(id, 'sla_breached');
    expect(breached.map((row) => (row.data as { kind: string }).kind)).toEqual(['resolution']);
  });

  it('leaves alone a ticket that was answered, is not due yet, or has its clock stopped', async () => {
    const answered = await ticket({
      firstResponseDueAt: minutesAgo(10),
      firstRespondedAt: minutesAgo(20),
    });
    const notDue = await ticket({ firstResponseDueAt: minutesAgo(-10) });
    const waiting = await ticket({
      firstResponseDueAt: minutesAgo(10),
      statusId: await statusId('Pending'),
    });

    await slaSweep();

    for (const id of [answered, notDue, waiting]) {
      expect(await flags(id)).toEqual({ firstResponseBreached: false, resolutionBreached: false });
      expect(await events(id, 'sla_breached')).toEqual([]);
    }
  });
});

describe('slaSweep: escalations', () => {
  it('escalates on the run that finds the breach when the wait is already over, and once', async () => {
    const agentId = await supervisor();
    const slaPolicyId = await policyEscalatingTo(agentId, 20);
    const id = await ticket({ slaPolicyId, firstResponseDueAt: minutesAgo(30) });

    await slaSweep();
    await slaSweep();

    expect(await watchers(id)).toEqual([agentId]);
    const escalated = await events(id, 'sla_escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.data).toEqual({
      kind: 'first_response',
      agentIds: [agentId],
      afterMins: 20,
    });
  });

  it('does not escalate before the wait is over', async () => {
    const agentId = await supervisor();
    const slaPolicyId = await policyEscalatingTo(agentId, 20);
    const id = await ticket({ slaPolicyId, firstResponseDueAt: minutesAgo(5) });

    await slaSweep();

    expect(await flags(id)).toMatchObject({ firstResponseBreached: true });
    expect(await watchers(id)).toEqual([]);
    expect(await events(id, 'sla_escalated')).toEqual([]);
  });

  // The case every production escalation is: the sweep runs every five
  // minutes, so it finds a breach within five minutes of the due date, and the
  // wait an admin sets is longer than that.
  it('escalates a breach it found early, once the wait is over', async () => {
    const agentId = await supervisor();
    const slaPolicyId = await policyEscalatingTo(agentId, 20);
    const id = await ticket({
      slaPolicyId,
      firstResponseDueAt: minutesAgo(5),
      resolutionDueAt: minutesAgo(5),
    });

    await slaSweep();
    expect(await events(id, 'sla_escalated')).toEqual([]);

    // Twenty minutes later.
    await db
      .update(conversations)
      .set({ firstResponseDueAt: minutesAgo(25), resolutionDueAt: minutesAgo(25) })
      .where(eq(conversations.id, id));
    await slaSweep();
    await slaSweep();

    expect(await watchers(id)).toEqual([agentId]);
    const escalated = await events(id, 'sla_escalated');
    expect(escalated.map((row) => (row.data as { kind: string }).kind).sort()).toEqual([
      'first_response',
      'resolution',
    ]);
    // Still one breach of each: the flags were already set.
    expect(await events(id, 'sla_breached')).toHaveLength(2);
  });

  it('does not escalate a breach that was answered before the wait was over', async () => {
    const agentId = await supervisor();
    const slaPolicyId = await policyEscalatingTo(agentId, 20);
    const id = await ticket({ slaPolicyId, firstResponseDueAt: minutesAgo(5) });

    await slaSweep();
    await db
      .update(conversations)
      .set({ firstRespondedAt: new Date(), firstResponseDueAt: minutesAgo(25) })
      .where(eq(conversations.id, id));
    await slaSweep();

    expect(await watchers(id)).toEqual([]);
    expect(await events(id, 'sla_escalated')).toEqual([]);
  });

  it('does not escalate a breach whose clock has since stopped', async () => {
    const agentId = await supervisor();
    const slaPolicyId = await policyEscalatingTo(agentId, 20);
    const id = await ticket({ slaPolicyId, resolutionDueAt: minutesAgo(5) });

    await slaSweep();
    await db
      .update(conversations)
      .set({ statusId: await statusId('Pending'), resolutionDueAt: minutesAgo(25) })
      .where(eq(conversations.id, id));
    await slaSweep();

    expect(await events(id, 'sla_escalated')).toEqual([]);
  });

  it('counts an escalation to somebody already watching, and adds no second watcher row', async () => {
    const agentId = await supervisor();
    const slaPolicyId = await policyEscalatingTo(agentId, 0);
    const id = await ticket({ slaPolicyId, firstResponseDueAt: minutesAgo(1) });
    await db.insert(conversationWatchers).values({ conversationId: id, agentId });

    await slaSweep();

    expect(await watchers(id)).toEqual([agentId]);
    expect(await events(id, 'sla_escalated')).toHaveLength(1);
  });
});
