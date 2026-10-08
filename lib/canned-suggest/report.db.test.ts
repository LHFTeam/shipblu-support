import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  cannedResponses,
  cannedSuggestions,
  contacts,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  byChannelAndLanguage,
  byProbability,
  byResponse,
  confusions,
  coverage,
  headline,
  type ReportWindow,
} from './report';
import { NONE_KEY, REQUEST_VERSION } from './request';

/**
 * The report's figures against one fixture per outcome a suggestion can have,
 * so every numerator and every denominator is pinned to the rows that produce
 * it. These are raw SQL — `count(*) filter`, a full join, a cast to the channel
 * enum's text — which nothing but Postgres checks.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const WINDOW: ReportWindow = { from: '2026-10-01', to: '2026-10-07', zone: ZONE };

/** An instant from Cairo wall-clock time, converted by the timezone database. */
function cairo(iso: string): Date {
  return DateTime.fromISO(iso, { zone: ZONE }).toJSDate();
}

const IN_WINDOW = cairo('2026-10-03T12:00');

async function fixture() {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [conversation] = await db
    .insert(conversations)
    .values({ channel: 'facebook', statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });

  const [where] = await db
    .insert(cannedResponses)
    .values({ title: 'Where is my parcel', bodyTextAr: 'في الطريق', bodyTextEn: 'On its way' })
    .returning({ id: cannedResponses.id });
  const [refund] = await db
    .insert(cannedResponses)
    .values({ title: 'Refund', bodyTextAr: 'استرداد', bodyTextEn: 'Refund' })
    .returning({ id: cannedResponses.id });

  return {
    agentId: agent!.id,
    conversationId: conversation!.id,
    where: where!.id,
    refund: refund!.id,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function reply(f: Fixture, at = IN_WINDOW) {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: f.conversationId,
      direction: 'outbound',
      authorAgentId: f.agentId,
      bodyText: 'x',
      createdAt: at,
    })
    .returning({ id: messages.id });
  return row!.id;
}

async function suggestion(f: Fixture, values: Partial<typeof cannedSuggestions.$inferInsert>) {
  await db.insert(cannedSuggestions).values({
    conversationId: f.conversationId,
    agentId: f.agentId,
    channel: 'facebook',
    customerLocale: 'ar',
    requestVersion: REQUEST_VERSION,
    createdAt: IN_WINDOW,
    settledAt: IN_WINDOW,
    ...values,
  });
}

/**
 * Nine suggestions, one per outcome:
 *
 *   1. Where — shown, taken with Tab, sent unchanged             (right, via Tab)
 *   2. Where — shown, picked from the list, sent extended         (right, via the picker)
 *   3. Where — shown, waved away, Refund sent instead              (wrong: replaced)
 *   4. Where — shown, ignored, typed by hand                       (wrong: own words)
 *   5. Where — never shown, sent anyway                            (blind, right)
 *   6. none  — Refund sent                                         (missed)
 *   7. none  — typed by hand                                       (none, right)
 *   8. failed
 *   9. in flight
 */
async function nineOutcomes(f: Fixture) {
  const shown = { shownAt: IN_WINDOW };
  const where = { choice: f.where, cannedResponseId: f.where, cannedTitle: 'Where is my parcel' };
  const sentWhere = {
    sentChoice: f.where,
    sentCannedResponseId: f.where,
    sentCannedTitle: 'Where is my parcel',
  };
  const sentRefund = {
    sentChoice: f.refund,
    sentCannedResponseId: f.refund,
    sentCannedTitle: 'Refund',
  };
  const sentNothing = { sentChoice: NONE_KEY };

  await suggestion(f, {
    ...where,
    ...shown,
    acceptedAt: IN_WINDOW,
    probability: 0.95,
    latencyMs: 200,
    inputTokens: 5000,
    messageId: await reply(f),
    repliedAt: IN_WINDOW,
    ...sentWhere,
    sentMatches: true,
    sentEdit: 'unchanged',
  });
  await suggestion(f, {
    ...where,
    ...shown,
    probability: 0.7,
    latencyMs: 300,
    inputTokens: 5000,
    messageId: await reply(f),
    repliedAt: IN_WINDOW,
    ...sentWhere,
    sentMatches: true,
    sentEdit: 'extended',
  });
  await suggestion(f, {
    ...where,
    ...shown,
    dismissedAt: IN_WINDOW,
    probability: 0.4,
    latencyMs: 400,
    inputTokens: 5000,
    messageId: await reply(f),
    repliedAt: IN_WINDOW,
    ...sentRefund,
    sentMatches: false,
  });
  await suggestion(f, {
    ...where,
    ...shown,
    probability: 0.2,
    latencyMs: 500,
    inputTokens: 5000,
    messageId: await reply(f),
    repliedAt: IN_WINDOW,
    ...sentNothing,
    sentMatches: false,
  });
  await suggestion(f, {
    ...where,
    probability: 0.8,
    latencyMs: 600,
    inputTokens: 5000,
    messageId: await reply(f),
    repliedAt: IN_WINDOW,
    ...sentWhere,
    sentMatches: true,
    sentEdit: 'reworded',
  });
  await suggestion(f, {
    choice: NONE_KEY,
    probability: 0.9,
    latencyMs: 700,
    inputTokens: 5000,
    messageId: await reply(f),
    repliedAt: IN_WINDOW,
    ...sentRefund,
    sentMatches: false,
  });
  await suggestion(f, {
    choice: NONE_KEY,
    latencyMs: 800,
    inputTokens: 5000,
    messageId: await reply(f),
    repliedAt: IN_WINDOW,
    ...sentNothing,
    sentMatches: true,
  });
  await suggestion(f, { error: 'TypeSafe returned 429', latencyMs: 50 });
  await suggestion(f, { settledAt: null });
}

describe('headline', () => {
  it('counts every outcome into the numerators and denominators the page prints', async () => {
    const f = await fixture();
    await nineOutcomes(f);

    expect(await headline(WINDOW)).toEqual({
      requests: 9,
      errored: 1,
      unanswered: 1,
      answered: 7,
      none: 2,
      suggested: 5,
      shown: 4,
      accepted: 1,
      dismissed: 1,
      // Precision: of the four shown and replied to, two carried Where.
      shownReplied: 4,
      shownRight: 2,
      blindReplied: 1,
      blindRight: 1,
      noneReplied: 2,
      noneMissed: 1,
      rightViaTab: 1,
      // Of the two shown and right; the blind one is in neither.
      rightViaPicker: 1,
      unchanged: 1,
      extended: 1,
      reworded: 1,
      // Over the seven answered rows: 200…800 ms.
      latencyP50: 500,
      latencyP90: 740,
      tokensAvg: 5000,
      tokensTotal: 35000,
    });
  });

  it('is all zeros over a window with nothing in it', async () => {
    expect(await headline(WINDOW)).toMatchObject({
      requests: 0,
      latencyP50: null,
      tokensAvg: null,
      tokensTotal: 0,
    });
  });

  // The window is a pair of Cairo dates. Cairo is UTC+3 in October, so a
  // suggestion at 00:30 on the first is the evening before in UTC — and the
  // database's own dates would put it in the wrong day.
  it('selects the days in Cairo, not in UTC', async () => {
    const f = await fixture();
    await suggestion(f, { choice: NONE_KEY, createdAt: cairo('2026-10-01T00:30') });
    await suggestion(f, { choice: NONE_KEY, createdAt: cairo('2026-09-30T23:30') });
    await suggestion(f, { choice: NONE_KEY, createdAt: cairo('2026-10-07T23:59') });
    await suggestion(f, { choice: NONE_KEY, createdAt: cairo('2026-10-08T00:01') });

    expect((await headline(WINDOW)).requests).toBe(2);
  });
});

describe('byResponse', () => {
  it('grades each response on its own, and counts a miss against the one that was sent', async () => {
    const f = await fixture();
    await nineOutcomes(f);

    const rows = await byResponse(WINDOW);
    expect(rows).toEqual([
      {
        id: f.where,
        title: 'Where is my parcel',
        gone: false,
        suggested: 5,
        shown: 4,
        accepted: 1,
        shownReplied: 4,
        shownRight: 2,
        sentAsSuggested: 3,
        viaTab: 1,
        viaPicker: 1,
        unchanged: 1,
        edited: 2,
        replaced: 1,
        ownWords: 1,
        missed: 0,
      },
      {
        id: f.refund,
        title: 'Refund',
        gone: false,
        suggested: 0,
        shown: 0,
        accepted: 0,
        shownReplied: 0,
        shownRight: 0,
        sentAsSuggested: 0,
        viaTab: 0,
        viaPicker: 0,
        unchanged: 0,
        edited: 0,
        replaced: 0,
        ownWords: 0,
        // Sent once instead of Where, and once when Jev said none.
        missed: 2,
      },
    ]);
  });

  it('keeps the frozen title of a response that has since been deleted', async () => {
    const f = await fixture();
    await nineOutcomes(f);
    await db.delete(cannedResponses).where(eq(cannedResponses.id, f.where));

    const [first] = await byResponse(WINDOW);
    expect(first).toMatchObject({
      id: f.where,
      title: 'Where is my parcel',
      gone: true,
      suggested: 5,
    });
  });
});

// The grade was frozen at send. Deleting both responses afterwards must move no
// figure but the live titles — the report's promise that the past is not re-graded.
describe('after the responses are deleted', () => {
  it('counts every outcome exactly as before', async () => {
    const f = await fixture();
    await nineOutcomes(f);
    const before = {
      headline: await headline(WINDOW),
      responses: await byResponse(WINDOW),
      pairs: await confusions(WINDOW),
    };

    await db.delete(cannedResponses).where(eq(cannedResponses.id, f.where));
    await db.delete(cannedResponses).where(eq(cannedResponses.id, f.refund));

    expect(await headline(WINDOW)).toEqual(before.headline);
    expect(await byResponse(WINDOW)).toEqual(
      before.responses.map((row) => ({ ...row, gone: true })),
    );
    expect(await confusions(WINDOW)).toEqual(expect.arrayContaining(before.pairs));
    expect(await confusions(WINDOW)).toHaveLength(before.pairs.length);
  });
});

describe('confusions', () => {
  it('pairs what Jev chose with what was sent instead, none included', async () => {
    const f = await fixture();
    await nineOutcomes(f);

    // A tie on the count is ordered by title, and how Postgres orders 'none'
    // against 'Where' is the database's collation, which is not this test's subject.
    const pairs = await confusions(WINDOW);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { suggestedId: NONE_KEY, suggested: NONE_KEY, sentId: f.refund, sent: 'Refund', count: 1 },
        {
          suggestedId: f.where,
          suggested: 'Where is my parcel',
          sentId: f.refund,
          sent: 'Refund',
          count: 1,
        },
      ]),
    );
  });
});

describe('byProbability', () => {
  it("bands the suggestions on Jev's share for its pick", async () => {
    const f = await fixture();
    await nineOutcomes(f);

    expect(await byProbability(WINDOW)).toEqual([
      { band: 'below 0.3', suggested: 1, shown: 1, accepted: 0, shownReplied: 1, shownRight: 0 },
      { band: '0.3 – 0.6', suggested: 1, shown: 1, accepted: 0, shownReplied: 1, shownRight: 0 },
      { band: '0.6 – 0.9', suggested: 2, shown: 1, accepted: 0, shownReplied: 1, shownRight: 1 },
      {
        band: '0.9 and above',
        suggested: 1,
        shown: 1,
        accepted: 1,
        shownReplied: 1,
        shownRight: 1,
      },
    ]);
  });
});

describe('byChannelAndLanguage', () => {
  it('slices by channel and the customer’s language', async () => {
    const f = await fixture();
    await nineOutcomes(f);
    await suggestion(f, { choice: NONE_KEY, customerLocale: 'en' });

    expect(await byChannelAndLanguage(WINDOW)).toEqual([
      {
        channel: 'facebook',
        locale: 'ar',
        requests: 9,
        suggested: 5,
        shown: 4,
        accepted: 1,
        shownReplied: 4,
        shownRight: 2,
      },
      {
        channel: 'facebook',
        locale: 'en',
        requests: 1,
        suggested: 0,
        shown: 0,
        accepted: 0,
        shownReplied: 0,
        shownRight: 0,
      },
    ]);
  });
});

describe('coverage', () => {
  it('counts the agent replies the suggestions saw, and says when replying and suggesting began', async () => {
    const f = await fixture();
    await nineOutcomes(f);
    await reply(f); // a reply with no suggestion behind it
    await reply(f, cairo('2026-09-20T10:00')); // outside the window

    const result = await coverage(WINDOW);
    expect(result).toMatchObject({ agentReplies: 8, linked: 7 });
    expect(result.lastAgentReplyAt?.toISOString()).toBe(IN_WINDOW.toISOString());
    expect(result.firstSuggestionAt?.toISOString()).toBe(IN_WINDOW.toISOString());
  });
});
