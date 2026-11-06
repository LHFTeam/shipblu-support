import { readFileSync } from 'node:fs';
import { asc, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { metaAppRoleEvents, webhookEvents } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { defaultAppStanding, forgetDefaultAppStanding, recordAppRole } from '@/lib/meta/app-roles';
import { parseMetaWebhook } from '@/lib/meta/parse';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `012_meta_app_role_backfill.sql`, run as `db/migrate.ts` runs it: the file's
 * own text, executed, and executed again.
 *
 * The backfill and `parseMetaWebhook` read the same deliveries into the same
 * rows, one in SQL and one in TypeScript, and the unique key only takes them as
 * one if they agree to the millisecond. So every shape here is checked against
 * the parser's own answer rather than against a second copy of the rules — and
 * the worker's insert is checked to find the backfill's row already there, and
 * the other way round.
 */

withCleanDatabase();

const backfill = readFileSync(new URL('./012_meta_app_role_backfill.sql', import.meta.url), 'utf8');

const run = () => db.execute(sql.raw(backfill));

const US = '1009187740467732';
const IG = '17841448759001625';
const PAGE = '101449698657189';
const SWITCH = new Date('2026-11-05T10:30:24Z');

// The two deliveries production holds (docs/PROJECT-STATE.md §6.111).
const PAGE_EVENT = {
  object: 'page',
  entry: [
    {
      id: PAGE,
      time: 1793874614469,
      messaging: [
        {
          recipient: { id: PAGE },
          timestamp: 1793874612,
          app_roles: { [US]: ['default_app'] },
        },
      ],
    },
  ],
};
const INSTAGRAM_EVENT = {
  object: 'instagram',
  entry: [
    {
      id: IG,
      time: 1793874628267,
      messaging: [
        { recipient: { id: IG }, timestamp: 1793874624, app_roles: { [US]: 'default_app' } },
      ],
    },
  ],
};

async function store(
  payload: unknown,
  { verified = true, provider = 'meta' }: { verified?: boolean; provider?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(webhookEvents)
    .values({ provider, payload, signatureVerified: verified, connection: 'facebook_page' })
    .returning({ id: webhookEvents.id });
  return row!.id;
}

async function stored() {
  return db
    .select({
      platform: metaAppRoleEvents.platform,
      accountId: metaAppRoleEvents.accountId,
      appId: metaAppRoleEvents.appId,
      roles: metaAppRoleEvents.roles,
      at: metaAppRoleEvents.at,
      webhookEventId: metaAppRoleEvents.webhookEventId,
    })
    .from(metaAppRoleEvents)
    .orderBy(
      asc(metaAppRoleEvents.platform),
      asc(metaAppRoleEvents.accountId),
      asc(metaAppRoleEvents.at),
      asc(metaAppRoleEvents.appId),
    );
}

/** What the parser makes of a delivery, in the shape of a stored row. */
function parsed(payload: unknown, webhookEventId: string) {
  return parseMetaWebhook(payload, 'facebook_page').appRoles.map((role) => ({
    ...role,
    webhookEventId,
  }));
}

const byKey = (a: { platform: string; accountId: string; at: Date; appId: string }) =>
  `${a.platform}|${a.accountId}|${a.at.toISOString()}|${a.appId}`;

describe('012_meta_app_role_backfill.sql', () => {
  it("copies production's two deliveries, once however often it replays", async () => {
    const page = await store(PAGE_EVENT);
    const instagram = await store(INSTAGRAM_EVENT);

    await run();
    await run();

    expect(await stored()).toEqual([
      {
        platform: 'facebook',
        accountId: PAGE,
        appId: US,
        roles: ['default_app'],
        at: new Date('2026-11-05T10:30:12Z'),
        webhookEventId: page,
      },
      {
        platform: 'instagram',
        accountId: IG,
        appId: US,
        roles: ['default_app'],
        at: SWITCH,
        webhookEventId: instagram,
      },
    ]);
  });

  it('reads every shape the parser reads into the rows the parser makes', async () => {
    const shapes: unknown[] = [
      // In standby, three apps, the roles in every spelling and some that are not roles.
      {
        object: 'instagram',
        entry: [
          {
            id: IG,
            standby: [
              {
                timestamp: 1793874624000,
                app_roles: {
                  '1': ['secondary_receiver', 7, null, ''],
                  '2': 'default_app',
                  '3': [],
                },
              },
            ],
          },
        ],
      },
      // Milliseconds with a fraction: truncated, as a Date is.
      {
        object: 'instagram',
        entry: [{ id: IG, messaging: [{ timestamp: 1793874624123.7, app_roles: { '4': 'x' } }] }],
      },
      // No event timestamp: the entry's time.
      {
        object: 'page',
        entry: [{ id: PAGE, time: 1793874614469, messaging: [{ app_roles: { '5': ['y'] } }] }],
      },
      // No entry id: the recipient's.
      {
        object: 'page',
        entry: [
          {
            messaging: [
              { recipient: { id: PAGE }, timestamp: 1793874600, app_roles: { '6': 'z' } },
            ],
          },
        ],
      },
      // Nothing to date it by, an empty account, an empty app id, roles that
      // are not an object, an object nobody reads, and a messaging array that
      // is not one: none of these is a row.
      { object: 'instagram', entry: [{ id: IG, messaging: [{ app_roles: { '7': 'a' } }] }] },
      {
        object: 'instagram',
        entry: [{ id: '', messaging: [{ timestamp: 1, app_roles: { '8': 'a' } }] }],
      },
      {
        object: 'instagram',
        entry: [{ id: IG, messaging: [{ timestamp: 1, app_roles: { '': 'a' } }] }],
      },
      { object: 'instagram', entry: [{ id: IG, messaging: [{ timestamp: 1, app_roles: 'a' }] }] },
      { object: 'instagram', entry: [{ id: IG, messaging: [{ timestamp: 1, app_roles: ['a'] }] }] },
      {
        object: 'whatsapp_business_account',
        entry: [{ id: IG, messaging: [{ timestamp: 1, app_roles: { '9': 'a' } }] }],
      },
      {
        object: 'instagram',
        entry: [{ id: IG, messaging: { timestamp: 1, app_roles: { '10': 'a' } } }],
      },
      // From review: instants Postgres cannot hold, or that a float and an
      // exact product would round apart. Each falls back to the entry's time
      // or is left out, and none makes the file raise, which would stop every
      // deploy.
      ...[1e30, -3e11, 9e15, 3e14, 1e-320, '1793874624'].map((timestamp, i) => ({
        object: 'instagram',
        entry: [
          {
            id: IG,
            time: 1793874628267,
            messaging: [{ timestamp, app_roles: { [`range-${i}`]: 'default_app' } }],
          },
        ],
      })),
      {
        object: 'instagram',
        entry: [
          { id: IG, messaging: [{ timestamp: 1793874624.0509999, app_roles: { frac: 'x' } }] },
        ],
      },
      // Ids that are not a non-empty string: the recipient's, or nothing.
      ...[0, false, true, { a: 1 }, 123, ''].map((id, i) => ({
        object: 'page',
        entry: [
          {
            id,
            messaging: [
              {
                recipient: { id: PAGE },
                timestamp: 1793874600,
                app_roles: { [`id-${i}`]: 'default_app' },
              },
            ],
          },
        ],
      })),
      // A null entry beside a real one.
      {
        object: 'instagram',
        entry: [
          null,
          { id: IG, messaging: [{ timestamp: 1793874624, app_roles: { beside: 'default_app' } }] },
        ],
      },
    ];

    const expected = [];
    for (const shape of shapes) expected.push(...parsed(shape, await store(shape)));

    await run();

    const rows = await stored();
    expect(rows.map(byKey).sort()).toEqual(expected.map(byKey).sort());
    expect([...rows].sort((a, b) => byKey(a).localeCompare(byKey(b)))).toEqual(
      [...expected]
        .sort((a, b) => byKey(a).localeCompare(byKey(b)))
        .map(({ platform, accountId, appId, roles, at, webhookEventId }) => ({
          platform,
          accountId,
          appId,
          roles,
          at,
          webhookEventId,
        })),
    );
    // The fraction went, as it does in JavaScript.
    expect(rows.find((row) => row.appId === '4')?.at).toEqual(new Date(1793874624123));
  });

  it('takes nothing from an unsigned delivery or another provider', async () => {
    // An unsigned POST naming this app the default would unblock replies.
    await store(INSTAGRAM_EVENT, { verified: false });
    await store(INSTAGRAM_EVENT, { provider: 'whatsapp' });

    await run();

    expect(await stored()).toEqual([]);
  });

  it("agrees with the worker's insert to the millisecond, either way round", async () => {
    const id = await store(INSTAGRAM_EVENT);
    const [role] = parseMetaWebhook(INSTAGRAM_EVENT, 'facebook_page').appRoles;

    await run();
    expect(await recordAppRole(role!, id)).toBe(false);

    await db.delete(metaAppRoleEvents);
    expect(await recordAppRole(role!, id)).toBe(true);
    await run();
    expect(await stored()).toHaveLength(1);
  });
});

describe('defaultAppStanding over what the backfill stored', () => {
  const saved = { ...process.env };

  // Memoised per process; each test starts from what its own rows say.
  beforeEach(() => forgetDefaultAppStanding());

  beforeAll(() => {
    process.env.META_APP_ID = US;
    process.env.INSTAGRAM_ACCOUNT_ID = IG;
    process.env.FACEBOOK_PAGE_ID = PAGE;
    resetEnvCache();
  });

  afterAll(() => {
    process.env = saved;
    resetEnvCache();
  });

  it("answers Instagram's switch, and nothing for the Page's", async () => {
    await store(PAGE_EVENT);
    await store(INSTAGRAM_EVENT);
    await run();

    expect(await defaultAppStanding('instagram')).toEqual({ since: SWITCH, lostAt: null });
    // Named default twelve seconds earlier, and Messenger's messages kept
    // arriving in standby: it supersedes nothing.
    expect(await defaultAppStanding('facebook')).toEqual({ since: null, lostAt: null });
  });

  it('answers nothing for an account this deployment does not send from', async () => {
    await store(INSTAGRAM_EVENT);
    await run();

    process.env.INSTAGRAM_ACCOUNT_ID = '17840000000000000';
    resetEnvCache();
    try {
      expect(await defaultAppStanding('instagram')).toEqual({ since: null, lostAt: null });
    } finally {
      process.env.INSTAGRAM_ACCOUNT_ID = IG;
      resetEnvCache();
    }
  });
});
