import { wamidKey } from '@/lib/whatsapp/wamid';

/**
 * Reactions, folded onto the messages they are about.
 *
 * A WhatsApp reaction arrives as a message of its own — `type: 'reaction'`,
 * naming the message it is about — and is stored as one, so the timeline drew
 * every 🙏 as a bubble saying `[reacted 🙏]`, a line below whatever it was
 * answering. It belongs on that message, as it does on the customer's phone.
 *
 * The row stays a row. What it means for the ticket — a customer touching the
 * thread — is the ingest's business, and so is every consumer that reads the
 * list (the inbox preview, the canned-suggestion anchor); this only decides
 * where the console draws it.
 *
 * What a message shows is the latest reaction from each side, the way WhatsApp
 * shows it: reacting again replaces the earlier one, and a reaction with no
 * emoji is the reactor taking theirs back, so it removes it. A reaction whose
 * message is not on this ticket — the bot's own messages are never stored, and
 * a customer can react to something from an earlier ticket — has nothing to be
 * drawn on, and the caller says so in a line of its own.
 */
export type ReactionRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  authorContactId: string | null;
  channelMessageId: string | null;
  reaction: StoredReaction | null;
};

export type StoredReaction = {
  /** The reacted-to message's wamid, in whatever form the reactor's copy names it. */
  targetWamid: string;
  /** Empty when the reactor took their reaction back. */
  emoji: string;
};

export type ShownReaction = { messageId: string; emoji: string };

export type ReactionFold = {
  /** Per reacted-to message, what it shows now, in the order it was last reacted. */
  shown: Map<string, ShownReaction[]>;
  /** Per reaction row, the message it is about, or null when that is not here. */
  targets: Map<string, string | null>;
};

export function foldReactions(rows: readonly ReactionRow[]): ReactionFold {
  const byWamid = new Map<string, string>();
  const byKey = new Map<string, string>();

  for (const row of rows) {
    // A reaction is never itself reacted to, and indexing one would let a
    // malformed target land on the reaction row rather than on nothing.
    if (row.reaction || !row.channelMessageId) continue;
    // First writer wins: a message stored twice under two of its wamids — a
    // history copy beside the live echo — keeps its reactions on the earlier.
    if (!byWamid.has(row.channelMessageId)) byWamid.set(row.channelMessageId, row.id);
    const key = wamidKey(row.channelMessageId);
    if (key && !byKey.has(key)) byKey.set(key, row.id);
  }

  const targets = new Map<string, string | null>();
  const current = new Map<string, Map<string, ShownReaction>>();

  for (const row of rows) {
    if (!row.reaction) continue;

    const { targetWamid, emoji } = row.reaction;
    const key = wamidKey(targetWamid);
    const target = byWamid.get(targetWamid) ?? (key ? byKey.get(key) : undefined) ?? null;
    targets.set(row.id, target);
    if (!target) continue;

    // Each side holds one reaction per message on a one-to-one chat; the
    // contact is in the key so a thread with two customers on it would not
    // have one of them overwrite the other.
    const reactor = `${row.direction}:${row.authorContactId ?? ''}`;
    const onTarget = current.get(target) ?? new Map<string, ShownReaction>();
    // Deleted before it is set, so a changed reaction moves to the end, where
    // the newest one belongs.
    onTarget.delete(reactor);
    if (emoji) onTarget.set(reactor, { messageId: row.id, emoji });
    current.set(target, onTarget);
  }

  const shown = new Map<string, ShownReaction[]>();
  for (const [target, onTarget] of current) {
    if (onTarget.size > 0) shown.set(target, [...onTarget.values()]);
  }

  return { shown, targets };
}

/**
 * The reaction a stored WhatsApp row carries, read off the delivery it was
 * stored from.
 *
 * `raw_body` rather than a field of `meta`, because that is where every
 * reaction stored so far has it: the inbound message, the business app's echo
 * and the copied history all keep the payload whole, and each names its target
 * as `reaction.message_id`. Reading it here needs no backfill and no second
 * place for the same fact to disagree with the first.
 */
export function storedReaction(
  meta: Record<string, unknown> | null,
  rawBody: string | null,
): StoredReaction | null {
  if (meta?.whatsappType !== 'reaction' || !rawBody) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const reaction =
    raw && typeof raw === 'object' ? (raw as { reaction?: unknown }).reaction : undefined;
  if (!reaction || typeof reaction !== 'object') return null;

  const { message_id: targetWamid, emoji } = reaction as { message_id?: unknown; emoji?: unknown };
  if (typeof targetWamid !== 'string' || !targetWamid) return null;

  return { targetWamid, emoji: typeof emoji === 'string' ? emoji.trim() : '' };
}
