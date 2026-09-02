import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationCategories,
  conversationEvents,
  conversations,
  ticketCategories,
} from '@/db/schema';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { type CategoryHit, bandFor, detectCategories } from './detect';
import { allCategories } from './taxonomy';

/**
 * Writing what the detector found onto the conversation.
 *
 * Mirrors `lib/shipments/links.ts` deliberately, down to the idempotency story:
 * every write is `onConflictDoNothing` against the natural key, and the audit
 * event is written **only for rows that were actually created**. That one
 * condition is the whole thing — a customer who says "where is my order" in each
 * of eleven messages gets one row and one timeline entry, not eleven.
 */

/** The version of the rules that wrote a row; see `detector_version`. */
export const DETECTOR_VERSION = 1;

export type CategorisedFromMessage = {
  applied: string[];
  suggested: string[];
};

const EMPTY: CategorisedFromMessage = { applied: [], suggested: [] };

/**
 * Rows the categoriser is allowed to look at — narrower than
 * `isLinkableMessage`, and the difference is the point.
 *
 * A tracking number is a *fact* wherever it appears, so shipment linking scans
 * notes and outbound replies too. A category is a claim about **what the
 * customer wanted**, so:
 *
 * - An **outbound** reply is our answer, not their question. A rule matching our
 *   own words would categorise every ticket where an agent pasted the canned
 *   apology, and the report would then describe our macros.
 * - A **note** is an agent's private commentary. "Customer seems to be asking
 *   about the address" in a note would create an address category with
 *   `source = 'detected'` — a rule laundering a person's opinion into the one
 *   column the tuning pass trusts to be the machine's.
 *
 * The filter lives here rather than at the call sites so the live path and the
 * backfill cannot drift into scanning different things.
 */
export function isCategorisableMessage(kind: string, direction: string): boolean {
  return kind === 'reply' && direction === 'inbound';
}

/**
 * Categorise one message and write what it found.
 *
 * `realtime` is required rather than optional so the backfill has to say what it
 * wants. The live path touches `conversations.updatedAt` to fire the existing
 * `notify_change` trigger, which is what makes an open ticket update in front of
 * an agent; a backfill over the archive doing the same would put tens of
 * thousands of `pg_notify` calls through every open console session in a few
 * minutes, for tickets nobody has on screen. An optional flag defaulting to
 * `notify` is one nobody would remember to pass.
 */
export async function categoriseFromMessage(
  input: {
    conversationId: string;
    messageId: string;
    bodyText: string;
    kind: string;
    direction: string;
  },
  realtime: 'notify' | 'silent',
): Promise<CategorisedFromMessage> {
  if (!isCategorisableMessage(input.kind, input.direction)) return EMPTY;
  if (!input.bodyText.trim()) return EMPTY;

  const conversation = await db
    .select({ channel: conversations.channel })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);

  const channel = conversation[0]?.channel;
  if (!channel) return EMPTY;

  // The bot channel is somebody else's self-service flow, not a queue. Its
  // messages are button presses answering a menu we do not hold a copy of, so a
  // category assigned there would describe the bot's funnel rather than support
  // demand — and it is 99.6% of the message volume, so it would drown every
  // number drawn from this table. `readOnlyChannels()` already means exactly
  // "nobody on the team is working these", which is the same test.
  if (isReadOnlyChannel(channel)) return EMPTY;

  const hits = detectCategories({ bodyText: input.bodyText });
  if (hits.length === 0) return EMPTY;

  const writable = hits.filter((hit) => bandFor(hit) !== 'ignored');
  if (writable.length === 0) return EMPTY;

  const ids = await categoryIds(writable.map((hit) => hit.key));

  const applied: string[] = [];
  const suggested: string[] = [];

  for (const hit of writable) {
    const categoryId = ids.get(hit.key);
    // A key the registry does not carry means the seed has not run, or an admin
    // deleted a row the FK should have refused. Skip it rather than failing the
    // ingest: a missing category is a gap in a report, and a thrown error here
    // would retry the whole job and re-send whatever else it did.
    if (!categoryId) continue;

    // `writable` already excluded `ignored`, so this narrows rather than checks.
    const band = bandFor(hit) === 'auto' ? 'auto' : 'suggested';
    const created = await insertAssignment(input, hit, categoryId, band);
    if (!created) continue;

    if (band === 'auto') applied.push(hit.key);
    else suggested.push(hit.key);
  }

  if (applied.length === 0 && suggested.length === 0) return EMPTY;

  await refreshPrimary(input.conversationId);

  await db.insert(conversationEvents).values({
    conversationId: input.conversationId,
    type: 'categorised',
    actorLabel: 'category-detector',
    data: {
      messageId: input.messageId,
      applied,
      suggested,
      rules: Object.fromEntries(writable.map((hit) => [hit.key, hit.ruleKey])),
    },
  });

  if (realtime === 'notify') {
    // Touch the conversation so the existing notify_change trigger fires.
    // Without it the new sidebar entry waits for the next refresh: the message's
    // own NOTIFY went out at commit time, before any of this ran.
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));
  }

  return { applied, suggested };
}

/**
 * True when the row did not already exist.
 *
 * `onConflictDoNothing` on the natural key is what makes a rejected row
 * permanent: a rejected assignment still occupies `(conversation, category)`, so
 * a later message re-asserting the same category conflicts and writes nothing.
 * An agent's judgement survives every subsequent message with no extra
 * machinery, and without a single `where` clause anywhere having to remember it.
 */
async function insertAssignment(
  input: { conversationId: string; messageId: string },
  hit: CategoryHit,
  categoryId: string,
  band: 'auto' | 'suggested',
): Promise<boolean> {
  const rows = await db
    .insert(conversationCategories)
    .values({
      conversationId: input.conversationId,
      categoryId,
      categoryKey: hit.key,
      source: 'detected',
      reviewState: band === 'auto' ? 'auto' : 'suggested',
      confidence: hit.confidence,
      ruleKey: hit.ruleKey,
      evidence: hit.evidence,
      detectedInMessageId: input.messageId,
      detectorVersion: DETECTOR_VERSION,
    })
    .onConflictDoNothing({
      target: [conversationCategories.conversationId, conversationCategories.categoryId],
    })
    .returning({ categoryId: conversationCategories.categoryId });

  if (rows.length > 0) return true;

  // Already there. Record that the customer said it again — "they have been
  // asking about this since Tuesday" and "they mentioned it again an hour ago"
  // are different facts, and the primary tie-break reads the second. Confidence
  // and the rule stay as first asserted: making them the *best* seen would need
  // a read-modify-write per message and would make the stored value depend on
  // the order messages happened to arrive in.
  await db
    .update(conversationCategories)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(conversationCategories.conversationId, input.conversationId),
        eq(conversationCategories.categoryId, categoryId),
        ne(conversationCategories.reviewState, 'rejected'),
      ),
    );

  return false;
}

/**
 * Decide which of a conversation's categories leads.
 *
 * Recomputed from scratch rather than patched, because the winner depends on the
 * whole set: a new high-severity category arriving on message nine changes which
 * of the existing eight should lead, and an incremental update would have to
 * know that.
 *
 * The ladder, and the reason for each rung:
 *
 * 1. **A person's choice wins.** `manual` then `confirmed` outrank anything the
 *    detector asserted on its own. An agent who set the primary by hand has
 *    said what the ticket is about, and no later message overrides that.
 * 2. **Confidence**, descending.
 * 3. **Severity.** At equal confidence, the half of the message somebody is out
 *    of money or out of a parcel over leads.
 * 4. **Recency**, then position, then key — so the answer is deterministic.
 *
 * Cleared before it is set, in one transaction: the partial unique index allows
 * exactly one primary per conversation, so writing the new one first would
 * conflict with the old.
 */
export async function refreshPrimary(conversationId: string): Promise<void> {
  const rows = await db
    .select({
      categoryId: conversationCategories.categoryId,
      categoryKey: conversationCategories.categoryKey,
      source: conversationCategories.source,
      reviewState: conversationCategories.reviewState,
      confidence: conversationCategories.confidence,
      lastSeenAt: conversationCategories.lastSeenAt,
    })
    .from(conversationCategories)
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        ne(conversationCategories.reviewState, 'rejected'),
      ),
    );

  // The fallback is never the primary. Everything on this ticket being either
  // rejected or unclassified leaves it with no primary at all, which is right:
  // promoting an admission that we could not read the ticket would put it on a
  // report as though it were a finding.
  const pool = rows.filter((row) => row.categoryKey !== 'meta.unclassified');

  await db
    .update(conversationCategories)
    .set({ isPrimary: false })
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.isPrimary, true),
      ),
    );

  if (pool.length === 0) return;

  const meta = categoryMeta();
  const humanRank = (row: (typeof pool)[number]): number => {
    if (row.source === 'manual') return 0;
    if (row.reviewState === 'confirmed') return 1;
    return 2;
  };
  const severityRank: Record<string, number> = { high: 0, normal: 1, low: 2 };

  const winner = [...pool].sort((a, b) => {
    if (humanRank(a) !== humanRank(b)) return humanRank(a) - humanRank(b);
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;

    const sa = severityRank[meta.get(a.categoryKey)?.severity ?? 'normal'] ?? 1;
    const sb = severityRank[meta.get(b.categoryKey)?.severity ?? 'normal'] ?? 1;
    if (sa !== sb) return sa - sb;

    const ta = a.lastSeenAt?.getTime() ?? 0;
    const tb = b.lastSeenAt?.getTime() ?? 0;
    if (ta !== tb) return tb - ta;

    const pa = meta.get(a.categoryKey)?.position ?? Number.MAX_SAFE_INTEGER;
    const pb = meta.get(b.categoryKey)?.position ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;

    return a.categoryKey.localeCompare(b.categoryKey);
  })[0]!;

  await db
    .update(conversationCategories)
    .set({ isPrimary: true })
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.categoryId, winner.categoryId),
      ),
    );
}

/**
 * Category ids for a set of keys.
 *
 * Cached for the life of the process. The registry changes when an admin edits
 * it, which is rare, and this runs on every inbound message — a lookup per hit
 * would be tens of thousands of round trips during a backfill. A key added by a
 * deploy is picked up when the process restarts, which a deploy does.
 */
let idCache: Map<string, string> | null = null;

async function categoryIds(keys: readonly string[]): Promise<Map<string, string>> {
  if (idCache && keys.every((key) => idCache!.has(key))) return idCache;

  const rows = await db
    .select({ id: ticketCategories.id, key: ticketCategories.key })
    .from(ticketCategories);

  idCache = new Map(rows.map((row) => [row.key, row.id]));
  return idCache;
}

/** Forget the cached registry — for tests and for the admin editor. */
export function forgetCategoryIds(): void {
  idCache = null;
}

type Meta = { position: number; severity: 'high' | 'normal' | 'low' };
let metaCache: ReadonlyMap<string, Meta> | null = null;

function categoryMeta(): ReadonlyMap<string, Meta> {
  if (metaCache) return metaCache;
  metaCache = new Map(
    allCategories().map((category) => [
      category.key,
      { position: category.position, severity: category.severity ?? 'normal' },
    ]),
  );
  return metaCache;
}

/**
 * Every conversation carrying a category, for the reporting queries.
 *
 * Kept here rather than in a page so the "not rejected, not the fallback" filter
 * has one definition — a report that forgot either would count an agent's
 * rejection as a finding.
 */
export function assignedFilter() {
  return and(
    ne(conversationCategories.reviewState, 'rejected'),
    sql`${conversationCategories.categoryKey} <> 'meta.unclassified'`,
  );
}
