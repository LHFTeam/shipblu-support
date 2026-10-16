import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  csatSurveys,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { scheduleSurvey } from '@/lib/csat';
import { saveCsatSettings, UNSET_CSAT_SETTINGS } from '@/lib/csat/settings';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { sendCsat } from './send-csat';

/**
 * The survey job against real Postgres: every decision is a row, a second run
 * is harmless, the language is the customer's, and nothing is queued while the
 * switch is off. These are the three bugs the first survey ever sent had
 * (`plans/csat.md`), held here so they stay fixed.
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

async function switchOn(overrides: Partial<Parameters<typeof saveCsatSettings>[0]> = {}) {
  const [admin] = await db
    .insert(agents)
    .values({ name: 'Admin', email: 'admin@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  await saveCsatSettings(
    {
      ...UNSET_CSAT_SETTINGS,
      enabled: true,
      channels: { email: true, webchat: true, facebook: true, instagram: true, api: true },
      ...overrides,
    },
    admin!.id,
  );
}

async function resolvedTicket(input: {
  channel: 'email' | 'webchat' | 'facebook' | 'whatsapp';
  email?: string | null;
  customerText?: string | null;
  status?: string;
}) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: input.email ?? null })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: input.channel,
      statusId: await statusId(input.status ?? 'Resolved'),
      requesterContactId: contact!.id,
      lastCustomerMessageAt: new Date(),
    })
    .returning({ id: conversations.id });
  if (input.customerText !== null) {
    await db.insert(messages).values({
      conversationId: row!.id,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: contact!.id,
      bodyText: input.customerText ?? 'فين الشحنة بتاعتي؟',
    });
  }
  return row!.id;
}

function job(conversationId: string, trigger?: 'agent' | 'rule' | 'manual'): ClaimedJob {
  return {
    id: 'job-1',
    type: 'send_csat',
    payload: { conversationId, ...(trigger ? { trigger } : {}) },
  } as unknown as ClaimedJob;
}

async function surveysOf(conversationId: string) {
  return db
    .select({
      status: csatSurveys.status,
      skipReason: csatSurveys.skipReason,
      delivery: csatSurveys.delivery,
      locale: csatSurveys.locale,
      channel: csatSurveys.channel,
      messageId: csatSurveys.messageId,
      tokenHash: csatSurveys.tokenHash,
    })
    .from(csatSurveys)
    .where(eq(csatSurveys.conversationId, conversationId));
}

async function eventTypes(conversationId: string) {
  const rows = await db
    .select({ type: conversationEvents.type })
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, conversationId));
  return rows.map((row) => row.type);
}

describe('send_csat', () => {
  it('sends an email survey in the language the customer wrote, and records it', async () => {
    await switchOn();
    const id = await resolvedTicket({ channel: 'email', email: 'amira@example.test' });

    await sendCsat(job(id));

    const [survey] = await surveysOf(id);
    expect(survey).toMatchObject({
      status: 'sent',
      delivery: 'email_link',
      locale: 'ar',
      channel: 'email',
    });
    expect(survey!.tokenHash).not.toBeNull();

    const [message] = await db
      .select({
        bodyText: messages.bodyText,
        bodyHtml: messages.bodyHtml,
        to: messages.toAddresses,
      })
      .from(messages)
      .where(eq(messages.id, survey!.messageId!));
    expect(message!.bodyText).toContain('/ar/csat/');
    expect(message!.bodyHtml).toContain('<a href=');
    expect(message!.to).toEqual(['amira@example.test']);

    const carriers = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(and(eq(jobs.type, 'send_email')));
    expect(carriers).toHaveLength(1);
    expect(await eventTypes(id)).toContain('csat_sent');
  });

  it('records why there was no survey, on the ticket', async () => {
    await switchOn();
    const noAddress = await resolvedTicket({ channel: 'email', email: null });
    const reopened = await resolvedTicket({ channel: 'email', email: 'a@b.test', status: 'Open' });
    const silent = await resolvedTicket({
      channel: 'email',
      email: 'a@b.test',
      customerText: null,
    });
    const whatsapp = await resolvedTicket({ channel: 'whatsapp' });

    await sendCsat(job(noAddress));
    await sendCsat(job(reopened));
    await sendCsat(job(silent));
    await sendCsat(job(whatsapp));

    expect((await surveysOf(noAddress))[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'no_address',
    });
    expect((await surveysOf(reopened))[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'reopened',
    });
    expect((await surveysOf(silent))[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'no_customer_message',
    });
    expect((await surveysOf(whatsapp))[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'channel_off',
    });
    expect(await eventTypes(noAddress)).toEqual(['csat_skipped']);

    // No survey row carries a message, so nothing was queued to any carrier.
    expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);
  });

  it('is harmless run twice, and surveys the ticket again only after the window', async () => {
    await switchOn({ resurveyAfterDays: 14 });
    const id = await resolvedTicket({ channel: 'webchat' });

    await sendCsat(job(id));
    await sendCsat(job(id));

    const rows = await surveysOf(id);
    expect(rows.map((row) => row.status).sort()).toEqual(['sent', 'skipped']);
    expect(rows.find((row) => row.status === 'skipped')!.skipReason).toBe('recently_surveyed');

    // The first survey ages past the window, unanswered — as most are. The
    // next resolve is surveyed, and the old row steps aside rather than
    // meeting the open-survey index.
    await db
      .update(csatSurveys)
      .set({ sentAt: new Date(Date.now() - 15 * 24 * 3_600_000) })
      .where(and(eq(csatSurveys.conversationId, id), eq(csatSurveys.status, 'sent')));
    await sendCsat(job(id));
    const after = await surveysOf(id);
    expect(after.filter((row) => row.status === 'sent')).toHaveLength(1);
    expect(after.filter((row) => row.status === 'expired')).toHaveLength(1);
  });

  it('honours the agent, the rule switch and the channel switches', async () => {
    await switchOn({
      surveyRuleResolved: false,
      channels: { ...UNSET_CSAT_SETTINGS.channels, email: true },
    });
    const suppressed = await resolvedTicket({ channel: 'email', email: 'a@b.test' });
    await db
      .update(conversations)
      .set({ csatSuppressed: true })
      .where(eq(conversations.id, suppressed));
    const byRule = await resolvedTicket({ channel: 'email', email: 'a@b.test' });
    const chat = await resolvedTicket({ channel: 'webchat' });

    await sendCsat(job(suppressed));
    await sendCsat(job(byRule, 'rule'));
    await sendCsat(job(chat));

    expect((await surveysOf(suppressed))[0]).toMatchObject({ skipReason: 'agent_suppressed' });
    expect((await surveysOf(byRule))[0]).toMatchObject({ skipReason: 'rule_resolved' });
    expect((await surveysOf(chat))[0]).toMatchObject({ skipReason: 'channel_off' });
  });

  it('queues nothing while the switch is off, and the delay the admin set when on', async () => {
    const id = await resolvedTicket({ channel: 'email', email: 'a@b.test' });
    expect(await scheduleSurvey(id, 'agent')).toBe(false);
    expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);

    await switchOn({ delayMinutes: 45 });
    const before = Date.now();
    expect(await scheduleSurvey(id, 'agent')).toBe(true);
    expect(await scheduleSurvey(id, 'manual')).toBe(true);

    const queued = await db
      .select({ runAt: jobs.runAt, payload: jobs.payload, dedupeKey: jobs.dedupeKey })
      .from(jobs)
      .where(eq(jobs.type, 'send_csat'));
    expect(queued).toHaveLength(2);
    // No dedupe key: the key this used to carry was spent for good, so a
    // second resolve never surveyed.
    expect(queued.every((row) => row.dedupeKey === null)).toBe(true);
    const delayed = queued.find((row) => (row.payload as { trigger: string }).trigger === 'agent')!;
    expect(delayed.runAt.getTime() - before).toBeGreaterThanOrEqual(45 * 60_000 - 1000);
    const manual = queued.find((row) => (row.payload as { trigger: string }).trigger === 'manual')!;
    expect(manual.runAt.getTime() - before).toBeLessThan(5_000);
  });
});
