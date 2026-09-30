import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { searchMergeCandidates } from './merge';

/**
 * The merge picker's own search. A duplicate is very often the same person
 * written two ways — أحمد on the WhatsApp record, احمد on the email one — so a
 * picker that only finds the exact spelling hides the one duplicate it exists
 * to find.
 */

withCleanDatabase();

async function contact(name: string): Promise<string> {
  const [row] = await db.insert(contacts).values({ name }).returning({ id: contacts.id });
  return row!.id;
}

describe('searchMergeCandidates', () => {
  it('offers a duplicate spelled with a hamza to an agent who typed without one', async () => {
    const self = await contact('احمد سمير');
    const duplicate = await contact('أحمد سمير');
    await contact('محمد سمير');

    const found = await searchMergeCandidates(self, 'احمد');

    expect(found.map((row) => row.id)).toEqual([duplicate]);
  });

  it('answers a query that is only a pasted direction mark with nothing', async () => {
    const self = await contact('احمد');
    await contact('أحمد');

    expect(await searchMergeCandidates(self, '\u200F')).toEqual([]);
  });
});
