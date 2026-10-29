import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channelOwnerChanges,
  channels,
  contacts,
  conversations,
  kbCategories,
  kbFolders,
  ticketStatuses,
  whatsappAccounts,
  whatsappCredentialEvents,
} from '@/db/schema';
import type { Permission } from '@/lib/auth/permissions';
import { resetEnvCache } from '@/lib/env';
import { saveCategoryAiSettings } from '@/lib/category-ai/settings';
import { withCleanDatabase } from '@/lib/testing/db';
import { untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { stubFetch } from '@/lib/testing/fetch';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import { credentialStatuses, storeBusinessToken } from '@/lib/whatsapp/credentials';
import { ONLY_WEBCHAT_ROW } from '@/lib/widget/switch';
import { GONE } from '../settings-shared';

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
 *
 * And the handover of a number to a person, whose ids both arrive in a form.
 */

const signedIn = vi.hoisted(() => ({
  id: '',
  permissions: {} as Record<string, boolean>,
}));

// The real guard's decision, against the overrides a test sets, with Next's
// redirect standing as the throw it is: an action refused by its permission
// answers nothing and writes nothing.
vi.mock('@/lib/auth/guard', async () => {
  const { can } =
    await vi.importActual<typeof import('@/lib/auth/permissions')>('@/lib/auth/permissions');
  return {
    requirePermission: async (permission: Permission) => {
      const agent = {
        id: signedIn.id,
        name: 'Mona Admin',
        role: 'admin' as const,
        permissions: signedIn.permissions,
      };
      if (!can(agent, permission)) throw new Error(`NEXT_REDIRECT forbidden: ${permission}`);
      return agent;
    },
  };
});
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidated.push(path) }));

const {
  connectBusinessAppNumber,
  deleteWhatsAppAccount,
  saveChannel,
  setNumberOwner,
  setWebchatActive,
} = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };
const saved = { ...process.env };
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
  revalidated.length = 0;
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

describe('saveChannel for a comments row', () => {
  // Rides the Page or account its platform's row does, so it carries routing
  // and nothing else — an address field submitted with it is ignored rather
  // than stored as `{ address }`, which the email fallthrough would write.
  it('creates a Facebook or Instagram comments row with an empty config', async () => {
    for (const type of ['facebook_comment', 'instagram_comment'] as const) {
      const result = await saveChannel(
        INITIAL,
        form({ type, name: `${type} row`, address: 'nobody@example.com' }),
      );
      expect(result.error).toBeNull();

      const [row] = await db
        .select({ type: channels.type, config: channels.config })
        .from(channels)
        .where(eq(channels.name, `${type} row`));
      expect(row).toEqual({ type, config: {} });
    }
  });

  it('still refuses a type nobody may create', async () => {
    const result = await saveChannel(INITIAL, form({ type: 'portal', name: 'Forged' }));
    expect(result.error).toBe('Unknown channel type');
  });
});

describe('saveChannel routing mode', () => {
  async function modeOf(id: string) {
    const [row] = await db
      .select({ routingMode: channels.routingMode, name: channels.name, config: channels.config })
      .from(channels)
      .where(eq(channels.id, id));
    return row!;
  }

  async function plain(values: Partial<typeof channels.$inferInsert> = {}) {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'email',
        name: 'Support mailbox',
        config: { address: 'help@shipblu.test' },
        ...values,
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  const classifier = (mode: 'off' | 'shadow' | 'apply') =>
    saveCategoryAiSettings({ mode, minProbability: 0.6, routingWindowMinutes: 5 }, signedIn.id);

  it('adds a channel on its default group unless the form names a mode', async () => {
    await classifier('apply');
    expect(
      await saveChannel(INITIAL, form({ type: 'email', name: 'Plain', address: 'a@shipblu.test' })),
    ).toMatchObject({ error: null });
    expect(
      await saveChannel(
        INITIAL,
        form({ type: 'email', name: 'Routed', address: 'b@shipblu.test', routingMode: 'category' }),
      ),
    ).toEqual(expect.not.objectContaining({ notice: expect.anything() }));

    const rows = await db
      .select({ name: channels.name, routingMode: channels.routingMode })
      .from(channels)
      .where(eq(channels.type, 'email'));
    expect(Object.fromEntries(rows.map((row) => [row.name, row.routingMode]))).toEqual({
      Plain: 'default_group',
      Routed: 'category',
    });
  });

  // Three forms post here; the editor and the widget's settings both carry
  // the field, and anything that does not — a forged post, a form from before
  // this existed — must not take the channel off routing as a side effect.
  it('leaves the mode as it is when the field is absent, on an edit and on the widget’s save', async () => {
    const id = await plain({ routingMode: 'category' });
    expect(
      (await saveChannel(INITIAL, form({ id, name: 'Renamed', address: 'help@shipblu.test' })))
        .error,
    ).toBeNull();
    expect(await modeOf(id)).toMatchObject({ name: 'Renamed', routingMode: 'category' });

    const chat = await plain({
      type: 'webchat',
      name: 'Web chat',
      config: { faqFolders: {} },
      routingMode: 'category_shadow',
    });
    expect(
      (await saveChannel(INITIAL, form({ id: chat, type: 'webchat', name: 'Web chat' }))).error,
    ).toBeNull();
    expect((await modeOf(chat)).routingMode).toBe('category_shadow');

    expect(
      (await saveChannel(INITIAL, form({ id, name: 'Renamed', routingMode: 'default_group' })))
        .error,
    ).toBeNull();
    expect((await modeOf(id)).routingMode).toBe('default_group');
  });

  it('refuses a mode no form offers, and writes nothing', async () => {
    const id = await plain();
    expect(
      await saveChannel(INITIAL, form({ id, name: 'Renamed', routingMode: 'everywhere' })),
    ).toEqual({ error: 'Unknown routing mode — reload the page and try again' });
    expect(await modeOf(id)).toMatchObject({
      name: 'Support mailbox',
      routingMode: 'default_group',
    });
  });

  it('refuses a category mode on a number on the Business app, and on the bot', async () => {
    const accountId = await account(WABA, 'ShipBlu');
    const [connected] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Business app',
        whatsappAccountId: accountId,
        config: {
          phoneNumberId: PHONE,
          coexistence: {
            onboardingId: null,
            onboardedAt: '2026-10-08T10:00:00.000Z',
            wabaId: WABA,
            syncs: {},
          },
        },
      })
      .returning({ id: channels.id });
    const [bot] = await db
      .select({ id: channels.id, config: channels.config })
      .from(channels)
      .where(eq(channels.type, 'whatsapp_bot'));

    const onConnected = await saveChannel(
      INITIAL,
      form({
        id: connected!.id,
        name: 'Business app',
        whatsappAccountId: accountId,
        routingMode: 'category',
      }),
    );
    expect(onConnected.error).toMatch(/stays on its default group.*typed on the phone/);
    expect((await modeOf(connected!.id)).routingMode).toBe('default_group');

    const onBot = await saveChannel(
      INITIAL,
      form({
        id: bot!.id,
        name: 'WhatsApp Customer Bot',
        phoneNumberId: String(bot!.config.phoneNumberId),
        whatsappAccountId: accountId,
        routingMode: 'category_shadow',
      }),
    );
    expect(onBot.error).toMatch(/stays on its default group.*customer bot/);
    expect((await modeOf(bot!.id)).routingMode).toBe('default_group');
  });

  // Saved, because the admin may be setting up ahead of switching the
  // classifier on — and told, because until then it holds nothing.
  it('saves a category mode while the classifier is not in Apply, and says it is idle', async () => {
    const id = await plain();

    await classifier('off');
    expect(
      await saveChannel(INITIAL, form({ id, name: 'Support', routingMode: 'category' })),
    ).toMatchObject({
      error: null,
      notice: expect.stringMatching(/Idle until the category classifier is in Apply.*it is off/),
    });
    expect((await modeOf(id)).routingMode).toBe('category');
    expect(revalidated).toContain('/admin/channels');

    // Said on a rename too: the row is idle whoever saves it.
    await classifier('shadow');
    expect(await saveChannel(INITIAL, form({ id, name: 'Support desk' }))).toMatchObject({
      notice: expect.stringMatching(/in Shadow, so nothing is recorded|in Shadow, so new tickets/),
    });

    await classifier('apply');
    const live = await saveChannel(INITIAL, form({ id, name: 'Support desk' }));
    expect(live.error).toBeNull();
    expect(live.notice).toBeUndefined();
  });

  // The onboarding job adopts a plain number between this action's read and
  // its write, resetting the mode in the transaction that writes the
  // coexistence object. The UPDATE waits on that lock and decides the mode
  // against the row it then finds, so the category the form named is not
  // written over the reset.
  it('keeps a number connected after the read on its default group', async () => {
    const accountId = await account(WABA, 'ShipBlu');
    const [number] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Sales line',
        whatsappAccountId: accountId,
        config: { phoneNumberId: PHONE },
      })
      .returning({ id: channels.id });

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let adopted!: () => void;
    const adopting = new Promise<void>((resolve) => (adopted = resolve));
    const job = db.transaction(async (tx) => {
      await tx
        .update(channels)
        .set({
          routingMode: 'default_group',
          config: {
            phoneNumberId: PHONE,
            coexistence: {
              onboardingId: null,
              onboardedAt: '2026-10-08T10:00:00.000Z',
              wabaId: WABA,
              syncs: {},
            },
          },
        })
        .where(eq(channels.id, number!.id));
      adopted();
      await held;
    });
    await adopting;

    const saving = saveChannel(
      INITIAL,
      form({
        id: number!.id,
        name: 'Sales line',
        phoneNumberId: PHONE,
        whatsappAccountId: accountId,
        routingMode: 'category',
      }),
    );
    await untilWaitingOnALock(db);
    release();
    await job;

    expect((await saving).error).toBeNull();
    const row = await modeOf(number!.id);
    expect(row.routingMode).toBe('default_group');
    expect(parseCoexistence(row.config)).not.toBeNull();
  });

  it('writes the mode a plain number is given', async () => {
    const accountId = await account(WABA, 'ShipBlu');
    const [number] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Sales line',
        whatsappAccountId: accountId,
        config: { phoneNumberId: PHONE },
      })
      .returning({ id: channels.id });

    const saved = await saveChannel(
      INITIAL,
      form({
        id: number!.id,
        name: 'Sales line',
        phoneNumberId: PHONE,
        whatsappAccountId: accountId,
        routingMode: 'category_shadow',
      }),
    );

    expect(saved.error).toBeNull();
    expect((await modeOf(number!.id)).routingMode).toBe('category_shadow');
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

  /**
   * The group's existence is checked once, in the lib, and its sentence is
   * what comes back; the action keeps only the parse, because a malformed
   * uuid reaching the lib's lookup is a 22P02 and a thrown action answers
   * nothing. Neither costs the business its one-use code.
   */
  it("answers a deleted or malformed default group with a sentence, before Meta's code is spent", async () => {
    process.env.META_APP_ID = '1234567890';
    process.env.META_APP_SECRET = 'app-secret-value-0123456789abcdef';
    process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = '987654321';
    process.env.APP_URL = 'https://support.example.test';
    resetEnvCache();
    const fetch = stubFetch(async () => new Response('unrouted', { status: 599 }));

    try {
      const attempt = (defaultGroupId: string) =>
        connectBusinessAppNumber(
          INITIAL,
          form({ code: 'AQD-sign-in-code', wabaId: WABA, phoneNumberId: PHONE, defaultGroupId }),
        );

      expect(await attempt('00000000-0000-4000-8000-000000000001')).toMatchObject({
        error: 'That default group no longer exists — reload the page.',
      });
      expect(await attempt('not-a-uuid')).toMatchObject({ error: 'Unknown default group' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      process.env = { ...saved };
      resetEnvCache();
    }
  });
});

describe('setNumberOwner', () => {
  async function agent(name: string, values: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db
      .insert(agents)
      .values({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@shipblu.test`, ...values })
      .returning({ id: agents.id });
    return row!.id;
  }

  async function number(
    name: string,
    type: 'whatsapp' | 'whatsapp_bot' | 'email' = 'whatsapp',
    ownerAgentId: string | null = null,
  ) {
    const [row] = await db
      .insert(channels)
      .values({
        type,
        name,
        ownerAgentId,
        config:
          type === 'email'
            ? { address: 'support@shipblu.test' }
            : {
                phoneNumberId: `pn-${name}`,
                coexistence: {
                  onboardedAt: '2026-09-19T08:00:00.000Z',
                  wabaId: WABA,
                  displayPhoneNumber: '+20 12 78707918',
                  syncs: {},
                },
              },
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  async function ticket(channelId: string, status: 'Open' | 'Pending' | 'Resolved') {
    const [state] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, status));
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const [row] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        channelId,
        statusId: state!.id,
        requesterContactId: contact!.id,
        subject: 'Where is my parcel?',
      })
      .returning({ id: conversations.id });
    return row!.id;
  }

  async function holders(id: string) {
    const [row] = await db
      .select({
        accountable: conversations.accountableAgentId,
        assignee: conversations.assigneeAgentId,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  async function ownerOf(channelId: string) {
    const [row] = await db
      .select({ owner: channels.ownerAgentId })
      .from(channels)
      .where(eq(channels.id, channelId));
    return row!.owner;
  }

  const records = () =>
    db
      .select({
        toAgentId: channelOwnerChanges.toAgentId,
        changedByAgentId: channelOwnerChanges.changedByAgentId,
        changedByLabel: channelOwnerChanges.changedByLabel,
        ticketsMoved: channelOwnerChanges.ticketsMoved,
      })
      .from(channelOwnerChanges);

  const handOver = (channelId: string, ownerAgentId: string) =>
    setNumberOwner(INITIAL, form({ channelId, ownerAgentId }));

  it('is refused to somebody who may not edit channels, before anything is read', async () => {
    const nayera = await agent('Nayera Mohamed');
    const id = await number('Nayera Mohamed');
    signedIn.permissions = { 'admin.channels': false };

    await expect(handOver(id, nayera)).rejects.toThrow(/forbidden: admin\.channels/);
    expect(await ownerOf(id)).toBeNull();
    expect(await records()).toEqual([]);
  });

  // A malformed uuid reaching the lookup is a 22P02, and an action that throws
  // answers nothing: each is a sentence instead, and nothing is written.
  it('answers a malformed channel or agent id with a sentence', async () => {
    const nayera = await agent('Nayera Mohamed');
    const id = await number('Nayera Mohamed');

    expect(await handOver('not-a-uuid', nayera)).toEqual({
      error: 'That no longer exists — reload the page and try again',
    });
    expect(await handOver(id, 'not-a-uuid')).toEqual({
      error: 'Unknown agent — reload the page and try again',
    });
    expect(await handOver('00000000-0000-4000-8000-000000000001', nayera)).toEqual({
      error: 'That channel no longer exists.',
    });
    expect(await ownerOf(id)).toBeNull();
    expect(await records()).toEqual([]);
    expect(revalidated).toEqual([]);
  });

  it('refuses a number that is not a plain WhatsApp number', async () => {
    const nayera = await agent('Nayera Mohamed');
    const bot = await number('Second bot', 'whatsapp_bot');
    const mailbox = await number('Mailbox', 'email');

    for (const id of [bot, mailbox]) {
      expect((await handOver(id, nayera)).error).toMatch(
        /^Only a WhatsApp number can belong to a person\./,
      );
      expect(await ownerOf(id)).toBeNull();
    }
    expect(await records()).toEqual([]);
  });

  it('refuses an owner who can no longer sign in, or no longer exists', async () => {
    const former = await agent('Omar Former', { isActive: false });
    const id = await number('Nayera Mohamed');
    const open = await ticket(id, 'Open');

    expect(await handOver(id, former)).toEqual({
      error: 'Omar Former is deactivated. Reactivate them before handing them a number.',
    });
    expect(await handOver(id, '00000000-0000-4000-8000-000000000002')).toEqual({
      error: 'That agent no longer exists.',
    });
    expect(await ownerOf(id)).toBeNull();
    expect(await holders(open)).toEqual({ accountable: null, assignee: null });
    expect(await records()).toEqual([]);
  });

  it('hands the number over with its open tickets, names the admin, and re-renders the page', async () => {
    const nayera = await agent('Nayera Mohamed');
    const id = await number('Nayera Mohamed');
    const open = await ticket(id, 'Open');
    const pending = await ticket(id, 'Pending');
    const resolved = await ticket(id, 'Resolved');

    const done = await handOver(id, nayera);

    expect(done).toMatchObject({
      error: null,
      ok: true,
      notice:
        'Nayera Mohamed owns +20 12 78707918 from now. 2 open or pending tickets moved to them.',
    });
    expect(revalidated).toEqual(['/admin/channels']);
    expect(await ownerOf(id)).toBe(nayera);
    expect(await holders(open)).toEqual({ accountable: nayera, assignee: nayera });
    expect(await holders(pending)).toEqual({ accountable: nayera, assignee: nayera });
    expect(await holders(resolved)).toEqual({ accountable: null, assignee: null });
    // The admin from the session, never from the form.
    expect(await records()).toEqual([
      {
        toAgentId: nayera,
        changedByAgentId: signedIn.id,
        changedByLabel: 'Mona Admin',
        ticketsMoved: 2,
      },
    ]);

    // A second press says so, and writes nothing.
    expect((await handOver(id, nayera)).notice).toBe(
      'Nayera Mohamed already owns +20 12 78707918; nothing changed.',
    );
    expect(await records()).toHaveLength(1);
  });

  // "Nobody — team number" submits an empty value, which is a choice, not a
  // malformed id.
  it('clears the owner when nobody is chosen', async () => {
    const nayera = await agent('Nayera Mohamed');
    const id = await number('Nayera Mohamed', 'whatsapp', nayera);
    const open = await ticket(id, 'Open');
    await db
      .update(conversations)
      .set({ accountableAgentId: nayera, assigneeAgentId: nayera })
      .where(eq(conversations.id, open));

    const done = await handOver(id, '');

    expect(done).toMatchObject({
      error: null,
      notice:
        '+20 12 78707918 is a team number from now: its 1 open or pending ticket counts against ' +
        'whoever holds it.',
    });
    expect(revalidated).toEqual(['/admin/channels']);
    expect(await ownerOf(id)).toBeNull();
    // The work stays where it was; only the breach stops being hers.
    expect(await holders(open)).toEqual({ accountable: null, assignee: nayera });
    expect(await records()).toEqual([
      expect.objectContaining({ toAgentId: null, changedByAgentId: signedIn.id, ticketsMoved: 1 }),
    ]);
  });
});

// A web chat row is edited from two places: the Chat widget card for the row
// the widget uses, and the row editor for the rest. Only the card carries the
// FAQ folders, and a save that carries none must leave them as they are.
describe('web chat rows', () => {
  async function webchatRow(name: string, faqFolders: Record<string, string>, second = 0) {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'webchat',
        name,
        config: { faqFolders },
        createdAt: new Date(Date.UTC(2026, 9, 1, 9, 0, second)),
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  async function configOf(id: string) {
    const [row] = await db
      .select({ name: channels.name, config: channels.config, isActive: channels.isActive })
      .from(channels)
      .where(eq(channels.id, id));
    return row!;
  }

  /** A public folder in each locale, which is what the card may choose. */
  async function folders() {
    const ids: Record<string, string> = {};
    for (const locale of ['en', 'ar'] as const) {
      const [category] = await db
        .insert(kbCategories)
        .values({ name: `Shipping ${locale}`, slug: 'shipping', locale })
        .returning({ id: kbCategories.id });
      const [folder] = await db
        .insert(kbFolders)
        .values({ categoryId: category!.id, name: 'Delivery', slug: 'delivery' })
        .returning({ id: kbFolders.id });
      ids[locale] = folder!.id;
    }
    return ids;
  }

  it('keeps the folders when the row editor saves, which posts none', async () => {
    const chosen = await folders();
    const chat = await webchatRow('Web chat', chosen);

    expect(
      (await saveChannel(INITIAL, form({ id: chat, type: 'webchat', name: 'Website chat' }))).error,
    ).toBeNull();
    expect(await configOf(chat)).toMatchObject({
      name: 'Website chat',
      config: { faqFolders: chosen },
    });

    // The card posts the field, and empty is its "Most-read articles".
    expect(
      (
        await saveChannel(
          INITIAL,
          form({
            id: chat,
            type: 'webchat',
            name: 'Website chat',
            faqFolder_en: '',
            faqFolder_ar: chosen.ar!,
          }),
        )
      ).error,
    ).toBeNull();
    expect((await configOf(chat)).config).toEqual({ faqFolders: { ar: chosen.ar } });
  });

  // A card drawn before its row stopped being the widget's would otherwise
  // save questions the widget never shows, and say they were saved.
  it("refuses the card's folders on a row the widget no longer uses", async () => {
    const chosen = await folders();
    await webchatRow('Web chat', {}, 0);
    const newer = await webchatRow('Second chat', {}, 1);

    expect(
      await saveChannel(
        INITIAL,
        form({ id: newer, type: 'webchat', name: 'Second chat', faqFolder_en: chosen.en! }),
      ),
    ).toEqual({
      error:
        'This is no longer the web chat row the widget uses — reload the page to configure the one that is',
    });
    expect((await configOf(newer)).config).toEqual({ faqFolders: {} });
  });

  it('answers a name another channel holds with a sentence, not a throw', async () => {
    await webchatRow('Web chat', {}, 0);
    const second = await webchatRow('Second chat', {}, 1);

    expect(
      await saveChannel(INITIAL, form({ id: second, type: 'webchat', name: 'Web chat' })),
    ).toEqual({ error: 'Another channel is already called “Web chat” — choose a different name' });
    expect(
      await saveChannel(
        INITIAL,
        form({ type: 'email', name: 'Web chat', address: 'help@shipblu.test' }),
      ),
    ).toEqual({ error: 'Another channel is already called “Web chat” — choose a different name' });
  });

  it('switches a row off and says where the widget went', async () => {
    const first = await webchatRow('Web chat', {}, 0);
    await webchatRow('Second chat', {}, 1);

    const state = await setWebchatActive(INITIAL, form({ id: first, active: 'off' }));
    expect(state.error).toBeNull();
    expect(state.notice).toContain('the widget now uses “Second chat”');
    expect((await configOf(first)).isActive).toBe(false);
    expect(revalidated).toEqual(['/admin/channels']);
  });

  it('refuses the last active row and a form it cannot read, writing nothing', async () => {
    const only = await webchatRow('Web chat', {}, 0);

    expect(await setWebchatActive(INITIAL, form({ id: only, active: 'off' }))).toEqual({
      error: ONLY_WEBCHAT_ROW,
    });
    expect(await setWebchatActive(INITIAL, form({ id: only, active: 'maybe' }))).toEqual({
      error: 'That form is out of date — reload the page and try again',
    });
    expect((await setWebchatActive(INITIAL, form({ id: 'not-a-uuid', active: 'off' }))).error).toBe(
      GONE,
    );
    expect((await configOf(only)).isActive).toBe(true);
    expect(revalidated).toEqual([]);
  });

  it('is refused without admin.channels', async () => {
    const only = await webchatRow('Web chat', {}, 0);
    signedIn.permissions = { 'admin.channels': false };

    await expect(setWebchatActive(INITIAL, form({ id: only, active: 'off' }))).rejects.toThrow(
      /forbidden: admin\.channels/,
    );
  });
});
