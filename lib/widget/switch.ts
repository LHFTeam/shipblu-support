import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { logger } from '@/lib/log';
import {
  reportedRow,
  switchNotice,
  webchatStateKey,
  webchatSwitch,
  widgetRow,
  type ReportedRow,
} from './rows';

const log = logger('webchat');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const ONLY_WEBCHAT_ROW =
  'This is the only active web chat row, and the widget needs one: without it chats are filed under no row and no group. Switch another web chat row on, or add one, first.';

/**
 * What a switch did, or why it did nothing, with the web chat rows as it left
 * them (`webchatStateKey`): the page shows the answer only while its rows
 * agree. A refusal about rows the page drew wrongly carries them too, so the
 * page can be drawn again; one for a row that is not web chat does not.
 */
export type SwitchOutcome =
  { ok: true; notice: string; stateKey: string } | { ok: false; error: string; stateKey?: string };

/**
 * Serialise everything that decides by which web chat row the widget uses: a
 * switch, and a save of a web chat row (`webchatEditRefusal`). A transaction
 * lock, because "which row is the widget's?" is a read the next writer cannot
 * see until this one commits. Two admins switching off the last two rows at
 * once would each find the other still on, and both commit; a save checked
 * before a switch commits and written after it lands on the wrong row. One
 * conditional UPDATE does not close either, since under READ COMMITTED its
 * subquery does not wait on another's uncommitted write. An advisory lock, as
 * `lockRoleChanges` takes for the last account admin, and no lock on any
 * channel row: a switch and a save are the only writers of a web chat row,
 * and both are milliseconds. Row locks taken `FOR NO KEY UPDATE` would
 * serialise them too without holding up the widget's ticket inserts, whose
 * foreign key takes KEY SHARE; `FOR UPDATE` would hold those up. The rows are
 * read after the wait, each statement on a snapshot taken then, so they
 * include whatever the writer before this one committed.
 */
async function lockWebchatRows(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('webchat-rows'::text, 0))`);
}

/**
 * Every web chat row, oldest first and ties by id, the order `webchatChannel`
 * picks the widget's in, so `widgetRow` over them names the same row. Inside
 * the caller's transaction, after its lock.
 */
async function webchatRowsIn(tx: Tx): Promise<ReportedRow[]> {
  const rows = await tx
    .select({
      id: channels.id,
      type: channels.type,
      name: channels.name,
      isActive: channels.isActive,
      config: channels.config,
    })
    .from(channels)
    .where(eq(channels.type, 'webchat'))
    .orderBy(asc(channels.createdAt), asc(channels.id));
  return rows.map(reportedRow);
}

/**
 * Why a save of web chat row `id` must not be written, or null; under the
 * lock, so the caller writes in the same transaction and no switch lands
 * between the answer and the write.
 *
 * Two forms save a web chat row, and which one may is decided by whether it is
 * the widget's. The Chat widget card (`card`) configures the row the widget
 * reads: one drawn before that row was switched off, or before an older one
 * was switched on, would save questions nobody is shown and say they were
 * saved. The row editor configures any other: one drawn before its row became
 * the widget's would write the page's group and mode over what the card has
 * saved on it since, and the widget's hours and routing would revert without a
 * word.
 */
export async function webchatEditRefusal(
  tx: Tx,
  id: string,
  card: boolean,
): Promise<string | null> {
  await lockWebchatRows(tx);
  const isWidgets = widgetRow(await webchatRowsIn(tx))?.id === id;
  if (card && !isWidgets) {
    return 'This is no longer the web chat row the widget uses — reload the page to configure the one that is';
  }
  if (!card && isWidgets) {
    return 'The widget uses this row now — reload the page and edit it under Chat widget';
  }
  return null;
}

/**
 * Switch a web chat row on or off, never leaving the widget without one.
 *
 * Web chat rows only, decided by the stored type. Every other type's ingest
 * picks its row by `is_active` too (`defaultEmailChannel`, `channelFor`,
 * `resolveWhatsAppChannel`), so a forged id switching a WhatsApp number off
 * would file its messages under no row, and nothing here is written to judge
 * that. Under `lockWebchatRows`.
 *
 * A row switched off keeps its tickets: a visitor's chat continues on the
 * ticket it is on, threaded on the visitor alone (`findLiveConversation`), and a
 * ticket held for the router on it is still decided by its mode. Only new chats
 * move.
 */
export async function switchWebchatRow(id: string, active: boolean): Promise<SwitchOutcome> {
  return db.transaction(async (tx) => {
    await lockWebchatRows(tx);

    const [target] = await tx
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);
    if (target && target.type !== 'webchat') {
      return { ok: false, error: 'Only a web chat channel is switched on and off here' };
    }

    const rows = await webchatRowsIn(tx);
    const stateKey = webchatStateKey(rows);
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) {
      return { ok: false, error: 'That channel no longer exists — reload the page', stateKey };
    }
    if (row.isActive === active) {
      return { ok: true, notice: `“${row.name}” is already ${active ? 'on' : 'off'}.`, stateKey };
    }
    if (!active && webchatSwitch(rows, id)?.kind === 'only_row') {
      return { ok: false, error: ONLY_WEBCHAT_ROW, stateKey };
    }

    await tx
      .update(channels)
      .set({ isActive: active, updatedAt: new Date() })
      .where(eq(channels.id, id));
    log.info('web chat row switched', { channel: id, active });

    const after = rows.map((candidate) =>
      candidate.id === id ? { ...candidate, isActive: active } : candidate,
    );
    return { ok: true, notice: switchNotice(rows, id, active), stateKey: webchatStateKey(after) };
  });
}
