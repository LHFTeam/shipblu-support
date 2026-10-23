import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversationCategories,
  conversations,
  ticketCategories,
  ticketRootCauses,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import { computeCategoryDay, computeRootCauseDay } from './category-rollup';
import { reportingContext } from './rollup';

/**
 * Which day the category and cause rollups count a ticket on, across the night
 * Cairo springs forward. Its clocks jump from 00:00 to 01:00 at the start of
 * Friday 24 April 2026, so the 24th opens at 01:00 and is 23 hours long. A day
 * ended at "its start plus a day" ends at 01:00 on the 25th, an hour after the
 * 25th began, and that hour was counted on both days.
 */

withCleanDatabase();

/** Half an hour into the 25th, Cairo time: inside the hour both days claimed. */
const AFTER_MIDNIGHT = cairo('2026-04-25T00:30');

async function ticket(
  status: string,
  row: Partial<typeof conversations.$inferInsert>,
): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [found] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, status));
  const [created] = await db
    .insert(conversations)
    .values({ channel: 'email', statusId: found!.id, requesterContactId: contact!.id, ...row })
    .returning({ id: conversations.id });
  return created!.id;
}

/** A ticket created at `createdAt` whose primary category is a late delivery. */
async function lateDelivery(createdAt: Date): Promise<void> {
  const conversationId = await ticket('Open', { createdAt });
  const [late] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, 'delivery.late'));
  await db.insert(conversationCategories).values({
    conversationId,
    categoryId: late!.id,
    categoryKey: 'delivery.late',
    isPrimary: true,
  });
}

/** A ticket resolved at `resolvedAt`, mis-sorted at the hub. */
async function missorted(resolvedAt: Date, createdAt: Date): Promise<void> {
  const [missort] = await db
    .select({ id: ticketRootCauses.id })
    .from(ticketRootCauses)
    .where(eq(ticketRootCauses.key, 'hub.missort'));
  await ticket('Resolved', {
    createdAt,
    resolvedAt,
    rootCauseId: missort!.id,
    rootCauseSetAt: resolvedAt,
  });
}

async function context() {
  const reporting = await reportingContext();
  expect(reporting.zone).toBe('Africa/Cairo');
  return reporting;
}

describe('the day Cairo springs forward', () => {
  // A missing midnight, not a 23-hour day: a spring-forward at 02:00 is 23 hours
  // too, and there the start plus a day was already the next day's start.
  it('has no midnight, or nothing below tests the changeover', () => {
    expect(DateTime.fromISO('2026-04-24', { zone: 'Africa/Cairo' }).hour).toBe(1);
  });

  it('counts a category on the 25th only, for a ticket created just after its midnight', async () => {
    await lateDelivery(AFTER_MIDNIGHT);
    const reporting = await context();

    expect(await computeCategoryDay('2026-04-24', reporting)).toEqual([]);
    expect(await computeCategoryDay('2026-04-25', reporting)).toMatchObject([
      { day: '2026-04-25', categoryKey: 'delivery.late', ticketsAny: 1, ticketsPrimary: 1 },
    ]);
  });

  it('counts a cause on the 25th only, for a ticket resolved just after its midnight', async () => {
    // Arrived on the 24th, so a cause counted by arrival rather than by
    // resolution would land there too.
    await missorted(AFTER_MIDNIGHT, cairo('2026-04-24T15:00'));
    const reporting = await context();

    expect(await computeRootCauseDay('2026-04-24', reporting)).toEqual([]);
    expect(await computeRootCauseDay('2026-04-25', reporting)).toMatchObject([
      { day: '2026-04-25', causeKey: 'hub.missort', owner: 'hub', ticketsResolved: 1 },
    ]);
  });

  // The fix moved the 24th's end; these hold both of its ends, so a correction
  // that overshot, ending the 24th early or opening it late, fails here.
  it("keeps the 24th's first and last hours on the 24th", async () => {
    const opening = cairo('2026-04-24T01:00');
    const lastHour = cairo('2026-04-24T23:30');
    await lateDelivery(opening);
    await lateDelivery(lastHour);
    await missorted(opening, cairo('2026-04-23T15:00'));
    await missorted(lastHour, cairo('2026-04-23T15:00'));
    const reporting = await context();

    for (const day of ['2026-04-23', '2026-04-25']) {
      expect(await computeCategoryDay(day, reporting)).toEqual([]);
      expect(await computeRootCauseDay(day, reporting)).toEqual([]);
    }
    expect(await computeCategoryDay('2026-04-24', reporting)).toMatchObject([
      { day: '2026-04-24', categoryKey: 'delivery.late', ticketsAny: 2 },
    ]);
    expect(await computeRootCauseDay('2026-04-24', reporting)).toMatchObject([
      { day: '2026-04-24', causeKey: 'hub.missort', ticketsResolved: 2 },
    ]);
  });
});
