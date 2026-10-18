import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  csatSurveys,
  groups,
  jobs,
  ticketStatuses,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { recordAnswer } from '@/lib/csat';
import { saveCsatSettings, UNSET_CSAT_SETTINGS } from '@/lib/csat/settings';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { notifyLowRating } from '@/worker/handlers/notify-low-rating';

/**
 * A low rating's alert against real Postgres: the answer queues it in its own
 * transaction, so it exists exactly once per low answer, and the job tells
 * each supervisor once however often it runs — or nobody, for a ticket the
 * report does not count or with the switch off — and says on the timeline
 * who it told.
 */

withCleanDatabase();

const saved = { ...process.env };

beforeEach(() => {
  process.env.APP_URL = 'https://support.example.test';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row.id;
}

/** A resolved email ticket with a survey out on it, as `sendSurvey` leaves one. */
async function surveyed(
  input: { deleted?: boolean; spam?: boolean; agentId?: string; groupId?: string } = {},
) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: 'amira@example.test' })
    .returning({ id: contacts.id });
  const [ticket] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      subject: 'The courier threw my parcel over the gate',
      statusId: await statusId('Resolved'),
      requesterContactId: contact!.id,
      deletedAt: input.deleted ? new Date() : null,
      isSpam: input.spam ?? false,
    })
    .returning({ id: conversations.id, number: conversations.number });
  const [survey] = await db
    .insert(csatSurveys)
    .values({
      conversationId: ticket!.id,
      status: 'sent',
      channel: 'email',
      delivery: 'email_link',
      agentId: input.agentId ?? null,
      groupId: input.groupId ?? null,
      sentAt: new Date(),
    })
    .returning({ id: csatSurveys.id });
  return { conversationId: ticket!.id, number: ticket!.number, surveyId: survey!.id };
}

/** One agent of each kind the recipients' rule tells apart. */
async function team() {
  const rows = await db
    .insert(agents)
    .values([
      { name: 'Mona', email: 'mona@shipblu.test', role: 'supervisor', passwordHash: 'x' },
      { name: 'Omar', email: 'omar@shipblu.test', role: 'admin', passwordHash: 'x' },
      { name: 'Sara', email: 'sara@shipblu.test', role: 'agent', passwordHash: 'x' },
      // A supervisor who never set a password, and one who left.
      { name: 'Hana', email: 'hana@shipblu.test', role: 'supervisor', passwordHash: null },
      {
        name: 'Karim',
        email: 'karim@shipblu.test',
        role: 'supervisor',
        passwordHash: 'x',
        isActive: false,
      },
    ])
    .returning({ id: agents.id, name: agents.name });
  const by = Object.fromEntries(rows.map((row) => [row.name, row.id]));
  return { mona: by.Mona!, omar: by.Omar!, sara: by.Sara! };
}

async function alertJobs() {
  const rows = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.type, 'notify_low_rating'));
  return rows.map((row) => row.payload);
}

async function emails() {
  const rows = await db
    .select({ payload: jobs.payload, priority: jobs.priority })
    .from(jobs)
    .where(eq(jobs.type, 'send_notification_email'));
  return rows
    .map((row) => ({
      ...(row.payload as { to: string; subject: string; textBody: string; htmlBody: string }),
      priority: row.priority,
    }))
    .sort((a, b) => a.to.localeCompare(b.to));
}

async function events(conversationId: string, type: string) {
  return db
    .select({ data: conversationEvents.data, actorLabel: conversationEvents.actorLabel })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, type)),
    );
}

/**
 * Resolves once another session is waiting on a lock, so a test that holds one
 * proves the contention it means to rather than winning a race with a sleep.
 */
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

function job(surveyId: string): ClaimedJob {
  return { id: 'job-1', type: 'notify_low_rating', payload: { surveyId } } as unknown as ClaimedJob;
}

describe('recording a low rating', () => {
  it('queues one alert for a 1 or a 2, and none for a 3 or above', async () => {
    const one = await surveyed();
    const two = await surveyed();
    const three = await surveyed();
    const five = await surveyed();

    expect(await recordAnswer(one.surveyId, 1, null, 'page')).toBe('recorded');
    expect(await recordAnswer(two.surveyId, 2, null, 'widget')).toBe('recorded');
    expect(await recordAnswer(three.surveyId, 3, null, 'page')).toBe('recorded');
    expect(await recordAnswer(five.surveyId, 5, null, 'page')).toBe('recorded');

    expect(await alertJobs()).toEqual(
      expect.arrayContaining([{ surveyId: one.surveyId }, { surveyId: two.surveyId }]),
    );
    expect(await alertJobs()).toHaveLength(2);
  });

  it('queues nothing more for a second tap, the comment after it, or a later answer', async () => {
    const ticket = await surveyed();

    expect(await recordAnswer(ticket.surveyId, 1, null, 'page')).toBe('recorded');
    // A forwarded link, or the same customer tapping again: first answer wins.
    expect(await recordAnswer(ticket.surveyId, 2, null, 'page')).toBe('ignored');
    expect(await recordAnswer(ticket.surveyId, 1, 'It never came.', 'page')).toBe('comment_added');
    expect(await recordAnswer(ticket.surveyId, 1, 'And again.', 'page')).toBe('ignored');

    expect(await alertJobs()).toEqual([{ surveyId: ticket.surveyId }]);
    expect(await events(ticket.conversationId, 'csat_received')).toHaveLength(1);
  });

  it('records one of two answers arriving at once, and queues one alert for it', async () => {
    const ticket = await surveyed();

    const outcomes = await Promise.all([
      recordAnswer(ticket.surveyId, 1, null, 'page'),
      recordAnswer(ticket.surveyId, 2, null, 'widget'),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'recorded')).toHaveLength(1);
    expect(await alertJobs()).toEqual([{ surveyId: ticket.surveyId }]);
    expect(await events(ticket.conversationId, 'csat_received')).toHaveLength(1);
  });

  it('waits for a send superseding the survey, rather than deadlocking against it', async () => {
    const ticket = await surveyed();

    // `sendSurvey`'s order: the ticket's lock, then the ticket's older surveys.
    // An answer that took the survey's row first and the ticket's second (the
    // event's foreign key) would hold what this needs while needing what it
    // holds, and Postgres would abort one of the two.
    let answered: Promise<string> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, ticket.conversationId))
        .for('update');
      answered = recordAnswer(ticket.surveyId, 1, null, 'page');
      // Until the answer is waiting on a lock — the ticket's, or with the order
      // reversed the event's foreign key after the survey's row — so the
      // supersede below contends with it rather than finishing first.
      await untilSomebodyWaits();
      await tx
        .update(csatSurveys)
        .set({ status: 'expired' })
        .where(eq(csatSurveys.id, ticket.surveyId));
    });

    // A superseded link still takes its answer, once the send has committed.
    expect(await answered).toBe('recorded');
    expect(await alertJobs()).toEqual([{ surveyId: ticket.surveyId }]);
  });

  it('adds the comment after the rating without waiting on the ticket', async () => {
    // The normal second request, and a tap delivered twice: neither can record
    // a rating, so neither queues behind whatever holds the ticket's row.
    const ticket = await surveyed();
    await recordAnswer(ticket.surveyId, 4, null, 'page');

    let outcome: string | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, ticket.conversationId))
        .for('update');
      outcome = await Promise.race([
        recordAnswer(ticket.surveyId, 4, 'Quick, thanks.', 'page'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waited on the ticket'), 2000)),
      ]);
    });

    expect(outcome).toBe('comment_added');
  });

  it('ignores a survey that does not exist, without a transaction to roll back', async () => {
    expect(await recordAnswer('00000000-0000-0000-0000-000000000000', 1, null, 'page')).toBe(
      'ignored',
    );
    expect(await alertJobs()).toEqual([]);
  });
});

describe('notify_low_rating', () => {
  it('emails each supervisor once, with a link and without the customer’s words', async () => {
    const { mona, omar, sara } = await team();
    // A supervisor kept on the report but taken off its people (`report.agents`).
    const [lina] = await db
      .insert(agents)
      .values({
        name: 'Lina',
        email: 'lina@shipblu.test',
        role: 'supervisor',
        passwordHash: 'x',
        permissions: { 'report.agents': false },
      })
      .returning({ id: agents.id });
    const [group] = await db
      .insert(groups)
      .values({ name: 'Returns desk' })
      .returning({ id: groups.id });
    const ticket = await surveyed({ agentId: sara, groupId: group!.id });
    await recordAnswer(ticket.surveyId, 1, 'The courier threw it over the gate.', 'page');

    await notifyLowRating(job(ticket.surveyId));

    const [event, ...more] = await events(ticket.conversationId, 'csat_low_rating');
    expect(more).toEqual([]);
    expect(event!.actorLabel).toBe('csat');
    expect(event!.data).toEqual({
      surveyId: ticket.surveyId,
      rating: 1,
      agentIds: expect.arrayContaining([mona, omar, lina!.id]),
    });
    expect(event!.data.agentIds).toHaveLength(3);

    const sent = await emails();
    expect(sent.map((email) => email.to)).toEqual([
      'lina@shipblu.test',
      'mona@shipblu.test',
      'omar@shipblu.test',
    ]);
    for (const email of sent) {
      expect(email.subject).toBe(`Ticket #${ticket.number} was rated 1 / 5`);
      expect(email.textBody).toContain(`https://support.example.test/inbox/${ticket.number}`);
      expect(email.textBody).toContain('Group: Returns desk');
      expect(email.priority).toBe(60);
      for (const body of [email.subject, email.textBody, email.htmlBody]) {
        expect(body).not.toContain('courier');
      }
    }
    // The agent beside the score, only where the report would draw it.
    const [toLina, toMona, toOmar] = sent;
    expect(toMona!.textBody).toContain('Agent: Sara');
    expect(toOmar!.textBody).toContain('Agent: Sara');
    for (const body of [toLina!.textBody, toLina!.htmlBody]) {
      expect(body).not.toContain('Sara');
    }
  });

  it('tells nobody about a ticket marked spam while it waited for the ticket', async () => {
    await team();
    const ticket = await surveyed();
    await recordAnswer(ticket.surveyId, 1, null, 'page');

    // The first read finds a counted ticket; the spam mark commits while the
    // job waits for the ticket's lock, and the read under it must see it.
    let ran: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, ticket.conversationId))
        .for('update');
      ran = notifyLowRating(job(ticket.surveyId));
      // Until the job has made its first read and is waiting for the ticket.
      await untilSomebodyWaits();
      await tx
        .update(conversations)
        .set({ isSpam: true })
        .where(eq(conversations.id, ticket.conversationId));
    });
    await ran;

    expect(await events(ticket.conversationId, 'csat_low_rating')).toEqual([]);
    expect(await emails()).toEqual([]);
  });

  it('names and links the ticket a merged one went into, which is the one a supervisor can open', async () => {
    await team();
    const merged = await surveyed();
    const survivor = await surveyed();
    await db
      .update(conversations)
      .set({ mergedIntoId: survivor.conversationId })
      .where(eq(conversations.id, merged.conversationId));
    await recordAnswer(merged.surveyId, 1, null, 'page');

    await notifyLowRating(job(merged.surveyId));

    for (const email of await emails()) {
      expect(email.subject).toBe(`Ticket #${survivor.number} was rated 1 / 5`);
      expect(email.textBody).toContain(`https://support.example.test/inbox/${survivor.number}`);
      expect(email.textBody).not.toContain(`/inbox/${merged.number}`);
    }
    expect(await emails()).toHaveLength(2);
    // The event stays on the ticket the customer rated, beside its rating.
    expect(await events(merged.conversationId, 'csat_low_rating')).toHaveLength(1);
  });

  it('tells nobody twice, run again or twice at once', async () => {
    await team();
    const ticket = await surveyed();
    await recordAnswer(ticket.surveyId, 2, null, 'page');

    await Promise.all([
      notifyLowRating(job(ticket.surveyId)),
      notifyLowRating(job(ticket.surveyId)),
    ]);
    await notifyLowRating(job(ticket.surveyId));

    expect(await events(ticket.conversationId, 'csat_low_rating')).toHaveLength(1);
    expect(await emails()).toHaveLength(2);
  });

  it('says so on the ticket when there is nobody to tell', async () => {
    // Only an agent, who cannot see the report.
    await db
      .insert(agents)
      .values({ name: 'Sara', email: 'sara@shipblu.test', role: 'agent', passwordHash: 'x' });
    const ticket = await surveyed();
    await recordAnswer(ticket.surveyId, 1, null, 'page');

    await notifyLowRating(job(ticket.surveyId));

    const [event] = await events(ticket.conversationId, 'csat_low_rating');
    expect(event!.data).toEqual({ surveyId: ticket.surveyId, rating: 1, agentIds: [] });
    expect(await emails()).toEqual([]);
  });

  it('tells nobody about a ticket since deleted or marked spam', async () => {
    await team();
    for (const ticket of [await surveyed({ deleted: true }), await surveyed({ spam: true })]) {
      await recordAnswer(ticket.surveyId, 1, null, 'page');
      await notifyLowRating(job(ticket.surveyId));
      expect(await events(ticket.conversationId, 'csat_low_rating')).toEqual([]);
    }
    expect(await emails()).toEqual([]);
  });

  it('tells nobody with the switch off, including about an answer queued before it went off', async () => {
    const { mona } = await team();
    const ticket = await surveyed();
    await recordAnswer(ticket.surveyId, 1, null, 'page');
    await saveCsatSettings({ ...UNSET_CSAT_SETTINGS, lowRatingAlerts: false }, mona);

    await notifyLowRating(job(ticket.surveyId));

    expect(await events(ticket.conversationId, 'csat_low_rating')).toEqual([]);
    expect(await emails()).toEqual([]);
  });

  it('tells nobody about an answer that is not low, or a survey nobody answered', async () => {
    await team();
    const four = await surveyed();
    await recordAnswer(four.surveyId, 4, null, 'page');
    const unanswered = await surveyed();

    // Only by hand: `recordAnswer` queues neither.
    await notifyLowRating(job(four.surveyId));
    await notifyLowRating(job(unanswered.surveyId));

    expect(await events(four.conversationId, 'csat_low_rating')).toEqual([]);
    expect(await events(unanswered.conversationId, 'csat_low_rating')).toEqual([]);
    expect(await emails()).toEqual([]);
  });

  // A purge that lands after the job is claimed, or a wrong id typed by hand:
  // dead on its first attempt, naming the survey, rather than a quiet success.
  it('fails at once, naming the survey, when the survey is gone', async () => {
    await team();
    const missing = '00000000-0000-0000-0000-000000000000';

    const failure = notifyLowRating(job(missing));

    await expect(failure).rejects.toBeInstanceOf(PermanentJobError);
    await expect(failure).rejects.toThrow(missing);
    expect(await emails()).toEqual([]);
  });
});
