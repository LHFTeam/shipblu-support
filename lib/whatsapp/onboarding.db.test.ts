import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, channels, jobs, whatsappAccounts, whatsappOnboardings } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { parseCoexistence } from './coexistence';
import { recordSyncRequest } from './coexistence-state';
import { credentialStatuses } from './credentials';
import { beginCoexistenceOnboarding, retryOnboarding } from './onboarding';
import { completeOnboarding } from './onboarding-complete';

/**
 * Connecting a WhatsApp Business-app number, both phases, against Postgres
 * with Graph stubbed route by route.
 *
 * What is pinned is what goes wrong silently: the token reaching a log line, a
 * job payload or a returned sentence; a second live attempt for one number; a
 * stale one locking the number out; a refused history request costing the
 * connection; a reconnect re-copying six months of chats; a transient failure
 * reading as a spinner instead of a sentence.
 */

withCleanDatabase();

const APP_ID = '1234567890';
const APP_SECRET = 'app-secret-value-0123456789abcdef';
const CODE = 'AQD-sign-in-code-0123456789';
const TOKEN = 'EAAGm0PX4ZCpsBAbusinessTokenValue0123456789';
const WABA = '102030405060';
const PHONE = '109876543210';

const saved = { ...process.env };

beforeEach(() => {
  process.env.META_APP_ID = APP_ID;
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = '987654321';
  process.env.APP_URL = 'https://support.example.test';
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
  vi.restoreAllMocks();
});

type Route = {
  method: 'GET' | 'POST';
  path: RegExp;
  answer: (url: URL, body: unknown) => unknown;
  status?: number;
};

/** Graph, answering each route; anything unrouted is a test failure, loudly. */
function graph(routes: Route[]) {
  return stubFetch(async (raw, init) => {
    const url = new URL(raw);
    const method = (init?.method ?? 'GET') as Route['method'];
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.path.test(url.pathname + url.search),
    );
    if (!route)
      return new Response(`unrouted ${method} ${url.pathname}${url.search}`, { status: 599 });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify(route.answer(url, body)), { status: route.status ?? 200 });
  });
}

const exchangeRoutes = (overrides: Partial<Record<string, Route>> = {}): Route[] => [
  overrides.exchange ?? {
    method: 'GET' as const,
    path: /\/oauth\/access_token\?/,
    answer: () => ({ access_token: TOKEN, token_type: 'bearer' }),
  },
  overrides.debug ?? {
    method: 'GET' as const,
    path: /\/debug_token\?/,
    answer: () => ({
      data: {
        app_id: APP_ID,
        is_valid: true,
        expires_at: 0,
        scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [WABA] }],
      },
    }),
  },
  overrides.waba ?? {
    method: 'GET' as const,
    path: new RegExp(`/${WABA}\\?fields=id,name$`),
    answer: () => ({ id: WABA, name: 'ShipBlu' }),
  },
  overrides.numbers ?? {
    method: 'GET' as const,
    path: new RegExp(`/${WABA}/phone_numbers\\?`),
    answer: () => ({
      data: [{ id: PHONE, display_phone_number: '+20 10 1234 5678', verified_name: 'ShipBlu' }],
    }),
  },
  {
    method: 'GET' as const,
    path: /\/me\?fields=client_business_id$/,
    answer: () => ({ client_business_id: '555666777', id: '1' }),
  },
];

const completeRoutes = (overrides: Partial<Record<string, Route>> = {}): Route[] => [
  ...exchangeRoutes(overrides),
  overrides.platform ?? {
    method: 'GET',
    path: new RegExp(`/${PHONE}\\?fields=is_on_biz_app,platform_type$`),
    answer: () => ({ is_on_biz_app: true, platform_type: 'CLOUD_API', id: PHONE }),
  },
  overrides.subscribe ?? {
    method: 'POST',
    path: new RegExp(`/${WABA}/subscribed_apps$`),
    answer: () => ({ success: true }),
  },
  overrides.subscribed ?? {
    method: 'GET',
    path: new RegExp(`/${WABA}/subscribed_apps$`),
    answer: () => ({
      data: [{ whatsapp_business_api_data: { id: APP_ID, name: 'ShipBlu Support' } }],
    }),
  },
  overrides.appFields ?? {
    method: 'GET',
    path: new RegExp(`/${APP_ID}/subscriptions$`),
    answer: () => ({
      data: [
        {
          object: 'whatsapp_business_account',
          callback_url: 'https://support.example.test/api/webhooks/whatsapp',
          active: true,
          fields: [{ name: 'messages' }],
        },
      ],
    }),
  },
  overrides.sync ?? {
    method: 'POST',
    path: new RegExp(`/${PHONE}/smb_app_data$`),
    answer: (_url, body) => ({
      messaging_product: 'whatsapp',
      request_id: `req-${(body as { sync_type: string }).sync_type}`,
    }),
  },
];

let admins = 0;

async function admin() {
  admins += 1;
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona Admin', email: `mona${admins}@shipblu.test`, role: 'admin' })
    .returning({ id: agents.id, name: agents.name });
  return row!;
}

const claim = (overrides = {}) => ({
  code: CODE,
  wabaId: WABA,
  phoneNumberId: PHONE as string | null,
  defaultGroupId: null as string | null,
  ...overrides,
});

/** Everything the console and the logger were handed, as one string to search. */
function captureLogs(): () => string {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)))
          .join(' '),
      );
    });
  }
  return () => lines.join('\n');
}

async function onboardingRow(id: string) {
  const [row] = await db.select().from(whatsappOnboardings).where(eq(whatsappOnboardings.id, id));
  return row!;
}

async function queued(type: string) {
  return db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.type, type));
}

const JOB = { attempts: 1, maxAttempts: 5 };

describe('the first phase: exchanging the code', () => {
  it('stores the credential, records the attempt and queues the rest — and says the token nowhere', async () => {
    const logs = captureLogs();
    const fetch = graph(exchangeRoutes());
    const mona = await admin();

    const outcome = await beginCoexistenceOnboarding(claim(), mona);

    expect(outcome).toMatchObject({ ok: true, notice: expect.stringMatching(/never expires/) });
    if (!outcome.ok) throw new Error(outcome.error);

    const row = await onboardingRow(outcome.onboardingId);
    expect(row).toMatchObject({
      status: 'exchanged',
      wabaId: WABA,
      phoneNumberId: PHONE,
      startedByLabel: 'Mona Admin',
    });

    const [account] = await db.select().from(whatsappAccounts);
    expect(account).toMatchObject({ name: 'ShipBlu', wabaId: WABA, tokenEnvVar: null });
    expect((await credentialStatuses()).get(account!.id)).toMatchObject({
      keyState: 'current',
      businessId: '555666777',
      expiresAt: null,
    });

    expect(await queued('complete_coexistence_onboarding')).toEqual([
      { payload: { onboardingId: outcome.onboardingId } },
    ]);

    // The exchange is the documented GET, and the only URL that carries the
    // secret; the app token rides in a header everywhere else.
    const exchange = fetch.mock.calls.find(([url]) => String(url).includes('oauth/access_token'));
    expect(exchange?.[1]?.method ?? 'GET').toBe('GET');
    for (const [url] of fetch.mock.calls) {
      if (String(url).includes('oauth/access_token')) continue;
      expect(String(url)).not.toContain(APP_SECRET);
      expect(String(url)).not.toContain(CODE);
    }

    for (const secret of [TOKEN, APP_SECRET, CODE]) {
      expect(logs()).not.toContain(secret);
      expect(JSON.stringify(outcome)).not.toContain(secret);
      expect(JSON.stringify(await db.select({ payload: jobs.payload }).from(jobs))).not.toContain(
        secret,
      );
    }
  });

  it('refuses an expired code without writing anything, and without repeating the code or the secret', async () => {
    graph(
      exchangeRoutes({
        exchange: {
          method: 'GET',
          path: /\/oauth\/access_token\?/,
          status: 400,
          answer: () => ({
            error: {
              message: `This authorization code has expired. code=${CODE} secret=${APP_SECRET}`,
              type: 'OAuthException',
              code: 100,
            },
          }),
        },
      }),
    );

    const outcome = await beginCoexistenceOnboarding(claim(), await admin());

    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/thirty seconds/) });
    expect(JSON.stringify(outcome)).not.toContain(CODE);
    expect(JSON.stringify(outcome)).not.toContain(APP_SECRET);
    expect(await db.select().from(whatsappAccounts)).toEqual([]);
    expect(await db.select().from(whatsappOnboardings)).toEqual([]);
  });

  it('refuses a token issued for another app, or without a scope sending needs', async () => {
    const debug = (data: Record<string, unknown>) => ({
      method: 'GET' as const,
      path: /\/debug_token\?/,
      answer: () => ({
        data: {
          app_id: APP_ID,
          is_valid: true,
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          ...data,
        },
      }),
    });

    graph(exchangeRoutes({ debug: debug({ app_id: '999' }) }));
    expect(await beginCoexistenceOnboarding(claim(), await admin())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/for app 999/),
    });

    graph(exchangeRoutes({ debug: debug({ scopes: ['whatsapp_business_management'] }) }));
    expect(await beginCoexistenceOnboarding(claim(), await admin())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/whatsapp_business_messaging/),
    });

    graph(
      exchangeRoutes({
        debug: debug({
          granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: ['111111'] }],
        }),
      }),
    );
    expect(await beginCoexistenceOnboarding(claim(), await admin())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not for 102030405060/),
    });

    expect(await db.select().from(whatsappOnboardings)).toEqual([]);
  });

  it('stores nothing when the token cannot read the WABA the browser named', async () => {
    graph(
      exchangeRoutes({
        waba: {
          method: 'GET',
          path: new RegExp(`/${WABA}\\?`),
          status: 400,
          answer: () => ({ error: { message: 'Unsupported get request.', code: 100 } }),
        },
      }),
    );

    const outcome = await beginCoexistenceOnboarding(claim(), await admin());

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot read business account/),
    });
    expect(await credentialStatuses()).toEqual(new Map());
  });

  it('names every missing setting, and calls nothing', async () => {
    delete process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;
    process.env.APP_URL = 'http://localhost:3000';
    resetEnvCache();
    const fetch = graph(exchangeRoutes());

    const outcome = await beginCoexistenceOnboarding(claim(), await admin());

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringMatching(/META_EMBEDDED_SIGNUP_CONFIG_ID, APP_URL/),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('finds the number when the window did not name it, and refuses to guess between several', async () => {
    graph(exchangeRoutes());
    const outcome = await beginCoexistenceOnboarding(claim({ phoneNumberId: null }), await admin());
    if (!outcome.ok) throw new Error(outcome.error);
    expect((await onboardingRow(outcome.onboardingId)).phoneNumberId).toBe(PHONE);

    graph(
      exchangeRoutes({
        numbers: {
          method: 'GET',
          path: new RegExp(`/${WABA}/phone_numbers\\?`),
          answer: () => ({ data: [{ id: PHONE }, { id: '109876543211' }] }),
        },
      }),
    );
    expect(
      await beginCoexistenceOnboarding(claim({ phoneNumberId: null }), await admin2()),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/has 2/) });
  });
});

async function admin2() {
  admins += 1;
  const [row] = await db
    .insert(agents)
    .values({ name: 'Omar Admin', email: `omar${admins}@shipblu.test`, role: 'admin' })
    .returning({ id: agents.id, name: agents.name });
  return row!;
}

describe('one live attempt per number', () => {
  it('refuses a second attempt while the first is live, before spending the code', async () => {
    graph(exchangeRoutes());
    const first = await beginCoexistenceOnboarding(claim(), await admin());
    expect(first.ok).toBe(true);

    const fetch = graph(exchangeRoutes());
    expect(await beginCoexistenceOnboarding(claim(), await admin2())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already being connected/),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('supersedes an attempt older than fifteen minutes whose job is gone', async () => {
    graph(exchangeRoutes());
    const first = await beginCoexistenceOnboarding(claim(), await admin());
    if (!first.ok) throw new Error(first.error);
    await db
      .update(whatsappOnboardings)
      .set({ startedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(whatsappOnboardings.id, first.onboardingId));

    // Still live while its job is queued, however old.
    expect(await beginCoexistenceOnboarding(claim(), await admin2())).toMatchObject({ ok: false });

    await db
      .update(jobs)
      .set({ status: 'dead' })
      .where(eq(jobs.type, 'complete_coexistence_onboarding'));
    graph(exchangeRoutes());
    const second = await beginCoexistenceOnboarding(claim(), await admin2());

    expect(second.ok).toBe(true);
    expect(await onboardingRow(first.onboardingId)).toMatchObject({
      status: 'failed',
      error: 'superseded',
    });
  });

  /** What the partial unique index is for: the check above is a read, this is not. */
  it('refuses a second exchanged row for the same number at the database', async () => {
    const base = { whatsappAccountId: crypto.randomUUID(), wabaId: WABA, phoneNumberId: PHONE };
    await db.insert(whatsappOnboardings).values({ ...base, status: 'exchanged' });
    await expect(
      db.insert(whatsappOnboardings).values({ ...base, status: 'exchanged' }),
    ).rejects.toThrow();
    await db.insert(whatsappOnboardings).values({ ...base, status: 'failed' });
  });
});

async function exchanged(routes = completeRoutes()) {
  graph(routes);
  const outcome = await beginCoexistenceOnboarding(claim(), await admin());
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.onboardingId;
}

async function channelFor(phone = PHONE) {
  const rows = await db.select().from(channels).where(eq(channels.type, 'whatsapp'));
  return rows.find((row) => row.config.phoneNumberId === phone) ?? null;
}

describe('the second phase: connecting the number', () => {
  it('connects, creates the channel, asks for the copy and names the webhook fields it lacks', async () => {
    const id = await exchanged();

    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');

    const row = await onboardingRow(id);
    expect(row.status).toBe('connected');
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.steps).toMatchObject({
      number: { ok: true, detail: '+20 10 1234 5678 · ShipBlu' },
      subscribe: {
        ok: true,
        warning: expect.stringMatching(
          /history, smb_app_state_sync, smb_message_echoes, account_update/,
        ),
      },
      channel: { ok: true, outcome: 'created' },
      contacts: { ok: true, detail: expect.stringMatching(/req-smb_app_state_sync/) },
      history: { ok: true, detail: expect.stringMatching(/req-history/) },
      templates: { ok: true },
    });

    const channel = await channelFor();
    expect(channel).toMatchObject({ name: 'ShipBlu', whatsappAccountId: row.whatsappAccountId });
    expect(row.channelId).toBe(channel!.id);
    expect(parseCoexistence(channel!.config)).toMatchObject({
      wabaId: WABA,
      verifiedName: 'ShipBlu',
      syncs: {
        contacts: { requestId: 'req-smb_app_state_sync' },
        history: { requestId: 'req-history' },
      },
    });
    expect(await queued('sync_whatsapp_templates')).toHaveLength(1);
  });

  it('keeps the connection when the phone refuses the history, and says why', async () => {
    const id = await exchanged(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          status: 400,
          answer: () => ({ error: { message: 'History sync request already made', code: 100 } }),
        },
      }),
    );

    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');

    const row = await onboardingRow(id);
    expect(row.status).toBe('connected');
    expect(row.steps.history).toMatchObject({
      ok: false,
      error: 'History sync request already made',
    });
    expect(parseCoexistence((await channelFor())!.config)?.syncs.history).toMatchObject({
      error: 'History sync request already made',
    });
  });

  it("words Meta's once-only refusal as what to do about it", async () => {
    const id = await exchanged(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          status: 400,
          answer: () => ({ error: { message: 'Sync already called', code: 2593107 } }),
        },
      }),
    );

    await completeOnboarding(id, { job: JOB });

    expect((await onboardingRow(id)).steps.contacts).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^Sync already called — Meta allows each copy once per connection/,
      ),
    });
  });

  it('fails, with a sentence, when the number is not on the WABA', async () => {
    const id = await exchanged(
      completeRoutes({
        numbers: {
          method: 'GET',
          path: new RegExp(`/${WABA}/phone_numbers\\?`),
          answer: () => ({ data: [{ id: '100000000001' }] }),
        },
      }),
    );

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');

    expect(await onboardingRow(id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/is not on business account/),
    });
    expect(await channelFor()).toBeNull();
  });

  it('records a transient failure and when it retries; fails on the last attempt', async () => {
    const outage: Route = {
      method: 'POST',
      path: new RegExp(`/${WABA}/subscribed_apps$`),
      status: 503,
      answer: () => ({ error: { message: 'Service temporarily unavailable', code: 2 } }),
    };
    const id = await exchanged(completeRoutes({ subscribe: outage }));

    await expect(
      completeOnboarding(id, { job: { attempts: 2, maxAttempts: 5 } }),
    ).rejects.toThrow();
    const waiting = await onboardingRow(id);
    expect(waiting).toMatchObject({
      status: 'exchanged',
      attempts: 2,
      lastTransientError: expect.stringMatching(/Meta answered 503.*on subscribe/),
    });
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    await expect(
      completeOnboarding(id, { job: { attempts: 5, maxAttempts: 5 } }),
    ).rejects.toThrow();
    expect(await onboardingRow(id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/gave up after 5 attempts/),
    });
  });

  it('on a reconnect, keeps the channel and does not copy six months of chats again', async () => {
    const first = await exchanged();
    await completeOnboarding(first, { job: JOB });
    const before = await channelFor();
    await db.update(channels).set({ name: 'Support line' }).where(eq(channels.id, before!.id));
    await db.update(jobs).set({ status: 'completed' });

    const fetch = graph(completeRoutes());
    const again = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!again.ok) throw new Error(again.error);
    await completeOnboarding(again.onboardingId, { job: JOB });

    const row = await onboardingRow(again.onboardingId);
    expect(row.steps).toMatchObject({
      channel: { ok: true, outcome: 'reconnected' },
      contacts: { ok: true, detail: expect.stringMatching(/Not requested/) },
      history: { ok: true, detail: expect.stringMatching(/Not requested/) },
    });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('smb_app_data'))).toBe(false);

    const after = await channelFor();
    expect(after).toMatchObject({ id: before!.id, name: 'Support line' });
    // A fresh window, with nothing requested in it yet: the buttons' to offer.
    expect(parseCoexistence(after!.config)?.syncs).toEqual({});
  });

  it('runs a named step alone on a connected number — the "copy again" button', async () => {
    const id = await exchanged(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          status: 400,
          answer: () => ({ error: { message: 'Try again later', code: 100 } }),
        },
      }),
    );
    await completeOnboarding(id, { job: JOB });

    graph(completeRoutes());
    expect(await completeOnboarding(id, { only: ['history'], job: JOB })).toBe('connected');

    const syncs = parseCoexistence((await channelFor())!.config)?.syncs;
    expect(syncs?.history).toEqual({ requestId: 'req-history', requestedAt: expect.any(String) });
    // Not asked again: only the history was named.
    expect(syncs?.contacts).toMatchObject({ error: 'Try again later' });
  });

  it('does nothing for an attempt that is no longer connecting', async () => {
    const id = await exchanged();
    await db
      .update(whatsappOnboardings)
      .set({ status: 'failed', error: 'superseded' })
      .where(eq(whatsappOnboardings.id, id));
    const fetch = graph(completeRoutes());

    expect(await completeOnboarding(id, { job: JOB })).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
    expect(await completeOnboarding(crypto.randomUUID(), { job: JOB })).toBe('gone');
  });
});

describe('retrying a failed attempt', () => {
  it('reopens it and queues the job again — unless another attempt is live', async () => {
    const id = await exchanged();
    await db
      .update(whatsappOnboardings)
      .set({ status: 'failed', error: 'Meta answered 503' })
      .where(eq(whatsappOnboardings.id, id));
    await db.delete(jobs);

    expect(await retryOnboarding(id)).toEqual({ ok: true });
    expect(await onboardingRow(id)).toMatchObject({ status: 'exchanged', error: null });
    expect(await queued('complete_coexistence_onboarding')).toHaveLength(1);

    // Now live: a second failed attempt for the same number cannot be reopened beside it.
    const [other] = await db
      .insert(whatsappOnboardings)
      .values({
        whatsappAccountId: crypto.randomUUID(),
        wabaId: WABA,
        phoneNumberId: PHONE,
        status: 'failed',
      })
      .returning({ id: whatsappOnboardings.id });
    expect(await retryOnboarding(other!.id)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already being connected/),
    });
    expect(await retryOnboarding(id)).toMatchObject({ ok: false });
  });
});

describe('recordSyncRequest', () => {
  async function coexistenceChannel() {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Coexistence',
        config: {
          phoneNumberId: PHONE,
          coexistence: { onboardedAt: new Date().toISOString(), wabaId: WABA, syncs: {} },
        },
      })
      .returning({ id: channels.id });
    return row!.id;
  }
  const syncsOf = async (id: string) =>
    parseCoexistence(
      (await db.select({ config: channels.config }).from(channels).where(eq(channels.id, id)))[0]!
        .config,
    )!.syncs;

  it('keeps progress that arrived first, and clears an earlier refusal on success', async () => {
    const id = await coexistenceChannel();
    const at = new Date('2026-10-08T10:00:00Z');

    await recordSyncRequest(id, 'history', { error: 'Try again later' }, at);
    // A history webhook processed before the request's answer was recorded.
    await db.execute(
      sql`update channels set config = jsonb_set(config, '{coexistence,syncs,history,chunks}', '3') where id = ${id}`,
    );
    await recordSyncRequest(id, 'history', { requestId: 'req-1' }, at);

    expect((await syncsOf(id)).history).toEqual({
      chunks: 3,
      requestId: 'req-1',
      requestedAt: at.toISOString(),
    });
  });

  it('never lets a refusal overwrite a request that succeeded', async () => {
    const id = await coexistenceChannel();
    const at = new Date('2026-10-08T10:00:00Z');

    await recordSyncRequest(id, 'contacts', { requestId: 'req-1' }, at);
    await recordSyncRequest(id, 'contacts', { error: 'already requested' }, at);

    expect((await syncsOf(id)).contacts).toEqual({
      requestId: 'req-1',
      requestedAt: at.toISOString(),
    });
  });

  it('does nothing to a channel that was not connected this way', async () => {
    const [row] = await db
      .insert(channels)
      .values({ type: 'whatsapp', name: 'Plain', config: { phoneNumberId: '109999999999' } })
      .returning({ id: channels.id, config: channels.config });

    await recordSyncRequest(row!.id, 'history', { requestId: 'req-1' }, new Date());

    const [after] = await db
      .select({ config: channels.config })
      .from(channels)
      .where(and(eq(channels.id, row!.id)));
    expect(after!.config).toEqual({ phoneNumberId: '109999999999' });
  });
});
