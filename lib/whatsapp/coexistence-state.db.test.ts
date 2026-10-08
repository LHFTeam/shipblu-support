import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { channels, whatsappAccounts } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { parseCoexistence } from './coexistence';
import { applyWhatsAppAccountUpdate } from './coexistence-state';
import { credentialStatuses, storeBusinessToken } from './credentials';

/**
 * What Meta's `account_update` events do to a coexistence channel. Applied
 * without a delivery key (`./delivery-id` says why), so each must be safe to
 * apply twice and must touch only the number it names.
 */

withCleanDatabase();

const WABA = '102290129340398';
const saved = { ...process.env };

beforeEach(() => {
  process.env.WHATSAPP_CREDENTIAL_KEY = 'k'.repeat(20) + 'coexistence-state-test-key';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

async function connectedAccount() {
  const [account] = await db
    .insert(whatsappAccounts)
    .values({ name: 'ShipBlu', wabaId: WABA })
    .returning({ id: whatsappAccounts.id });
  await db.transaction((tx) =>
    storeBusinessToken(tx, {
      accountId: account!.id,
      wabaId: WABA,
      token: 'EAAGm0PX4ZCpsBAcoexistenceStateTestToken0123',
      inspection: null,
      businessId: null,
      actor: null,
    }),
  );
  return account!.id;
}

async function channel(accountId: string | null, phoneNumberId: string, display: string) {
  const [row] = await db
    .insert(channels)
    .values({
      type: 'whatsapp',
      name: `Phone ${display}`,
      whatsappAccountId: accountId,
      config: {
        phoneNumberId,
        coexistence: {
          onboardedAt: '2026-10-01T08:00:00.000Z',
          wabaId: WABA,
          displayPhoneNumber: display,
          syncs: {},
        },
      },
    })
    .returning({ id: channels.id });
  return row!.id;
}

async function disconnected(channelId: string) {
  const [row] = await db
    .select({ config: channels.config })
    .from(channels)
    .where(eq(channels.id, channelId));
  return parseCoexistence(row!.config)?.disconnected ?? null;
}

const AT = new Date('2026-10-08T09:00:00Z');

describe('applyWhatsAppAccountUpdate', () => {
  it('marks the number the phone disconnected, and records the credential refused', async () => {
    const accountId = await connectedAccount();
    const removed = await channel(accountId, '106540352242922', '+1 555-078-3881');
    const other = await channel(accountId, '106540352242999', '+1 555-078-9999');

    const update = {
      wabaId: WABA,
      phoneNumber: '15550783881',
      event: 'PARTNER_REMOVED',
      reason: 'PRIMARY_INACTIVITY',
      initiatedBy: 'SYSTEM',
      at: AT,
    };
    expect(await applyWhatsAppAccountUpdate(update)).toBe(1);
    // Twice, as a replayed delivery would: the same state, no second effect.
    expect(await applyWhatsAppAccountUpdate(update)).toBe(1);

    expect(await disconnected(removed)).toMatchObject({
      at: AT.toISOString(),
      event: 'PARTNER_REMOVED',
      reason: 'PRIMARY_INACTIVITY',
    });
    expect(await disconnected(other)).toBeNull();
    expect((await credentialStatuses()).get(accountId)?.lastRefusal).toMatch(
      /disconnected from the WhatsApp Business app \(PRIMARY_INACTIVITY, by system\)/,
    );
  });

  it('marks every number on an offboarded account, and leaves the credential alone', async () => {
    const accountId = await connectedAccount();
    const first = await channel(accountId, '106540352242922', '15550783881');
    const second = await channel(accountId, '106540352242999', '15550789999');

    expect(
      await applyWhatsAppAccountUpdate({
        wabaId: WABA,
        phoneNumber: null,
        event: 'ACCOUNT_OFFBOARDED',
        reason: null,
        initiatedBy: null,
        at: AT,
      }),
    ).toBe(2);

    expect(await disconnected(first)).toMatchObject({ event: 'ACCOUNT_OFFBOARDED' });
    expect(await disconnected(second)).toMatchObject({ event: 'ACCOUNT_OFFBOARDED' });
    // Meta keeps the partner's access through a re-onboarding.
    expect((await credentialStatuses()).get(accountId)?.lastRefusal).toBeNull();
  });

  it('clears the mark when Meta reconnects the number', async () => {
    const accountId = await connectedAccount();
    const id = await channel(accountId, '106540352242922', '15550783881');
    const base = { wabaId: WABA, phoneNumber: null, reason: null, initiatedBy: null, at: AT };
    await applyWhatsAppAccountUpdate({ ...base, event: 'ACCOUNT_OFFBOARDED' });

    expect(await applyWhatsAppAccountUpdate({ ...base, event: 'ACCOUNT_RECONNECTED' })).toBe(1);

    expect(await disconnected(id)).toBeNull();
  });

  it('touches nothing for another WABA, or an event that is not about the connection', async () => {
    const accountId = await connectedAccount();
    const id = await channel(accountId, '106540352242922', '15550783881');
    const base = { phoneNumber: null, reason: null, initiatedBy: null, at: AT };

    expect(
      await applyWhatsAppAccountUpdate({ ...base, wabaId: '999999999', event: 'PARTNER_REMOVED' }),
    ).toBe(0);
    expect(
      await applyWhatsAppAccountUpdate({ ...base, wabaId: WABA, event: 'VERIFIED_ACCOUNT' }),
    ).toBe(0);
    expect(await disconnected(id)).toBeNull();
  });
});
