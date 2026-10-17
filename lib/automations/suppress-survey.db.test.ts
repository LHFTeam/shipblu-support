import { and, eq } from 'drizzle-orm';
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
import { sendSurvey, setSurveySuppressed, suppressedBy } from '@/lib/csat';
import { saveCsatSettings, UNSET_CSAT_SETTINGS } from '@/lib/csat/settings';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { sendCsat } from '@/worker/handlers/send-csat';
import { runAutomations } from './index';

/**
 * A rule's `suppress_survey`, against real Postgres: it sets the agent's flag
 * once however often the rule matches, it never undoes an agent's "Allow a
 * survey", and the skip it leads to names the rule rather than an agent —
 * including when the rule resolved the ticket and queued the survey itself.
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
) {
  await db.insert(automationRules).values({ name, trigger, conditions: {}, actions });
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

  it('leaves a ticket an agent allowed a survey on alone, for good, and only that ticket', async () => {
    const agentId = await admin();
    const allowed = await ticket();
    await setSurveySuppressed(allowed, agentId, true);
    await setSurveySuppressed(allowed, agentId, false);
    // Untouched: another ticket's "Allow a survey" says nothing about it.
    const other = await ticket();

    await rule('on_update', [{ type: 'suppress_survey' }]);
    await runAutomations('on_update', allowed);
    await runAutomations('on_update', other);

    expect(await flagOf(allowed)).toEqual({ suppressed: false, by: null });
    expect(await suppressionEvents(allowed)).toHaveLength(1);
    expect(await flagOf(other)).toEqual({ suppressed: true, by: 'rule' });
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

  it('names the rule in the skip, when the same rule resolved the ticket and queued the survey', async () => {
    const adminId = await admin();
    await saveCsatSettings(
      {
        ...UNSET_CSAT_SETTINGS,
        enabled: true,
        channels: { ...UNSET_CSAT_SETTINGS.channels, email: true },
      },
      adminId,
    );
    await rule('on_update', [
      { type: 'set_status', category: 'resolved' },
      { type: 'suppress_survey' },
    ]);
    const id = await ticket();

    await runAutomations('on_update', id);
    // The resolve queued the survey before the rule's next action ran.
    const queued = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(eq(jobs.type, 'send_csat'));
    expect(queued).toHaveLength(1);

    await sendCsat(surveyJob(id));
    expect(await skipReasonOf(id)).toEqual(['rule_suppressed']);
  });

  it('is read again behind the lock when the survey is written, for a rule and an agent', async () => {
    const adminId = await admin();
    await saveCsatSettings(
      {
        ...UNSET_CSAT_SETTINGS,
        enabled: true,
        channels: { ...UNSET_CSAT_SETTINGS.channels, email: true },
      },
      adminId,
    );
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
