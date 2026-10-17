import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, csatSurveys, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { latestComments, liveSurveys, skipReasons, type ReportWindow } from './csat-queries';

/**
 * The satisfaction report's live reads, against real Postgres: each keys a
 * survey on the timestamp the rollup does, on the team's days rather than the
 * database's, and counts only the conversations the rollup counts.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();
const WINDOW: ReportWindow = { from: '2026-10-11', to: '2026-10-13', zone: ZONE };

type Channel = (typeof conversations.$inferInsert)['channel'];

async function ticket(channel: Channel = 'email'): Promise<{ id: string; number: number }> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [resolved] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Resolved'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: resolved!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id, number: conversations.number });
  return row!;
}

async function survey(row: Partial<typeof csatSurveys.$inferInsert>, channel?: Channel) {
  const { id, number } = await ticket(channel);
  await db.insert(csatSurveys).values({ conversationId: id, ...row });
  return number;
}

describe('skipReasons', () => {
  it('counts the window’s skips by reason, on the team’s days, most common first', async () => {
    const skipped = (reason: string, local: string, channel?: Channel) =>
      survey({ status: 'skipped', skipReason: reason, createdAt: at(local) }, channel);

    await skipped('window_closed', '2026-10-11T00:05');
    await skipped('window_closed', '2026-10-13T23:55');
    await skipped('agent_suppressed', '2026-10-12T12:00');
    // Five minutes before the window's first Cairo midnight, and five after
    // its last: both outside, although in UTC the second is still the 13th
    // (and the first counted one above, 21:05 UTC, still the 10th).
    await skipped('reopened', '2026-10-10T23:55');
    await skipped('reopened', '2026-10-14T00:05');
    // The bot's, which the rollup never counts either.
    await skipped('read_only_channel', '2026-10-12T12:00', 'whatsapp_bot');
    // Sent, not skipped.
    await survey({ status: 'sent', sentAt: at('2026-10-12T12:00') });

    expect(await skipReasons(WINDOW)).toEqual([
      {
        reason: 'window_closed',
        label: 'the messaging window had closed',
        count: 2,
      },
      {
        reason: 'agent_suppressed',
        label: 'an agent asked that this ticket not be surveyed',
        count: 1,
      },
    ]);
  });
});

describe('latestComments', () => {
  it('lists the window’s answers that came with words, newest first, with who they were about', async () => {
    const [mona] = await db
      .insert(agents)
      .values({ name: 'Mona', email: 'mona@shipblu.test', role: 'agent' })
      .returning({ id: agents.id });

    const older = await survey({
      status: 'answered',
      channel: 'webchat',
      agentId: mona!.id,
      rating: 2,
      comment: 'The courier never called.',
      respondedAt: at('2026-10-11T09:00'),
    });
    const newer = await survey({
      status: 'answered',
      channel: 'instagram',
      rating: 5,
      comment: 'تمام، شكرًا',
      respondedAt: at('2026-10-13T21:00'),
    });
    // A rating alone (a blank comment is stored as null by `recordAnswer`), an
    // answer outside the window and the bot's: none of them is a comment in it.
    await survey({ status: 'answered', rating: 4, respondedAt: at('2026-10-12T10:00') });
    await survey({
      status: 'answered',
      rating: 1,
      comment: 'Too late',
      respondedAt: at('2026-10-14T00:05'),
    });
    await survey(
      { status: 'answered', rating: 1, comment: 'bot', respondedAt: at('2026-10-12T10:00') },
      'whatsapp_bot',
    );

    const comments = await latestComments(WINDOW);
    expect(
      comments.map(({ number, rating, comment, channel, agent }) => ({
        number,
        rating,
        comment,
        channel,
        agent,
      })),
    ).toEqual([
      { number: newer, rating: 5, comment: 'تمام، شكرًا', channel: 'instagram', agent: null },
      {
        number: older,
        rating: 2,
        comment: 'The courier never called.',
        channel: 'webchat',
        agent: 'Mona',
      },
    ]);
    expect(comments[0]!.respondedAt).toEqual(at('2026-10-13T21:00'));
  });

  it('files a comment under the survey’s own channel, and the ticket’s only where it has none', async () => {
    await survey(
      {
        status: 'answered',
        channel: null,
        rating: 4,
        comment: 'ok',
        respondedAt: at('2026-10-12T10:00'),
      },
      'facebook',
    );
    expect((await latestComments(WINDOW)).map((row) => row.channel)).toEqual(['facebook']);
  });
});

describe('liveSurveys', () => {
  it('counts each day’s sends and decisions against as the rollup keys them, and the first send ever', async () => {
    await survey({ status: 'answered', sentAt: at('2026-10-11T00:05'), rating: 5 });
    await survey({ status: 'expired', sentAt: at('2026-10-12T12:00') });
    await survey({ status: 'sent', sentAt: at('2026-10-13T23:55') });
    await survey({ status: 'skipped', skipReason: 'reopened', createdAt: at('2026-10-12T12:00') });
    await survey({ status: 'skipped', skipReason: 'reopened', createdAt: at('2026-10-12T13:00') });
    // A survey written on the 10th and sent on the 11th is a send on the 11th
    // and nothing on the 10th.
    await survey({
      status: 'sent',
      createdAt: at('2026-10-10T22:00'),
      sentAt: at('2026-10-11T09:00'),
    });
    // Before the window, which is also the first send ever; a skip just past
    // its end; and the bot's, which is nobody's.
    await survey({ status: 'sent', sentAt: at('2026-10-02T08:00') });
    await survey({ status: 'skipped', skipReason: 'reopened', createdAt: at('2026-10-14T00:05') });
    await survey({ status: 'sent', sentAt: at('2026-09-01T08:00') }, 'whatsapp_bot');

    expect(await liveSurveys(WINDOW)).toEqual({
      days: [
        { day: '2026-10-11', sent: 2, skipped: 0 },
        { day: '2026-10-12', sent: 1, skipped: 2 },
        { day: '2026-10-13', sent: 1, skipped: 0 },
      ],
      first: '2026-10-02',
    });
  });

  it('files a day in the team’s zone, not the database’s', async () => {
    // 00:30 in Cairo on the 12th is still the 11th in UTC.
    await survey({ status: 'sent', sentAt: at('2026-10-12T00:30') });
    expect(await liveSurveys(WINDOW)).toEqual({
      days: [{ day: '2026-10-12', sent: 1, skipped: 0 }],
      first: '2026-10-12',
    });
  });

  it('reads an empty archive as no days and no first send', async () => {
    expect(await liveSurveys(WINDOW)).toEqual({ days: [], first: null });
  });
});
