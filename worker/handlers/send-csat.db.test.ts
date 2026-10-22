import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  csatRules,
  csatSurveys,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { scheduleSurvey, sendSurvey, ticketSurveyState } from '@/lib/csat';
import { saveCsatSettings, UNSET_CSAT_SETTINGS } from '@/lib/csat/settings';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { sendCsat } from './send-csat';

/**
 * The survey job against real Postgres: every decision is a row, two runs for
 * one ticket send one survey, a run stopped half-way is finished by the next,
 * the language is the customer's, and nothing is queued while the switch is
 * off. These are the bugs the first survey ever sent had (`plans/csat.md`),
 * and the ones review found in the fix, held here so they stay fixed.
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
  channel:
    | 'email'
    | 'webchat'
    | 'facebook'
    | 'facebook_comment'
    | 'instagram'
    | 'whatsapp'
    | 'whatsapp_bot';
  email?: string | null;
  /** The customer's one message; null for none; a media stand-in is words too here. */
  customerText?: string | null;
  status?: string;
  externalId?: string;
  /** When the customer last wrote, which is what Meta's windows count from. */
  lastWroteAt?: Date;
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
      lastCustomerMessageAt: input.lastWroteAt ?? new Date(),
      externalId: input.externalId ?? null,
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

async function carrierJobs() {
  return db
    .select({ type: jobs.type, dedupeKey: jobs.dedupeKey })
    .from(jobs)
    .where(eq(jobs.type, 'send_email'));
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

    expect(await carrierJobs()).toHaveLength(1);
    expect(await eventTypes(id)).toContain('csat_sent');

    // Not the acknowledgement the rule engine looks for.
    const [ticket] = await db
      .select({ firstAutoRepliedAt: conversations.firstAutoRepliedAt })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(ticket!.firstAutoRepliedAt).toBeNull();
  });

  it('sends the admin’s wording for the ticket’s channel, and remembers which', async () => {
    await switchOn();
    // Two rules, so the test proves the ticket's channel picked the email one.
    await db.insert(csatRules).values({ channel: 'webchat', questionEn: 'Chat only' });
    const [rule] = await db
      .insert(csatRules)
      .values({
        channel: 'email',
        questionAr: 'كيف كان الدعم اليوم؟',
        introEn: 'From the team',
      })
      .returning({ id: csatRules.id });
    const id = await resolvedTicket({ channel: 'email', email: 'a@b.test', customerText: 'hello' });

    await sendCsat(job(id));

    const [survey] = await db
      .select({ ruleId: csatSurveys.ruleId, messageId: csatSurveys.messageId })
      .from(csatSurveys)
      .where(eq(csatSurveys.conversationId, id));
    expect(survey!.ruleId).toBe(rule!.id);
    const [message] = await db
      .select({ bodyText: messages.bodyText, bodyHtml: messages.bodyHtml })
      .from(messages)
      .where(eq(messages.id, survey!.messageId!));
    // English customer: the question falls back to the rule's Arabic, the
    // first line is the rule's English, and the five links carry the rating.
    expect(message!.bodyText).toContain('From the team');
    expect(message!.bodyText).toContain('كيف كان الدعم اليوم؟');
    expect(message!.bodyText).not.toContain('Chat only');
    expect(message!.bodyHtml).toContain('?rating=5');
    expect(message!.bodyHtml).toContain('?rating=1');
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
    const bot = await resolvedTicket({ channel: 'whatsapp_bot' });
    // A public comment thread: the survey would be posted on the post.
    const comment = await resolvedTicket({
      channel: 'facebook_comment',
      externalId: 'facebook:comment:123_456',
    });

    for (const id of [noAddress, reopened, silent, whatsapp, bot, comment]) await sendCsat(job(id));

    expect((await surveysOf(noAddress))[0]).toMatchObject({ skipReason: 'no_address' });
    expect((await surveysOf(reopened))[0]).toMatchObject({ skipReason: 'reopened' });
    expect((await surveysOf(silent))[0]).toMatchObject({ skipReason: 'no_customer_message' });
    expect((await surveysOf(whatsapp))[0]).toMatchObject({ skipReason: 'channel_unsupported' });
    expect((await surveysOf(bot))[0]).toMatchObject({ skipReason: 'read_only_channel' });
    expect((await surveysOf(comment))[0]).toMatchObject({ skipReason: 'comment_thread' });
    expect(await eventTypes(noAddress)).toEqual(['csat_skipped']);

    // The same reason again within the day is the earlier row's, not a second.
    await sendCsat(job(noAddress));
    expect(await surveysOf(noAddress)).toHaveLength(1);

    // No survey row carries a message, so nothing was queued to any carrier.
    expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);
  });

  it('surveys Facebook with Messenger’s card for seven days, and Instagram inside one', async () => {
    await switchOn({ privacyUrl: 'https://shipblu.com/privacy', metaExpiresInDays: 5 });
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000);
    const card = await resolvedTicket({ channel: 'facebook', lastWroteAt: threeDaysAgo });
    const buttons = await resolvedTicket({ channel: 'instagram', customerText: 'where is it?' });
    const late = await resolvedTicket({ channel: 'instagram', lastWroteAt: threeDaysAgo });

    for (const id of [card, buttons, late]) await sendCsat(job(id));

    // Past the 24 hours, the card still goes: its own tag carries it.
    const [cardSurvey] = await surveysOf(card);
    expect(cardSurvey).toMatchObject({ status: 'sent', delivery: 'meta_template' });
    // Nothing would carry a link, so there is no token for one.
    expect(cardSurvey!.tokenHash).toBeNull();
    const [cardMessage] = await db
      .select({ bodyText: messages.bodyText, meta: messages.meta })
      .from(messages)
      .where(eq(messages.id, cardSurvey!.messageId!));
    expect(cardMessage!.bodyText).not.toContain('http');
    expect(cardMessage!.meta).toMatchObject({
      csatSurveyId: expect.any(String),
      sendKind: 'feedback_template',
      card: { privacyUrl: 'https://shipblu.com/privacy', expiresInDays: 5 },
      labels: ['سيئة جدًا', 'سيئة', 'مقبولة', 'جيدة', 'ممتازة'],
    });

    expect((await surveysOf(buttons))[0]).toMatchObject({
      status: 'sent',
      delivery: 'meta_quick_reply',
      locale: 'en',
      tokenHash: null,
    });
    // Instagram has no card, and nothing carries its buttons past a day.
    expect((await surveysOf(late))[0]).toMatchObject({
      status: 'skipped',
      skipReason: 'window_closed',
    });

    const carriers = await db
      .select({ dedupeKey: jobs.dedupeKey })
      .from(jobs)
      .where(eq(jobs.type, 'send_meta'));
    expect(carriers).toHaveLength(2);
  });

  it('surveys Facebook with rating buttons until there is a privacy link, and says why past them', async () => {
    await switchOn();
    const fresh = await resolvedTicket({ channel: 'facebook', customerText: 'where is it?' });
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000);
    const late = await resolvedTicket({ channel: 'facebook', lastWroteAt: threeDaysAgo });

    for (const id of [fresh, late]) await sendCsat(job(id));

    // Inside the 24 hours the buttons need no link.
    expect((await surveysOf(fresh))[0]).toMatchObject({
      status: 'sent',
      delivery: 'meta_quick_reply',
    });
    // Past them only the card would have gone, and it needs one.
    expect(await surveysOf(late)).toEqual([
      expect.objectContaining({ status: 'skipped', skipReason: 'no_privacy_url' }),
    ]);
  });

  it('counts a photo as the customer taking part', async () => {
    await switchOn();
    // What ingest stores for a photo sent without a caption: a label of ours,
    // which the language rule looks past but which is still the customer
    // writing in.
    const id = await resolvedTicket({ channel: 'webchat', customerText: '[image]' });

    await sendCsat(job(id));

    expect((await surveysOf(id))[0]).toMatchObject({
      status: 'sent',
      locale: 'en',
      // Drawn by the widget as a card; the message still carries the link,
      // so it still has a token.
      delivery: 'widget_card',
      tokenHash: expect.any(String),
    });
  });

  it('answers an agent who pressed "Send now" on a surveyed ticket, on the ticket', async () => {
    await switchOn();
    const id = await resolvedTicket({ channel: 'webchat' });

    await sendCsat(job(id));
    await sendCsat(job(id, 'manual'));

    const rows = await surveysOf(id);
    expect(rows.map((row) => row.status).sort()).toEqual(['sent', 'skipped']);
    expect(rows.find((row) => row.status === 'skipped')!.skipReason).toBe('recently_surveyed');
  });

  it('sends one survey when two jobs for one ticket run together, and writes nothing for the other', async () => {
    await switchOn();
    const id = await resolvedTicket({ channel: 'email', email: 'a@b.test' });

    await Promise.all([sendCsat(job(id)), sendCsat(job(id)), sendCsat(job(id))]);

    const rows = await surveysOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('sent');
    expect(await carrierJobs()).toHaveLength(1);
    expect(await eventTypes(id)).toEqual(['csat_sent']);
  });

  it('surveys the ticket again only after the window, retiring the unanswered one', async () => {
    await switchOn({ resurveyAfterDays: 14 });
    const id = await resolvedTicket({ channel: 'webchat' });

    await sendCsat(job(id));
    await sendCsat(job(id));
    expect(await surveysOf(id)).toHaveLength(1);

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

  it('commits the carrier with the survey, so no run can leave one without the other', async () => {
    await switchOn();
    const id = await resolvedTicket({ channel: 'email', email: 'a@b.test' });
    const send = (body: Parameters<typeof sendSurvey>[0]['body']) =>
      sendSurvey({
        conversationId: id,
        locale: 'en',
        delivery: 'email_link',
        snapshot: { agentId: null, groupId: null, channel: 'email' },
        resurveyAfterDays: 14,
        ruleId: null,
        requesterEmail: 'a@b.test',
        body,
      });

    // A run that dies inside the transaction leaves nothing: no survey, no
    // message, no job for a worker to pick up.
    await expect(
      send(() => {
        throw new Error('the worker went away');
      }),
    ).rejects.toThrow('the worker went away');
    expect(await surveysOf(id)).toEqual([]);
    expect(await carrierJobs()).toEqual([]);

    // One that commits has its carrier already, with nothing queued after.
    const sent = await send((url) => ({ text: url ?? '', html: null }));
    if (sent.kind !== 'sent') throw new Error(`no survey: ${sent.kind}`);
    expect(await carrierJobs()).toEqual([
      { type: 'send_email', dedupeKey: `send:${sent.messageId}` },
    ]);
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
    // Who resolved is read off the row: a rule leaves `resolved_by_agent_id`
    // null, an agent writes their id. The trigger on the job says nothing.
    const byRule = await resolvedTicket({ channel: 'email', email: 'a@b.test' });
    const byAgent = await resolvedTicket({ channel: 'email', email: 'a@b.test' });
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.email, 'admin@shipblu.test'));
    await db
      .update(conversations)
      .set({ resolvedByAgentId: agent!.id })
      .where(eq(conversations.id, byAgent));
    const chat = await resolvedTicket({ channel: 'webchat' });

    await sendCsat(job(suppressed));
    await sendCsat(job(byRule, 'agent'));
    await sendCsat(job(byAgent, 'rule'));
    await sendCsat(job(chat));

    expect((await surveysOf(suppressed))[0]).toMatchObject({ skipReason: 'agent_suppressed' });
    expect((await surveysOf(byRule))[0]).toMatchObject({ skipReason: 'rule_resolved' });
    expect((await surveysOf(byAgent))[0]).toMatchObject({ status: 'sent' });
    expect((await surveysOf(chat))[0]).toMatchObject({ skipReason: 'channel_off' });
  });

  it('queues nothing while the switch is off, and the delay the admin set when on', async () => {
    const id = await resolvedTicket({ channel: 'email', email: 'a@b.test' });
    expect(await scheduleSurvey(id, 'agent')).toBe('off');
    expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);

    // On, but the channel is off, or has no switch at all: no job either.
    await switchOn({
      delayMinutes: 45,
      channels: { ...UNSET_CSAT_SETTINGS.channels, webchat: true },
    });
    expect(await scheduleSurvey(id, 'agent')).toBe('channel_off');
    expect(await scheduleSurvey(await resolvedTicket({ channel: 'whatsapp' }), 'agent')).toBe(
      'channel_unsupported',
    );
    expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);

    await db.delete(agents);
    await switchOn({ delayMinutes: 45 });
    const before = Date.now();
    expect(await scheduleSurvey(id, 'agent')).toBe('queued');
    expect(await scheduleSurvey(id, 'manual')).toBe('queued');

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

  it('answers every "Send now" on the ticket, where a scheduled repeat folds into the earlier row', async () => {
    await switchOn();
    const id = await resolvedTicket({ channel: 'email', email: null });

    await sendCsat(job(id));
    await sendCsat(job(id));
    expect(await surveysOf(id)).toHaveLength(1);

    // The sidebar clears its "queued" line when a new decision lands; the same
    // reason folded into the earlier row would leave it up for good.
    const pressedOn = (await ticketSurveyState(id, 'email')).latestId;
    // And the open ticket hears that it landed: neither row a skip writes
    // notifies, so the skip touches the conversation, whose trigger does.
    const updatedAt = async () => {
      const [row] = await db
        .select({ at: conversations.updatedAt })
        .from(conversations)
        .where(eq(conversations.id, id));
      return row!.at.getTime();
    };
    const before = await updatedAt();

    await sendCsat(job(id, 'manual'));

    expect((await ticketSurveyState(id, 'email')).latestId).not.toBe(pressedOn);
    expect(await updatedAt()).toBeGreaterThan(before);

    await sendCsat(job(id, 'manual'));
    const rows = await surveysOf(id);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.skipReason === 'no_address')).toBe(true);
  });

  it('reads who resolved the ticket off its timeline, not off a column a direct close leaves empty', async () => {
    await switchOn({ surveyRuleResolved: false });
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.email, 'admin@shipblu.test'));
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const statusEvent = (
      conversationId: string,
      category: string,
      by: 'agent' | 'rule',
      createdAt: Date,
    ) => ({
      conversationId,
      type: 'status_changed',
      ...(by === 'agent'
        ? { actorAgentId: agent!.id }
        : { actorLabel: 'automation:Close thanks-only tickets' }),
      data: { category },
      createdAt,
    });

    // An agent closed it straight from Open: `resolved_by_agent_id` is never
    // stamped, which read as a rule's resolve when the column alone answered.
    // The fallback's status check answers this one too; the next is the case
    // only the timeline can.
    const closedByAgent = await resolvedTicket({
      channel: 'email',
      email: 'a@b.test',
      status: 'Closed',
    });
    // A rule closed it straight from Open: the fallback reads a closed ticket
    // as an agent's, so only a `closed` move on the timeline says rule.
    const closedByRule = await resolvedTicket({
      channel: 'email',
      email: 'e@b.test',
      status: 'Closed',
    });
    // An agent resolved it and the three-day rule closed it: still the agent's.
    const autoClosed = await resolvedTicket({
      channel: 'email',
      email: 'b@b.test',
      status: 'Closed',
    });
    // A rule resolved it, it was reopened, and an agent resolved it again.
    const reResolved = await resolvedTicket({ channel: 'email', email: 'c@b.test' });
    // A rule resolved it, an agent moved it back to Open or Pending — a status
    // change, no `reopened` event — and resolved it. The rule's resolve is
    // the older stretch's; the column, null, would say rule.
    const backToOpen = await resolvedTicket({ channel: 'email', email: 'f@b.test' });
    const backToPending = await resolvedTicket({ channel: 'email', email: 'g@b.test' });
    // A rule resolved it, and nothing since.
    const byRule = await resolvedTicket({ channel: 'email', email: 'd@b.test' });
    // A rule resolved it and an agent resolved it again, with no open between
    // — "reply and resolve" on it, or another resolved status. The agent's.
    const agentReResolved = await resolvedTicket({ channel: 'email', email: 'h@b.test' });
    // A rule resolved it and an agent closed it: closing is not resolving, so
    // still the rule's.
    const ruleThenAgentClose = await resolvedTicket({
      channel: 'email',
      email: 'i@b.test',
      status: 'Closed',
    });

    await db
      .insert(conversationEvents)
      .values([
        statusEvent(closedByAgent, 'closed', 'agent', at(10)),
        statusEvent(closedByRule, 'closed', 'rule', at(10)),
        statusEvent(autoClosed, 'resolved', 'agent', at(60)),
        statusEvent(autoClosed, 'closed', 'rule', at(10)),
        statusEvent(reResolved, 'resolved', 'rule', at(60)),
        { conversationId: reResolved, type: 'reopened', data: {}, createdAt: at(30) },
        statusEvent(reResolved, 'resolved', 'agent', at(10)),
        statusEvent(backToOpen, 'resolved', 'rule', at(60)),
        statusEvent(backToOpen, 'open', 'agent', at(30)),
        statusEvent(backToOpen, 'resolved', 'agent', at(10)),
        statusEvent(backToPending, 'resolved', 'rule', at(60)),
        statusEvent(backToPending, 'pending', 'agent', at(30)),
        statusEvent(backToPending, 'resolved', 'agent', at(10)),
        statusEvent(byRule, 'resolved', 'rule', at(10)),
        statusEvent(agentReResolved, 'resolved', 'rule', at(60)),
        statusEvent(agentReResolved, 'resolved', 'agent', at(10)),
        statusEvent(ruleThenAgentClose, 'resolved', 'rule', at(60)),
        statusEvent(ruleThenAgentClose, 'closed', 'agent', at(10)),
      ]);

    for (const id of [
      closedByAgent,
      closedByRule,
      autoClosed,
      reResolved,
      backToOpen,
      backToPending,
      byRule,
      agentReResolved,
      ruleThenAgentClose,
    ]) {
      await sendCsat(job(id, 'manual'));
    }

    expect((await surveysOf(closedByAgent))[0]).toMatchObject({ status: 'sent' });
    expect((await surveysOf(closedByRule))[0]).toMatchObject({ skipReason: 'rule_resolved' });
    expect((await surveysOf(autoClosed))[0]).toMatchObject({ status: 'sent' });
    expect((await surveysOf(reResolved))[0]).toMatchObject({ status: 'sent' });
    expect((await surveysOf(backToOpen))[0]).toMatchObject({ status: 'sent' });
    expect((await surveysOf(backToPending))[0]).toMatchObject({ status: 'sent' });
    expect((await surveysOf(byRule))[0]).toMatchObject({ skipReason: 'rule_resolved' });
    expect((await surveysOf(agentReResolved))[0]).toMatchObject({ status: 'sent' });
    expect((await surveysOf(ruleThenAgentClose))[0]).toMatchObject({
      skipReason: 'rule_resolved',
    });
  });
});

describe('the sidebar', () => {
  it('says whether a survey could go out on the ticket\'s channel, so it offers "Send now" only there', async () => {
    const email = await resolvedTicket({ channel: 'email', email: 'a@b.test' });

    // A fresh install: surveys off.
    expect((await ticketSurveyState(email, 'email')).availability).toBe('off');
    expect((await ticketSurveyState(email, 'whatsapp')).availability).toBe('unsupported');
    // And the resolve that schedules a survey asks the same question: a
    // WhatsApp ticket is "not sent on this channel" to both, switch or no.
    const whatsapp = await resolvedTicket({ channel: 'whatsapp' });
    expect(await scheduleSurvey(whatsapp, 'agent')).toBe('channel_unsupported');
    expect(await scheduleSurvey(email, 'agent')).toBe('off');

    await switchOn({ channels: { ...UNSET_CSAT_SETTINGS.channels, email: true } });
    expect((await ticketSurveyState(email, 'email')).availability).toBe('on');
    // Portal rides email's switch.
    expect((await ticketSurveyState(email, 'portal')).availability).toBe('on');
    expect((await ticketSurveyState(email, 'webchat')).availability).toBe('channel_off');
    expect((await ticketSurveyState(email, 'whatsapp_bot')).availability).toBe('unsupported');
  });

  it('shows a skip only while it is the newest decision, and keys "queued" on that decision', async () => {
    await switchOn({ resurveyAfterDays: 14 });
    const id = await resolvedTicket({ channel: 'email', email: 'a@b.test' });

    // Answered three weeks ago, outside the window; since then the ticket was
    // reopened and resolved again, and the customer wrote back inside the
    // delay.
    await sendCsat(job(id));
    const longAgo = new Date(Date.now() - 21 * 24 * 3_600_000);
    await db
      .update(csatSurveys)
      .set({
        status: 'answered',
        rating: 4,
        respondedAt: longAgo,
        sentAt: longAgo,
        createdAt: longAgo,
      })
      .where(eq(csatSurveys.conversationId, id));
    await db.insert(csatSurveys).values({
      conversationId: id,
      status: 'skipped',
      skipReason: 'reopened',
      channel: 'email',
      createdAt: new Date(Date.now() - 3_600_000),
    });

    const pressed = await ticketSurveyState(id, 'email');
    expect(pressed.survey?.status).toBe('answered');
    expect(pressed.skip?.reason).toBe('reopened');
    expect(pressed.newer).toBeNull();

    // "Send now": a survey goes out under the old rating.
    await sendCsat(job(id, 'manual'));

    const [sent] = await db
      .select({ id: csatSurveys.id })
      .from(csatSurveys)
      .where(and(eq(csatSurveys.conversationId, id), eq(csatSurveys.status, 'sent')));
    const after = await ticketSurveyState(id, 'email');
    // The rating stays on screen; the skip the new survey answered does not,
    // and the "queued" line — keyed on the decision before — clears.
    expect(after.survey?.status).toBe('answered');
    expect(after.skip).toBeNull();
    expect(after.latestId).toBe(sent!.id);
    expect(after.latestId).not.toBe(pressed.latestId);
    // And the new survey says it went, under the rating it sits beneath.
    expect(after.newer).toEqual({ sentAt: expect.any(Date) });
  });
});
