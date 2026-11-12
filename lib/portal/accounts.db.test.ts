import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { contactIdentities, contacts, contactTokens, jobs } from '@/db/schema';
import { hashPassword } from '@/lib/auth/password';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { withCleanDatabase } from '@/lib/testing/db';
import { requestAccount, requestPasswordReset } from './accounts';

/**
 * Registration and the verification email's job asking one question of an
 * address, against Postgres, because the bug was in what got written: on
 * 2026-11-12 the help centre stored an account for an address with two dots in
 * a row, minted its link and queued an email the worker then refused as an
 * invalid payload (`docs/PROJECT-STATE.md` §6.117). So these read back the
 * rows — the contact, the identity, the token and the job — rather than a
 * return value, and the job a registration does queue is parsed with the
 * handler's own schema.
 */

withCleanDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

const PASSWORD = 'Correct-Horse-9-battery';
const REFUSED = 'amira..hassan@gmail.com';

async function written() {
  return {
    contacts: await db.$count(contacts),
    identities: await db.$count(contactIdentities),
    tokens: await db.$count(contactTokens),
    jobs: await db.$count(jobs, eq(jobs.type, 'send_notification_email')),
  };
}

describe('requestAccount', () => {
  it('refuses an address the job would refuse before it writes anything', async () => {
    const before = await written();

    const result = await requestAccount({
      email: REFUSED,
      name: 'Amira',
      password: PASSWORD,
      locale: 'ar',
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_email' });
    // No contact for an address nobody can reach, and no link to it.
    expect(await written()).toEqual(before);
  });

  it('queues a verification email the job accepts for an address it accepts', async () => {
    const result = await requestAccount({
      email: ' Amira.Hassan@Gmail.com ',
      name: 'Amira',
      password: PASSWORD,
      locale: 'ar',
    });
    expect(result).toEqual({ ok: true });

    const [identity] = await db
      .select({ id: contactIdentities.id, isVerified: contactIdentities.isVerified })
      .from(contactIdentities)
      .where(eq(contactIdentities.identifier, 'amira.hassan@gmail.com'));
    expect(identity?.isVerified).toBe(false);
    expect(
      await db
        .select({ purpose: contactTokens.purpose })
        .from(contactTokens)
        .where(eq(contactTokens.identityId, identity!.id)),
    ).toEqual([{ purpose: 'verify_email' }]);

    const queued = await db.select().from(jobs).where(eq(jobs.type, 'send_notification_email'));
    expect(queued).toHaveLength(1);
    // The handler's first line, on the row the registration wrote.
    const payload = parseJobPayload(queued[0] as unknown as ClaimedJob, 'send_notification_email');
    expect(payload.to).toBe('amira.hassan@gmail.com');
  });
});

describe('requestPasswordReset', () => {
  /**
   * The row the 2026-11-12 registration left: an unverified identity holding a
   * password, stored before registration asked the job's question. Every
   * resend — a sign-in, on either form, and a forgotten password — reaches
   * `issueToken` with its address.
   */
  async function storedBeforeTheFix(address: string, isVerified = false): Promise<string> {
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const [identity] = await db
      .insert(contactIdentities)
      .values({
        contactId: contact!.id,
        channel: 'email',
        identifier: address,
        passwordHash: await hashPassword(PASSWORD),
        passwordSetAt: new Date(),
        isVerified,
      })
      .returning({ id: contactIdentities.id });
    return identity!.id;
  }

  it('mints no link and queues no email for a stored address the job refuses', async () => {
    const identityId = await storedBeforeTheFix(REFUSED);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await requestPasswordReset(REFUSED, 'ar');

    expect(await db.$count(contactTokens)).toBe(0);
    expect(await db.$count(jobs, eq(jobs.type, 'send_notification_email'))).toBe(0);
    // The identity names the row; the address is not repeated into the log.
    expect(warn).toHaveBeenCalledWith(
      `[portal_accounts] not issuing verify_email: the send path refuses this identity's address identity=${identityId}`,
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(REFUSED);
  });

  it('still sends the link for a stored address the job accepts', async () => {
    await storedBeforeTheFix('amira.hassan@gmail.com');

    await requestPasswordReset('amira.hassan@gmail.com', 'en');

    const queued = await db.select().from(jobs).where(eq(jobs.type, 'send_notification_email'));
    expect(queued).toHaveLength(1);
    expect(parseJobPayload(queued[0] as unknown as ClaimedJob, 'send_notification_email').to).toBe(
      'amira.hassan@gmail.com',
    );
  });
});
