import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversations,
  messages,
  metricsDaily,
  rollupDays,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { systemHealth, todayByHour } from './live';
import { lastWholeDay } from './queries';

/**
 * The live report's hourly volume, the one figure on it counted from messages
 * rather than tickets — so the one that has to say for itself which rows are
 * traffic.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const NOW = DateTime.fromISO('2026-10-13T12:30', { zone: ZONE });

async function ticket(channel: 'whatsapp' | 'email'): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('todayByHour', () => {
  it('counts what was said, from either side, and neither side’s reactions', async () => {
    const chat = await ticket('whatsapp');
    const mail = await ticket('email');
    const at = (time: string) => DateTime.fromISO(`2026-10-13T${time}`, { zone: ZONE }).toJSDate();

    await db.insert(messages).values([
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: 'فين شحنتي؟',
        meta: { whatsappType: 'text' },
        createdAt: at('11:05'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: 'On its way',
        meta: { sendKind: 'text' },
        createdAt: at('11:10'),
      },
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: at('11:12'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: '[reacted ❤️]',
        meta: { whatsappType: 'reaction', echo: true, echoSource: 'business_app' },
        createdAt: at('11:15'),
      },
      // No `whatsappType` at all, as on every email: still traffic.
      { conversationId: mail, direction: 'inbound', bodyText: 'Refund?', createdAt: at('11:20') },
    ]);

    const hours = await todayByHour(ZONE, NOW.toJSDate());

    expect(hours.find((bucket) => bucket.hour === 11)).toEqual({
      hour: 11,
      inbound: 2,
      outbound: 1,
    });
  });
});

/**
 * The health card's rollup tile: how far the rollup has reached, which a
 * supervisor reads to see whether it has stopped. Read on Monday the 19th;
 * the nightly run is 00:00 UTC, 03:00 in Cairo that week.
 */
describe('systemHealth', () => {
  const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();
  const MONDAY_NOON = at('2026-10-19T12:00');

  it('names the newest day the rollup computed whole, worked or not, as the satisfaction report does', async () => {
    // Thursday the 15th was the last day anybody worked. Last night's run
    // computed the 16th to the 18th and wrote no figures for them, and a hand
    // run this morning over today, a day still going, wrote figures for it.
    await db.insert(metricsDaily).values([
      { day: '2026-10-15', ticketsCreated: 2, computedAt: at('2026-10-18T03:00:21') },
      { day: '2026-10-19', ticketsCreated: 1, computedAt: at('2026-10-19T10:00:01') },
    ]);
    await db.insert(rollupDays).values([
      { day: '2026-10-15', computedAt: at('2026-10-18T03:00:20') },
      { day: '2026-10-16', computedAt: at('2026-10-19T03:00:10') },
      { day: '2026-10-17', computedAt: at('2026-10-19T03:00:05') },
      { day: '2026-10-18', computedAt: at('2026-10-19T03:00:00') },
      { day: '2026-10-19', computedAt: at('2026-10-19T10:00:00') },
    ]);

    const health = await systemHealth(ZONE, MONDAY_NOON);

    expect(health.rollupDay).toBe('2026-10-18');
    expect(health.rollupComputedAt).toEqual(at('2026-10-19T03:00:00'));
    expect(health.rollupDaysBehind).toBe(0);
    expect(health.rollupDay).toBe(
      await lastWholeDay({ from: '2026-09-20', to: '2026-10-19', zone: ZONE }),
    );
  });

  it('does not count a day computed while it was still going, though it is over now', async () => {
    // Sunday's run reached Saturday the 17th. Somebody ran Sunday by hand
    // that evening, and last night's run did not happen.
    await db.insert(rollupDays).values([
      { day: '2026-10-17', computedAt: at('2026-10-18T03:00:00') },
      { day: '2026-10-18', computedAt: at('2026-10-18T18:00:00') },
    ]);

    const health = await systemHealth(ZONE, MONDAY_NOON);

    expect(health.rollupDay).toBe('2026-10-17');
    expect(health.rollupComputedAt).toEqual(at('2026-10-18T03:00:00'));
    // A night missed, and still no further behind than before tonight's run,
    // as `/reports/csat` counts it: the tile turns amber at the next midnight.
    expect(health.rollupDaysBehind).toBe(1);
  });

  it('counts the days a stalled rollup has not reached', async () => {
    // Saturday's run reached Friday the 16th. Sunday's run and last night's
    // did not happen, so neither the 17th nor the 18th has been computed.
    await db.insert(rollupDays).values([
      { day: '2026-10-15', computedAt: at('2026-10-17T03:00:05') },
      { day: '2026-10-16', computedAt: at('2026-10-17T03:00:00') },
    ]);

    const health = await systemHealth(ZONE, MONDAY_NOON);

    expect(health.rollupDay).toBe('2026-10-16');
    expect(health.rollupDaysBehind).toBe(2);
  });

  it('reads the newest figures before today while rollup_days is empty', async () => {
    // Between the deploy whose migration creates the table and the first
    // nightly run to write it: the last day with figures, and when they were
    // written. Not the 14th, rebuilt by hand on Sunday afternoon after the
    // night's run wrote the 15th, nor today, rebuilt by hand this morning.
    await db.insert(metricsDaily).values([
      { day: '2026-10-14', ticketsCreated: 3, computedAt: at('2026-10-18T15:00:00') },
      { day: '2026-10-15', ticketsCreated: 2, computedAt: at('2026-10-18T03:00:21') },
      { day: '2026-10-19', ticketsCreated: 1, computedAt: at('2026-10-19T10:00:01') },
    ]);

    const health = await systemHealth(ZONE, MONDAY_NOON);

    expect(health.rollupDay).toBe('2026-10-15');
    expect(health.rollupComputedAt).toEqual(at('2026-10-18T03:00:21'));
    // Three days back, but whether they were missed or quiet is not
    // something `metrics_daily` can say.
    expect(health.rollupDaysBehind).toBeNull();
  });

  it('names no day before the rollup has computed one', async () => {
    const health = await systemHealth(ZONE, MONDAY_NOON);

    expect(health.rollupDay).toBeNull();
    expect(health.rollupComputedAt).toBeNull();
    expect(health.rollupDaysBehind).toBeNull();
  });
});
