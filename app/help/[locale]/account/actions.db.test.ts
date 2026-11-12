import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { contactIdentities, contacts, contactTokens, jobs } from '@/db/schema';
import { hashPassword } from '@/lib/auth/password';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * The help centre's three forms that take an address, against Postgres: each
 * answers an address the verification email's job would refuse with a sentence
 * the customer can act on, and writes nothing for it.
 *
 * On 2026-11-12 registration asked a regex of its own, which let two dots in a
 * row through; it stored the account, answered "check your inbox", and the job
 * refused the address on its first attempt (`docs/PROJECT-STATE.md` §6.117).
 * The account it left behind is what the sign-in and forgotten-password cases
 * start from.
 */

const dispatches = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/auth/throttle', () => ({
  allowLoginAttempt: () => true,
  clearLoginAttempts: () => undefined,
  allowEmailDispatch: (email: string) => {
    dispatches.push(email);
    return true;
  },
}));
vi.mock('@/lib/http/request-meta', () => ({
  requestMeta: async () => ({ ip: '198.51.100.7', userAgent: null }),
}));
vi.mock('@/lib/auth/customer-session', () => ({
  createCustomerSession: async () => undefined,
  destroyCustomerSession: async () => undefined,
  destroyAllCustomerSessions: async () => undefined,
}));
// Next's redirect throws to end the action; the test only needs to know it ran.
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const { portalForgotPassword, portalRegister, portalSignIn } = await import('./actions');

withCleanDatabase();

beforeEach(() => {
  dispatches.length = 0;
});

const INITIAL = { error: null };
const PASSWORD = 'Correct-Horse-9-battery';
const REFUSED = 'amira..hassan@gmail.com';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set('locale', 'ar');
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function written() {
  return {
    contacts: await db.$count(contacts),
    identities: await db.$count(contactIdentities),
    tokens: await db.$count(contactTokens),
    jobs: await db.$count(jobs, eq(jobs.type, 'send_notification_email')),
  };
}

/** The unverified account a registration made before the two checks were one. */
async function storedBeforeTheFix(): Promise<void> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning({
    id: contacts.id,
  });
  await db.insert(contactIdentities).values({
    contactId: contact!.id,
    channel: 'email',
    identifier: REFUSED,
    passwordHash: await hashPassword(PASSWORD),
    passwordSetAt: new Date(),
    isVerified: false,
  });
}

describe('portalRegister', () => {
  it('answers an address the job refuses with a sentence, before the throttle, writing nothing', async () => {
    const before = await written();

    expect(
      await portalRegister(INITIAL, form({ email: REFUSED, name: 'Amira', password: PASSWORD })),
    ).toEqual({ error: 'errorInvalidEmail' });

    expect(await written()).toEqual(before);
    // A typo spends nothing of the address's allowance, and is never answered
    // with the silent success a throttled request gets.
    expect(dispatches).toEqual([]);
  });

  it('queues a link the job accepts for the address as it is typed into the form', async () => {
    expect(
      await portalRegister(
        INITIAL,
        form({ email: ' Amira.Hassan@Gmail.com ', name: 'Amira', password: PASSWORD }),
      ),
    ).toEqual({ error: null, done: true });

    const queued = await db.select().from(jobs).where(eq(jobs.type, 'send_notification_email'));
    expect(queued).toHaveLength(1);
    expect(parseJobPayload(queued[0] as unknown as ClaimedJob, 'send_notification_email').to).toBe(
      'amira.hassan@gmail.com',
    );
  });
});

describe('the account a registration left before the fix', () => {
  it('is told on sign-in that the address is not valid, rather than to check an inbox', async () => {
    await storedBeforeTheFix();
    const before = await written();

    expect(await portalSignIn(INITIAL, form({ email: REFUSED, password: PASSWORD }))).toEqual({
      error: 'errorInvalidEmail',
    });
    expect(await written()).toEqual(before);
  });

  it('is told the same by the forgotten-password form, which sends nothing', async () => {
    await storedBeforeTheFix();
    const before = await written();

    expect(await portalForgotPassword(INITIAL, form({ email: REFUSED }))).toEqual({
      error: 'errorInvalidEmail',
    });
    expect(await written()).toEqual(before);
    expect(dispatches).toEqual([]);
  });
});
