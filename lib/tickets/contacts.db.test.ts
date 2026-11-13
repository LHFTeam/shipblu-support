import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { apiSessions, contactIdentities, contacts } from '@/db/schema';
import { mintSession } from '@/lib/api/sessions';
import { mergeCandidates } from '@/lib/contacts/merge';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { pendingApiContact, resolveApiContactIn, resolveContact } from './contacts';

/**
 * The phone-keyed resolver a myBlu session is minted through
 * (`plans/myblu-ticket-api.md`, _Identity_), against Postgres: which contact a
 * new account hangs off, and two mints at once deciding it under their locks.
 */

withCleanDatabase();

const PHONE = '201001234567';

async function mint(externalUserId: string, phone = PHONE, name: string | null = 'Nour Adel') {
  const outcome = await mintSession({
    externalUserId,
    phone,
    name,
    platform: 'ios',
    appVersion: '5.4.1',
    forwardedFor: null,
    now: new Date(),
  });
  if (outcome.kind !== 'minted') throw new Error(`expected a session, got ${outcome.kind}`);
  return outcome;
}

async function identityOf(externalUserId: string) {
  const [row] = await db
    .select({
      identityId: contactIdentities.id,
      contactId: contactIdentities.contactId,
      isVerified: contactIdentities.isVerified,
    })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channel, 'api'),
        eq(contactIdentities.identifier, `myblu:${externalUserId}`),
      ),
    );
  return row!;
}

async function contact(id: string) {
  const [row] = await db
    .select({ name: contacts.name, primaryPhone: contacts.primaryPhone })
    .from(contacts)
    .where(eq(contacts.id, id));
  return row!;
}

async function whatsappContact(phone = PHONE, name = 'Amira from WhatsApp') {
  const { contactId } = await resolveContact({
    channel: 'whatsapp',
    identifier: phone,
    displayName: name,
  });
  await db.update(contacts).set({ name }).where(eq(contacts.id, contactId));
  return contactId;
}

async function whatsappIdentities(): Promise<number> {
  return (
    await db
      .select({ id: contactIdentities.id })
      .from(contactIdentities)
      .where(eq(contactIdentities.channel, 'whatsapp'))
  ).length;
}

describe('resolving a myBlu account', () => {
  it('gives a new contact for a number nobody holds the number as primary_phone', async () => {
    const minted = await mint('u_1');
    const identity = await identityOf('u_1');

    expect(identity.identityId).toBe(minted.identityId);
    expect(identity.isVerified).toBe(true);
    expect(await contact(identity.contactId)).toEqual({
      name: 'Nour Adel',
      primaryPhone: PHONE,
    });
    // Holding a SIM says nothing about a WhatsApp account.
    expect(await whatsappIdentities()).toBe(0);
  });

  it("joins the number's WhatsApp contact, and leaves its name as it was", async () => {
    const amira = await whatsappContact();

    await mint('u_1');

    expect((await identityOf('u_1')).contactId).toBe(amira);
    expect(await contact(amira)).toEqual({ name: 'Amira from WhatsApp', primaryPhone: PHONE });
    expect(await whatsappIdentities()).toBe(1);
    expect((await db.select({ id: contacts.id }).from(contacts)).length).toBe(1);
  });

  it('gives a second account on that number a contact of its own, with no primary_phone', async () => {
    const amira = await whatsappContact();
    await mint('u_1');

    await mint('u_2', PHONE, 'Somebody else');

    const second = await identityOf('u_2');
    expect(second.contactId).not.toBe(amira);
    expect(await contact(second.contactId)).toEqual({ name: 'Somebody else', primaryPhone: null });
  });

  it('gives a second account on a number another account holds no primary_phone either', async () => {
    await mint('u_1');
    await mint('u_2');

    const [first, second] = [await identityOf('u_1'), await identityOf('u_2')];
    expect(first.contactId).not.toBe(second.contactId);
    expect((await contact(first.contactId)).primaryPhone).toBe(PHONE);
    expect((await contact(second.contactId)).primaryPhone).toBeNull();
  });

  // The order the plan's sentence about a second account was not written for:
  // the first account holds the number as its primary_phone, a WhatsApp
  // contact then writes from it and is rightly suggested against it, and a
  // second account joining that contact would make the suggestion one between
  // two accounts.
  it("gives a second account its own contact when the first account's contact holds the number, WhatsApp contact or not", async () => {
    await mint('u_1');
    const amira = await whatsappContact();

    await mint('u_2', PHONE, 'Somebody else');

    const [first, second] = [await identityOf('u_1'), await identityOf('u_2')];
    expect(second.contactId).not.toBe(amira);
    expect(second.contactId).not.toBe(first.contactId);
    expect(await contact(second.contactId)).toEqual({ name: 'Somebody else', primaryPhone: null });

    // The WhatsApp contact is still offered against the first account's; no
    // pair of accounts is.
    const offered = (await mergeCandidates(first.contactId)).map((c) => c.id);
    expect(offered).toContain(amira);
    expect(offered).not.toContain(second.contactId);
  });

  it("keeps the account's contact when its phone changes, and writes the new phone on the session", async () => {
    await mint('u_1');
    const before = await identityOf('u_1');
    const other = await whatsappContact('201112223334');

    const minted = await mint('u_1', '201112223334', 'A new name');

    const after = await identityOf('u_1');
    expect(after).toEqual(before);
    expect(after.contactId).not.toBe(other);
    expect(await contact(after.contactId)).toEqual({ name: 'Nour Adel', primaryPhone: PHONE });

    // The number each mint vouched for is kept on its own session row.
    const phones = (
      await db
        .select({ phone: apiSessions.phone })
        .from(apiSessions)
        .where(eq(apiSessions.identityId, minted.identityId))
    ).map((r) => r.phone);
    expect(phones.sort()).toEqual([PHONE, '201112223334'].sort());
  });

  it('refuses an identifier that arrives with anything to trim, and a phone with its plus', async () => {
    await expect(
      pendingApiContact({ identifier: ' myblu:u_1', phone: PHONE, name: null }),
    ).rejects.toThrow();
    await expect(
      pendingApiContact({ identifier: 'myblu:u_1', phone: `+${PHONE}`, name: null }),
    ).rejects.toThrow();
  });
});

describe('two mints at once', () => {
  it("on one phone under two accounts end on two contacts, the WhatsApp contact's and a new one", async () => {
    const amira = await whatsappContact();

    // The first holds the contact's row lock and its identity, uncommitted; the
    // second read the contact as free before either wrote, and waits on the lock.
    const held = holdNextTransaction('after');
    const first = mint('u_1');
    await held.atHold;
    const second = mint('u_2');
    expect(await untilWaitingOnALock(db, { rowLockIn: '^\\s*select\\M' })).toBe(true);
    held.release();
    await Promise.all([first, second]);

    const [one, two] = [await identityOf('u_1'), await identityOf('u_2')];
    expect(one.contactId).toBe(amira);
    expect(two.contactId).not.toBe(amira);
    expect((await contact(two.contactId)).primaryPhone).toBeNull();
  });

  it('on a number nobody holds give the number to one contact only', async () => {
    const held = holdNextTransaction('after');
    const first = mint('u_1');
    await held.atHold;
    const second = mint('u_2');
    // On the number's advisory lock: there is no row to wait on.
    expect(await untilWaitingOnALock(db)).toBe(true);
    held.release();
    await Promise.all([first, second]);

    const phones = await Promise.all(
      ['u_1', 'u_2'].map(
        async (id) => (await contact((await identityOf(id)).contactId)).primaryPhone,
      ),
    );
    expect(phones).toEqual([PHONE, null]);
  });

  it("on a number another account is still writing as its primary_phone keep the second account off the number's WhatsApp contact", async () => {
    // The first read the number as free, wrote it on its new contact and holds
    // the number's lock, uncommitted; the WhatsApp contact arrives meanwhile,
    // and the second account reads it as the number's contact to join.
    const held = holdNextTransaction('after');
    const first = mint('u_1');
    await held.atHold;
    const amira = await whatsappContact();
    const second = mint('u_2', PHONE, 'Somebody else');
    // On the number's lock, taken under the WhatsApp contact's row lock before
    // it joins: asked without it, the first account's primary_phone was not
    // there to see yet.
    expect(await untilWaitingOnALock(db)).toBe(true);
    held.release();
    await Promise.all([first, second]);

    const [one, two] = [await identityOf('u_1'), await identityOf('u_2')];
    expect((await contact(one.contactId)).primaryPhone).toBe(PHONE);
    expect(two.contactId).not.toBe(amira);
    expect(two.contactId).not.toBe(one.contactId);
    expect((await contact(two.contactId)).primaryPhone).toBeNull();
  });

  it('for one account leave one identity and one contact', async () => {
    const held = holdNextTransaction('after');
    const first = mint('u_1');
    await held.atHold;
    const second = mint('u_1');
    expect(await untilWaitingOnALock(db)).toBe(true);
    held.release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.identityId).toBe(b.identityId);
    expect((await db.select({ id: contacts.id }).from(contacts)).length).toBe(1);
    expect((await db.select({ hash: apiSessions.tokenHash }).from(apiSessions)).length).toBe(2);
  });
});

describe('resolveApiContactIn', () => {
  it('writes nothing outside the transaction it is handed', async () => {
    const pending = await pendingApiContact({ identifier: 'myblu:u_1', phone: PHONE, name: null });
    await expect(
      db.transaction(async (tx) => {
        await resolveApiContactIn(tx, pending);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    expect(await db.select({ id: contacts.id }).from(contacts)).toEqual([]);
    expect(await db.select({ id: contactIdentities.id }).from(contactIdentities)).toEqual([]);
  });
});
