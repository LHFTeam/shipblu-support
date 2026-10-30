import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { webchatChannel } from './session';
import { ONLY_WEBCHAT_ROW, switchWebchatRow } from './switch';

/**
 * Switching web chat rows on and off, against Postgres: the widget's row moves
 * as `lib/widget/rows.ts` says, the last active row stays on, and two switches
 * at once cannot both find the other still on.
 */

withCleanDatabase();

/** Web chat rows, oldest first: each a second apart, so the order is the created order. */
async function webchatRows(...spec: [string, boolean][]): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, [name, isActive]] of spec.entries()) {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'webchat',
        name,
        isActive,
        config: { faqFolders: {} },
        createdAt: new Date(Date.UTC(2026, 9, 1, 9, 0, index)),
      })
      .returning({ id: channels.id });
    ids.push(row!.id);
  }
  return ids;
}

async function active(): Promise<string[]> {
  const rows = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.isActive, true))
    .orderBy(asc(channels.createdAt));
  return rows.map((row) => row.name).filter((name) => name !== 'WhatsApp Customer Bot');
}

describe('switchWebchatRow', () => {
  it('refuses the only active web chat row, and leaves it on', async () => {
    const [chat, old] = await webchatRows(['Web chat', true], ['Old copy', false]);

    // With the rows it refused on, so the page drawn again shows the refusal
    // only while they are still so.
    expect(await switchWebchatRow(chat!, false)).toEqual({
      ok: false,
      error: ONLY_WEBCHAT_ROW,
      stateKey: [`${chat}:on:-`, `${old}:off:-`].sort().join(','),
    });
    expect(await active()).toEqual(['Web chat']);
  });

  // The widget reads the oldest active row, so switching that one off moves
  // the widget on, and switching an older one on takes it back.
  it('moves the widget with the switch, and says so', async () => {
    const [first, second] = await webchatRows(['First', true], ['Second', true]);

    // The answer carries the rows as the switch left them, which the page
    // compares with its own before showing it.
    const off = await switchWebchatRow(first!, false);
    expect(off).toMatchObject({
      ok: true,
      stateKey: [`${first}:off:-`, `${second}:on:-`].sort().join(','),
    });
    expect(off.ok && off.notice).toContain('the widget now uses “Second”');
    expect((await webchatChannel())?.id).toBe(second);

    const on = await switchWebchatRow(first!, true);
    expect(on).toMatchObject({
      ok: true,
      stateKey: [`${first}:on:-`, `${second}:on:-`].sort().join(','),
    });
    expect(on.ok && on.notice).toContain('the widget now uses it');
    expect((await webchatChannel())?.id).toBe(first);
  });

  it('switches only web chat rows, decided by the stored type', async () => {
    await webchatRows(['Web chat', true]);
    const [number] = await db
      .insert(channels)
      .values({ type: 'whatsapp', name: 'Sales line', config: { phoneNumberId: '1' } })
      .returning({ id: channels.id });

    // About no web chat row, so it carries none: nothing on the page drew it.
    expect(await switchWebchatRow(number!.id, false)).toEqual({
      ok: false,
      error: 'Only a web chat channel is switched on and off here',
    });
    const [row] = await db
      .select({ isActive: channels.isActive })
      .from(channels)
      .where(eq(channels.id, number!.id));
    expect(row?.isActive).toBe(true);
  });

  it('writes nothing for a row already in the state asked for', async () => {
    const [chat] = await webchatRows(['Web chat', true]);
    const [before] = await db
      .select({ updatedAt: channels.updatedAt })
      .from(channels)
      .where(eq(channels.id, chat!));

    expect(await switchWebchatRow(chat!, true)).toEqual({
      ok: true,
      notice: '“Web chat” is already on.',
      stateKey: `${chat}:on:-`,
    });
    const [after] = await db
      .select({ updatedAt: channels.updatedAt })
      .from(channels)
      .where(eq(channels.id, chat!));
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  // Each switch asks whether another row is still on. Held open after its
  // write, the first has switched its row off and not committed; the second
  // waits on the lock rather than reading past that write, and then finds the
  // only row left on is its own.
  it('cannot be raced into leaving no row on', async () => {
    const [first, second] = await webchatRows(['First', true], ['Second', true]);

    const hold = holdNextTransaction('after');
    const firstSwitch = switchWebchatRow(first!, false);
    await hold.atHold;
    const secondSwitch = switchWebchatRow(second!, false);
    await untilWaitingOnALock(db);
    hold.release();

    expect(await firstSwitch).toMatchObject({ ok: true });
    expect(await secondSwitch).toMatchObject({ ok: false, error: ONLY_WEBCHAT_ROW });
    expect(await active()).toEqual(['Second']);
  });
});
