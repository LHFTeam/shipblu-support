import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { recordCannedUse } from './canned-usage';

/**
 * The per-language split is only worth reading if it moves with the total and
 * never instead of it. The update is a hand-built `set` keyed by locale, which
 * `tsc` checks as an object and nothing checks as a statement until it runs.
 */

withCleanDatabase();

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
    const id = await insertResponse();

    await recordCannedUse(id, 'ar');
    await recordCannedUse(id, 'ar');
    await recordCannedUse(id, 'en');

    expect(await countsOf(id)).toEqual({ total: 3, ar: 2, en: 1 });
  });

  it('moves the total alone when the language is not known', async () => {
    const id = await insertResponse();

    await recordCannedUse(id, null);

    expect(await countsOf(id)).toEqual({ total: 1, ar: 0, en: 0 });
  });

  // The history the split cannot attribute: a count from before it began stays
  // in the total, and new uses add to both sides of it.
  it('adds to a total that predates the split without touching what it held', async () => {
    const id = await insertResponse({ usageCount: 5 });

    await recordCannedUse(id, 'en');

    expect(await countsOf(id)).toEqual({ total: 6, ar: 0, en: 1 });
  });

  it('touches only the response it names', async () => {
    const id = await insertResponse();
    const other = await insertResponse({ title: 'Refund' });

    await recordCannedUse(id, 'ar');

    expect(await countsOf(other)).toEqual({ total: 0, ar: 0, en: 0 });
  });

  // `sendReply` runs it after the reply is stored. An id that matches nothing is
  // a response deleted since the composer rendered. A malformed one is dropped
  // by `uuidField` before it gets here, and swallowed here as well, so the
  // contract does not depend on the caller. Neither may fail a reply that has
  // already been sent.
  it('swallows an id that matches nothing and one Postgres refuses', async () => {
    await expect(
      recordCannedUse('00000000-0000-4000-8000-000000000000', 'ar'),
    ).resolves.toBeUndefined();
    await expect(recordCannedUse('not-a-uuid', 'en')).resolves.toBeUndefined();
  });
});
