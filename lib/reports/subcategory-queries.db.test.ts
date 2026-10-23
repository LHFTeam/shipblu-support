import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversations,
  conversationSubcategories,
  rootCauseMetricsDaily,
  subcategoryMetricsDaily,
  ticketRootCauses,
  ticketStatuses,
  ticketSubcategories,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  areaTotals,
  causeCoverage,
  causeTotals,
  channelTotals,
  ownerTotals,
  rolledUpRange,
  subcategoryTotals,
} from './subcategory-queries';

/**
 * The subcategory report's reads, against real Postgres. Every one is a raw
 * template over tables Stage 2.B renamed, so nothing static can tell whether
 * the names it spells still exist; and each is read the way the page reads
 * it — summed over a window of the rollup's days, labelled from the registry,
 * and ordered by volume.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();

/** The window most cases below are read over; each fixture names a day either side. */
const WEEK = { from: '2026-09-20', to: '2026-09-26' };

async function subcategory(
  day: string,
  row: Partial<typeof subcategoryMetricsDaily.$inferInsert> = {},
) {
  await db.insert(subcategoryMetricsDaily).values({
    day,
    subcategoryKey: 'wismo',
    area: 'delivery',
    channel: 'email',
    ticketsAny: 1,
    ...row,
  });
}

async function cause(day: string, row: Partial<typeof rootCauseMetricsDaily.$inferInsert> = {}) {
  await db
    .insert(rootCauseMetricsDaily)
    .values({ day, causeKey: 'courier_delay', owner: 'courier', channel: 'email', ...row });
}

// Where the subcategorised history starts. A day nobody worked has no row in
// either rollup, so a window opening on one must not be reported as the history
// starting inside it when it reaches further back.
describe('rolledUpRange', () => {
  it('takes the start of the history from before the window, past a quiet first day', async () => {
    await subcategory('2026-08-18');
    await cause('2026-08-19');
    // Nothing on the 20th, in either table: the window below opens on a gap.
    await subcategory('2026-08-21');
    await cause('2026-08-23');

    expect(await rolledUpRange({ from: '2026-08-20', to: '2026-08-25' })).toEqual({
      first: '2026-08-18',
      last: '2026-08-23',
      days: 2,
    });
  });

  it('still reports a history that really starts inside the window', async () => {
    await cause('2026-09-24');
    await subcategory('2026-09-25');

    expect(await rolledUpRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      first: '2026-09-24',
      last: '2026-09-25',
      days: 2,
    });
  });

  it('counts a day once when both tables have it, and nothing after the window', async () => {
    await subcategory('2026-09-10');
    await cause('2026-09-10');
    await subcategory('2026-10-02');

    expect(await rolledUpRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      first: '2026-09-10',
      last: '2026-09-10',
      days: 1,
    });
  });

  it('answers null for a window before any history', async () => {
    await subcategory('2026-09-10');

    expect(await rolledUpRange({ from: '2026-08-01', to: '2026-08-31' })).toEqual({
      first: null,
      last: null,
      days: 0,
    });
  });
});

/**
 * A week of subcategory rows. Late deliveries on two channels and three days,
 * two of which are outside the window by a day, so a sum that leaked past
 * either edge would be off by a hundred.
 */
async function subcategoryWeek() {
  await subcategory('2026-09-19', { subcategoryKey: 'delivery.late', ticketsAny: 100 });
  await subcategory('2026-09-20', {
    subcategoryKey: 'delivery.late',
    ticketsPrimary: 3,
    ticketsAny: 4,
    assignedAuto: 2,
    assignedSuggested: 1,
    assignedManual: 1,
  });
  await subcategory('2026-09-26', {
    subcategoryKey: 'delivery.late',
    channel: 'whatsapp',
    ticketsPrimary: 1,
    ticketsAny: 2,
    assignedSuggested: 2,
  });
  await subcategory('2026-09-27', { subcategoryKey: 'delivery.late', ticketsAny: 100 });

  await subcategory('2026-09-22', {
    subcategoryKey: 'payment.refund',
    area: 'payment',
    channel: 'facebook',
    ticketsPrimary: 2,
    ticketsAny: 2,
    assignedManual: 2,
  });
  await subcategory('2026-09-23', {
    subcategoryKey: 'condition.damaged',
    area: 'condition',
    channel: 'whatsapp',
    ticketsPrimary: 2,
    ticketsAny: 2,
    assignedAuto: 2,
  });
  // The fallback is never primary, so it shows only under "any".
  await subcategory('2026-09-24', {
    subcategoryKey: 'meta.unclassified',
    area: 'meta',
    channel: 'instagram',
    ticketsAny: 3,
    assignedAuto: 3,
  });
  await subcategory('2026-09-25', {
    subcategoryKey: 'meta.unclassified',
    area: 'meta',
    channel: 'email',
    ticketsAny: 1,
    assignedAuto: 1,
  });
  // Counted under a key the registry no longer has.
  await subcategory('2026-09-21', {
    subcategoryKey: 'wismo',
    ticketsPrimary: 1,
    ticketsAny: 1,
    assignedAuto: 1,
  });
}

describe('subcategoryTotals', () => {
  it('sums each subcategory over its channels and the window’s days, under its current label', async () => {
    await subcategoryWeek();
    // An admin renames a label; the rollup keeps the key it counted under.
    await db
      .update(ticketSubcategories)
      .set({ labelEn: 'Running late' })
      .where(eq(ticketSubcategories.key, 'delivery.late'));

    expect(await subcategoryTotals(WEEK)).toEqual([
      {
        subcategoryKey: 'delivery.late',
        label: 'Running late',
        area: 'delivery',
        ticketsPrimary: 4,
        ticketsAny: 6,
        assignedAuto: 2,
        assignedSuggested: 3,
        assignedManual: 1,
      },
      {
        subcategoryKey: 'meta.unclassified',
        label: 'Not classified',
        area: 'meta',
        ticketsPrimary: 0,
        ticketsAny: 4,
        assignedAuto: 4,
        assignedSuggested: 0,
        assignedManual: 0,
      },
      // Two each: the tie goes to the key, so the table does not reshuffle.
      {
        subcategoryKey: 'condition.damaged',
        label: 'Damaged',
        area: 'condition',
        ticketsPrimary: 2,
        ticketsAny: 2,
        assignedAuto: 2,
        assignedSuggested: 0,
        assignedManual: 0,
      },
      {
        subcategoryKey: 'payment.refund',
        label: 'Refund request',
        area: 'payment',
        ticketsPrimary: 2,
        ticketsAny: 2,
        assignedAuto: 0,
        assignedSuggested: 0,
        assignedManual: 2,
      },
      // Retired from the registry: still reported, labelled by its key.
      {
        subcategoryKey: 'wismo',
        label: 'wismo',
        area: 'delivery',
        ticketsPrimary: 1,
        ticketsAny: 1,
        assignedAuto: 1,
        assignedSuggested: 0,
        assignedManual: 0,
      },
    ]);
  });

  it('answers nothing for a window with no rows', async () => {
    await subcategoryWeek();
    expect(await subcategoryTotals({ from: '2026-10-01', to: '2026-10-07' })).toEqual([]);
  });
});

describe('areaTotals', () => {
  it('folds the subcategories into their areas, retired keys included', async () => {
    await subcategoryWeek();

    expect(await areaTotals(WEEK)).toEqual([
      // delivery.late's six and wismo's one.
      { area: 'delivery', ticketsAny: 7, ticketsPrimary: 5 },
      { area: 'meta', ticketsAny: 4, ticketsPrimary: 0 },
      { area: 'condition', ticketsAny: 2, ticketsPrimary: 2 },
      { area: 'payment', ticketsAny: 2, ticketsPrimary: 2 },
    ]);
  });
});

describe('channelTotals', () => {
  it('counts each channel’s tickets by their primary, and what no rule could read beside it', async () => {
    await subcategoryWeek();

    expect(await channelTotals(WEEK)).toEqual([
      // delivery.late's three and wismo's one; the one unread is the fallback.
      { channel: 'email', ticketsPrimary: 4, unread: 1 },
      { channel: 'whatsapp', ticketsPrimary: 3, unread: 0 },
      { channel: 'facebook', ticketsPrimary: 2, unread: 0 },
      // Nothing led on Instagram at all, only the fallback: it sorts last, and
      // its unread count is the instagram rows' "any", not their primary.
      { channel: 'instagram', ticketsPrimary: 0, unread: 3 },
    ]);
  });

  it('orders a tie by the channel’s name rather than the enum’s order', async () => {
    // `whatsapp` is declared before `facebook` in the enum, so a sort on the
    // enum rather than on the text the page receives would swap these.
    await subcategory('2026-09-22', {
      subcategoryKey: 'delivery.late',
      channel: 'whatsapp',
      ticketsPrimary: 2,
      ticketsAny: 2,
    });
    await subcategory('2026-09-22', {
      subcategoryKey: 'delivery.late',
      channel: 'facebook',
      ticketsPrimary: 2,
      ticketsAny: 2,
    });

    expect((await channelTotals(WEEK)).map((row) => row.channel)).toEqual(['facebook', 'whatsapp']);
  });
});

describe('causeTotals and ownerTotals', () => {
  async function causeWeek() {
    await cause('2026-09-19', { causeKey: 'courier.late', ticketsResolved: 100 });
    await cause('2026-09-20', { causeKey: 'courier.late', ticketsResolved: 3 });
    await cause('2026-09-25', {
      causeKey: 'courier.late',
      channel: 'whatsapp',
      ticketsResolved: 2,
    });
    await cause('2026-09-27', { causeKey: 'courier.late', ticketsResolved: 100 });
    await cause('2026-09-22', {
      causeKey: 'merchant.bad_address',
      owner: 'merchant',
      ticketsResolved: 4,
    });
    await cause('2026-09-23', { causeKey: 'hub.backlog', owner: 'hub', ticketsResolved: 1 });
    // A cause the registry no longer has, still carrying the owner it was
    // counted under. Nothing but the row can say whose it was.
    await cause('2026-09-24', {
      causeKey: 'courier_delay',
      owner: 'courier',
      channel: 'whatsapp',
      ticketsResolved: 1,
    });
    await cause('2026-09-26', {
      causeKey: 'none.enquiry',
      owner: 'none',
      channel: 'webchat',
      ticketsResolved: 4,
    });
  }

  it('sums each cause over the window, labelled from the registry, with the owner its rows carry', async () => {
    await causeWeek();
    await db
      .update(ticketRootCauses)
      .set({ labelEn: 'Courier was late' })
      .where(eq(ticketRootCauses.key, 'courier.late'));

    expect(await causeTotals(WEEK)).toEqual([
      { causeKey: 'courier.late', label: 'Courier was late', owner: 'courier', ticketsResolved: 5 },
      // Four each: the tie goes to the key.
      {
        causeKey: 'merchant.bad_address',
        label: 'Merchant supplied a bad address',
        owner: 'merchant',
        ticketsResolved: 4,
      },
      {
        causeKey: 'none.enquiry',
        label: 'An enquiry, nothing failed',
        owner: 'none',
        ticketsResolved: 4,
      },
      { causeKey: 'courier_delay', label: 'courier_delay', owner: 'courier', ticketsResolved: 1 },
      { causeKey: 'hub.backlog', label: 'Hub backlog', owner: 'hub', ticketsResolved: 1 },
    ]);
  });

  it('adds up each owner’s causes, retired ones included', async () => {
    await causeWeek();

    expect(await ownerTotals(WEEK)).toEqual([
      // courier.late's five and courier_delay's one.
      { owner: 'courier', ticketsResolved: 6 },
      { owner: 'merchant', ticketsResolved: 4 },
      { owner: 'none', ticketsResolved: 4 },
      { owner: 'hub', ticketsResolved: 1 },
    ]);
  });
});

describe('causeCoverage', () => {
  const WINDOW = { from: '2026-10-07', to: '2026-10-13' };

  async function statusId(name: string): Promise<string> {
    const [row] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, name));
    return row!.id;
  }

  /**
   * An ended ticket and the subcategories it carries, the first of them its
   * lead. The key is frozen from the registry's, as the subcategoriser writes it.
   */
  async function ended(
    ticket: {
      resolvedAt?: Date;
      rootCauseSetAt?: Date;
      cause?: string;
      deletedAt?: Date;
      status?: string;
    },
    keys: { primary?: string; carried?: string[] } = {},
  ): Promise<void> {
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const [rootCause] = ticket.cause
      ? await db
          .select({ id: ticketRootCauses.id })
          .from(ticketRootCauses)
          .where(eq(ticketRootCauses.key, ticket.cause))
      : [];
    const [row] = await db
      .insert(conversations)
      .values({
        channel: 'email',
        statusId: await statusId(ticket.status ?? 'Resolved'),
        requesterContactId: contact!.id,
        resolvedAt: ticket.resolvedAt,
        rootCauseSetAt: ticket.rootCauseSetAt ?? (ticket.cause ? ticket.resolvedAt : undefined),
        rootCauseId: rootCause?.id,
        deletedAt: ticket.deletedAt,
      })
      .returning({ id: conversations.id });

    const assignments = [
      ...(keys.primary ? [{ key: keys.primary, isPrimary: true }] : []),
      ...(keys.carried ?? []).map((key) => ({ key, isPrimary: false })),
    ];
    for (const { key, isPrimary } of assignments) {
      const [registered] = await db
        .select({ id: ticketSubcategories.id })
        .from(ticketSubcategories)
        .where(eq(ticketSubcategories.key, key));
      await db.insert(conversationSubcategories).values({
        conversationId: row!.id,
        subcategoryId: registered!.id,
        subcategoryKey: key,
        isPrimary,
      });
    }
  }

  it('measures only tickets whose lead subcategory owes a cause', async () => {
    const resolvedAt = at('2026-10-10T12:00');
    await ended({ resolvedAt, cause: 'courier.late' }, { primary: 'delivery.late' });
    await ended({ resolvedAt }, { primary: 'condition.damaged' });
    await ended({ resolvedAt, cause: 'merchant.cod_error' }, { primary: 'payment.cod_dispute' });
    // Led by a pricing question, so owed nothing, whatever else it carries.
    await ended(
      { resolvedAt },
      { primary: 'commercial.pricing_enquiry', carried: ['delivery.late'] },
    );
    // Carrying a delivery subcategory without leading on it.
    await ended({ resolvedAt }, { carried: ['delivery.where_is_it'] });
    // Never subcategorised at all, cause or not.
    await ended({ resolvedAt, cause: 'hub.backlog' });

    expect(await causeCoverage(WINDOW, ZONE)).toEqual({ withCause: 2, total: 3 });
  });

  it('cuts the window at the team’s midnights, at both ends', async () => {
    // 00:10 on the 7th in Cairo, still the 6th in UTC: inside.
    await ended(
      { resolvedAt: at('2026-10-07T00:10'), cause: 'courier.late' },
      {
        primary: 'pickup.not_collected',
      },
    );
    // 23:50 on the 6th: outside.
    await ended({ resolvedAt: at('2026-10-06T23:50') }, { primary: 'return.status' });
    // 23:30 on the 13th: inside.
    await ended({ resolvedAt: at('2026-10-13T23:30') }, { primary: 'delivery.late' });
    // 00:30 on the 14th in Cairo, 21:30 on the 13th in UTC: outside, as the
    // rollup beside it would have it.
    await ended(
      { resolvedAt: at('2026-10-14T00:30'), cause: 'courier.late' },
      {
        primary: 'delivery.late',
      },
    );

    expect(await causeCoverage(WINDOW, ZONE)).toEqual({ withCause: 1, total: 2 });
  });

  it('dates a closed ticket by its cause, and leaves out deleted and unended ones', async () => {
    // Closed without a resolve: dated by when its cause was set.
    await ended(
      { status: 'Closed', rootCauseSetAt: at('2026-10-11T09:00'), cause: 'courier.no_contact' },
      { primary: 'delivery.no_contact' },
    );
    // Resolved in the window, and deleted since.
    await ended(
      { resolvedAt: at('2026-10-10T12:00'), deletedAt: at('2026-10-12T12:00') },
      { primary: 'delivery.late' },
    );
    // Still open, with nothing to date it by.
    await ended({ status: 'Open' }, { primary: 'delivery.late' });

    expect(await causeCoverage(WINDOW, ZONE)).toEqual({ withCause: 1, total: 1 });
  });
});
