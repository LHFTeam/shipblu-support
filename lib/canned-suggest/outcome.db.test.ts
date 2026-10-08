import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { recordCannedUse } from '@/lib/tickets/canned-usage';
import { withCleanDatabase } from '@/lib/testing/db';
import { recordSuggestionEvent } from './events';
import { recordSuggestionOutcome } from './outcome';
import { NONE_KEY, REQUEST_VERSION } from './request';

/**
 * What happens to a suggestion after Jev answered: the events the composer
 * reports, and the grade a sent reply gives it. Both take an id out of the
 * browser, so most of what is pinned here is what they refuse — somebody
 * else's suggestion, the wrong ticket, a second link, an event that contradicts
 * one already recorded.
 */

withCleanDatabase();

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function agent(email = 'omar@shipblu.test') {
  const [row] = await db.insert(agents).values({ name: email, email }).returning({ id: agents.id });
  return row!.id;
}

async function ticket() {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel: 'facebook', statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

async function reply(conversationId: string, agentId: string, text: string) {
  const [row] = await db
    .insert(messages)
    .values({ conversationId, direction: 'outbound', authorAgentId: agentId, bodyText: text })
    .returning({ id: messages.id });
  return row!.id;
}

const BODY_AR = 'حضرتك الشحنة في الطريق.';
const BODY_EN = 'Your parcel is on its way.';

async function canned(title = 'Where is my parcel') {
  const [row] = await db
    .insert(cannedResponses)
    .values({ title, bodyTextAr: BODY_AR, bodyTextEn: BODY_EN })
    .returning({ id: cannedResponses.id });
  return row!.id;
}

/** An answered suggestion, as `suggestFor` leaves one. */
async function suggestion(
  conversationId: string,
  agentId: string,
  choice: string,
  values: Partial<typeof cannedSuggestions.$inferInsert> = {},
) {
  const [row] = await db
    .insert(cannedSuggestions)
    .values({
      conversationId,
      agentId,
      channel: 'facebook',
      requestVersion: REQUEST_VERSION,
      choice,
      cannedResponseId: choice === NONE_KEY ? null : choice,
      settledAt: new Date(),
      ...values,
    })
    .returning({ id: cannedSuggestions.id });
  return row!.id;
}

async function row(id: string) {
  const [found] = await db.select().from(cannedSuggestions).where(eq(cannedSuggestions.id, id));
  return found!;
}

describe('recordSuggestionEvent', () => {
  it('records the first time a suggestion was shown, and keeps it', async () => {
    const me = await agent();
    const id = await suggestion(await ticket(), me, await canned());

    expect(await recordSuggestionEvent(me, id, 'shown')).toBe(true);
    const first = (await row(id)).shownAt;
    expect(first).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordSuggestionEvent(me, id, 'shown');
    expect((await row(id)).shownAt).toEqual(first);
  });

  it('marks a taken suggestion as seen too, in case that report was lost', async () => {
    const me = await agent();
    const id = await suggestion(await ticket(), me, await canned());

    await recordSuggestionEvent(me, id, 'accepted');

    const taken = await row(id);
    expect(taken.acceptedAt).toBeInstanceOf(Date);
    expect(taken.shownAt).toBeInstanceOf(Date);
  });

  it("answers somebody else's suggestion, and a malformed id, as missing", async () => {
    const me = await agent();
    const them = await agent('nour@shipblu.test');
    const id = await suggestion(await ticket(), them, await canned());

    expect(await recordSuggestionEvent(me, id, 'accepted')).toBe(false);
    expect(await recordSuggestionEvent(me, 'not-a-uuid', 'shown')).toBe(false);
    expect((await row(id)).acceptedAt).toBeNull();
  });

  it('will not take a suggestion that was waved away, nor wave away one that was taken', async () => {
    const me = await agent();
    const conversationId = await ticket();
    const where = await canned();
    const waved = await suggestion(conversationId, me, where);
    const taken = await suggestion(conversationId, me, where, {
      anchorMessageId: await reply(conversationId, me, 'x'),
    });

    await recordSuggestionEvent(me, waved, 'dismissed');
    expect(await recordSuggestionEvent(me, waved, 'accepted')).toBe(true);
    expect((await row(waved)).acceptedAt).toBeNull();

    await recordSuggestionEvent(me, taken, 'accepted');
    await recordSuggestionEvent(me, taken, 'dismissed');
    expect((await row(taken)).dismissedAt).toBeNull();
  });

  it('records nothing against a none, which had nothing on screen to take', async () => {
    const me = await agent();
    const id = await suggestion(await ticket(), me, NONE_KEY);

    await recordSuggestionEvent(me, id, 'shown');
    await recordSuggestionEvent(me, id, 'accepted');

    expect(await row(id)).toMatchObject({ shownAt: null, acceptedAt: null });
  });

  it('leaves a suggestion alone once a reply has settled it', async () => {
    const me = await agent();
    const id = await suggestion(await ticket(), me, await canned(), { repliedAt: new Date() });

    await recordSuggestionEvent(me, id, 'accepted');

    expect((await row(id)).acceptedAt).toBeNull();
  });
});

describe('recordSuggestionOutcome', () => {
  it('grades a reply that carried the suggested response, sent as it stood, as right and unchanged', async () => {
    const me = await agent();
    const conversationId = await ticket();
    const where = await canned();
    const id = await suggestion(conversationId, me, where);
    const messageId = await reply(conversationId, me, BODY_AR);

    const used = await recordCannedUse(me, where, 'ar');
    await recordSuggestionOutcome(me, id, {
      conversationId,
      messageId,
      body: `${BODY_AR}\r\n`,
      used,
    });

    expect(await row(id)).toMatchObject({
      messageId,
      sentCannedResponseId: where,
      sentCannedTitle: 'Where is my parcel',
      sentLocale: 'ar',
      sentMatches: true,
      sentEdit: 'unchanged',
    });
    expect((await row(id)).repliedAt).toBeInstanceOf(Date);
  });

  it('calls the suggested text sent with something added extended, and a rewrite reworded', async () => {
    const me = await agent();
    const conversationId = await ticket();
    const where = await canned();
    const added = await suggestion(conversationId, me, where);
    const rewritten = await suggestion(conversationId, me, where, {
      anchorMessageId: await reply(conversationId, me, 'earlier'),
    });

    const used = await recordCannedUse(me, where, 'en');
    await recordSuggestionOutcome(me, added, {
      conversationId,
      messageId: await reply(conversationId, me, 'a'),
      body: `Hi Amira,\n\n${BODY_EN}`,
      used,
    });
    await recordSuggestionOutcome(me, rewritten, {
      conversationId,
      messageId: await reply(conversationId, me, 'b'),
      body: 'It will arrive tomorrow.',
      used,
    });

    expect((await row(added)).sentEdit).toBe('extended');
    expect((await row(rewritten)).sentEdit).toBe('reworded');
  });

  it('grades a different response, or none at all, as wrong — and a reply of its own after none as right', async () => {
    const me = await agent();
    const conversationId = await ticket();
    const where = await canned();
    const refund = await canned('Refund');
    const replaced = await suggestion(conversationId, me, where);
    const ignored = await suggestion(conversationId, me, where, {
      anchorMessageId: await reply(conversationId, me, '1'),
    });
    const none = await suggestion(conversationId, me, NONE_KEY, {
      anchorMessageId: await reply(conversationId, me, '2'),
    });

    await recordSuggestionOutcome(me, replaced, {
      conversationId,
      messageId: await reply(conversationId, me, 'r'),
      body: BODY_EN,
      used: await recordCannedUse(me, refund, 'en'),
    });
    await recordSuggestionOutcome(me, ignored, {
      conversationId,
      messageId: await reply(conversationId, me, 'i'),
      body: 'typed by hand',
      used: null,
    });
    await recordSuggestionOutcome(me, none, {
      conversationId,
      messageId: await reply(conversationId, me, 'n'),
      body: 'typed by hand',
      used: null,
    });

    expect(await row(replaced)).toMatchObject({
      sentMatches: false,
      sentCannedResponseId: refund,
      sentCannedTitle: 'Refund',
      sentEdit: null,
    });
    expect(await row(ignored)).toMatchObject({ sentMatches: false, sentCannedResponseId: null });
    expect(await row(none)).toMatchObject({ sentMatches: true, sentEdit: null });
  });

  it('links nothing for another agent, another ticket, or a suggestion already linked', async () => {
    const me = await agent();
    const them = await agent('nour@shipblu.test');
    const conversationId = await ticket();
    const elsewhere = await ticket();
    const where = await canned();
    const theirs = await suggestion(conversationId, them, where);
    const mine = await suggestion(conversationId, me, where);

    const first = await reply(conversationId, me, 'one');
    await recordSuggestionOutcome(me, theirs, {
      conversationId,
      messageId: first,
      body: BODY_EN,
      used: null,
    });
    await recordSuggestionOutcome(me, mine, {
      conversationId: elsewhere,
      messageId: first,
      body: BODY_EN,
      used: null,
    });
    expect((await row(theirs)).messageId).toBeNull();
    expect((await row(mine)).messageId).toBeNull();

    await recordSuggestionOutcome(me, mine, {
      conversationId,
      messageId: first,
      body: BODY_EN,
      used: null,
    });
    const second = await reply(conversationId, me, 'two');
    await recordSuggestionOutcome(me, mine, {
      conversationId,
      messageId: second,
      body: BODY_EN,
      used: null,
    });
    expect((await row(mine)).messageId).toBe(first);
  });

  it('links nothing to a suggestion that failed, and never throws', async () => {
    const me = await agent();
    const conversationId = await ticket();
    const failed = await suggestion(conversationId, me, NONE_KEY, {
      choice: null,
      error: 'TypeSafe returned 429',
    });
    const messageId = await reply(conversationId, me, 'x');

    await recordSuggestionOutcome(me, failed, { conversationId, messageId, body: 'x', used: null });
    await expect(
      recordSuggestionOutcome(me, 'not-a-uuid', {
        conversationId,
        messageId,
        body: 'x',
        used: null,
      }),
    ).resolves.toBeUndefined();

    expect((await row(failed)).messageId).toBeNull();
  });
});
