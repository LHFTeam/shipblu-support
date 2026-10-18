import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  contacts,
  conversationEvents,
  conversations,
  csatSurveys,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { sendSurvey, setSurveySuppressed, suppressedBy, suppressSurveyByRule } from '@/lib/csat';
import { saveCsatSettings, UNSET_CSAT_SETTINGS } from '@/lib/csat/settings';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { sendCsat } from '@/worker/handlers/send-csat';
import { runAutomations } from './index';

/**
 * A rule's `suppress_survey`, against real Postgres: it sets the agent's flag
 * once however often the rule matches, it never undoes an agent's "Allow a
 * survey" that answered a rule, and the skip it leads to names the rule
 * rather than an agent. A resolve in the same pass — in the same rule or
 * another — queues its survey only after the suppression is in.
 */

withCleanDatabase();

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row.id;
}

async function admin(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona', email: `mona-${crypto.randomUUID()}@shipblu.test`, role: 'admin' })
    .returning({ id: agents.id });
  return row!.id;
}

async function rule(
  trigger: 'on_create' | 'on_update',
  actions: Record<string, unknown>[],
  name = 'Internal queue',
  position = 0,
) {
  await db.insert(automationRules).values({ name, trigger, conditions: {}, actions, position });
}

async function surveysOn() {
  const adminId = await admin();
  await saveCsatSettings(
    {
      ...UNSET_CSAT_SETTINGS,
      enabled: true,
      channels: { ...UNSET_CSAT_SETTINGS.channels, email: true },
    },
    adminId,
  );
  return adminId;
}

/**
 * When the survey job was queued, against when the flag went on: the job must
 * not exist before the suppression does, or with the delay at 0 the worker
 * can send it in between.
 */
async function queuedAfterSuppression(conversationId: string) {
  // Compared in Postgres: read back as a JavaScript Date, both are cut to the
  // millisecond, and a few round trips apart they can tie.
  const [row] = await db.execute<{ jobs: number; after: boolean }>(sql`
    select count(j.id)::int as jobs,
           coalesce(bool_and(j.created_at > (
             select max(e.created_at) from ${conversationEvents} e
             where e.conversation_id = ${conversationId}::uuid and e.type = 'csat_suppressed'
           )), false) as after
    from ${jobs} j
    where j.type = 'send_csat' and j.payload->>'conversationId' = ${conversationId}
  `);
  return { jobs: row!.jobs, after: row!.after };
}

/** Resolves once another session is waiting on a lock this test holds. */
async function untilSomebodyWaits(): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (row && row.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing came to wait on the lock this test holds');
}

/** An email ticket the customer wrote on, in `status`. */
async function ticket(status = 'Open'): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: `amira-${crypto.randomUUID()}@example.test` })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      statusId: await statusId(status),
      requesterContactId: contact!.id,
      lastCustomerMessageAt: new Date(),
    })
    .returning({ id: conversations.id });
  await db.insert(messages).values({
    conversationId: row!.id,
    direction: 'inbound',
    kind: 'reply',
    authorContactId: contact!.id,
    bodyText: 'Where is my parcel?',
  });
  return row!.id;
}

async function suppressionEvents(conversationId: string) {
  return db
    .select({
      type: conversationEvents.type,
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'csat_suppressed'),
      ),
    );
}

async function flagOf(conversationId: string) {
  const [row] = await db
    .select({ suppressed: conversations.csatSuppressed, by: suppressedBy() })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row;
}

function surveyJob(conversationId: string): ClaimedJob {
  return {
    id: 'job-1',
    type: 'send_csat',
    payload: { conversationId, trigger: 'rule' },
  } as unknown as ClaimedJob;
}

async function skipReasonOf(conversationId: string) {
  const rows = await db
    .select({ skipReason: csatSurveys.skipReason })
    .from(csatSurveys)
    .where(eq(csatSurveys.conversationId, conversationId));
  return rows.map((row) => row.skipReason);
}

describe('suppress_survey', () => {
  it('sets the flag once, in the rule’s name, however often the rule matches', async () => {
    await rule('on_create', [{ type: 'suppress_survey' }]);
    const id = await ticket();

    await runAutomations('on_create', id);
    await runAutomations('on_create', id);

    expect(await flagOf(id)).toEqual({ suppressed: true, by: 'rule' });
    expect(await suppressionEvents(id)).toEqual([
      { type: 'csat_suppressed', actorAgentId: null, actorLabel: 'automation:Internal queue' },
    ]);
  });

  it('leaves a ticket alone for good once an agent allowed a survey a rule had kept off, and only that ticket', async () => {
    const agentId = await admin();
    await rule('on_create', [{ type: 'suppress_survey' }], 'On arrival');
    const allowed = await ticket();
    await runAutomations('on_create', allowed);
    await setSurveySuppressed(allowed, agentId, false);
    // Untouched: another ticket's "Allow a survey" says nothing about it.
    const other = await ticket();

    await rule('on_update', [{ type: 'suppress_survey' }], 'On update');
    await runAutomations('on_update', allowed);
    await runAutomations('on_update', other);

    expect(await flagOf(allowed)).toEqual({ suppressed: false, by: null });
    expect(await suppressionEvents(allowed)).toHaveLength(1);
    expect(await flagOf(other)).toEqual({ suppressed: true, by: 'rule' });
  });

  it('still applies after an agent undid their own "Don’t survey", which overruled no rule', async () => {
    const agentId = await admin();
    const id = await ticket();
    await setSurveySuppressed(id, agentId, true);
    await setSurveySuppressed(id, agentId, false);

    await rule('on_update', [{ type: 'suppress_survey' }]);
    await runAutomations('on_update', id);

    expect(await flagOf(id)).toEqual({ suppressed: true, by: 'rule' });
  });

  it('reads each ticket’s own author, an agent’s flag beside a rule’s', async () => {
    const agentId = await admin();
    const byAgent = await ticket();
    await setSurveySuppressed(byAgent, agentId, true);
    const byRule = await ticket();

    await rule('on_update', [{ type: 'suppress_survey' }]);
    await runAutomations('on_update', byAgent);
    await runAutomations('on_update', byRule);

    expect(await flagOf(byAgent)).toEqual({ suppressed: true, by: 'agent' });
    expect(await suppressionEvents(byAgent)).toHaveLength(1);
    expect(await flagOf(byRule)).toEqual({ suppressed: true, by: 'rule' });
  });

  it('goes by the newest decision when a rule and an agent take turns', async () => {
    const agentId = await admin();
    await rule('on_create', [{ type: 'suppress_survey' }], 'On arrival');
    await rule('on_update', [{ type: 'suppress_survey' }], 'On update');
    const id = await ticket();

    await runAutomations('on_create', id);
    expect(await flagOf(id)).toEqual({ suppressed: true, by: 'rule' });

    // The agent allows a survey, then thinks better of it: the flag is theirs.
    await setSurveySuppressed(id, agentId, false);
    await setSurveySuppressed(id, agentId, true);
    expect(await flagOf(id)).toEqual({ suppressed: true, by: 'agent' });

    // And allows it again, after which no rule turns it off.
    await setSurveySuppressed(id, agentId, false);
    await runAutomations('on_update', id);
    expect(await flagOf(id)).toEqual({ suppressed: false, by: null });
    expect(await suppressionEvents(id)).toHaveLength(2);
  });

  it('keeps a deleted agent’s flag an agent’s', async () => {
    const agentId = await admin();
    const id = await ticket();
    await setSurveySuppressed(id, agentId, true);
    // The event's agent goes to null with the agent; its missing label is
    // what still tells it from a rule's.
    await db.delete(agents).where(eq(agents.id, agentId));

    expect(await flagOf(id)).toEqual({ suppressed: true, by: 'agent' });
  });

  it('queues the survey only after the suppression, when the same rule resolves first', async () => {
    await surveysOn();
    await rule('on_update', [
      { type: 'set_status', category: 'resolved' },
      { type: 'suppress_survey' },
    ]);
    const id = await ticket();

    await runAutomations('on_update', id);

    expect(await queuedAfterSuppression(id)).toEqual({ jobs: 1, after: true });
    await sendCsat(surveyJob(id));
    expect(await skipReasonOf(id)).toEqual(['rule_suppressed']);
  });

  it('queues the survey only after the suppression, when a later rule in the pass suppresses', async () => {
    await surveysOn();
    await rule(
      'on_update',
      [{ type: 'set_status', category: 'resolved' }],
      'Resolve internal forms',
      1,
    );
    await rule('on_update', [{ type: 'suppress_survey' }], 'Don’t survey the internal group', 2);
    const id = await ticket();

    await runAutomations('on_update', id);

    expect(await queuedAfterSuppression(id)).toEqual({ jobs: 1, after: true });
    await sendCsat(surveyJob(id));
    expect(await skipReasonOf(id)).toEqual(['rule_suppressed']);
  });

  it('queues the survey a resolve owes even when the pass fails after it', async () => {
    // The resolve has committed; a write after it in the pass — here the
    // rule's `last_run_at`, refused by a trigger — must not take the survey
    // with it, or the ticket stays resolved with no survey and no reason.
    await surveysOn();
    await rule('on_update', [{ type: 'set_status', category: 'resolved' }]);
    const id = await ticket();
    await db.execute(
      sql.raw(`create or replace function refuse_rule_bookkeeping() returns trigger
      language plpgsql as $$ begin raise exception 'refused for the test'; end $$`),
    );
    await db.execute(
      sql.raw(`create trigger refuse_rule_bookkeeping before update on automation_rules
      for each row execute function refuse_rule_bookkeeping()`),
    );
    try {
      await runAutomations('on_update', id);
    } finally {
      await db.execute(
        sql.raw('drop trigger if exists refuse_rule_bookkeeping on automation_rules'),
      );
      await db.execute(sql.raw('drop function if exists refuse_rule_bookkeeping()'));
    }

    const queued = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, 'send_csat'));
    expect(queued).toHaveLength(1);
  });

  it('queues one survey however many rules in the pass resolve', async () => {
    await surveysOn();
    await rule('on_update', [{ type: 'set_status', category: 'resolved' }], 'First', 1);
    await rule('on_update', [{ type: 'set_status', category: 'resolved' }], 'Second', 2);
    const id = await ticket();

    await runAutomations('on_update', id);

    const queued = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, 'send_csat'));
    expect(queued).toHaveLength(1);
  });

  it('stamps each writer’s event when it holds the ticket, not when its transaction began', async () => {
    // An agent's toggle that began first and wrote last must sort last, or
    // `suppressedBy` names a rule that committed in between for the agent's
    // flag. Held here, each writer waits on the ticket after beginning.
    const agentId = await admin();
    for (const write of [
      (id: string) => setSurveySuppressed(id, agentId, true),
      (id: string) => suppressSurveyByRule(id, 'Internal queue'),
    ]) {
      const id = await ticket();
      let wrote: Promise<unknown> | undefined;
      // Text, which keeps the microseconds a Date would drop.
      let released: string | undefined;
      await db.transaction(async (tx) => {
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, id))
          .for('update');
        wrote = write(id);
        await untilSomebodyWaits();
        const [row] = await tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`);
        released = row!.at;
      });
      await wrote;

      const [event] = await db
        .select({
          afterRelease: sql<boolean>`${conversationEvents.createdAt} >= ${released}::timestamptz`,
        })
        .from(conversationEvents)
        .where(
          and(
            eq(conversationEvents.conversationId, id),
            eq(conversationEvents.type, 'csat_suppressed'),
          ),
        );
      expect(event!.afterRelease).toBe(true);
    }
  });

  it('is read again behind the lock when the survey is written, for a rule and an agent', async () => {
    const adminId = await surveysOn();
    const send = (conversationId: string) =>
      sendSurvey({
        conversationId,
        locale: 'en',
        delivery: 'email_link',
        snapshot: { agentId: null, groupId: null, channel: 'email' },
        resurveyAfterDays: 14,
        ruleId: null,
        requesterEmail: 'amira@example.test',
        body: () => ({ text: 'How did we do?', html: null }),
      });

    await rule('on_update', [{ type: 'suppress_survey' }]);
    const byRule = await ticket('Resolved');
    await runAutomations('on_update', byRule);
    const byAgent = await ticket('Resolved');
    await setSurveySuppressed(byAgent, adminId, true);

    expect(await send(byRule)).toEqual({ kind: 'skip', reason: 'rule_suppressed' });
    expect(await send(byAgent)).toEqual({ kind: 'skip', reason: 'agent_suppressed' });
  });
});
