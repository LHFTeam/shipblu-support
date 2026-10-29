import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { logger } from '@/lib/log';
import { parseWidgetConfig } from './config';
import { switchNotice, webchatSwitch, type ReportedRow } from './rows';

const log = logger('webchat');

export const ONLY_WEBCHAT_ROW =
  'This is the only active web chat row, and the widget needs one: without it chats are filed under no row and no group. Switch another web chat row on first.';

export type SwitchOutcome = { ok: true; notice: string } | { ok: false; error: string };

/**
 * Switch a web chat row on or off, never leaving the widget without one.
 *
 * Web chat rows only, decided by the stored type. Every other type's ingest
 * picks its row by `is_active` too (`defaultEmailChannel`, `channelFor`,
 * `resolveWhatsAppChannel`), so a forged id switching a WhatsApp number off
 * would file its messages under no row, and nothing here is written to judge
 * that.
 *
 * Under a transaction lock, because "is another row active?" is a read the
 * next switch cannot see until this one commits: two admins switching off the
 * last two rows at once would each find the other still on, and both commit.
 * One conditional UPDATE does not close that either, since under READ
 * COMMITTED its subquery does not wait on the other's uncommitted write. An
 * advisory lock rather than row locks, as `lockRoleChanges` takes for the last
 * account admin: this is the only writer of a web chat row's `is_active`, and a
 * row lock would also be held against the widget's ticket inserts, which take
 * KEY SHARE on the row through `conversations.channel_id`. The rows are read
 * after the wait, each statement on a snapshot taken then, so they include
 * whatever the switch before this one committed.
 *
 * A row switched off keeps its tickets: a visitor's chat continues on the
 * ticket it is on, threaded on the visitor alone (`findLiveConversation`), and a
 * ticket held for the router on it is still decided by its mode. Only new chats
 * move.
 */
export async function switchWebchatRow(id: string, active: boolean): Promise<SwitchOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('webchat-rows'::text, 0))`);

    const [target] = await tx
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);
    if (!target) return { ok: false, error: 'That channel no longer exists — reload the page' };
    if (target.type !== 'webchat') {
      return { ok: false, error: 'Only a web chat channel is switched on and off here' };
    }

    const rows: ReportedRow[] = (
      await tx
        .select({
          id: channels.id,
          name: channels.name,
          isActive: channels.isActive,
          config: channels.config,
        })
        .from(channels)
        .where(eq(channels.type, 'webchat'))
        .orderBy(asc(channels.createdAt), asc(channels.id))
    ).map(({ config, ...row }) => ({
      ...row,
      hasFaqFolders: Object.keys(parseWidgetConfig(config).faqFolders).length > 0,
    }));

    const row = rows.find((candidate) => candidate.id === id)!;
    if (row.isActive === active) {
      return { ok: true, notice: `“${row.name}” is already ${active ? 'on' : 'off'}.` };
    }
    if (!active && webchatSwitch(rows, id)?.kind === 'only_row') {
      return { ok: false, error: ONLY_WEBCHAT_ROW };
    }

    await tx
      .update(channels)
      .set({ isActive: active, updatedAt: new Date() })
      .where(eq(channels.id, id));
    log.info('web chat row switched', { channel: id, active });

    return { ok: true, notice: switchNotice(rows, id, active) };
  });
}
