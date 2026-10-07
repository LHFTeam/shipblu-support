import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, cannedResponses, groupMembers, groups } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { recordCannedUse } from './canned-usage';

/**
 * The per-language split is only worth reading if it moves with the total and
 * never instead of it, and only for a use the agent could actually have made.
 * The update is a hand-built `set` keyed by locale, and the visibility rule is
 * a raw subquery — two things `tsc` checks as objects and nothing checks as a
 * statement until it runs.
 */

withCleanDatabase();

async function agent(email = 'omar@shipblu.test') {
  const [row] = await db
    .insert(agents)
    .values({ name: email.split('@')[0]!, email })
    .returning({ id: agents.id });
  return row!.id;
}

async function insertResponse(values: Partial<typeof cannedResponses.$inferInsert> = {}) {
  const [row] = await db
    .insert(cannedResponses)
    .values({
      title: 'Where is my order',
      bodyTextAr: 'في الطريق.',
      bodyTextEn: 'On its way.',
      ...values,
    })
    .returning({ id: cannedResponses.id });
  return row!.id;
}

async function countsOf(id: string) {
  const [row] = await db
    .select({
      total: cannedResponses.usageCount,
      ar: cannedResponses.usageCountAr,
      en: cannedResponses.usageCountEn,
    })
    .from(cannedResponses)
    .where(eq(cannedResponses.id, id));
  return row;
}

describe('recordCannedUse', () => {
  it('moves the total and the language the response went out in, and no other', async () => {
    const me = await agent();
    const id = await insertResponse();

    await recordCannedUse(me, id, 'ar');
    await recordCannedUse(me, id, 'ar');
    await recordCannedUse(me, id, 'en');

    expect(await countsOf(id)).toEqual({ total: 3, ar: 2, en: 1 });
  });

  it('moves the total alone when the language is not known', async () => {
    const me = await agent();
    const id = await insertResponse();

    await recordCannedUse(me, id, null);

    expect(await countsOf(id)).toEqual({ total: 1, ar: 0, en: 0 });
  });

  // The posted language is a claim. A response with no English cannot have
  // been inserted in English, so the use lands where `resolveLocale` puts it —
  // the same answer the composer gave when it inserted the text.
  it('counts a claimed language the response lacks in the one it has', async () => {
    const me = await agent();
    const id = await insertResponse({ bodyTextEn: '' });

    await recordCannedUse(me, id, 'en');

    expect(await countsOf(id)).toEqual({ total: 1, ar: 1, en: 0 });
  });

  // The history the split cannot attribute: a count from before it began stays
  // in the total, and new uses add to both sides of it.
  it('adds to a total that predates the split without touching what it held', async () => {
    const me = await agent();
    const id = await insertResponse({ usageCount: 5 });

    await recordCannedUse(me, id, 'en');

    expect(await countsOf(id)).toEqual({ total: 6, ar: 0, en: 1 });
  });

  it('touches only the response it names', async () => {
    const me = await agent();
    const id = await insertResponse();
    const other = await insertResponse({ title: 'Refund' });

    await recordCannedUse(me, id, 'ar');

    expect(await countsOf(other)).toEqual({ total: 0, ar: 0, en: 0 });
  });

  // The id arrives in a form field. Somebody else's personal response, and a
  // group's this agent is not on, are not in their picker, so a use posted
  // against either is one they could not have made.
  it("counts nothing for a response the agent may not use, and does for their own and their team's", async () => {
    const me = await agent();
    const someoneElse = await agent('zeina@shipblu.test');
    const [team] = await db
      .insert(groups)
      .values({ name: 'Returns desk' })
      .returning({ id: groups.id });
    const [otherTeam] = await db
      .insert(groups)
      .values({ name: 'Finance desk' })
      .returning({ id: groups.id });
    await db.insert(groupMembers).values({ groupId: team!.id, agentId: me });

    const theirs = await insertResponse({ visibility: 'personal', agentId: someoneElse });
    const notMyTeam = await insertResponse({ visibility: 'group', groupId: otherTeam!.id });
    const mine = await insertResponse({ visibility: 'personal', agentId: me });
    const myTeam = await insertResponse({ visibility: 'group', groupId: team!.id });

    for (const id of [theirs, notMyTeam, mine, myTeam]) await recordCannedUse(me, id, 'ar');

    expect(await countsOf(theirs)).toEqual({ total: 0, ar: 0, en: 0 });
    expect(await countsOf(notMyTeam)).toEqual({ total: 0, ar: 0, en: 0 });
    expect(await countsOf(mine)).toEqual({ total: 1, ar: 1, en: 0 });
    expect(await countsOf(myTeam)).toEqual({ total: 1, ar: 1, en: 0 });
  });

  // `sendReply` runs it after the reply is stored. An id that matches nothing is
  // a response deleted since the composer rendered. A malformed one is dropped
  // by `uuidField` before it gets here, and swallowed here as well, so the
  // contract does not depend on the caller. Neither may fail a reply that has
  // already been sent.
  it('swallows an id that matches nothing and one Postgres refuses', async () => {
    const me = await agent();
    await expect(
      recordCannedUse(me, '00000000-0000-4000-8000-000000000000', 'ar'),
    ).resolves.toBeUndefined();
    await expect(recordCannedUse(me, 'not-a-uuid', 'en')).resolves.toBeUndefined();
  });
});
