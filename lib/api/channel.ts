import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { logger } from '@/lib/log';
import { apiStateKey, apiSwitchNotice, type ApiRow } from './channel-rows';

const log = logger('api_channel');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The `channels` row the myBlu app's tickets are filed under
 * (`plans/myblu-ticket-api.md`, _Tickets_): its default group, and with it the
 * hours the app is told, and its routing mode. Null when no `api` row is on,
 * which the plan's `POST /tickets` answers `503 not_configured` and its
 * `GET /config` reports as `tickets.canCreate: false`, while reads and replies
 * on the tickets the app already has go on — they are found through their
 * ownership rows, never through this one. That is what makes the switch
 * (`switchApiChannel`) a way to stop new work without cutting a customer off
 * mid-conversation.
 *
 * The oldest active row, ties by id, as `webchatChannel` and `portalChannel`
 * pick theirs and as the routing panel judges "the row tickets are filed
 * under" (`filingRowOfType`): nothing stops an admin adding a second `api`
 * row, and without an order Postgres may hand back either, so which group a new
 * ticket started in would depend on the plan it happened to pick.
 *
 * The columns are what `planRouting` takes (`RoutingChannel`: the id, the type,
 * the config `routingModeOf` reads and the mode), with the default group
 * beside them, so the stage that opens a ticket reads the row once, on the
 * pool, before its transaction. Not wrapped in React's `cache()`, as
 * `webchatChannel` is for the widget's page: its callers are route handlers,
 * one read per request.
 *
 * `GET /config` reads it for `tickets.canCreate`, and `createApiTicket`
 * (`lib/api/tickets.ts`) files every new ticket from the app under it.
 */
export async function apiChannel() {
  const rows = await db
    .select({
      id: channels.id,
      type: channels.type,
      config: channels.config,
      routingMode: channels.routingMode,
      defaultGroupId: channels.defaultGroupId,
    })
    .from(channels)
    .where(and(eq(channels.type, 'api'), eq(channels.isActive, true)))
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * What a switch did, or why it did nothing, with the `api` rows as it left
 * them (`apiStateKey`): the page shows the answer only while its rows agree. A
 * refusal for a row that is not `api` carries none, since the page drew no
 * switch for it.
 */
export type ApiSwitchOutcome =
  { ok: true; notice: string; stateKey: string } | { ok: false; error: string; stateKey?: string };

/**
 * Serialise the switches, so the sentence each one answers with — which row
 * the app now uses, or that none is on — is about the rows as they are. A
 * transaction lock, as `lockWebchatRows` takes, because under READ COMMITTED a
 * read cannot see a switch that has written and not committed: two admins
 * switching off the app's two rows at once would each be told the app moved
 * to the other. Unlike web chat's, the lock guards no refusal — the last row
 * may go off — only the answer. No lock on any channel row: nothing else in
 * the console writes an `api` row's `is_active`, and a ticket insert's foreign
 * key takes KEY SHARE on the row, which only a `FOR UPDATE` would hold up.
 */
async function lockApiRows(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('api-rows'::text, 0))`);
}

/** Every `api` row, oldest first and ties by id, the order `apiChannel` reads. After the lock. */
async function apiRowsIn(tx: Tx): Promise<ApiRow[]> {
  return tx
    .select({
      id: channels.id,
      type: channels.type,
      name: channels.name,
      isActive: channels.isActive,
    })
    .from(channels)
    .where(eq(channels.type, 'api'))
    .orderBy(asc(channels.createdAt), asc(channels.id));
}

/**
 * Switch an `api` row on or off — the last active one included, since that is
 * how new tickets from the app are stopped.
 *
 * `api` rows only, decided by the stored type: every other type's ingest picks
 * its row by `is_active` too, and the widget's switch refuses its last row, so
 * a forged id here must not reach them. `saveChannel` carries no `isActive`,
 * so this and web chat's `switchWebchatRow` are the only writers of the
 * column from the console.
 *
 * A row switched off keeps its tickets: the app's reads and replies find a
 * ticket by its own rows, and a ticket held for the router on it is still
 * decided by its mode. Only new tickets move, or stop.
 */
export async function switchApiChannel(id: string, active: boolean): Promise<ApiSwitchOutcome> {
  return db.transaction(async (tx) => {
    await lockApiRows(tx);

    const [target] = await tx
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);
    if (target && target.type !== 'api') {
      return { ok: false, error: 'Only a myBlu app channel is switched on and off here' };
    }

    const rows = await apiRowsIn(tx);
    const stateKey = apiStateKey(rows);
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) {
      return { ok: false, error: 'That channel no longer exists — reload the page', stateKey };
    }
    if (row.isActive === active) {
      return { ok: true, notice: `“${row.name}” is already ${active ? 'on' : 'off'}.`, stateKey };
    }

    await tx
      .update(channels)
      .set({ isActive: active, updatedAt: new Date() })
      .where(eq(channels.id, id));
    log.info('myBlu app row switched', { channel: id, active });

    const after = rows.map((candidate) =>
      candidate.id === id ? { ...candidate, isActive: active } : candidate,
    );
    return { ok: true, notice: apiSwitchNotice(rows, id, active), stateKey: apiStateKey(after) };
  });
}
