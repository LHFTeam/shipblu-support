import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, channels, whatsappAccounts, whatsappCredentialEvents } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import { credentialStatuses, storeBusinessToken } from '@/lib/whatsapp/credentials';

/**
 * Two things the channel actions must not let an `admin.channels` holder do
 * to a number connected through Meta, against Postgres because both are
 * decided there:
 *
 * - disconnect an account holding a stored credential without
 *   `admin.channels.connect` — the cascade takes the credential, which is
 *   exactly what that key gates on Forget;
 * - move a connected number to another business account from the editor — it
 *   would send with a credential it was never connected with.
 */

const signedIn = vi.hoisted(() => ({
  id: '',
  permissions: {} as Record<string, boolean>,
}));

vi.mock('@/lib/auth/guard', () => ({
  requirePermission: async () => ({
    id: signedIn.id,
    name: 'Mona Admin',
    role: 'admin',
    permissions: signedIn.permissions,
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { connectBusinessAppNumber, deleteWhatsAppAccount, saveChannel } = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };
const WABA = '102290129340398';
const OTHER_WABA = '109999999999999';
const PHONE = '106540352242922';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(async () => {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Mona Admin', email: 'mona@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  signedIn.id = agent!.id;
  signedIn.permissions = {};
});

async function account(wabaId: string, name: string) {
  const [row] = await db
    .insert(whatsappAccounts)
    .values({ name, wabaId })
    .returning({ id: whatsappAccounts.id });
  return row!.id;
}

async function withStoredCredential(accountId: string, wabaId: string) {
  await db.transaction((tx) =>
    storeBusinessToken(tx, {
      accountId,
      wabaId,
      token: 'EAAGm0PX4ZCpsBAchannelActionsTestToken0123',
      inspection: null,
      businessId: null,
      actor: null,
    }),
  );
}

async function accountExists(id: string) {
  const rows = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.id, id));
  return rows.length === 1;
}

describe('deleteWhatsAppAccount', () => {
  it('refuses to take a stored credential with it for somebody who may not connect numbers', async () => {
    const id = await account(WABA, 'ShipBlu');
    await withStoredCredential(id, WABA);
    signedIn.permissions = { 'admin.channels.connect': false };

    const refused = await deleteWhatsAppAccount(INITIAL, form({ id }));

    expect(refused.error).toMatch(/needs the permission to connect numbers/);
    expect(await accountExists(id)).toBe(true);
    expect((await credentialStatuses()).has(id)).toBe(true);

    // Somebody who holds the key disconnects it in one step, and is named.
    signedIn.permissions = {};
    expect((await deleteWhatsAppAccount(INITIAL, form({ id }))).error).toBeNull();
    expect(await accountExists(id)).toBe(false);
    expect(
      await db
        .select({
          event: whatsappCredentialEvents.event,
          agentId: whatsappCredentialEvents.agentId,
        })
        .from(whatsappCredentialEvents)
        .where(eq(whatsappCredentialEvents.event, 'removed')),
    ).toEqual([{ event: 'removed', agentId: signedIn.id }]);
  });

  it('still disconnects an account with no stored credential for an admin.channels holder', async () => {
    const id = await account(WABA, 'ShipBlu');
    signedIn.permissions = { 'admin.channels.connect': false };

    expect((await deleteWhatsAppAccount(INITIAL, form({ id }))).error).toBeNull();
    expect(await accountExists(id)).toBe(false);
  });
});

describe('saveChannel on a number connected through Meta', () => {
  async function connectedChannel(accountId: string | null) {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Support line',
        whatsappAccountId: accountId,
        config: {
          phoneNumberId: PHONE,
          coexistence: {
            onboardingId: null,
            onboardedAt: '2026-10-08T10:00:00.000Z',
            wabaId: WABA,
            syncs: { contacts: { requestId: 'c-1', requestedAt: '2026-10-08T10:01:00.000Z' } },
          },
        },
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  async function channelRow(id: string) {
    const [row] = await db
      .select({
        name: channels.name,
        whatsappAccountId: channels.whatsappAccountId,
        config: channels.config,
      })
      .from(channels)
      .where(eq(channels.id, id));
    return row!;
  }

  const edit = (id: string, accountId: string, name = 'Renamed') =>
    saveChannel(
      INITIAL,
      form({
        id,
        type: 'whatsapp',
        name,
        phoneNumberId: '100000000000',
        whatsappAccountId: accountId,
      }),
    );

  it('refuses to move it to another business account, and saves a rename that keeps it', async () => {
    const connected = await account(WABA, 'ShipBlu');
    const other = await account(OTHER_WABA, 'WhatsApp');
    const id = await connectedChannel(connected);

    const refused = await edit(id, other);

    expect(refused.error).toMatch(
      new RegExp(`connected through Meta to business account ${WABA}.*connect it again`),
    );
    expect(await channelRow(id)).toMatchObject({
      name: 'Support line',
      whatsappAccountId: connected,
    });

    expect((await edit(id, connected)).error).toBeNull();
    const saved = await channelRow(id);
    expect(saved).toMatchObject({ name: 'Renamed', whatsappAccountId: connected });
    expect(saved.config.phoneNumberId).toBe(PHONE);
    expect(parseCoexistence(saved.config)?.syncs.contacts).toMatchObject({ requestId: 'c-1' });
  });

  /** Detached by the account's disconnection: reconnecting is the way back, not the picker. */
  it('keeps a connected number with no account link unlinked rather than letting the form pick one', async () => {
    await account(WABA, 'ShipBlu');
    const other = await account(OTHER_WABA, 'WhatsApp');
    const id = await connectedChannel(null);

    expect((await edit(id, other)).error).toMatch(/cannot be moved to another here/);
    expect((await edit(id, '')).error).toBeNull();
    expect(await channelRow(id)).toMatchObject({ name: 'Renamed', whatsappAccountId: null });
  });

  /** The editor's documented purpose — the "no business account" badge — is untouched. */
  it('still moves a plain number between business accounts', async () => {
    const first = await account(WABA, 'ShipBlu');
    const other = await account(OTHER_WABA, 'WhatsApp');
    const [plain] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Plain',
        whatsappAccountId: first,
        config: { phoneNumberId: '106540352240000' },
      })
      .returning({ id: channels.id });

    expect((await edit(plain!.id, other, 'Plain')).error).toBeNull();
    expect(await channelRow(plain!.id)).toMatchObject({
      whatsappAccountId: other,
      config: { phoneNumberId: '100000000000' },
    });
  });
});

describe('connectBusinessAppNumber', () => {
  /**
   * The card reads `wait` off the answer to stop offering Meta's window, whose
   * every run unlinks the phone's linked devices again — so a refusal another
   * run could fix must not carry it, and the rate limit must.
   */
  it('marks the rate-limit refusal as one to wait out, and an ordinary refusal not', async () => {
    const attempt = () => connectBusinessAppNumber(INITIAL, form({ code: '', wabaId: WABA }));

    for (let tries = 0; tries < 5; tries += 1) {
      const refused = await attempt();
      expect(refused.error).toEqual(expect.any(String));
      expect(refused.wait).toBeUndefined();
    }

    expect(await attempt()).toMatchObject({
      error: expect.stringMatching(/Too many attempts/),
      wait: true,
    });
  });
});
