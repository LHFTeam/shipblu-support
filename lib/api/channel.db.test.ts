import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, channels, groups } from '@/db/schema';
import { saveCategoryAiSettings } from '@/lib/category-ai/settings';
import { planRouting } from '@/lib/routing/start';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { apiChannel, switchApiChannel } from './channel';

/**
 * Which `api` row the myBlu app files under, and switching one, against
 * Postgres: the order is the query's, and the switch's answer depends on
 * which rows a concurrent switch has committed.
 */

withCleanDatabase();

type Row = {
  name: string;
  type?: 'api' | 'webchat';
  isActive?: boolean;
  second: number;
  /** Fixed where the test is about id order; random otherwise. */
  id?: string;
};

/** Rows a second apart, so their created order is the order given by `second`. */
async function rows(...spec: Row[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const { name, type = 'api', isActive = true, second, id } of spec) {
    const [row] = await db
      .insert(channels)
      .values({
        ...(id ? { id } : {}),
        type,
        name,
        isActive,
        config: {},
        createdAt: new Date(Date.UTC(2026, 10, 13, 9, 0, second)),
      })
      .returning({ id: channels.id });
    ids[name] = row!.id;
  }
  return ids;
}

async function isActive(id: string): Promise<boolean> {
  const [row] = await db
    .select({ isActive: channels.isActive })
    .from(channels)
    .where(eq(channels.id, id));
  return row!.isActive;
}

describe('apiChannel', () => {
  // Before anybody adds one, and once every one is off: what `POST /tickets`
  // will answer `503 not_configured` on.
  it('is null with no api row, and with every api row off', async () => {
    // A web chat row is no row of the app's, however old.
    await rows({ name: 'Web chat', type: 'webchat', second: 0 });
    expect(await apiChannel()).toBeNull();

    await rows({ name: 'myBlu app', isActive: false, second: 1 });
    expect(await apiChannel()).toBeNull();
  });

  it('is the oldest active api row, whichever was inserted first', async () => {
    // Inserted newest first, so the answer is the created order and not the
    // order Postgres happens to return rows in.
    const ids = await rows({ name: 'Newer app row', second: 5 }, { name: 'myBlu app', second: 1 });
    expect((await apiChannel())?.id).toBe(ids['myBlu app']);
  });

  it('skips an older row that is off', async () => {
    const ids = await rows(
      { name: 'Old app row', isActive: false, second: 0 },
      { name: 'myBlu app', second: 1 },
      { name: 'Spare app row', second: 2 },
    );
    expect((await apiChannel())?.id).toBe(ids['myBlu app']);
  });

  // The row inserted first has the larger id. With no id order, Postgres hands
  // back the tied rows in the order they sit in the heap — the first inserted —
  // so random ids passed this test whenever the first one happened to sort
  // lower, about half the time; fixed ones fail it on every run.
  it('breaks a tie on the created instant by id, as every other row of a type is picked', async () => {
    const ids = await rows(
      { name: 'One', second: 0, id: '00000000-0000-4000-8000-000000000002' },
      { name: 'Two', second: 0, id: '00000000-0000-4000-8000-000000000001' },
    );
    expect((await apiChannel())?.id).toBe(ids.Two);
  });

  // The stage that opens a ticket hands the row straight to `planRouting`,
  // read once before its transaction: the row in category mode, with the
  // classifier in Apply, is a live hold on that row, and its group is beside it.
  it('answers what planRouting takes, with the default group beside it', async () => {
    const [group] = await db.insert(groups).values({ name: 'Recipients' }).returning();
    const [row] = await db
      .insert(channels)
      .values({
        type: 'api',
        name: 'myBlu app',
        defaultGroupId: group!.id,
        routingMode: 'category',
      })
      .returning({ id: channels.id });
    // The settings row names who saved it; any agent will do.
    const [admin] = await db
      .insert(agents)
      .values({ name: 'Mona Admin', email: 'mona@shipblu.test', role: 'admin' })
      .returning({ id: agents.id });
    await saveCategoryAiSettings(
      { mode: 'apply', minProbability: 0.6, routingWindowMinutes: 5 },
      admin!.id,
    );

    const channel = await apiChannel();
    expect(channel).toEqual({
      id: row!.id,
      type: 'api',
      config: {},
      routingMode: 'category',
      defaultGroupId: group!.id,
    });
    expect(await planRouting(channel)).toEqual({
      start: 'live',
      channelId: row!.id,
      windowMinutes: 5,
    });
  });
});

describe('switchApiChannel', () => {
  // What the switch is for: with no row on, the app opens nothing new.
  it('switches the last active row off, and says what that stops', async () => {
    const ids = await rows({ name: 'myBlu app', second: 0 });

    const outcome = await switchApiChannel(ids['myBlu app']!, false);
    expect(outcome).toEqual({
      ok: true,
      notice: expect.stringContaining('no myBlu app row is on'),
      stateKey: `${ids['myBlu app']}:off`,
    });
    expect(await isActive(ids['myBlu app']!)).toBe(false);
    expect(await apiChannel()).toBeNull();

    expect(await switchApiChannel(ids['myBlu app']!, true)).toMatchObject({ ok: true });
    expect((await apiChannel())?.id).toBe(ids['myBlu app']);
  });

  it('refuses a row of another type, and an id no row has, writing nothing', async () => {
    const ids = await rows(
      { name: 'Web chat', type: 'webchat', second: 0 },
      { name: 'myBlu app', second: 1 },
    );

    expect(await switchApiChannel(ids['Web chat']!, false)).toEqual({
      ok: false,
      error: 'Only a myBlu app channel is switched on and off here',
    });
    expect(await isActive(ids['Web chat']!)).toBe(true);

    expect(await switchApiChannel('00000000-0000-4000-8000-000000000000', false)).toEqual({
      ok: false,
      error: 'That channel no longer exists — reload the page',
      stateKey: `${ids['myBlu app']}:on`,
    });
  });

  // Each answer names the row the app uses after it. Held open after its
  // write, the first switch has taken one row off and not committed; the
  // second waits on the lock rather than reading past that write, and is then
  // told the truth: that no row is left on, not that the app moved to the row
  // the first switch has just taken off.
  it('answers about the rows as a concurrent switch left them', async () => {
    const ids = await rows({ name: 'First', second: 0 }, { name: 'Second', second: 1 });

    const hold = holdNextTransaction('after');
    const first = switchApiChannel(ids.First!, false);
    await hold.atHold;
    const second = switchApiChannel(ids.Second!, false);
    expect(await untilWaitingOnALock(db)).toBe(true);
    hold.release();

    expect(await first).toMatchObject({
      ok: true,
      notice: expect.stringContaining('the app now opens its tickets under “Second”'),
    });
    expect(await second).toMatchObject({
      ok: true,
      notice: expect.stringContaining('no myBlu app row is on'),
    });
    expect(await apiChannel()).toBeNull();
  });
});
