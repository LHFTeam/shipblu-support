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

const ZONE = 'Africa/Cairo';
const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();

/** Half an hour into the 25th, Cairo time: inside the hour both days claimed. */
const AFTER_MIDNIGHT = at('2026-04-25T00:30');

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

describe('the day Cairo springs forward', () => {
  it('is 23 hours long, or nothing below tests the changeover', () => {
    const start = DateTime.fromISO('2026-04-24', { zone: ZONE });
    const next = DateTime.fromISO('2026-04-25', { zone: ZONE });
    expect(next.diff(start, 'hours').hours).toBe(23);
  });

  it('counts a category on the 25th only, for a ticket created just after its midnight', async () => {
    const conversationId = await ticket('Open', { createdAt: AFTER_MIDNIGHT });
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

    const context = await reportingContext();
    expect(context.zone).toBe(ZONE);

    expect(await computeCategoryDay('2026-04-24', context)).toEqual([]);
    expect(await computeCategoryDay('2026-04-25', context)).toMatchObject([
      { day: '2026-04-25', categoryKey: 'delivery.late', ticketsAny: 1, ticketsPrimary: 1 },
    ]);
  });

  it('counts a cause on the 25th only, for a ticket resolved just after its midnight', async () => {
    const [missort] = await db
      .select({ id: ticketRootCauses.id })
      .from(ticketRootCauses)
      .where(eq(ticketRootCauses.key, 'hub.missort'));
    await ticket('Resolved', {
      createdAt: at('2026-04-24T15:00'),
      resolvedAt: AFTER_MIDNIGHT,
      rootCauseId: missort!.id,
      rootCauseSetAt: AFTER_MIDNIGHT,
    });

    const context = await reportingContext();
    expect(context.zone).toBe(ZONE);

    expect(await computeRootCauseDay('2026-04-24', context)).toEqual([]);
    expect(await computeRootCauseDay('2026-04-25', context)).toMatchObject([
      { day: '2026-04-25', causeKey: 'hub.missort', owner: 'hub', ticketsResolved: 1 },
    ]);
  });
});
