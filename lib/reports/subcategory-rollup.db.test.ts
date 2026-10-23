import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversations,
  conversationSubcategories,
  ticketRootCauses,
  ticketStatuses,
  ticketSubcategories,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { reportingContext } from './rollup';
import { computeRootCauseDay, computeSubcategoryDay } from './subcategory-rollup';

/**
 * The two daily rollups the subcategory report reads, built from the renamed
 * `conversation_subcategories` and its join to `conversations`, against real
 * Postgres. Every statement here is a raw template, so a table or column that
 * no longer exists under the name it spells passes every static check; these
 * fixtures are the first thing to execute it.
 *
 * Each ticket says which day it belongs on and why. The day under test is
 * 13 October, in Cairo, which is UTC+3 until the end of the month.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();

type Ticket = Omit<Partial<typeof conversations.$inferInsert>, 'statusId' | 'rootCauseId'> & {
  status?: string;
  cause?: string;
};
type Assignment = Omit<
  Partial<typeof conversationSubcategories.$inferInsert>,
  'conversationId' | 'subcategoryId' | 'subcategoryKey'
> & { key: string };

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row.id;
}

async function subcategoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketSubcategories.id })
    .from(ticketSubcategories)
    .where(eq(ticketSubcategories.key, key));
  if (!row) throw new Error(`no subcategory ${key}`);
  return row.id;
}

async function causeId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketRootCauses.id })
    .from(ticketRootCauses)
    .where(eq(ticketRootCauses.key, key));
  if (!row) throw new Error(`no root cause ${key}`);
  return row.id;
}

/**
 * A ticket and the subcategories it carries. The frozen key is written from
 * the registry key, as `subcategoriseFromMessage` does, so the rollup's
 * `subcategory_key` and the join through `subcategory_id` name the same row.
 */
async function ticket(
  { status = 'Open', cause, ...values }: Ticket,
  assignments: Assignment[] = [],
): Promise<string> {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      ...values,
      statusId: await statusId(status),
      requesterContactId: contact!.id,
      rootCauseId: cause ? await causeId(cause) : null,
    })
    .returning({ id: conversations.id });

  for (const { key, ...assignment } of assignments) {
    await db.insert(conversationSubcategories).values({
      conversationId: row!.id,
      subcategoryId: await subcategoryId(key),
      subcategoryKey: key,
      ...assignment,
    });
  }
  return row!.id;
}

const primary = (key: string, assignment: Omit<Assignment, 'key'> = {}): Assignment => ({
  key,
  isPrimary: true,
  ...assignment,
});
const carried = (key: string, assignment: Omit<Assignment, 'key'> = {}): Assignment => ({
  key,
  ...assignment,
});
const suggested = { reviewState: 'suggested', confidence: 0.7 } as const;
const manual = { source: 'manual' } as const;

/** One day's subcategory rows, without the instant they were computed at. */
async function subcategoryDay(day: string) {
  const rows = await computeSubcategoryDay(day, await reportingContext());
  return rows
    .map((row) => ({
      day: row.day,
      key: row.subcategoryKey,
      area: row.area,
      channel: row.channel,
      primary: row.ticketsPrimary,
      any: row.ticketsAny,
      auto: row.assignedAuto,
      suggested: row.assignedSuggested,
      manual: row.assignedManual,
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.channel.localeCompare(b.channel));
}

async function causeDay(day: string) {
  const rows = await computeRootCauseDay(day, await reportingContext());
  return rows
    .map((row) => ({
      day: row.day,
      cause: row.causeKey,
      owner: row.owner,
      channel: row.channel,
      resolved: row.ticketsResolved,
    }))
    .sort((a, b) => a.cause.localeCompare(b.cause) || a.channel.localeCompare(b.channel));
}

const counts = (
  day: string,
  key: string,
  channel: string,
  given: { primary?: number; any: number; auto?: number; suggested?: number; manual?: number },
) => ({
  day,
  key,
  area: key.split('.')[0],
  channel,
  primary: given.primary ?? 0,
  any: given.any,
  auto: given.auto ?? 0,
  suggested: given.suggested ?? 0,
  manual: given.manual ?? 0,
});

describe('computeSubcategoryDay', () => {
  it('counts each subcategory per channel, primary apart from carried, banded by how it was made', async () => {
    expect((await reportingContext()).zone).toBe(ZONE);

    // Late and a refund on email: the late is the lead, filed without asking;
    // the refund is a suggestion nobody has looked at.
    await ticket({ createdAt: at('2026-10-13T10:00') }, [
      primary('delivery.late'),
      carried('payment.refund', suggested),
    ]);
    // Late again on email, filed by an agent.
    await ticket({ createdAt: at('2026-10-13T16:00') }, [primary('delivery.late', manual)]);
    // On WhatsApp the lead is the damage, and the late is a suggestion an agent
    // confirmed: it was filed as a suggestion, so it stays one.
    await ticket({ channel: 'whatsapp', createdAt: at('2026-10-13T09:00') }, [
      primary('condition.damaged'),
      carried('delivery.late', { reviewState: 'confirmed', confidence: 0.7 }),
    ]);
    // A late an agent threw out is the lexicon corrected, not demand; the
    // unreadable message beside it is still counted, under the fallback.
    await ticket({ channel: 'whatsapp', createdAt: at('2026-10-13T11:00') }, [
      carried('delivery.late', { reviewState: 'rejected', confidence: 0.55 }),
      carried('meta.unclassified', { confidence: 0 }),
    ]);
    // Deleted, and a copied history an agent labelled: neither is the day's
    // demand.
    await ticket({ createdAt: at('2026-10-13T12:00'), deletedAt: at('2026-10-14T09:00') }, [
      primary('delivery.late'),
    ]);
    await ticket(
      { channel: 'whatsapp', createdAt: at('2026-10-13T12:00'), sourceSystem: 'import' },
      [primary('delivery.late', manual)],
    );

    expect(await subcategoryDay('2026-10-13')).toEqual([
      counts('2026-10-13', 'condition.damaged', 'whatsapp', { primary: 1, any: 1, auto: 1 }),
      counts('2026-10-13', 'delivery.late', 'email', { primary: 2, any: 2, auto: 1, manual: 1 }),
      counts('2026-10-13', 'delivery.late', 'whatsapp', { any: 1, suggested: 1 }),
      counts('2026-10-13', 'meta.unclassified', 'whatsapp', { any: 1, auto: 1 }),
      counts('2026-10-13', 'payment.refund', 'email', { any: 1, suggested: 1 }),
    ]);
  });

  it('puts a ticket on the day it was created in the team’s zone, whenever it was labelled', async () => {
    // Half an hour before Cairo's midnight: the 13th, though UTC agrees.
    await ticket({ createdAt: at('2026-10-13T23:30') }, [primary('delivery.late')]);
    // Half an hour after it: the 14th, though it is still 21:30 on the 13th in UTC.
    await ticket({ createdAt: at('2026-10-14T00:30') }, [primary('delivery.late')]);
    // Arrived on the 12th and labelled on the 13th: demand is counted on arrival.
    await ticket({ createdAt: at('2026-10-12T10:00') }, [
      primary('pickup.schedule', { ...manual, firstSeenAt: at('2026-10-13T10:00') }),
    ]);

    expect(await subcategoryDay('2026-10-12')).toEqual([
      counts('2026-10-12', 'pickup.schedule', 'email', { primary: 1, any: 1, manual: 1 }),
    ]);
    expect(await subcategoryDay('2026-10-13')).toEqual([
      counts('2026-10-13', 'delivery.late', 'email', { primary: 1, any: 1, auto: 1 }),
    ]);
    expect(await subcategoryDay('2026-10-14')).toEqual([
      counts('2026-10-14', 'delivery.late', 'email', { primary: 1, any: 1, auto: 1 }),
    ]);
  });

  // Cairo leaves summer time at the end of Thursday 29 October 2026: the clock
  // reads 23:00 twice, so the day is 25 hours long. A fixed +03:00 would end it
  // at 21:00 UTC and move its last hour onto the 30th.
  it('keeps the repeated hour on the 25-hour day summer time ends', async () => {
    // 23:30 the second time round, at +02:00.
    await ticket({ createdAt: new Date('2026-10-29T21:30:00Z') }, [primary('delivery.late')]);
    // 00:30 on the 30th, at +02:00.
    await ticket({ createdAt: new Date('2026-10-29T22:30:00Z') }, [primary('return.status')]);

    expect(await subcategoryDay('2026-10-29')).toEqual([
      counts('2026-10-29', 'delivery.late', 'email', { primary: 1, any: 1, auto: 1 }),
    ]);
    expect(await subcategoryDay('2026-10-30')).toEqual([
      counts('2026-10-30', 'return.status', 'email', { primary: 1, any: 1, auto: 1 }),
    ]);
  });
});

describe('computeRootCauseDay', () => {
  it('counts each cause on the day it was worked out, per channel, with the owner it has', async () => {
    // Arrived on the 1st, resolved on the 13th: the cause belongs to the 13th.
    await ticket(
      {
        status: 'Resolved',
        createdAt: at('2026-10-01T10:00'),
        resolvedAt: at('2026-10-13T12:00'),
        cause: 'courier.late',
      },
      [primary('delivery.late')],
    );
    await ticket({
      status: 'Resolved',
      createdAt: at('2026-10-13T08:00'),
      resolvedAt: at('2026-10-13T18:00'),
      cause: 'courier.late',
    });
    await ticket({
      channel: 'whatsapp',
      status: 'Resolved',
      createdAt: at('2026-10-12T08:00'),
      resolvedAt: at('2026-10-13T09:00'),
      cause: 'courier.late',
    });
    // Closed straight from Open, so never resolved: dated by when its cause was set.
    await ticket({
      channel: 'whatsapp',
      status: 'Closed',
      createdAt: at('2026-10-10T08:00'),
      rootCauseSetAt: at('2026-10-13T15:00'),
      cause: 'merchant.bad_address',
    });
    // Resolved that day with no cause, and resolved with one but deleted since.
    await ticket({ status: 'Resolved', resolvedAt: at('2026-10-13T10:00') });
    await ticket({
      status: 'Resolved',
      resolvedAt: at('2026-10-13T10:00'),
      deletedAt: at('2026-10-14T10:00'),
      cause: 'hub.backlog',
    });

    expect(await causeDay('2026-10-13')).toEqual([
      { day: '2026-10-13', cause: 'courier.late', owner: 'courier', channel: 'email', resolved: 2 },
      {
        day: '2026-10-13',
        cause: 'courier.late',
        owner: 'courier',
        channel: 'whatsapp',
        resolved: 1,
      },
      {
        day: '2026-10-13',
        cause: 'merchant.bad_address',
        owner: 'merchant',
        channel: 'whatsapp',
        resolved: 1,
      },
    ]);
  });

  it('dates a cause by the resolve in the team’s zone, and the resolve over a later cause', async () => {
    // Half an hour after Cairo's midnight: the 14th, while UTC still says the 13th.
    await ticket({
      status: 'Resolved',
      resolvedAt: at('2026-10-14T00:30'),
      cause: 'courier.no_contact',
    });
    // Half an hour before it: the 13th.
    await ticket({
      status: 'Resolved',
      resolvedAt: at('2026-10-13T23:30'),
      cause: 'hub.missort',
    });
    // Resolved on the 12th and its cause filled in on the 13th: the resolve
    // keeps it on the 12th, so going back to fill one in does not move it.
    await ticket({
      status: 'Resolved',
      resolvedAt: at('2026-10-12T14:00'),
      rootCauseSetAt: at('2026-10-13T11:00'),
      cause: 'recipient.unavailable',
    });

    expect(await causeDay('2026-10-12')).toEqual([
      {
        day: '2026-10-12',
        cause: 'recipient.unavailable',
        owner: 'recipient',
        channel: 'email',
        resolved: 1,
      },
    ]);
    expect(await causeDay('2026-10-13')).toEqual([
      { day: '2026-10-13', cause: 'hub.missort', owner: 'hub', channel: 'email', resolved: 1 },
    ]);
    expect(await causeDay('2026-10-14')).toEqual([
      {
        day: '2026-10-14',
        cause: 'courier.no_contact',
        owner: 'courier',
        channel: 'email',
        resolved: 1,
      },
    ]);
  });
});
