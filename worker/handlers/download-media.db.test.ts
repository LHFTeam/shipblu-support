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
import { credentialStatuses, storeBusinessToken } from '@/lib/whatsapp/credentials';
import { downloadMediaJob } from './download-media';

/**
 * A customer's photo that cannot be fetched because Meta refused the stored
 * credential (190) badges the credential, as a refused send does, rather than
 * waiting for the hourly template sync — and still fails the attempt, so the
 * file downloads on the retry after a reconnect. Against Postgres, because the
 * record is a transition under a row lock, with Graph stubbed.
 */

withCleanDatabase();

const NUMBER = '106540352242922';
const STORED = 'EAAGm0PX4ZCpsBAEXAMPLEstoredTokenValue123456';
const saved = { ...process.env };

beforeEach(() => {
  process.env.WHATSAPP_CREDENTIAL_KEY = 'k'.repeat(20) + 'media-test-credential-key';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

async function storedAccount() {
  const [row] = await db
    .insert(whatsappAccounts)
    .values({ name: 'Egypt', wabaId: '111111' })
    .returning({ id: whatsappAccounts.id, wabaId: whatsappAccounts.wabaId });
  await db.transaction((tx) =>
    storeBusinessToken(tx, {
      accountId: row!.id,
      wabaId: row!.wabaId,
      token: STORED,
      inspection: null,
      businessId: null,
      actor: null,
    }),
  );
  return row!.id;
}

/** A customer's photo, received on a number owned by `accountId`, not yet stored. */
async function photo(accountId: string): Promise<string> {
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
    })
    .returning({ id: conversations.id });
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: conversation!.id,
      direction: 'inbound',
      bodyText: '',
      meta: { phoneNumberId: NUMBER, media: { id: 'media-1', mimeType: 'image/jpeg' } },
    })
    .returning({ id: messages.id });
  return message!.id;
}

const job = (messageId: string) =>
  ({
    id: 'job-1',
    type: 'download_media',
    payload: { messageId, mediaId: 'media-1' },
  }) as unknown as ClaimedJob;

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

describe('downloadMediaJob: a stored credential Meta refuses', () => {
  it('records the refusal on the credential, and fails the attempt so a retry can fetch it', async () => {
    const accountId = await storedAccount();
    const messageId = await photo(accountId);
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 190, message: 'Session has expired on Tuesday' } }),
          { status: 401 },
        ),
    );

    await expect(downloadMediaJob(job(messageId))).rejects.toMatchObject({ code: 190 });
    await expect(downloadMediaJob(job(messageId))).rejects.toMatchObject({ code: 190 });

    expect((await credentialStatuses()).get(accountId)?.lastRefusal).toBe(
      'Session has expired on Tuesday',
    );
    // Once per refusal, however often the job is retried.
    expect(await refusals(accountId)).toBe(1);

    // Not marked undownloadable: a 190 is the credential, not the file.
    const [row] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect((row!.meta as { media: Record<string, unknown> }).media.downloaded).toBeUndefined();
  });

  it('records nothing for a failure that is not about the credential', async () => {
    const accountId = await storedAccount();
    const messageId = await photo(accountId);
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: { code: 100, message: 'Unsupported get request' } }), {
          status: 400,
        }),
    );

    await downloadMediaJob(job(messageId));

    expect((await credentialStatuses()).get(accountId)?.lastRefusal).toBeNull();
    expect(await refusals(accountId)).toBe(0);
  });
});
