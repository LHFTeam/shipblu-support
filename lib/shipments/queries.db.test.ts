import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, shippingAccounts } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { searchContacts } from './queries';

/**
 * The contacts page's search box, which reads people, shipping accounts and
 * shipments at once. What is pinned here is that a name is found however its
 * Arabic letters were spelled, the same answer the inbox gives, and that the
 * columns nobody writes Arabic in keep their plain ILIKE.
 */

withCleanDatabase();

describe('searchContacts', () => {
  it('finds a person and an account whichever way the Arabic was spelled', async () => {
    const [hamza] = await db
      .insert(contacts)
      .values({ name: 'أحمد سمير' })
      .returning({ id: contacts.id });
    await db.insert(contacts).values({ name: 'محمد' });
    const [account] = await db
      .insert(shippingAccounts)
      .values({ sbid: 'SBID4471', name: 'شركة الأمل للتجارة' })
      .returning({ id: shippingAccounts.id });

    const person = await searchContacts('احمد');
    expect(person.contacts.map((row) => row.id)).toEqual([hamza!.id]);

    const business = await searchContacts('الامل');
    expect(business.accounts.map((row) => row.id)).toEqual([account!.id]);
  });

  it('keeps the plain match for email and phone', async () => {
    const [nada] = await db
      .insert(contacts)
      .values({ name: 'Nada', primaryEmail: 'nada@example.test', primaryPhone: '201014428154' })
      .returning({ id: contacts.id });

    expect((await searchContacts('nada@example')).contacts.map((row) => row.id)).toEqual([
      nada!.id,
    ]);
    expect((await searchContacts('01014428154')).contacts.map((row) => row.id)).toEqual([nada!.id]);
  });

  it('answers a query that is only a pasted direction mark with nothing, not everything', async () => {
    await db.insert(contacts).values({ name: 'أحمد' });

    expect(await searchContacts('\u200F')).toEqual({ contacts: [], accounts: [], shipments: [] });
  });
});
