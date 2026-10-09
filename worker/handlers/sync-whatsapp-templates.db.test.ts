import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { whatsappAccounts, whatsappTemplates } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { credentialStatuses, storeBusinessToken } from '@/lib/whatsapp/credentials';
import { syncWhatsAppTemplates } from './sync-whatsapp-templates';

/**
 * The hourly sync is the only thing that exercises a stored credential every
 * hour, so it is where Meta's verdict on one is recorded: a refusal on the
 * credential and on the account, explained as a reconnect rather than as the
 * shared token; a success clearing it. Against Postgres, with Graph stubbed.
 */

withCleanDatabase();

const STORED = 'EAAGm0PX4ZCpsBAEXAMPLEstoredTokenValue123456';
const saved = { ...process.env };

beforeEach(() => {
  // Unset on purpose: an install whose only credential is a stored one is a
  // working install, and the sync must not skip it as unconfigured.
  delete process.env.META_PAGE_ACCESS_TOKEN;
  process.env.WHATSAPP_CREDENTIAL_KEY = 'k'.repeat(20) + 'sync-test-credential-key';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

async function connected() {
  const [account] = await db
    .insert(whatsappAccounts)
    .values({ name: 'Egypt', wabaId: '111111' })
    .returning({ id: whatsappAccounts.id, wabaId: whatsappAccounts.wabaId });

  await db.transaction((tx) =>
    storeBusinessToken(tx, {
      accountId: account!.id,
      wabaId: account!.wabaId,
      token: STORED,
      inspection: null,
      businessId: null,
      actor: null,
    }),
  );
  return account!;
}

async function accountRow(id: string) {
  const [row] = await db
    .select({
      lastSyncError: whatsappAccounts.lastSyncError,
      lastSyncedAt: whatsappAccounts.lastSyncedAt,
    })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.id, id));
  return row!;
}

describe('syncWhatsAppTemplates with a stored credential', () => {
  it('sends with the stored token, and records a refusal as a reconnect', async () => {
    const account = await connected();
    const fetch = stubFetch(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 190, message: 'Session has expired on Tuesday' } }),
          { status: 401 },
        ),
    );

    await expect(syncWhatsAppTemplates()).rejects.toThrow(/1 of 1 WhatsApp business account/);

    const [, init] = fetch.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${STORED}`);

    const row = await accountRow(account.id);
    expect(row.lastSyncError).toContain('Session has expired on Tuesday');
    expect(row.lastSyncError).toContain('reconnected through Meta');
    expect(row.lastSyncError).not.toContain('META_PAGE_ACCESS_TOKEN');

    expect((await credentialStatuses()).get(account.id)).toMatchObject({
      lastRefusal: expect.stringContaining('Session has expired on Tuesday'),
    });
  });

  it('clears the refusal on the first sync that works', async () => {
    const account = await connected();
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: { code: 190, message: 'expired' } }), {
          status: 401,
        }),
    );
    await expect(syncWhatsAppTemplates()).rejects.toThrow();

    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 't-1',
                name: 'shipment_update',
                language: 'ar',
                category: 'UTILITY',
                status: 'APPROVED',
                components: [],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await syncWhatsAppTemplates();

    const status = (await credentialStatuses()).get(account.id)!;
    expect(status.lastRefusedAt).toBeNull();
    expect(status.lastVerifiedAt).toBeInstanceOf(Date);
    expect((await accountRow(account.id)).lastSyncError).toBeNull();
    expect(await db.select({ name: whatsappTemplates.name }).from(whatsappTemplates)).toEqual([
      { name: 'shipment_update' },
    ]);
  });
});
