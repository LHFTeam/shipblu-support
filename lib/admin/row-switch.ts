import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import type { logger } from '@/lib/log';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What a row switch did, or why it did nothing, with the rows of its type as
 * it left them (`stateKey`): the page shows the answer only while its rows
 * agree. A refusal about rows the page drew wrongly carries them too, so the
 * page can be drawn again; one for a row of another type does not.
 */
export type RowSwitchOutcome =
  { ok: true; notice: string; stateKey: string } | { ok: false; error: string; stateKey?: string };

export interface SwitchRow {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
}

/**
 * A type whose rows the console switches on and off one at a time, and which
 * files under the oldest active one: web chat (the widget's row) and the myBlu
 * app. What differs between them is here; the steps every such switch takes
 * are `switchRow`'s.
 */
export interface RowKind<R extends SwitchRow> {
  readonly type: 'webchat' | 'api';
  /**
   * The refusal for an id whose stored row is of another type. Every other
   * type's ingest picks its row by `is_active` too, so a forged id must not
   * switch a WhatsApp number off from here.
   */
  readonly wrongType: string;
  /**
   * Serialises the type's switches, so each answer is about the rows as they
   * are: under READ COMMITTED a read cannot see a switch that has written and
   * not committed.
   */
  readonly lock: (tx: Tx) => Promise<void>;
  /** Every row of the type, in the order the type files by. After the lock. */
  readonly rowsIn: (tx: Tx) => Promise<R[]>;
  readonly stateKey: (rows: readonly R[]) => string;
  /** Why this switch must not be written, or null: web chat refuses its last active row. */
  readonly refusal?: (rows: readonly R[], id: string, active: boolean) => string | null;
  /**
   * The answer, worded for the rows as the switch leaves them: `before` as
   * read under the lock, `after` with the switched row flipped, worked out once
   * here for the state key and the notice alike, so the two cannot disagree
   * about the result.
   */
  readonly notice: (
    before: readonly R[],
    after: readonly R[],
    id: string,
    active: boolean,
  ) => string;
  readonly log: ReturnType<typeof logger>;
  readonly logLine: string;
}

/**
 * Switch one row of `kind` on or off, under the kind's lock. One copy of the
 * steps, so the two switches cannot drift: they were near line-for-line
 * copies, and a fix to the stale-answer handling or the type check in one was
 * a fix the other had to be remembered for.
 *
 * `saveChannel` carries no `isActive`, so this is the only writer of the
 * column from the console for these types. A row switched off keeps its
 * tickets; only new ones move, or stop.
 */
export async function switchRow<R extends SwitchRow>(
  kind: RowKind<R>,
  id: string,
  active: boolean,
): Promise<RowSwitchOutcome> {
  return db.transaction(async (tx) => {
    await kind.lock(tx);

    const [target] = await tx
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);
    if (target && target.type !== kind.type) return { ok: false, error: kind.wrongType };

    const rows = await kind.rowsIn(tx);
    const stateKey = kind.stateKey(rows);
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) {
      return { ok: false, error: 'That channel no longer exists — reload the page', stateKey };
    }
    if (row.isActive === active) {
      return { ok: true, notice: `“${row.name}” is already ${active ? 'on' : 'off'}.`, stateKey };
    }
    const refused = kind.refusal?.(rows, id, active) ?? null;
    if (refused) return { ok: false, error: refused, stateKey };

    await tx
      .update(channels)
      .set({ isActive: active, updatedAt: new Date() })
      .where(eq(channels.id, id));
    kind.log.info(kind.logLine, { channel: id, active });

    const after = rows.map((candidate) =>
      candidate.id === id ? { ...candidate, isActive: active } : candidate,
    );
    return {
      ok: true,
      notice: kind.notice(rows, after, id, active),
      stateKey: kind.stateKey(after),
    };
  });
}
