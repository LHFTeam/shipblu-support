import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  jobs,
  whatsappAccounts,
  whatsappCredentialEvents,
  whatsappOnboardings,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { canRequestSync, parseCoexistence } from './coexistence';
import { recordContactSync, recordHistoryProgress, recordSyncRequest } from './coexistence-state';
import { credentialStatuses, forgetStoredCredential } from './credentials';
import { adoptBusinessAppNumber, beginCoexistenceOnboarding, retryOnboarding } from './onboarding';
import { completeOnboarding } from './onboarding-complete';
import { copyRequestRefusal, listLatestOnboardings } from './onboarding-reads';
import { NUMBER_NOT_ON_ACCOUNT } from './onboarding-view';

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
    const answer = route.answer(url, body);
    // A route that answers per request — one sync type refused, the other not.
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: route.status ?? 200 });
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
  overrides.me ?? {
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

  /**
   * The note prints the same instant as the credential card on /admin/channels,
   * so it reads it in Cairo as the card does. Each case is an expiry in the
   * first hours of a Cairo day, whose UTC date is the day before — which the
   * note printed while it took the date off `toISOString()` — once on either
   * side of daylight saving, since the hours affected move with it.
   */
  it.each([
    {
      season: 'winter',
      cairo: '2027-01-15T01:30',
      utcDay: '2027-01-14',
      shown: '15 Jan 2027, 01:30',
    },
    {
      season: 'summer',
      cairo: '2027-07-15T02:30',
      utcDay: '2027-07-14',
      shown: '15 Jul 2027, 02:30',
    },
  ])(
    'says when the token expires on the Cairo day, as the card does ($season)',
    async ({ cairo, utcDay, shown }) => {
      const expires = DateTime.fromISO(cairo, { zone: TEAM_TIME_ZONE });
      expect(expires.toUTC().toISODate()).toBe(utcDay);
      graph(
        exchangeRoutes({
          debug: {
            method: 'GET',
            path: /\/debug_token\?/,
            answer: () => ({
              data: {
                app_id: APP_ID,
                is_valid: true,
                expires_at: expires.toUnixInteger(),
                scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
                granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [WABA] }],
              },
            }),
          },
        }),
      );

      const outcome = await beginCoexistenceOnboarding(claim(), await admin());

      expect(outcome).toMatchObject({
        ok: true,
        notice: expect.stringContaining(`(expires ${shown})`),
      });
      const [account] = await db.select().from(whatsappAccounts);
      expect((await credentialStatuses()).get(account!.id)?.expiresAt).toEqual(expires.toJSDate());
    },
  );

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

  /**
   * The one check of the group: the action used to run its own copy, and two
   * copies of a refusal drift. Before the exchange, because a refusal after it
   * would cost the business its one-use code and another pass through Meta's
   * window.
   */
  it('refuses a default group that no longer exists, before spending the code', async () => {
    const fetch = stubFetch(async () => new Response('unrouted', { status: 599 }));

    const outcome = await beginCoexistenceOnboarding(
      claim({ defaultGroupId: '00000000-0000-4000-8000-000000000001' }),
      await admin(),
    );

    expect(outcome).toEqual({
      ok: false,
      error: 'That default group no longer exists — reload the page.',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(whatsappOnboardings)).toEqual([]);
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

  /**
   * Graph is not known to echo a bearer token or the request it was sent, but
   * nothing promises it never will. So every read made with the new token
   * answers here with a sentence carrying all three secrets, and the sentence
   * must still reach the admin — it is the only reason they are given — with
   * none of them in it, nor in a log line, a row or a job.
   */
  describe('when Graph echoes what it was sent', () => {
    const ECHO = `Invalid OAuth access token - Cannot parse access token ${TOKEN} (code ${CODE}, client_secret ${APP_SECRET})`;
    const refusing = (path: RegExp, status = 400): Route => ({
      method: 'GET',
      path,
      status,
      answer: () => ({ error: { message: ECHO, type: 'OAuthException', code: 190 } }),
    });

    async function everythingWritten(): Promise<string> {
      return JSON.stringify([
        await db.select().from(whatsappOnboardings),
        await db.select().from(whatsappAccounts),
        await db.select().from(whatsappCredentialEvents),
        await db.select().from(channels),
        await db.select().from(jobs),
      ]);
    }

    it.each([
      {
        read: 'the WABA read',
        routes: { waba: refusing(new RegExp(`/${WABA}\\?`)) },
        phoneNumberId: PHONE,
        outcome: { ok: false, error: expect.stringMatching(/cannot read business account/) },
      },
      {
        read: 'the phone_numbers read',
        routes: { numbers: refusing(new RegExp(`/${WABA}/phone_numbers\\?`)) },
        phoneNumberId: null,
        outcome: { ok: false, error: expect.stringMatching(/would not list the numbers/) },
      },
      {
        read: 'the /me read',
        routes: { me: refusing(/\/me\?/) },
        phoneNumberId: PHONE,
        outcome: { ok: true, notice: expect.stringMatching(/which business portfolio/) },
      },
      {
        read: 'debug_token, failing',
        routes: { debug: refusing(/\/debug_token\?/, 500) },
        phoneNumberId: PHONE,
        outcome: { ok: true, notice: expect.stringMatching(/inspection did not answer/) },
      },
      {
        read: 'debug_token, calling the token invalid',
        routes: {
          debug: {
            method: 'GET',
            path: /\/debug_token\?/,
            answer: () => ({ data: { app_id: APP_ID, is_valid: false, error: { message: ECHO } } }),
          } satisfies Route,
        },
        phoneNumberId: PHONE,
        outcome: { ok: false, error: expect.stringMatching(/is not valid/) },
      },
    ])('repeats $read with all three cut out', async ({ routes, phoneNumberId, outcome }) => {
      const logs = captureLogs();
      graph(exchangeRoutes(routes));

      const answered = await beginCoexistenceOnboarding(claim({ phoneNumberId }), await admin());

      expect(answered).toMatchObject(outcome);
      // Meta's sentence did arrive, so the absences below are a scrub, not silence.
      expect(JSON.stringify(answered)).toContain('Cannot parse access token [redacted]');
      for (const secret of [TOKEN, CODE, APP_SECRET]) {
        expect(JSON.stringify(answered)).not.toContain(secret);
        expect(logs()).not.toContain(secret);
        expect(await everythingWritten()).not.toContain(secret);
      }
    });
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
    // `wait`: the card must not offer Meta's window again, which would unlink
    // the phone's linked devices once more and end the same way.
    expect(await beginCoexistenceOnboarding(claim(), await admin2())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already being connected/),
      wait: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses at the insert, with the same wait, when the window did not name the number', async () => {
    graph(exchangeRoutes());
    const first = await beginCoexistenceOnboarding(claim(), await admin());
    if (!first.ok) throw new Error(first.error);

    // No number in the claim, so the cheap check cannot be asked: the code is
    // spent, the number read off the WABA, and the partial unique index
    // refuses the row.
    graph(exchangeRoutes());
    expect(
      await beginCoexistenceOnboarding(claim({ phoneNumberId: null }), await admin2()),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already being connected/),
      wait: true,
    });
    expect(await db.select({ id: whatsappOnboardings.id }).from(whatsappOnboardings)).toEqual([
      { id: first.onboardingId },
    ]);
  });

  /**
   * The cheap check is the only one asked when the window names the number;
   * without one, the index refused and the answer was always "again in fifteen
   * minutes" — false for as long as the worker stays down, and every press
   * spends a code and unlinks the phone's devices again.
   */
  it('names the waiting job at the insert too, when only the queue keeps the first attempt live', async () => {
    graph(exchangeRoutes());
    const first = await beginCoexistenceOnboarding(claim(), await admin());
    if (!first.ok) throw new Error(first.error);
    await db
      .update(whatsappOnboardings)
      .set({ startedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(whatsappOnboardings.id, first.onboardingId));
    expect(await queued('complete_coexistence_onboarding')).toHaveLength(1);

    const fetch = graph(exchangeRoutes());
    expect(
      await beginCoexistenceOnboarding(claim({ phoneNumberId: null }), await admin2()),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/still waiting in the queue.*worker service/),
      wait: true,
    });
    // Refused at the insert, not before the code was spent.
    expect(fetch).toHaveBeenCalled();
    expect(await onboardingRow(first.onboardingId)).toMatchObject({ status: 'exchanged' });
    expect(await db.select({ id: whatsappOnboardings.id }).from(whatsappOnboardings)).toEqual([
      { id: first.onboardingId },
    ]);
  });

  it('supersedes an attempt older than fifteen minutes whose job is gone', async () => {
    graph(exchangeRoutes());
    const first = await beginCoexistenceOnboarding(claim(), await admin());
    if (!first.ok) throw new Error(first.error);
    await db
      .update(whatsappOnboardings)
      .set({ startedAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(whatsappOnboardings.id, first.onboardingId));

    // Still live while its job is queued, however old — and said so as a job
    // no worker has run, not as "again in fifteen minutes", which is false for
    // as long as the worker stays down.
    expect(await beginCoexistenceOnboarding(claim(), await admin2())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/still waiting in the queue.*worker service/),
      wait: true,
    });

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

/**
 * The phone answering the connection's copies, through the writers its
 * webhooks use: some contacts, and history chunks at `historyAt` percent.
 * Without it a copy was only asked for, and a reconnect asks for it again
 * (`copiedSoFar`) — so the reconnect tests below say what the phone sent.
 */
async function phoneSent({
  contacts = 3,
  historyAt = 100 as number | null,
}: { contacts?: number; historyAt?: number | null } = {}) {
  const channel = await channelFor();
  const at = new Date();
  // One write per delivery, as the webhook handler counts them.
  await recordContactSync(channel!.id, at, contacts);
  if (historyAt === null) return;
  // Each phase, as Meta sends them: the last one reported carries the figure.
  for (const phase of [0, 1, 2]) {
    await recordHistoryProgress(channel!.id, { phase, progress: historyAt }, at);
  }
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

  it('keeps the connection when Meta refuses the copy request, and says why', async () => {
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
      // In a word, so the page can tell the wrong number from a failure a
      // Retry may fix without reading the sentence (`shownOnboardings`).
      steps: { number: { ok: false, outcome: NUMBER_NOT_ON_ACCOUNT } },
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
    await phoneSent();
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
    // And what the earlier connection copied, on the channel the row reads —
    // without it, a day later the row calls both "never copied".
    expect(parseCoexistence(after!.config)?.carriedOver).toEqual(['contacts', 'history']);
  });

  /**
   * A reconnect's own slots are empty — it asked for nothing — so "copied"
   * has to carry through it, or the reconnect after it asks the phone for six
   * months of chats the helpdesk already holds.
   */
  it('on a second reconnect, still does not copy what the first connection copied', async () => {
    const first = await exchanged();
    await completeOnboarding(first, { job: JOB });
    await phoneSent();
    await db.update(jobs).set({ status: 'completed' });

    graph(completeRoutes());
    const second = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!second.ok) throw new Error(second.error);
    await completeOnboarding(second.onboardingId, { job: JOB });
    await db.update(jobs).set({ status: 'completed' });

    const fetch = graph(completeRoutes());
    const third = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!third.ok) throw new Error(third.error);
    await completeOnboarding(third.onboardingId, { job: JOB });

    const { steps } = await onboardingRow(third.onboardingId);
    expect(steps.channel).toMatchObject({
      outcome: 'reconnected',
      previouslyCopied: ['contacts', 'history'],
    });
    expect(steps.history).toMatchObject({ ok: true, outcome: 'previously_copied' });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('smb_app_data'))).toBe(false);
    expect(parseCoexistence((await channelFor())!.config)?.carriedOver).toEqual([
      'contacts',
      'history',
    ]);
  });

  it('on a reconnect, asks for what the earlier connection did not get — refused, or declined', async () => {
    const first = await exchanged(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          answer: (_url, body) =>
            (body as { sync_type: string }).sync_type === 'history'
              ? new Response(JSON.stringify({ error: { message: 'Try again later', code: 100 } }), {
                  status: 400,
                })
              : { messaging_product: 'whatsapp', request_id: 'req-contacts-1' },
        },
      }),
    );
    await completeOnboarding(first, { job: JOB });
    await phoneSent({ historyAt: null });
    await db.update(jobs).set({ status: 'completed' });

    const fetch = graph(completeRoutes());
    const again = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!again.ok) throw new Error(again.error);
    await completeOnboarding(again.onboardingId, { job: JOB });

    const { steps } = await onboardingRow(again.onboardingId);
    expect(steps.channel).toMatchObject({ outcome: 'reconnected', previouslyCopied: ['contacts'] });
    expect(steps.contacts).toMatchObject({ ok: true, outcome: 'previously_copied' });
    expect(steps.history).toMatchObject({ ok: true, detail: expect.stringMatching(/req-history/) });
    const asked = fetch.mock.calls
      .filter(([url]) => String(url).includes('smb_app_data'))
      .map(([, init]) => JSON.parse(String(init?.body)).sync_type);
    expect(asked).toEqual(['history']);
  });

  it('on a reconnect, asks again for a history the business declined on the phone', async () => {
    const first = await exchanged();
    await completeOnboarding(first, { job: JOB });
    await phoneSent({ historyAt: null });
    const channel = await channelFor();
    await db.execute(
      sql`update channels set config = jsonb_set(config, '{coexistence,syncs,history,declined}', 'true') where id = ${channel!.id}`,
    );
    await db.update(jobs).set({ status: 'completed' });

    const fetch = graph(completeRoutes());
    const again = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!again.ok) throw new Error(again.error);
    await completeOnboarding(again.onboardingId, { job: JOB });

    const { steps } = await onboardingRow(again.onboardingId);
    expect(steps.channel).toMatchObject({ outcome: 'reconnected', previouslyCopied: ['contacts'] });
    expect(steps.contacts).toMatchObject({ ok: true, outcome: 'previously_copied' });
    expect(steps.history).toMatchObject({ ok: true, detail: expect.stringMatching(/req-history/) });
    const asked = fetch.mock.calls
      .filter(([url]) => String(url).includes('smb_app_data'))
      .map(([, init]) => JSON.parse(String(init?.body)).sync_type);
    expect(asked).toEqual(['history']);
  });

  /**
   * The case the "history stalled" badge sends an admin to Reconnect for. The
   * stalled copy holds a request id, and counting that as copied had the
   * reconnect skip the one copy it was made for — and, carried over, never
   * offer it again.
   */
  it('on a reconnect, asks again for a history copy that stalled part-way', async () => {
    const first = await exchanged();
    await completeOnboarding(first, { job: JOB });
    await phoneSent({ historyAt: 30 });
    await db.update(jobs).set({ status: 'completed' });

    const fetch = graph(completeRoutes());
    const again = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!again.ok) throw new Error(again.error);
    await completeOnboarding(again.onboardingId, { job: JOB });

    const { steps } = await onboardingRow(again.onboardingId);
    expect(steps.channel).toMatchObject({ outcome: 'reconnected', previouslyCopied: ['contacts'] });
    expect(steps.history).toMatchObject({ ok: true, detail: expect.stringMatching(/req-history/) });
    const asked = fetch.mock.calls
      .filter(([url]) => String(url).includes('smb_app_data'))
      .map(([, init]) => JSON.parse(String(init?.body)).sync_type);
    expect(asked).toEqual(['history']);
    expect(parseCoexistence((await channelFor())!.config)?.carriedOver).toEqual(['contacts']);
  });

  /** Nor a contacts copy that never delivered one: Meta sends no "finished" for those. */
  it('on a reconnect, asks again for contacts that never arrived', async () => {
    const first = await exchanged();
    await completeOnboarding(first, { job: JOB });
    await phoneSent({ contacts: 0 });
    await db.update(jobs).set({ status: 'completed' });

    const fetch = graph(completeRoutes());
    const again = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!again.ok) throw new Error(again.error);
    await completeOnboarding(again.onboardingId, { job: JOB });

    const { steps } = await onboardingRow(again.onboardingId);
    expect(steps.channel).toMatchObject({ outcome: 'reconnected', previouslyCopied: ['history'] });
    expect(steps.contacts).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/req-smb_app_state_sync/),
    });
    const asked = fetch.mock.calls
      .filter(([url]) => String(url).includes('smb_app_data'))
      .map(([, init]) => JSON.parse(String(init?.body)).sync_type);
    expect(asked).toEqual(['smb_app_state_sync']);
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

  it('stops copying when Meta says the number is not on the Business app, and warns of a platform', async () => {
    const fetch = graph(
      completeRoutes({
        platform: {
          method: 'GET',
          path: new RegExp(`/${PHONE}\\?fields=is_on_biz_app,platform_type$`),
          answer: () => ({ is_on_biz_app: false, platform_type: 'ON_PREMISE', id: PHONE }),
        },
      }),
    );
    const id = await beginCoexistenceOnboarding(claim(), await admin()).then((outcome) => {
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.onboardingId;
    });

    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');

    const { steps } = await onboardingRow(id);
    expect(steps.number?.warning).toMatch(
      /not on the WhatsApp Business app.*ON_PREMISE, not CLOUD_API/,
    );
    expect(steps.contacts).toMatchObject({ ok: true, outcome: 'not_applicable' });
    expect(steps.history).toMatchObject({ ok: true, outcome: 'not_applicable' });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('smb_app_data'))).toBe(false);

    // On the channel too, where the row's buttons and badges look: no copy is
    // offered, and the window closing is nothing missed.
    const coexistence = parseCoexistence((await channelFor())!.config)!;
    expect(coexistence.notOnBusinessApp).toBe(true);
    expect(canRequestSync(coexistence, 'history', new Date())).toMatchObject({
      ok: false,
      reason: 'not_on_business_app',
    });
  });

  it('reads Meta’s "already asked" after a lost answer as the first request having gone through', async () => {
    const outage: Route = {
      method: 'POST',
      path: new RegExp(`/${PHONE}/smb_app_data$`),
      status: 503,
      answer: () => ({ error: { message: 'Service temporarily unavailable', code: 2 } }),
    };
    const id = await exchanged(completeRoutes({ sync: outage }));
    await expect(
      completeOnboarding(id, { job: { attempts: 1, maxAttempts: 5 } }),
    ).rejects.toThrow();
    expect((await onboardingRow(id)).steps.contacts).toMatchObject({ outcome: 'sending' });

    graph(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          status: 400,
          answer: () => ({ error: { message: 'Sync already called', code: 2593107 } }),
        },
      }),
    );
    expect(await completeOnboarding(id, { job: { attempts: 2, maxAttempts: 5 } })).toBe(
      'connected',
    );

    expect((await onboardingRow(id)).steps.contacts).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/answer was lost/),
    });
    expect(parseCoexistence((await channelFor())!.config)?.syncs.contacts).toMatchObject({
      requestId: 'unconfirmed',
    });
  });

  /**
   * After its channel step, an attempt waiting out a retry has written the
   * object the copy buttons read, with nothing requested in it. The button's
   * action used to enqueue a copy the job then skipped as "not connected";
   * now both answer from one rule, and both open up once the attempt finishes.
   */
  it('refuses the copy buttons while the attempt is still connecting, as the job would', async () => {
    const outage: Route = {
      method: 'POST',
      path: new RegExp(`/${PHONE}/smb_app_data$`),
      status: 503,
      answer: () => ({ error: { message: 'Service temporarily unavailable', code: 2 } }),
    };
    const id = await exchanged(completeRoutes({ sync: outage }));
    await expect(
      completeOnboarding(id, { job: { attempts: 1, maxAttempts: 5 } }),
    ).rejects.toThrow();

    expect((await onboardingRow(id)).status).toBe('exchanged');
    const coexistence = parseCoexistence((await channelFor())!.config)!;
    expect(coexistence.onboardingId).toBe(id);
    expect(canRequestSync(coexistence, 'history', new Date())).toEqual({ ok: true });

    expect(await copyRequestRefusal(id)).toMatch(/has not finished yet/);
    expect(await completeOnboarding(id, { only: ['history'], job: JOB })).toBe('skipped');

    graph(completeRoutes());
    expect(await completeOnboarding(id, { job: { attempts: 2, maxAttempts: 5 } })).toBe(
      'connected',
    );
    expect(await copyRequestRefusal(id)).toBeNull();
  });

  it('finishes connected, not failed, when the last attempt dies after the channel exists', async () => {
    const id = await exchanged(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          status: 503,
          answer: () => ({ error: { message: 'Service temporarily unavailable', code: 2 } }),
        },
      }),
    );

    expect(await completeOnboarding(id, { job: { attempts: 5, maxAttempts: 5 } })).toBe(
      'connected',
    );

    const row = await onboardingRow(id);
    expect(row).toMatchObject({
      status: 'connected',
      lastTransientError: null,
      nextAttemptAt: null,
    });
    expect(row.steps.contacts).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Meta answered 503.*gave up after 5 attempts/),
    });
    expect(await channelFor()).not.toBeNull();
    expect(await queued('sync_whatsapp_templates')).toHaveLength(1);
  });

  it('fails, rather than connecting with another token, when the stored credential was forgotten', async () => {
    const id = await exchanged();
    const row = await onboardingRow(id);
    await forgetStoredCredential(row.whatsappAccountId, null);
    process.env.META_PAGE_ACCESS_TOKEN = 'shared-token';
    resetEnvCache();

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    expect(await onboardingRow(id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/has since been forgotten/),
    });
    expect(await channelFor()).toBeNull();
  });

  it('re-running into its own channel neither rewrites it nor calls its own requests refused', async () => {
    const id = await exchanged();
    await completeOnboarding(id, { job: JOB });
    const before = await channelFor();
    // A run that died after the channel's writes and before the steps' records.
    await db
      .update(whatsappOnboardings)
      .set({
        status: 'exchanged',
        finishedAt: null,
        steps: sql`${whatsappOnboardings.steps} - 'channel' - 'contacts' - 'history'`,
      })
      .where(eq(whatsappOnboardings.id, id));
    const fetch = graph(completeRoutes());

    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');

    const { steps } = await onboardingRow(id);
    expect(steps.channel).toMatchObject({ ok: true, outcome: 'connected' });
    expect(steps.history).toMatchObject({ ok: true, detail: expect.stringMatching(/earlier/) });
    expect((await channelFor())!.config).toEqual(before!.config);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('smb_app_data'))).toBe(false);
  });

  /** A reconnect's run that died after writing the channel still carries over what it did. */
  it('re-running a reconnect into its own channel still skips what it carried over', async () => {
    const first = await exchanged();
    await completeOnboarding(first, { job: JOB });
    await phoneSent();
    await db.update(jobs).set({ status: 'completed' });

    graph(completeRoutes());
    const again = await beginCoexistenceOnboarding(claim(), await admin2());
    if (!again.ok) throw new Error(again.error);
    await completeOnboarding(again.onboardingId, { job: JOB });
    await db
      .update(whatsappOnboardings)
      .set({
        status: 'exchanged',
        finishedAt: null,
        steps: sql`${whatsappOnboardings.steps} - 'channel' - 'contacts' - 'history'`,
      })
      .where(eq(whatsappOnboardings.id, again.onboardingId));
    const fetch = graph(completeRoutes());

    expect(await completeOnboarding(again.onboardingId, { job: JOB })).toBe('connected');

    const { steps } = await onboardingRow(again.onboardingId);
    expect(steps.channel).toMatchObject({
      ok: true,
      outcome: 'connected',
      previouslyCopied: ['contacts', 'history'],
    });
    expect(steps.history).toMatchObject({ ok: true, outcome: 'previously_copied' });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('smb_app_data'))).toBe(false);
  });

  it('queues the template sync again when asked by name, though it already ran once', async () => {
    const id = await exchanged();
    await completeOnboarding(id, { job: JOB });
    expect(await queued('sync_whatsapp_templates')).toHaveLength(1);

    expect(await completeOnboarding(id, { only: ['templates'], job: JOB })).toBe('connected');
    expect(await queued('sync_whatsapp_templates')).toHaveLength(2);
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

describe('retrying an attempt something has replaced, or that stalled', () => {
  const attempt = (values: Partial<typeof whatsappOnboardings.$inferInsert> = {}) =>
    db
      .insert(whatsappOnboardings)
      .values({
        whatsappAccountId: crypto.randomUUID(),
        wabaId: WABA,
        phoneNumberId: PHONE,
        status: 'failed',
        ...values,
      })
      .returning({ id: whatsappOnboardings.id })
      .then((rows) => rows[0]!.id);

  it('refuses one a newer attempt superseded, or that is simply older than another', async () => {
    const superseded = await attempt({ error: 'superseded' });
    const older = await attempt({ createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    await attempt();

    for (const id of [superseded, older]) {
      expect(await retryOnboarding(id)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/newer connection/),
      });
      expect((await onboardingRow(id)).status).toBe('failed');
    }
    expect(await queued('complete_coexistence_onboarding')).toEqual([]);
  });

  it('reopens an exchanged attempt whose job died, and refuses one still live', async () => {
    const stalled = await attempt({
      status: 'exchanged',
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      lastTransientError: 'Meta answered 503 on subscribe',
    });

    expect(await retryOnboarding(stalled)).toEqual({ ok: true });
    const row = await onboardingRow(stalled);
    expect(row).toMatchObject({ status: 'exchanged', lastTransientError: null });
    expect(row.startedAt.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
    expect(await queued('complete_coexistence_onboarding')).toHaveLength(1);

    // Now it is live — just started, and its job queued.
    expect(await retryOnboarding(stalled)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already being connected/),
    });
    expect(await queued('complete_coexistence_onboarding')).toHaveLength(1);
  });

  /**
   * Past fifteen minutes only a queued job keeps an attempt live, and the card
   * offers Retry by then. "It can be started again in fifteen minutes" answered
   * every press of it, for as long as no worker ran.
   */
  it('refuses one whose job is still queued with the worker named, not "fifteen minutes"', async () => {
    const waiting = await attempt({
      status: 'exchanged',
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    await db.insert(jobs).values({
      type: 'complete_coexistence_onboarding',
      payload: { onboardingId: waiting },
      status: 'pending',
    });

    expect(await retryOnboarding(waiting)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no worker has finished it.*worker service.*Nothing is lost/),
    });
    expect(await onboardingRow(waiting)).toMatchObject({ status: 'exchanged' });
    expect(await queued('complete_coexistence_onboarding')).toHaveLength(1);
  });

  /** The partial unique index's refusal picks between the same two sentences. */
  it('names the waiting job when another attempt on the number is live only through it', async () => {
    const waiting = await attempt({
      status: 'exchanged',
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    await db.insert(jobs).values({
      type: 'complete_coexistence_onboarding',
      payload: { onboardingId: waiting },
      status: 'pending',
    });
    const failed = await attempt();

    expect(await retryOnboarding(failed)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/still waiting in the queue.*worker service/),
    });
    expect(await onboardingRow(failed)).toMatchObject({ status: 'failed' });
    expect(await queued('complete_coexistence_onboarding')).toHaveLength(1);
  });

  it('refuses a connected one', async () => {
    const connected = await attempt({ status: 'connected' });
    expect(await retryOnboarding(connected)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already connected/),
    });
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

/**
 * The second phase runs with the decrypted stored token, and every sentence it
 * records — a step's error or warning, `last_transient_error`, the attempt's
 * `error`, a credential's refusal, the worker log — is read by somebody. So
 * when Meta's answer repeats the token, or the app secret the subscription
 * read goes out with, neither may survive into any of them (`askGraph`).
 */
describe('the second phase, when Graph echoes what it was sent', () => {
  const ECHO = `Invalid OAuth access token - Cannot parse access token ${TOKEN} (client_secret ${APP_SECRET})`;
  const refusing = (method: 'GET' | 'POST', path: RegExp, status = 400, code = 100): Route => ({
    method,
    path,
    status,
    answer: () => ({ error: { message: ECHO, type: 'OAuthException', code } }),
  });

  async function everythingWritten(): Promise<string> {
    return JSON.stringify([
      await db.select().from(whatsappOnboardings),
      await db.select().from(whatsappCredentialEvents),
      await db.select().from(channels),
      await db.select().from(jobs),
    ]);
  }

  it.each([
    {
      read: 'the phone_numbers read',
      overrides: { numbers: refusing('GET', new RegExp(`/${WABA}/phone_numbers\\?`)) },
    },
    {
      read: 'the platform read',
      overrides: {
        platform: refusing('GET', new RegExp(`/${PHONE}\\?fields=is_on_biz_app,platform_type$`)),
      },
    },
    {
      read: 'the subscription',
      overrides: { subscribe: refusing('POST', new RegExp(`/${WABA}/subscribed_apps$`)) },
    },
    {
      read: 'a transient subscription failure',
      overrides: {
        subscribe: refusing('POST', new RegExp(`/${WABA}/subscribed_apps$`), 503, 2),
      },
    },
    {
      read: "the app's webhook fields",
      overrides: { appFields: refusing('GET', new RegExp(`/${APP_ID}/subscriptions$`)) },
    },
    {
      read: 'the copy request',
      overrides: { sync: refusing('POST', new RegExp(`/${PHONE}/smb_app_data$`)) },
    },
    {
      read: 'the copy request, refused as a bad token',
      overrides: { sync: refusing('POST', new RegExp(`/${PHONE}/smb_app_data$`), 400, 190) },
    },
  ])('records $read with both cut out', async ({ overrides }) => {
    const id = await exchanged();
    graph(completeRoutes(overrides));
    const logs = captureLogs();

    let thrown = '';
    try {
      await completeOnboarding(id, { job: { attempts: 2, maxAttempts: 5 } });
    } catch (error) {
      thrown = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    }

    const written = await everythingWritten();
    // Meta's sentence did arrive somewhere a person reads, so the absences
    // below are a scrub, not silence.
    expect(`${written}\n${logs()}\n${thrown}`).toContain('Cannot parse access token [redacted]');
    for (const secret of [TOKEN, APP_SECRET]) {
      expect(written).not.toContain(secret);
      expect(logs()).not.toContain(secret);
      expect(thrown).not.toContain(secret);
    }
  });
});

/**
 * A number the business connected to Cloud API in Meta's own interface, added
 * from its business account's row. Nothing was exchanged or stored, so what is
 * pinned is the credential: the account's variable, or its stored one, and
 * never the shared Page token — and the sentences that say which.
 */
describe('adopting a number connected in Meta’s own interface', () => {
  const VARIABLE = 'WHATSAPP_TOKEN_ADOPTED';
  const VARIABLE_TOKEN = 'EAAGsystemUserTokenForTheAdoptedNumber0123456789';
  const SECOND = '108765432109';

  async function account(tokenEnvVar: string | null = VARIABLE) {
    const [row] = await db
      .insert(whatsappAccounts)
      .values({ name: 'ShipBlu Sales', wabaId: WABA, tokenEnvVar })
      .returning({ id: whatsappAccounts.id });
    return row!.id;
  }

  async function adopted(accountId: string, phoneNumberId = PHONE) {
    const outcome = await adoptBusinessAppNumber(
      { accountId, phoneNumberId, defaultGroupId: null },
      await admin(),
    );
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.onboardingId;
  }

  /** The bearer tokens Graph was sent for the number and its WABA — not the app's own reads. */
  function bearersFor(fetch: ReturnType<typeof graph>, ...ids: string[]) {
    return fetch.mock.calls
      .filter(([url]) => ids.some((id) => new URL(String(url)).pathname.includes(`/${id}`)))
      .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization);
  }

  beforeEach(() => {
    process.env[VARIABLE] = VARIABLE_TOKEN;
  });

  it('connects with the variable the account names, and marks the channel adopted', async () => {
    const accountId = await account();
    const id = await adopted(accountId);

    const row = await onboardingRow(id);
    expect(row).toMatchObject({ origin: 'adopted', status: 'exchanged', wabaId: WABA });
    // The job is handed the attempt and nothing else — no token, no origin.
    expect(await queued('complete_coexistence_onboarding')).toEqual([
      { payload: { onboardingId: id } },
    ]);
    expect((await listLatestOnboardings())[0]).toMatchObject({ id, origin: 'adopted' });

    const fetch = graph(completeRoutes());
    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');

    const sent = bearersFor(fetch, WABA, PHONE);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set([`Bearer ${VARIABLE_TOKEN}`]));

    const channel = await channelFor();
    expect(channel).toMatchObject({ whatsappAccountId: accountId, isActive: true });
    expect(parseCoexistence(channel!.config)).toMatchObject({
      onboardingId: id,
      onboardedAt: row.createdAt.toISOString(),
      adopted: true,
      syncs: {
        contacts: { requestId: 'req-smb_app_state_sync' },
        history: { requestId: 'req-history' },
      },
    });
    // Nothing was stored, and the account still names its variable.
    expect(await credentialStatuses()).toEqual(new Map());
    const [after] = await db
      .select({ tokenEnvVar: whatsappAccounts.tokenEnvVar })
      .from(whatsappAccounts)
      .where(eq(whatsappAccounts.id, accountId));
    expect(after!.tokenEnvVar).toBe(VARIABLE);
  });

  it('takes over a plain channel already made for the number by hand', async () => {
    const accountId = await account();
    const [plain] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Sales line',
        whatsappAccountId: accountId,
        config: { phoneNumberId: PHONE },
      })
      .returning({ id: channels.id });
    const id = await adopted(accountId);

    graph(completeRoutes());
    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');

    const channel = await channelFor();
    expect(channel!.id).toBe(plain!.id);
    expect(channel!.name).toBe('Sales line');
    expect(parseCoexistence(channel!.config)).toMatchObject({ onboardingId: id, adopted: true });
  });

  it('refuses, queueing nothing, what the job could only refuse later', async () => {
    const mona = await admin();
    const adopt = (accountId: string, phoneNumberId = PHONE) =>
      adoptBusinessAppNumber({ accountId, phoneNumberId, defaultGroupId: null }, mona);

    const shared = await account(null);
    expect(await adopt(shared)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/names no token variable/),
    });

    await db
      .update(whatsappAccounts)
      .set({ tokenEnvVar: VARIABLE })
      .where(eq(whatsappAccounts.id, shared));
    expect(await adopt(shared, '+20 10 1234 5678')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not the phone number itself/),
    });
    expect(await adopt(crypto.randomUUID())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer exists/),
    });

    await db.insert(channels).values({
      type: 'whatsapp_bot',
      name: 'Bot',
      config: { phoneNumberId: SECOND },
    });
    expect(await adopt(shared, SECOND)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/customer bot's channel/),
    });

    await db
      .update(whatsappAccounts)
      .set({ isActive: false })
      .where(eq(whatsappAccounts.id, shared));
    expect(await adopt(shared)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is switched off/),
    });

    expect(await db.select().from(whatsappOnboardings)).toEqual([]);
    expect(await queued('complete_coexistence_onboarding')).toEqual([]);
  });

  it('refuses a number already connected, waits out an offboarding, and adds one the phone disconnected', async () => {
    const accountId = await account();
    const first = await adopted(accountId);
    graph(completeRoutes());
    await completeOnboarding(first, { job: JOB });
    const adopt = async () =>
      adoptBusinessAppNumber(
        { accountId, phoneNumberId: PHONE, defaultGroupId: null },
        await admin(),
      );

    expect(await adopt()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already connected.*disconnect it from the business platform/s),
    });

    const channel = await channelFor();
    const disconnect = (event: string) =>
      db
        .update(channels)
        .set({
          config: sql`jsonb_set(${channels.config}, '{coexistence,disconnected}', ${JSON.stringify({
            at: new Date().toISOString(),
            event,
            reason: null,
            initiatedBy: null,
          })}::jsonb)`,
        })
        .where(eq(channels.id, channel!.id));

    // Meta undoes this one by itself; adding the number now would restart its copies.
    await disconnect('ACCOUNT_OFFBOARDED');
    expect(await adopt()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/usually undoes/),
    });

    await disconnect('PARTNER_REMOVED');
    expect((await adopt()).ok).toBe(true);
  });

  it('refuses a second attempt while the first is live', async () => {
    const accountId = await account();
    await adopted(accountId);
    expect(
      await adoptBusinessAppNumber(
        { accountId, phoneNumberId: PHONE, defaultGroupId: null },
        await admin(),
      ),
    ).toMatchObject({ ok: false, wait: true });
  });

  it('fails with a sentence when the variable is not set, and Retry runs it once it is', async () => {
    const accountId = await account('WHATSAPP_TOKEN_NOT_SET_YET');
    const id = await adopted(accountId);
    const fetch = graph(completeRoutes());

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    expect(await onboardingRow(id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/WHATSAPP_TOKEN_NOT_SET_YET .*is not set.*Retry connection/s),
    });
    expect(fetch).not.toHaveBeenCalled();

    process.env.WHATSAPP_TOKEN_NOT_SET_YET = VARIABLE_TOKEN;
    expect(await retryOnboarding(id)).toEqual({ ok: true });
    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');
  });

  it('never falls back to the shared Page token', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    // The variable cleared after the attempt was queued: the account now
    // resolves to META_PAGE_ACCESS_TOKEN, which reaches no WhatsApp account.
    await db
      .update(whatsappAccounts)
      .set({ tokenEnvVar: null })
      .where(eq(whatsappAccounts.id, accountId));
    process.env.META_PAGE_ACCESS_TOKEN = 'page-token';
    resetEnvCache();
    const fetch = graph(completeRoutes());

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    expect(await onboardingRow(id)).toMatchObject({
      error: expect.stringMatching(/META_PAGE_ACCESS_TOKEN is the Facebook Page's/),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await channelFor()).toBeNull();
  });

  it('fails at once, naming the account, when there is no source and no shared token either', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    await db
      .update(whatsappAccounts)
      .set({ tokenEnvVar: null })
      .where(eq(whatsappAccounts.id, accountId));
    delete process.env.META_PAGE_ACCESS_TOKEN;
    resetEnvCache();
    const fetch = graph(completeRoutes());

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    expect(await onboardingRow(id)).toMatchObject({
      status: 'failed',
      lastTransientError: null,
      error: expect.stringMatching(/"ShipBlu Sales" holds no stored credential.*Retry connection/s),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a token issued for another Meta app before subscribing anything', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    const fetch = graph(
      completeRoutes({
        debug: {
          method: 'GET',
          path: /\/debug_token\?/,
          answer: () => ({
            data: { app_id: '5550001112', is_valid: true, expires_at: 0, scopes: [] },
          }),
        },
      }),
    );

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    expect((await onboardingRow(id)).error).toMatch(
      new RegExp(`${VARIABLE} holds a token issued for Meta app 5550001112, not this one`),
    );
    const subscribes = fetch.mock.calls.filter(
      ([url, init]) => init?.method === 'POST' && String(url).includes('/subscribed_apps'),
    );
    expect(subscribes).toEqual([]);
    expect(await channelFor()).toBeNull();
  });

  it('says to ask for the copy again, not to Retry, when a copy-again run has no credential', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    graph(completeRoutes());
    await completeOnboarding(id, { job: JOB });
    await db
      .update(whatsappAccounts)
      .set({ tokenEnvVar: null })
      .where(eq(whatsappAccounts.id, accountId));

    expect(await completeOnboarding(id, { only: ['history'], job: JOB })).toBe('connected');
    const row = await onboardingRow(id);
    expect(row.status).toBe('connected');
    expect(row.steps.history).toMatchObject({
      ok: false,
      error: expect.stringMatching(/then ask for the copy again\.$/),
    });
  });

  it('adds a number connected here through another WABA, which has moved', async () => {
    const accountId = await account();
    const first = await adopted(accountId);
    graph(completeRoutes());
    await completeOnboarding(first, { job: JOB });

    const [other] = await db
      .insert(whatsappAccounts)
      .values({ name: 'ShipBlu Ops', wabaId: '203040506070', tokenEnvVar: VARIABLE })
      .returning({ id: whatsappAccounts.id });
    const moved = await adoptBusinessAppNumber(
      { accountId: other!.id, phoneNumberId: PHONE, defaultGroupId: null },
      await admin(),
    );
    expect(moved.ok).toBe(true);
  });

  it('treats a variable naming the shared token the long way round as no variable', async () => {
    const accountId = await account('meta_page_access_token');
    expect(
      await adoptBusinessAppNumber(
        { accountId, phoneNumberId: PHONE, defaultGroupId: null },
        await admin(),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/holds no stored credential/) });

    // A row edited after the attempt was queued: the job refuses it too.
    await db
      .update(whatsappAccounts)
      .set({ tokenEnvVar: VARIABLE })
      .where(eq(whatsappAccounts.id, accountId));
    const id = await adopted(accountId);
    await db
      .update(whatsappAccounts)
      .set({ tokenEnvVar: 'META_PAGE_ACCESS_TOKEN' })
      .where(eq(whatsappAccounts.id, accountId));
    process.env.META_PAGE_ACCESS_TOKEN = 'page-token';
    resetEnvCache();
    const fetch = graph(completeRoutes());

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    expect((await onboardingRow(id)).error).toMatch(/holds no stored credential/);
    expect(fetch).not.toHaveBeenCalled();
  });

  /** Graph's answers for a token it will not vouch for, and one it could not be asked about. */
  const debugAnswering = (status: number, body: unknown): Route => ({
    method: 'GET',
    path: /\/debug_token\?/,
    status,
    answer: () => body,
  });
  const subscribePosts = (fetch: ReturnType<typeof graph>) =>
    fetch.mock.calls.filter(
      ([url, init]) => init?.method === 'POST' && String(url).includes('/subscribed_apps'),
    );

  it('refuses a token Meta will not inspect for this app, before subscribing anything', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    const fetch = graph(
      completeRoutes({
        debug: debugAnswering(400, {
          error: {
            message: 'The App_id in the input_token did not match the Viewing App',
            code: 100,
          },
        }),
      }),
    );

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    const { error } = await onboardingRow(id);
    expect(error).toMatch(/Meta would not inspect the token in WHATSAPP_TOKEN_ADOPTED/);
    expect(error).toMatch(/did not match the Viewing App/);
    expect(error).not.toContain(VARIABLE_TOKEN);
    expect(subscribePosts(fetch)).toEqual([]);
  });

  it('refuses a token Meta says is not valid, before subscribing anything', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    const fetch = graph(
      completeRoutes({
        debug: debugAnswering(200, {
          data: { is_valid: false, error: { message: 'Session has expired', code: 190 } },
        }),
      }),
    );

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    expect((await onboardingRow(id)).error).toMatch(/not valid: Session has expired/);
    expect(subscribePosts(fetch)).toEqual([]);
  });

  it('retries, subscribing nothing, when the inspection does not get an answer', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    const fetch = graph(completeRoutes({ debug: debugAnswering(503, { error: 'unavailable' }) }));

    await expect(completeOnboarding(id, { job: JOB })).rejects.toThrow(/Could not inspect/);
    expect(await onboardingRow(id)).toMatchObject({
      status: 'exchanged',
      lastTransientError: expect.stringMatching(
        /Could not inspect the token in WHATSAPP_TOKEN_ADOPTED/,
      ),
    });
    expect(subscribePosts(fetch)).toEqual([]);
  });

  it('says on the card why a retry after the channel exists could not carry on', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    // The channel is made, then the history request fails transiently: the
    // queue will run the attempt again, with steps still to finish.
    graph(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          answer: (_url, body) =>
            (body as { sync_type: string }).sync_type === 'history'
              ? new Response(JSON.stringify({ error: { message: 'Try later', code: 2 } }), {
                  status: 503,
                })
              : { messaging_product: 'whatsapp', request_id: 'req-contacts' },
        },
      }),
    );
    await expect(completeOnboarding(id, { job: JOB })).rejects.toThrow();
    expect((await onboardingRow(id)).steps.channel).toMatchObject({ ok: true });

    // Before the retry, the variable goes.
    delete process.env[VARIABLE];
    expect(await completeOnboarding(id, { job: { attempts: 2, maxAttempts: 5 } })).toBe(
      'connected',
    );
    const row = await onboardingRow(id);
    for (const step of ['history', 'templates'] as const) {
      expect(row.steps[step]).toMatchObject({
        ok: false,
        error: expect.stringMatching(/WHATSAPP_TOKEN_ADOPTED .*is not set/s),
      });
    }
    expect(row.steps.contacts).toMatchObject({ ok: true });
  });

  it('names the variable, not Meta’s window, when Meta refuses the token', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    graph(
      completeRoutes({
        numbers: {
          method: 'GET',
          path: new RegExp(`/${WABA}/phone_numbers\\?`),
          status: 401,
          answer: () => ({ error: { message: 'Error validating access token', code: 190 } }),
        },
      }),
    );

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    const { error } = await onboardingRow(id);
    expect(error).toContain(VARIABLE);
    expect(error).not.toMatch(/reconnected through Meta/);
    expect(error).not.toContain(VARIABLE_TOKEN);
  });

  it('says to check the id when the number is not on the account', async () => {
    const accountId = await account();
    const id = await adopted(accountId, SECOND);
    graph(completeRoutes());

    expect(await completeOnboarding(id, { job: JOB })).toBe('failed');
    const row = await onboardingRow(id);
    expect(row.steps.number).toMatchObject({ ok: false, outcome: NUMBER_NOT_ON_ACCOUNT });
    expect(row.error).toMatch(/Check the phone number ID in WhatsApp Manager/);
  });

  it('connects a second number on a WABA connected through Meta’s window with its stored credential', async () => {
    const first = await exchanged();
    await completeOnboarding(first, { job: JOB });
    const { whatsappAccountId } = await onboardingRow(first);

    const id = await adopted(whatsappAccountId, SECOND);
    const fetch = graph([
      {
        method: 'GET',
        path: new RegExp(`/${WABA}/phone_numbers\\?`),
        answer: () => ({
          data: [
            { id: PHONE, display_phone_number: '+20 10 1234 5678', verified_name: 'ShipBlu' },
            { id: SECOND, display_phone_number: '+20 10 8765 4321', verified_name: 'ShipBlu Two' },
          ],
        }),
      },
      {
        method: 'GET',
        path: new RegExp(`/${SECOND}\\?fields=is_on_biz_app,platform_type$`),
        answer: () => ({ is_on_biz_app: true, platform_type: 'CLOUD_API', id: SECOND }),
      },
      ...completeRoutes().filter(
        (route) => route.method === 'POST' || /subscri/.test(route.path.source),
      ),
      {
        method: 'POST',
        path: new RegExp(`/${SECOND}/smb_app_data$`),
        answer: (_url, body) => ({
          messaging_product: 'whatsapp',
          request_id: `second-${(body as { sync_type: string }).sync_type}`,
        }),
      },
    ]);

    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');
    expect(new Set(bearersFor(fetch, WABA, SECOND))).toEqual(new Set([`Bearer ${TOKEN}`]));
    // Meta's window minted it for this app, so nothing asks debug_token about it.
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/debug_token'))).toBe(false);
    expect(parseCoexistence((await channelFor(SECOND))!.config)).toMatchObject({
      onboardingId: id,
      adopted: true,
      syncs: { history: { requestId: 'second-history' } },
    });
    // The first number's connection is untouched.
    expect(parseCoexistence((await channelFor(PHONE))!.config)?.adopted).toBeUndefined();
  });

  it('runs "copy again" with the variable once Meta refused the first request', async () => {
    const accountId = await account();
    const id = await adopted(accountId);
    graph(
      completeRoutes({
        sync: {
          method: 'POST',
          path: new RegExp(`/${PHONE}/smb_app_data$`),
          answer: (_url, body) =>
            (body as { sync_type: string }).sync_type === 'history'
              ? new Response(JSON.stringify({ error: { message: 'Not allowed yet', code: 100 } }), {
                  status: 400,
                })
              : { messaging_product: 'whatsapp', request_id: 'req-contacts' },
        },
      }),
    );
    expect(await completeOnboarding(id, { job: JOB })).toBe('connected');
    expect((await onboardingRow(id)).steps.history).toMatchObject({ ok: false });

    const fetch = graph(completeRoutes());
    expect(await completeOnboarding(id, { only: ['history'], job: JOB })).toBe('connected');
    expect((await onboardingRow(id)).steps.history).toMatchObject({ ok: true });
    expect(new Set(bearersFor(fetch, PHONE))).toEqual(new Set([`Bearer ${VARIABLE_TOKEN}`]));
  });
});
