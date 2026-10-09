import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { channels, whatsappAccounts } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { parseCoexistence } from './coexistence';
import {
  applyWhatsAppAccountUpdate,
  recordHistoryProgress,
  whatsappEditColumns,
  writeOnboardedCoexistence,
} from './coexistence-state';
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
    // After the credential was stored, which is stamped with the wall clock: a
    // disconnection from before it is about an earlier one (below).
    const at = new Date();

    const update = {
      wabaId: WABA,
      phoneNumber: '15550783881',
      event: 'PARTNER_REMOVED',
      reason: 'PRIMARY_INACTIVITY',
      initiatedBy: 'SYSTEM',
      at,
    };
    expect(await applyWhatsAppAccountUpdate(update)).toBe(1);
    // Twice, as a replayed delivery would: the same state, no second effect.
    expect(await applyWhatsAppAccountUpdate(update)).toBe(1);

    expect(await disconnected(removed)).toMatchObject({
      at: at.toISOString(),
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

  /**
   * Deliveries are processed in no order, and each of these events overwrites
   * the last, so the one that happened last must win whichever was processed
   * last.
   */
  describe('in the order the events happened, not the order they are processed', () => {
    const T1 = new Date('2026-10-08T09:00:00Z');
    const T2 = new Date('2026-10-08T09:05:00Z');
    const T3 = new Date('2026-10-08T09:10:00Z');
    const event = (name: string, at: Date) => ({
      wabaId: WABA,
      phoneNumber: null,
      event: name,
      reason: null,
      initiatedBy: null,
      at,
    });

    it('keeps a newer disconnection when an older reconnection lands late', async () => {
      const id = await channel(null, '106540352242922', '15550783881');
      await applyWhatsAppAccountUpdate(event('ACCOUNT_OFFBOARDED', T1));
      await applyWhatsAppAccountUpdate(event('PARTNER_REMOVED', T3));

      expect(await applyWhatsAppAccountUpdate(event('ACCOUNT_RECONNECTED', T2))).toBe(0);

      expect(await disconnected(id)).toMatchObject({
        event: 'PARTNER_REMOVED',
        at: T3.toISOString(),
      });
    });

    it('leaves a reconnected number unbadged when the offboarding before it lands late', async () => {
      const id = await channel(null, '106540352242922', '15550783881');
      await applyWhatsAppAccountUpdate(event('ACCOUNT_RECONNECTED', T2));

      expect(await applyWhatsAppAccountUpdate(event('ACCOUNT_OFFBOARDED', T1))).toBe(0);

      expect(await disconnected(id)).toBeNull();
    });

    it('never downgrades a removal to the offboarding that came before it', async () => {
      const id = await channel(null, '106540352242922', '15550783881');
      await applyWhatsAppAccountUpdate(event('PARTNER_REMOVED', T3));

      await applyWhatsAppAccountUpdate(event('ACCOUNT_OFFBOARDED', T1));

      expect(await disconnected(id)).toMatchObject({ event: 'PARTNER_REMOVED' });
    });

    it('ignores a removal of the connection before a reconnect, and its credential', async () => {
      const accountId = await connectedAccount();
      const id = await channel(accountId, '106540352242922', '15550783881');
      const reconnectedAt = new Date();
      await writeOnboardedCoexistence(db, id, {
        onboardingId: null,
        onboardedAt: reconnectedAt.toISOString(),
        wabaId: WABA,
        displayPhoneNumber: '15550783881',
        verifiedName: null,
        subscribedAt: null,
        syncs: {},
      });

      const stale = event('PARTNER_REMOVED', new Date(reconnectedAt.getTime() - 60 * 60_000));
      expect(await applyWhatsAppAccountUpdate(stale)).toBe(0);

      expect(await disconnected(id)).toBeNull();
      expect((await credentialStatuses()).get(accountId)?.lastRefusal).toBeNull();
    });

    /**
     * The action stores the new credential before the job writes the new
     * connection, so in between the channel still carries the old
     * `onboardedAt` — and only the credential's own instant says the removal
     * is about the one before.
     */
    it('refuses no credential stored after the removal, before the job has rewritten the channel', async () => {
      const accountId = await connectedAccount();
      const id = await channel(accountId, '106540352242922', '15550783881');

      const stale = event('PARTNER_REMOVED', new Date(Date.now() - 60 * 60_000));
      expect(await applyWhatsAppAccountUpdate(stale)).toBe(1);

      // The old connection's object is badged until the job replaces it.
      expect(await disconnected(id)).toMatchObject({ event: 'PARTNER_REMOVED' });
      expect((await credentialStatuses()).get(accountId)?.lastRefusal).toBeNull();
    });
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

/**
 * An admin's save of a WhatsApp channel decides its `config` and account in
 * the UPDATE. It used to copy them from a read taken before it, which wrote a
 * snapshot back over every `jsonb_set` that landed in between — progress went
 * backwards, a disconnection vanished — and wiped the connection of a channel
 * the job adopted after the read.
 */
describe('whatsappEditColumns', () => {
  async function save(channelId: string, form: { phoneNumberId: string; account: string | null }) {
    await db
      .update(channels)
      .set({
        name: 'Renamed',
        ...whatsappEditColumns({
          phoneNumberId: form.phoneNumberId,
          whatsappAccountId: form.account,
        }),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId));
    const [row] = await db
      .select({ config: channels.config, whatsappAccountId: channels.whatsappAccountId })
      .from(channels)
      .where(eq(channels.id, channelId));
    return row!;
  }

  async function otherAccount() {
    const [row] = await db
      .insert(whatsappAccounts)
      .values({ name: 'Elsewhere', wabaId: '109999999999999' })
      .returning({ id: whatsappAccounts.id });
    return row!.id;
  }

  it('keeps everything a connected channel has gathered, whatever the form says', async () => {
    const accountId = await connectedAccount();
    const id = await channel(accountId, '106540352242922', '15550783881');
    await recordHistoryProgress(id, { phase: 0, progress: 40 }, AT);
    await recordHistoryProgress(id, { phase: 1, progress: 100 }, AT);
    await applyWhatsAppAccountUpdate({
      wabaId: WABA,
      phoneNumber: null,
      event: 'ACCOUNT_OFFBOARDED',
      reason: null,
      initiatedBy: null,
      at: AT,
    });

    const row = await save(id, { phoneNumberId: '100000000000', account: await otherAccount() });

    expect(row.whatsappAccountId).toBe(accountId);
    expect(row.config.phoneNumberId).toBe('106540352242922');
    const coexistence = parseCoexistence(row.config);
    expect(coexistence?.syncs.history).toMatchObject({
      chunks: 2,
      progressByPhase: { '0': 40, '1': 100 },
    });
    expect(coexistence?.disconnected).toMatchObject({ event: 'ACCOUNT_OFFBOARDED' });
  });

  it('writes the form’s phone number id and account on a plain number', async () => {
    const accountId = await connectedAccount();
    const elsewhere = await otherAccount();
    const [plain] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Plain',
        whatsappAccountId: accountId,
        config: { phoneNumberId: '106540352240000' },
      })
      .returning({ id: channels.id });

    const row = await save(plain!.id, { phoneNumberId: '106540352241111', account: elsewhere });

    expect(row).toEqual({
      config: { phoneNumberId: '106540352241111' },
      whatsappAccountId: elsewhere,
    });
    expect((await save(plain!.id, { phoneNumberId: '1', account: null })).whatsappAccountId).toBe(
      null,
    );
  });

  /** The race the read-then-write lost: the form was drawn before the job adopted the number. */
  it('keeps the connection of a plain number the job adopted after the form was drawn', async () => {
    const [legacy] = await db
      .insert(whatsappAccounts)
      .values({ name: 'Legacy', wabaId: '108888888888888' })
      .returning({ id: whatsappAccounts.id });
    const accountId = await connectedAccount();
    const [plain] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Plain',
        whatsappAccountId: legacy!.id,
        config: { phoneNumberId: '106540352242922' },
      })
      .returning({ id: channels.id });

    // What `channelStep` does when it takes a plain channel over.
    await db.transaction(async (tx) => {
      await tx
        .update(channels)
        .set({ whatsappAccountId: accountId })
        .where(eq(channels.id, plain!.id));
      await writeOnboardedCoexistence(tx, plain!.id, {
        onboardingId: null,
        onboardedAt: AT.toISOString(),
        wabaId: WABA,
        displayPhoneNumber: '15550783881',
        verifiedName: null,
        subscribedAt: null,
        syncs: {},
      });
    });

    // The admin's form, drawn before: the legacy account and the old id.
    const row = await save(plain!.id, { phoneNumberId: '106540352242922', account: legacy!.id });

    expect(row.whatsappAccountId).toBe(accountId);
    expect(parseCoexistence(row.config)).toMatchObject({ wabaId: WABA, syncs: {} });
  });
});
