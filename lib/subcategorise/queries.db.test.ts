import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversationSubcategories,
  conversations,
  messages,
  ticketStatuses,
  ticketSubcategories,
} from '@/db/schema';
import { CONVERSATION_CHANNELS } from '@/lib/tickets/channel-policy';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import {
  reviewQueue,
  ruleScores,
  subcategoriesForConversation,
  subcategoryOptions,
  unclassifiedQueue,
} from './queries';
import { UNCLASSIFIED_KEY, allSubcategories } from './taxonomy';

/**
 * The read side of the subcategoriser, against real Postgres, after Stage 2.B
 * of `plans/ticket-category-routing.md` renamed every table and column these
 * read. `ruleScores` is a raw `sql` template, so nothing but executing it can
 * tell it still names a table that exists; the other four are Drizzle, and are
 * here because they are what `/admin/subcategories/review` and the ticket
 * sidebar draw from, so a join or a filter on a renamed column that went wrong
 * would show an agent the wrong queue rather than an error.
 *
 * Each case builds the rows it reads, on the baseline's seeded registry, and
 * asserts what the page renders from them — counts, order, which rows are left
 * out — rather than that a query ran.
 */

withCleanDatabase();

type Channel = (typeof conversations.$inferInsert)['channel'];
type Assignment = Omit<
  typeof conversationSubcategories.$inferInsert,
  'conversationId' | 'subcategoryId' | 'subcategoryKey'
>;

/** What the review page passes for an agent without `ticket.view.bot`. */
const WITHOUT_BOT = CONVERSATION_CHANNELS.filter((channel) => channel !== 'whatsapp_bot');

async function ticket(
  channel: Channel = 'email',
  extra: Partial<typeof conversations.$inferInsert> = {},
): Promise<{ id: string; number: number }> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: open!.id, requesterContactId: contact!.id, ...extra })
    .returning({ id: conversations.id, number: conversations.number });
  return row!;
}

async function message(conversationId: string, bodyText: string): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({ conversationId, direction: 'inbound', kind: 'reply', bodyText })
    .returning({ id: messages.id });
  return row!.id;
}

/** The seeded registry row, so a case can assert the id the join hands back. */
async function registry(key: string) {
  const [row] = await db.select().from(ticketSubcategories).where(eq(ticketSubcategories.key, key));
  if (!row) throw new Error(`the baseline seed has no subcategory ${key}`);
  return row;
}

/**
 * One assignment, its key frozen from the registry the way `apply.ts` writes
 * it, so a case states only what it is about.
 */
async function assign(conversationId: string, key: string, row: Assignment = {}): Promise<void> {
  const subcategory = await registry(key);
  await db.insert(conversationSubcategories).values({
    conversationId,
    subcategoryId: subcategory.id,
    subcategoryKey: key,
    ...row,
  });
}

describe('ruleScores', () => {
  it("counts each rule's rows by what a person said about them, and leaves a person's own choice out", async () => {
    // One rule across four tickets, one in each review state, so each column
    // is shown to count exactly the states it names.
    for (const reviewState of ['confirmed', 'rejected', 'auto', 'suggested'] as const) {
      const { id } = await ticket();
      await assign(id, 'delivery.late', { reviewState, ruleKey: 'kw.late', confidence: 0.55 });
    }
    // An agent's own choice carries no rule. It is the signal that the rules
    // missed, not a score for one of them.
    const { id: manual } = await ticket();
    await assign(manual, 'delivery.late', {
      source: 'manual',
      reviewState: 'confirmed',
      confidence: 1,
      ruleKey: null,
    });

    // Numbers, not the strings postgres.js hands back for a bare count(*):
    // the page compares `rejected > agreed`, which on strings is lexical.
    expect(await ruleScores()).toEqual([
      { ruleKey: 'kw.late', agreed: 1, rejected: 1, unreviewed: 2 },
    ]);
  });

  it('keeps two rules awarding the same subcategory apart, the most rejected first', async () => {
    const award = async (ruleKey: string, reviewState: 'confirmed' | 'rejected' | 'auto') => {
      const { id } = await ticket();
      await assign(id, 'delivery.late', { reviewState, ruleKey, confidence: 0.7 });
    };
    // Every rule awards the same subcategory: grouped by subcategory they
    // would be one row, and the rule that over-fires could not be found.
    await award('c.rule', 'confirmed');
    await award('b.rule', 'rejected');
    await award('b.rule', 'rejected');
    await award('b.rule', 'confirmed');
    await award('z.rule', 'rejected');
    await award('a.rule', 'auto');

    // Most rejected first, then by key, so the two that tie at none are
    // in a stable order rather than whatever the hash aggregate produced.
    expect(await ruleScores()).toEqual([
      { ruleKey: 'b.rule', agreed: 1, rejected: 2, unreviewed: 0 },
      { ruleKey: 'z.rule', agreed: 0, rejected: 1, unreviewed: 0 },
      { ruleKey: 'a.rule', agreed: 0, rejected: 0, unreviewed: 1 },
      { ruleKey: 'c.rule', agreed: 1, rejected: 0, unreviewed: 0 },
    ]);
  });

  it('answers nothing when no rule has fired', async () => {
    const { id } = await ticket();
    await assign(id, 'condition.damaged', { source: 'manual', reviewState: 'confirmed' });

    expect(await ruleScores()).toEqual([]);
  });
});

describe('subcategoriesForConversation', () => {
  it('reads labels through the registry, keeps a rejected row, and leads with the primary', async () => {
    const { id } = await ticket();
    const { id: other } = await ticket();
    const said = await message(id, 'the parcel arrived crushed');

    // An admin renamed it after it was assigned. The sidebar shows the name it
    // has now, which only the join can supply: the frozen key never changes.
    await db
      .update(ticketSubcategories)
      .set({ labelEn: 'Arrived broken' })
      .where(eq(ticketSubcategories.key, 'condition.damaged'));

    // The primary has the weakest evidence, so it is first by its flag alone.
    await assign(id, 'delivery.where_is_it', {
      reviewState: 'auto',
      confidence: 0.55,
      isPrimary: true,
      ruleKey: 'kw.where',
      firstSeenAt: cairo('2026-10-20T09:00'),
    });
    await assign(id, 'delivery.address_change', {
      source: 'manual',
      reviewState: 'confirmed',
      confidence: 1,
      firstSeenAt: cairo('2026-10-20T09:05'),
    });
    await assign(id, 'delivery.refused', {
      reviewState: 'rejected',
      confidence: 0.9,
      ruleKey: 'kw.refused',
      firstSeenAt: cairo('2026-10-20T09:10'),
    });
    // Two at the same grade: the registry's position decides, and
    // `condition.damaged` is placed after `delivery.late` in the taxonomy.
    await assign(id, 'condition.damaged', {
      reviewState: 'suggested',
      confidence: 0.7,
      ruleKey: 'kw.damaged',
      detectedInMessageId: said,
      firstSeenAt: cairo('2026-10-20T09:15'),
    });
    await assign(id, 'delivery.late', {
      reviewState: 'suggested',
      confidence: 0.7,
      ruleKey: 'kw.late',
      firstSeenAt: cairo('2026-10-20T09:20'),
    });
    // Another ticket's assignment, which the filter must leave behind.
    await assign(other, 'pickup.supplies', { reviewState: 'auto', confidence: 0.9 });

    const rows = await subcategoriesForConversation(id);

    expect(rows.map((row) => [row.key, row.reviewState])).toEqual([
      ['delivery.where_is_it', 'auto'],
      ['delivery.address_change', 'confirmed'],
      ['delivery.refused', 'rejected'],
      ['delivery.late', 'suggested'],
      ['condition.damaged', 'suggested'],
    ]);

    const damaged = await registry('condition.damaged');
    expect(rows.find((row) => row.key === 'condition.damaged')).toEqual({
      subcategoryId: damaged.id,
      key: 'condition.damaged',
      area: 'condition',
      labelEn: 'Arrived broken',
      labelAr: damaged.labelAr,
      source: 'detected',
      reviewState: 'suggested',
      confidence: 0.7,
      isPrimary: false,
      ruleKey: 'kw.damaged',
      detectedInMessageId: said,
      firstSeenAt: cairo('2026-10-20T09:15'),
    });
    expect(rows.find((row) => row.key === 'delivery.address_change')).toMatchObject({
      source: 'manual',
      ruleKey: null,
      detectedInMessageId: null,
    });
  });

  it('answers nothing for a ticket nothing was filed under', async () => {
    const { id } = await ticket();
    const { id: other } = await ticket();
    await assign(other, 'delivery.late', { reviewState: 'auto', confidence: 0.9 });

    expect(await subcategoriesForConversation(id)).toEqual([]);
  });
});

describe('subcategoryOptions', () => {
  it('offers every active subcategory but unclassified, in picker order, with its audience', async () => {
    // Retired by an admin: out of the picker, though its history stays.
    await db
      .update(ticketSubcategories)
      .set({ isActive: false })
      .where(eq(ticketSubcategories.key, 'pickup.supplies'));
    await db
      .update(ticketSubcategories)
      .set({ labelEn: 'Running late' })
      .where(eq(ticketSubcategories.key, 'delivery.late'));

    const options = await subcategoryOptions();

    const expected = allSubcategories()
      .filter((one) => one.key !== UNCLASSIFIED_KEY && one.key !== 'pickup.supplies')
      .map((one) => ({
        key: one.key,
        area: one.area,
        labelEn: one.key === 'delivery.late' ? 'Running late' : one.labelEn,
        labelAr: one.labelAr,
        audience: one.audience,
      }));
    expect(options.map(({ id: _id, ...rest }) => rest)).toEqual(expected);
    // The seeded taxonomy has all three audiences, so the comparison above is
    // reading the renamed enum's every value, not only the default.
    expect(new Set(options.map((one) => one.audience))).toEqual(
      new Set(['merchant', 'recipient', 'any']),
    );

    const late = await registry('delivery.late');
    expect(options.find((one) => one.key === 'delivery.late')?.id).toBe(late.id);
  });
});

describe('reviewQueue', () => {
  it('holds only suggestions, best evidence first, on tickets the agent can see', async () => {
    const late = await ticket('email', { subject: 'Where is it' });
    const lateSaid = await message(late.id, 'my order is three days late');
    await assign(late.id, 'delivery.late', {
      reviewState: 'suggested',
      confidence: 0.7,
      ruleKey: 'kw.late',
      detectedInMessageId: lateSaid,
      firstSeenAt: cairo('2026-10-20T10:00'),
    });

    // The same grade, seen later: newer first among equals.
    const damaged = await ticket('whatsapp');
    await assign(damaged.id, 'condition.damaged', {
      reviewState: 'suggested',
      confidence: 0.7,
      ruleKey: 'kw.damaged',
      firstSeenAt: cairo('2026-10-20T11:00'),
    });

    const refused = await ticket('webchat');
    await assign(refused.id, 'delivery.refused', {
      reviewState: 'suggested',
      confidence: 0.9,
      ruleKey: 'phrase.refused',
      firstSeenAt: cairo('2026-10-20T08:00'),
    });

    // Already answered, or never asked: nothing to click.
    const settled = await ticket();
    await assign(settled.id, 'delivery.where_is_it', { reviewState: 'auto', confidence: 0.9 });
    await assign(settled.id, 'delivery.reschedule', { reviewState: 'confirmed', confidence: 0.7 });
    await assign(settled.id, 'delivery.no_contact', { reviewState: 'rejected', confidence: 0.7 });

    // Unclassified has a list of its own, and at confidence 0 it would sort
    // last here anyway.
    const unread = await ticket();
    await assign(unread.id, UNCLASSIFIED_KEY, { reviewState: 'suggested', confidence: 0 });

    // A bot transcript, and a deleted ticket.
    const bot = await ticket('whatsapp_bot');
    await assign(bot.id, 'delivery.late', {
      reviewState: 'suggested',
      confidence: 0.95,
      ruleKey: 'kw.late',
      firstSeenAt: cairo('2026-10-20T12:00'),
    });
    const deleted = await ticket('email', { deletedAt: cairo('2026-10-21T09:00') });
    await assign(deleted.id, 'delivery.late', {
      reviewState: 'suggested',
      confidence: 0.95,
      ruleKey: 'kw.late',
    });

    const queue = await reviewQueue({ visibleChannels: WITHOUT_BOT });

    expect(queue.map((row) => [row.number, row.key])).toEqual([
      [refused.number, 'delivery.refused'],
      [damaged.number, 'condition.damaged'],
      [late.number, 'delivery.late'],
    ]);

    const subcategory = await registry('delivery.late');
    expect(queue[2]).toEqual({
      conversationId: late.id,
      number: late.number,
      subject: 'Where is it',
      channel: 'email',
      subcategoryId: subcategory.id,
      key: 'delivery.late',
      labelEn: subcategory.labelEn,
      confidence: 0.7,
      ruleKey: 'kw.late',
      firstSeenAt: cairo('2026-10-20T10:00'),
      excerpt: 'my order is three days late',
    });

    // Somebody who may read the bot's transcripts gets its suggestion too, at
    // the top on its evidence. The deleted ticket stays out for everybody.
    const everything = await reviewQueue({ visibleChannels: CONVERSATION_CHANNELS });
    expect(everything.map((row) => row.number)).toEqual([
      bot.number,
      refused.number,
      damaged.number,
      late.number,
    ]);
  });

  it('cuts the excerpt at 240 characters, and says nothing when the message is gone', async () => {
    const long = 'و'.repeat(100) + 'x'.repeat(200);
    const kept = await ticket();
    await assign(kept.id, 'delivery.late', {
      reviewState: 'suggested',
      confidence: 0.9,
      detectedInMessageId: await message(kept.id, long),
    });

    // The FK sets it null when the message is deleted.
    const gone = await ticket();
    const goneSaid = await message(gone.id, 'deleted since');
    await assign(gone.id, 'delivery.late', {
      reviewState: 'suggested',
      confidence: 0.8,
      detectedInMessageId: goneSaid,
    });
    await db.delete(messages).where(eq(messages.id, goneSaid));

    const queue = await reviewQueue({ visibleChannels: WITHOUT_BOT });

    expect(queue.map((row) => row.excerpt)).toEqual([long.slice(0, 240), null]);
  });

  it('answers an agent who can see no channel without asking, and stops at the limit', async () => {
    const { id } = await ticket();
    await assign(id, 'delivery.late', { reviewState: 'suggested', confidence: 0.7 });

    expect(await reviewQueue({ visibleChannels: [] })).toEqual([]);

    // Fifty-one waiting: the page shows the fifty with the best evidence, and
    // the weakest one is the one left for the next visit.
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [contact] = await db.insert(contacts).values({ name: 'Batch' }).returning();
    const many = await db
      .insert(conversations)
      .values(
        Array.from({ length: 50 }, () => ({
          channel: 'email' as const,
          statusId: open!.id,
          requesterContactId: contact!.id,
        })),
      )
      .returning({ id: conversations.id });
    const subcategory = await registry('delivery.late');
    await db.insert(conversationSubcategories).values(
      many.map((row) => ({
        conversationId: row.id,
        subcategoryId: subcategory.id,
        subcategoryKey: 'delivery.late',
        reviewState: 'suggested' as const,
        confidence: 0.9,
      })),
    );

    const page = await reviewQueue({ visibleChannels: WITHOUT_BOT });
    expect(page).toHaveLength(50);
    expect(page.map((row) => row.conversationId)).not.toContain(id);

    expect(await reviewQueue({ visibleChannels: WITHOUT_BOT, limit: 3 })).toHaveLength(3);
  });
});

describe('unclassifiedQueue', () => {
  it('lists what no rule read, newest first, on tickets the agent can see', async () => {
    const unread = async (channel: Channel, at: string, body: string | null) => {
      const row = await ticket(channel);
      await assign(row.id, UNCLASSIFIED_KEY, {
        reviewState: 'suggested',
        confidence: 0,
        detectedInMessageId: body === null ? null : await message(row.id, body),
        firstSeenAt: cairo(at),
      });
      return row;
    };

    const morning = await unread('email', '2026-10-20T09:00', 'ممكن حد يكلمني');
    const noon = await unread('whatsapp', '2026-10-20T12:00', '؟');
    const ten = await unread('webchat', '2026-10-20T10:00', null);
    const bot = await unread('whatsapp_bot', '2026-10-20T13:00', '1');

    // A real suggestion belongs to the other list; an unclassified row
    // somebody already answered, and a deleted ticket's, to neither.
    const suggested = await ticket();
    await assign(suggested.id, 'delivery.late', {
      reviewState: 'suggested',
      confidence: 0.7,
      firstSeenAt: cairo('2026-10-20T14:00'),
    });
    const answered = await ticket();
    await assign(answered.id, UNCLASSIFIED_KEY, {
      reviewState: 'rejected',
      confidence: 0,
      firstSeenAt: cairo('2026-10-20T15:00'),
    });
    const deleted = await ticket('email', { deletedAt: cairo('2026-10-21T09:00') });
    await assign(deleted.id, UNCLASSIFIED_KEY, {
      reviewState: 'suggested',
      confidence: 0,
      firstSeenAt: cairo('2026-10-20T16:00'),
    });

    expect(await unclassifiedQueue({ visibleChannels: WITHOUT_BOT })).toEqual([
      {
        conversationId: noon.id,
        number: noon.number,
        channel: 'whatsapp',
        firstSeenAt: cairo('2026-10-20T12:00'),
        excerpt: '؟',
      },
      {
        conversationId: ten.id,
        number: ten.number,
        channel: 'webchat',
        firstSeenAt: cairo('2026-10-20T10:00'),
        excerpt: null,
      },
      {
        conversationId: morning.id,
        number: morning.number,
        channel: 'email',
        firstSeenAt: cairo('2026-10-20T09:00'),
        excerpt: 'ممكن حد يكلمني',
      },
    ]);

    const everything = await unclassifiedQueue({ visibleChannels: CONVERSATION_CHANNELS });
    expect(everything.map((row) => row.number)).toEqual([
      bot.number,
      noon.number,
      ten.number,
      morning.number,
    ]);
  });

  it('answers an agent who can see no channel without asking, cuts the excerpt, and stops at the limit', async () => {
    const long = 'x'.repeat(300);
    const first = await ticket();
    await assign(first.id, UNCLASSIFIED_KEY, {
      reviewState: 'suggested',
      confidence: 0,
      detectedInMessageId: await message(first.id, long),
      firstSeenAt: cairo('2026-10-01T09:00'),
    });

    expect(await unclassifiedQueue({ visibleChannels: [] })).toEqual([]);
    expect((await unclassifiedQueue({ visibleChannels: WITHOUT_BOT }))[0]?.excerpt).toBe(
      long.slice(0, 240),
    );

    // Twenty-five newer ones push the oldest off the default page.
    const unclassified = await registry(UNCLASSIFIED_KEY);
    for (let day = 2; day <= 26; day += 1) {
      const { id } = await ticket();
      await db.insert(conversationSubcategories).values({
        conversationId: id,
        subcategoryId: unclassified.id,
        subcategoryKey: UNCLASSIFIED_KEY,
        reviewState: 'suggested',
        confidence: 0,
        firstSeenAt: cairo(`2026-10-${String(day).padStart(2, '0')}T09:00`),
      });
    }

    const page = await unclassifiedQueue({ visibleChannels: WITHOUT_BOT });
    expect(page).toHaveLength(25);
    expect(page.map((row) => row.conversationId)).not.toContain(first.id);
    expect(page[0]?.firstSeenAt).toEqual(cairo('2026-10-26T09:00'));

    expect(await unclassifiedQueue({ visibleChannels: WITHOUT_BOT, limit: 2 })).toHaveLength(2);
  });
});
