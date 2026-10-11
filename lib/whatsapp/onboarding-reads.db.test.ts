import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { channels, whatsappAccounts, whatsappOnboardings } from '@/db/schema';
import { listChannelsForAdmin } from '@/lib/admin/settings';
import { withCleanDatabase } from '@/lib/testing/db';
import { progressVersion } from './onboarding-view';
import {
  copyRequestRefusal,
  listLatestOnboardings,
  readProgressVersion,
  runsNamedSteps,
} from './onboarding-reads';

/**
 * `distinct on` is the one thing here only Postgres can judge: an `order by`
 * that does not start with the distinct column is a syntax error the type
 * checker cannot see, and one that sorts the wrong way shows the first attempt
 * on a number for ever.
 */

withCleanDatabase();

const WABA = '102030405060';

async function account() {
  const [row] = await db
    .insert(whatsappAccounts)
    .values({ name: 'ShipBlu', wabaId: WABA, tokenEnvVar: null, isDefault: true })
    .returning({ id: whatsappAccounts.id });
  return row!.id;
}

async function attempt(input: {
  accountId: string;
  phoneNumberId: string;
  status: 'exchanged' | 'connected' | 'failed';
  startedAt: Date;
  error?: string;
}) {
  const [row] = await db
    .insert(whatsappOnboardings)
    .values({
      whatsappAccountId: input.accountId,
      wabaId: WABA,
      phoneNumberId: input.phoneNumberId,
      status: input.status,
      startedAt: input.startedAt,
      error: input.error ?? null,
      startedByLabel: 'Mona Admin',
      steps:
        input.status === 'connected' ? { number: { at: '2026-10-08T10:00:00Z', ok: true } } : {},
    })
    .returning({ id: whatsappOnboardings.id });
  return row!.id;
}

describe('listLatestOnboardings', () => {
  it('answers nothing for a database with no attempts', async () => {
    expect(await listLatestOnboardings()).toEqual([]);
  });

  it('shows one card per number, the latest attempt, newest number first', async () => {
    const accountId = await account();
    const older = await attempt({
      accountId,
      phoneNumberId: '109876543210',
      status: 'failed',
      startedAt: new Date('2026-10-08T09:00:00Z'),
      error: 'superseded',
    });
    const newer = await attempt({
      accountId,
      phoneNumberId: '109876543210',
      status: 'exchanged',
      startedAt: new Date('2026-10-08T10:00:00Z'),
    });
    const other = await attempt({
      accountId,
      phoneNumberId: '109876543211',
      status: 'connected',
      startedAt: new Date('2026-10-08T11:00:00Z'),
    });

    const views = await listLatestOnboardings();
    expect(views.map((view) => view.id)).toEqual([other, newer]);
    expect(views.map((view) => view.id)).not.toContain(older);

    expect(views[1]).toMatchObject({
      status: 'exchanged',
      phoneNumberId: '109876543210',
      wabaId: WABA,
      startedAt: '2026-10-08T10:00:00.000Z',
      startedByLabel: 'Mona Admin',
    });
    expect(views[1]!.steps.map((step) => step.state)).toEqual([
      'running',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(views[0]!.steps[0]).toMatchObject({ step: 'number', state: 'done' });
  });
});

/**
 * The copy buttons' gate is the job's: a run of the copy alone happens only on
 * an attempt that finished connecting. The action used to enqueue it for an
 * attempt still connecting, the job skipped it, and the page said the copy was
 * on its way.
 */
describe('copyRequestRefusal', () => {
  it('allows the copy through a connected attempt, and only through one', async () => {
    const accountId = await account();
    const at = new Date('2026-10-08T10:00:00Z');
    const connected = await attempt({
      accountId,
      phoneNumberId: '109876543210',
      status: 'connected',
      startedAt: at,
    });
    const connecting = await attempt({
      accountId,
      phoneNumberId: '109876543211',
      status: 'exchanged',
      startedAt: at,
    });
    const replaced = await attempt({
      accountId,
      phoneNumberId: '109876543212',
      status: 'failed',
      startedAt: at,
      error: 'superseded',
    });

    expect(await copyRequestRefusal(connected)).toBeNull();
    expect(await copyRequestRefusal(connecting)).toMatch(/has not finished yet.*progress card/);
    expect(await copyRequestRefusal(replaced)).toMatch(/replaced by a newer one/);
    // Gone, or a hand-written id Postgres would answer with 22P02: a sentence, not a crash.
    for (const missing of [crypto.randomUUID(), 'not-a-uuid']) {
      expect(await copyRequestRefusal(missing)).toMatch(/no longer recorded.*Reconnect/);
    }

    expect(runsNamedSteps('connected')).toBe(true);
    expect(runsNamedSteps('exchanged')).toBe(false);
    expect(runsNamedSteps('failed')).toBe(false);
  });
});

describe('readProgressVersion', () => {
  /** What the Channels page computes from its own reads, through the same function. */
  async function versionAsThePageSeesIt(now: Date): Promise<string> {
    const [onboardings, channelList] = await Promise.all([
      listLatestOnboardings(),
      listChannelsForAdmin(),
    ]);
    return progressVersion(
      onboardings,
      channelList
        .filter((channel) => channel.type === 'whatsapp')
        .map(({ id, config }) => ({ id, config })),
      now,
    );
  }

  it('agrees with the page when nothing has moved, and differs once something has', async () => {
    const accountId = await account();
    const [channel] = await db
      .insert(channels)
      .values([
        {
          type: 'whatsapp',
          name: 'ShipBlu',
          whatsappAccountId: accountId,
          config: {
            phoneNumberId: '109876543210',
            coexistence: {
              onboardedAt: '2026-10-08T10:00:00Z',
              wabaId: WABA,
              syncs: { history: { requestId: 'r', requestedAt: '2026-10-08T10:00:05Z' } },
            },
          },
        },
        // Not a WhatsApp number: the page leaves it out, and so must the read.
        { type: 'email', name: 'Support inbox', config: { address: 'help@example.com' } },
      ])
      .returning({ id: channels.id });
    await attempt({
      accountId,
      phoneNumberId: '109876543210',
      status: 'connected',
      startedAt: new Date('2026-10-08T10:00:00Z'),
    });
    const now = new Date('2026-10-08T10:05:00Z');

    // If these ever differ with nothing moved, the page re-renders on every
    // poll — the cost this exists to remove.
    const polled = await readProgressVersion(now);
    expect(polled).toBe(await versionAsThePageSeesIt(now));

    await db
      .update(channels)
      .set({
        config: {
          phoneNumberId: '109876543210',
          coexistence: {
            onboardedAt: '2026-10-08T10:00:00Z',
            wabaId: WABA,
            syncs: {
              history: {
                requestId: 'r',
                requestedAt: '2026-10-08T10:00:05Z',
                progressByPhase: { 0: 50 },
              },
            },
          },
        },
      })
      .where(eq(channels.id, channel!.id));

    expect(await readProgressVersion(now)).not.toBe(polled);
  });
});
