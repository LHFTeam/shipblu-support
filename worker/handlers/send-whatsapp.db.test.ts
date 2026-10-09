import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  channels,
  contacts,
  conversations,
  messages,
  ticketStatuses,
  whatsappAccounts,
  whatsappCredentialEvents,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { credentialBadges } from '@/lib/whatsapp/credential-status';
import { credentialStatuses, storeBusinessToken } from '@/lib/whatsapp/credentials';
import { sendWhatsApp } from './send-whatsapp';

/**
 * A reply Meta refuses with 190 on a stored credential is recorded on the
 * credential as well as explained on the message: the console's "refused by
 * Meta" badge is what sends an admin to Reconnect, and an agent's reply is
 * usually the first thing to bounce — the hourly template sync would badge it
 * up to an hour later. Against Postgres, because the record is a transition
 * under a row lock, with Graph stubbed.
 */

withCleanDatabase();

const NUMBER = '106540352242922';
const STORED = 'EAAGm0PX4ZCpsBAEXAMPLEstoredTokenValue123456';
const RESTORED = 'EAAGm0PX4ZCpsBAEXAMPLEreconnectedToken654321';
const saved = { ...process.env };

beforeEach(() => {
  process.env.WHATSAPP_CREDENTIAL_KEY = 'k'.repeat(20) + 'send-test-credential-key';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

async function account(values: { tokenEnvVar?: string | null } = {}) {
  const [row] = await db
    .insert(whatsappAccounts)
    .values({ name: 'Egypt', wabaId: '111111', ...values })
    .returning({ id: whatsappAccounts.id, wabaId: whatsappAccounts.wabaId });
  return row!;
}

async function store(row: { id: string; wabaId: string }, token = STORED) {
  await db.transaction((tx) =>
    storeBusinessToken(tx, {
      accountId: row.id,
      wabaId: row.wabaId,
      token,
      inspection: null,
      businessId: null,
      actor: null,
    }),
  );
}

/** An agent's reply inside the customer's window, on a number owned by `accountId`. */
async function reply(accountId: string): Promise<string> {
  const [channel] = await db
    .insert(channels)
    .values({
      type: 'whatsapp',
      name: 'ShipBlu',
      whatsappAccountId: accountId,
      config: { phoneNumberId: NUMBER },
    })
    .returning({ id: channels.id });
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [conversation] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: open!.id,
      channel: 'whatsapp',
      channelId: channel!.id,
      lastCustomerMessageAt: new Date(Date.now() - 60_000),
    })
    .returning({ id: conversations.id });
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: conversation!.id,
      direction: 'outbound',
      bodyText: 'Your parcel is on its way.',
      toAddresses: ['201001234567'],
    })
    .returning({ id: messages.id });
  return message!.id;
}

const job = (messageId: string) =>
  ({ id: 'job-1', type: 'send_whatsapp', payload: { messageId } }) as unknown as ClaimedJob;

const refusedBy = (code: number, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status: code === 190 ? 401 : 400 });

/** The audit trail's `refused` events for the account. */
async function refusals(accountId: string): Promise<number> {
  const rows = await db
    .select({ id: whatsappCredentialEvents.id })
    .from(whatsappCredentialEvents)
    .where(
      and(
        eq(whatsappCredentialEvents.whatsappAccountId, accountId),
        eq(whatsappCredentialEvents.event, 'refused'),
      ),
    );
  return rows.length;
}

async function delivery(messageId: string) {
  const [row] = await db
    .select({ status: messages.deliveryStatus, error: messages.deliveryError })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row!;
}

describe('sendWhatsApp: a stored credential Meta refuses', () => {
  it('records the refusal on the credential, once however often the send is retried', async () => {
    const row = await account();
    await store(row);
    const messageId = await reply(row.id);
    const fetch = stubFetch(async () => refusedBy(190, 'Session has expired on Tuesday'));

    // Retryable on purpose: the reply still delivers on the attempt after a reconnect.
    await expect(sendWhatsApp(job(messageId))).rejects.toThrow();
    await expect(sendWhatsApp(job(messageId))).rejects.toThrow();

    const [, init] = fetch.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${STORED}`);

    expect(await delivery(messageId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('reconnected through Meta'),
    });

    const status = (await credentialStatuses()).get(row.id)!;
    expect(status.lastRefusedAt).toBeInstanceOf(Date);
    // Meta's sentence, not the explanation the agent reads.
    expect(status.lastRefusal).toBe('Session has expired on Tuesday');
    expect(credentialBadges(status, new Date()).map((badge) => badge.kind)).toContain('refused');
    // One for both attempts: the event marks the transition, not each bounce.
    expect(await refusals(row.id)).toBe(1);
  });

  /**
   * Resolved, then answered a moment later: a Reconnect in between replaced the
   * credential, and the old token's refusal must not badge the fresh one —
   * which nothing but the next hourly sync would clear.
   */
  it('records nothing when the credential was replaced while the send was in flight', async () => {
    const row = await account();
    await store(row);
    const messageId = await reply(row.id);
    stubFetch(async () => {
      await store(row, RESTORED);
      return refusedBy(190, 'Session has expired on Tuesday');
    });

    await expect(sendWhatsApp(job(messageId))).rejects.toThrow();

    const status = (await credentialStatuses()).get(row.id)!;
    expect(status.lastRefusedAt).toBeNull();
    expect(credentialBadges(status, new Date()).map((badge) => badge.kind)).not.toContain(
      'refused',
    );
    expect(await refusals(row.id)).toBe(0);
  });

  it('records nothing for a refusal that is not about the credential', async () => {
    const row = await account();
    await store(row);
    const messageId = await reply(row.id);
    stubFetch(async () => refusedBy(131026, 'Message undeliverable'));

    // Permanent: nothing a retry could fix, so the job is consumed.
    await sendWhatsApp(job(messageId));

    expect((await delivery(messageId)).status).toBe('failed');
    expect((await credentialStatuses()).get(row.id)!.lastRefusedAt).toBeNull();
    expect(await refusals(row.id)).toBe(0);
  });

  /**
   * A variable or the shared token is fixed on Render, and has no stored row
   * to badge; the explanation on the message says which one.
   */
  it('records nothing for a token read from a variable or the shared one', async () => {
    process.env.WHATSAPP_TOKEN_EGYPT = 'EAAGvariableTokenValue0123456789';
    process.env.META_PAGE_ACCESS_TOKEN = 'EAAGsharedTokenValue0123456789';
    resetEnvCache();
    const named = await account({ tokenEnvVar: 'WHATSAPP_TOKEN_EGYPT' });
    const messageId = await reply(named.id);
    stubFetch(async () => refusedBy(190, 'Session has expired on Tuesday'));

    await expect(sendWhatsApp(job(messageId))).rejects.toThrow();
    expect((await delivery(messageId)).error).toContain('WHATSAPP_TOKEN_EGYPT');

    await db.update(whatsappAccounts).set({ tokenEnvVar: null });
    await expect(sendWhatsApp(job(messageId))).rejects.toThrow();
    expect((await delivery(messageId)).error).toContain('META_PAGE_ACCESS_TOKEN');

    expect(await credentialStatuses()).toEqual(new Map());
    expect(await refusals(named.id)).toBe(0);
  });
});
