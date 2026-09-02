import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  contactShippingAccounts,
  contacts,
  conversationCategories,
  conversationEvents,
  conversations,
  ticketCategories,
} from '@/db/schema';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { type CategoryHit, bandFor, detectCategories } from './detect';
import { type RequesterKind, requesterKindFrom } from './requester';
import { UNCLASSIFIED_KEY, allCategories } from './taxonomy';

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
    .select({
      channel: conversations.channel,
      requesterContactId: conversations.requesterContactId,
      requesterKind: conversations.requesterKind,
    })
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

  // Established once, on the first inbound message that gets this far, and never
  // overwritten: a value already set was either established from these same
  // records or put there by a person, and neither should be revised by a later
  // message. Costs one extra read per ticket rather than per message.
  await establishRequesterKind(
    input.conversationId,
    conversation[0]!.requesterContactId,
    conversation[0]!.requesterKind,
  );

  const hits = detectCategories({ bodyText: input.bodyText });
  if (hits.length === 0) return EMPTY;

  const writable = hits.filter((hit) => bandFor(hit) !== 'ignored');
  if (writable.length === 0) return EMPTY;

  const ids = await categoryIds(writable.map((hit) => hit.key));

  const applied: string[] = [];
  const suggested: string[] = [];
  // Tracked separately from `applied`/`suggested`, which are the *new* rows and
  // are what the timeline event reports. A message that only re-raises
  // categories the ticket already carries writes no event — eleven "where is my
  // order" messages must not make eleven timeline entries — but it does move
  // `last_seen_at`, and that is an input to which category leads. Deciding
  // whether to re-rank from `applied`/`suggested` alone left the bump unable to
  // change anything it was written for.
  let changed = false;

  for (const hit of writable) {
    const categoryId = ids.get(hit.key);
    // A key the registry does not carry means the seed has not run, an admin
    // retired the category, or a row the FK should have refused was deleted.
    // Skip it rather than failing the ingest: a missing category is a gap in a
    // report, and a thrown error here would retry the whole job and re-send
    // whatever else it did.
    if (!categoryId) continue;

    // `writable` already excluded `ignored`, so this narrows rather than checks.
    const band = bandFor(hit) === 'auto' ? 'auto' : 'suggested';
    const outcome = await insertAssignment(input, hit, categoryId, band);
    if (outcome === 'unchanged') continue;
    changed = true;
    if (outcome === 'touched') continue;

    if (band === 'auto') applied.push(hit.key);
    else suggested.push(hit.key);
  }

  if (!changed) return EMPTY;

  await refreshPrimary(input.conversationId);

  // The event is written **only for rows that were actually created** — see the
  // file header. A message re-raising categories the ticket already carries has
  // still re-ranked above and still notifies below, because the star may have
  // moved; what it must not do is add an eleventh timeline entry saying the
  // customer asked where their order is.
  if (applied.length > 0 || suggested.length > 0) {
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
  }

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
 * Fill in which population the ticket came from, if the records can say.
 *
 * Written here rather than at ticket creation because that is spread across six
 * ingest paths and a portal form, and the answer can improve between the two:
 * a contact whose shipping account is linked an hour after their first message
 * is a merchant by the time they send their second. Writing it on the first
 * inbound message that reaches the categoriser means one place decides it, on
 * the same records, for every channel.
 *
 * Guarded by `is null` in the `where` as well as by the early return — two
 * ingest jobs for one conversation can run in parallel, and the guard belongs
 * where the write happens rather than only where it was decided.
 */
async function establishRequesterKind(
  conversationId: string,
  requesterContactId: string | null,
  current: RequesterKind | 'prospect' | 'other' | null,
): Promise<void> {
  if (current !== null || !requesterContactId) return;

  const rows = await db
    .select({
      isShipper: contacts.isShipper,
      isRecipient: contacts.isRecipient,
      accountId: contactShippingAccounts.shippingAccountId,
    })
    .from(contacts)
    .leftJoin(contactShippingAccounts, eq(contactShippingAccounts.contactId, contacts.id))
    .where(eq(contacts.id, requesterContactId))
    .limit(1);

  const row = rows[0];
  if (!row) return;

  const kind = requesterKindFrom({
    isShipper: row.isShipper,
    isRecipient: row.isRecipient,
    hasShippingAccount: row.accountId !== null,
  });
  if (!kind) return;

  await db
    .update(conversations)
    .set({ requesterKind: kind })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.requesterKind)));
}

/**
 * What the write did: created the row, touched one that was already there, or
 * found nothing to touch because the category had been rejected.
 *
 * Three states rather than a boolean because the caller needs to tell `created`
 * from `touched`. Both change what the primary should be — a bump to
 * `last_seen_at` is the fourth rung of `refreshPrimary`'s ladder — so collapsing
 * them meant the timestamp this function goes out of its way to write could
 * never actually re-rank anything.
 */
type AssignmentOutcome = 'created' | 'touched' | 'unchanged';

/**
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
): Promise<AssignmentOutcome> {
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

  if (rows.length > 0) return 'created';

  // Already there. Record that the customer said it again — "they have been
  // asking about this since Tuesday" and "they mentioned it again an hour ago"
  // are different facts, and the primary tie-break reads the second. Confidence
  // and the rule stay as first asserted: making them the *best* seen would need
  // a read-modify-write per message and would make the stored value depend on
  // the order messages happened to arrive in.
  //
  // `returning` rather than a bare update, because the `ne(rejected)` clause
  // means this can legitimately match nothing — and "the agent threw this
  // category out" must not read to the caller as "the customer raised it
  // again".
  const touched = await db
    .update(conversationCategories)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(conversationCategories.conversationId, input.conversationId),
        eq(conversationCategories.categoryId, categoryId),
        ne(conversationCategories.reviewState, 'rejected'),
      ),
    )
    .returning({ categoryId: conversationCategories.categoryId });

  return touched.length > 0 ? 'touched' : 'unchanged';
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
 * Cleared before it is set, **in one transaction**: the partial unique index
 * allows exactly one primary per conversation, so writing the new one first
 * would conflict with the old — and the gap between the two statements is a
 * window where a second caller sees no primary and writes its own. That is not
 * hypothetical here. The index's own comment in `db/schema/categories.ts` says
 * ingest jobs for one conversation run in parallel on the worker, and two
 * agents pressing Confirm on the same ticket reach this the same way. The
 * losing side raises 23505, which `afterMessageStored` swallows — so the
 * symptom is a message that silently never got its timeline event or its
 * `notify_change` touch, and the sidebar simply never updates.
 *
 * The whole read-decide-write runs inside the transaction rather than only the
 * two writes: deciding from rows read outside it would pick a winner from a set
 * that had already changed.
 */
export async function refreshPrimary(conversationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await refreshPrimaryIn(tx, conversationId);
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function refreshPrimaryIn(tx: Tx, conversationId: string): Promise<void> {
  const rows = await tx
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
  const pool = rows.filter((row) => row.categoryKey !== UNCLASSIFIED_KEY);

  await tx
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

  await tx
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
 * Ids for the categories the detector is currently **allowed to assign**.
 *
 * `is_active` is part of the query, not an afterthought: retiring a category in
 * the admin editor is how somebody stops an over-firing rule filling a report,
 * and without this filter it only stopped the category appearing in the agent's
 * picker while the detector carried on assigning it. The control looked like it
 * worked, which is worse than not having it.
 *
 * Cached because this runs on every inbound message and a lookup per hit would
 * be tens of thousands of round trips during a backfill. Two things the first
 * version of this cache got wrong, both worth stating because they are the
 * general shape of the bug rather than anything about categories:
 *
 * - **The guard was "every requested key is cached", so one key the registry
 *   does not carry defeated it forever.** A key in `rules.ts` that the seed has
 *   not created yet can never enter the map, so every subsequent message re-read
 *   the whole table — silently, with no error, doing exactly the thing the cache
 *   exists to prevent. Misses are remembered too now.
 * - **`forgetCategoryIds()` can only clear the process that calls it**, and the
 *   admin editor runs in the web service while the detector runs in the worker.
 *   A TTL is the only thing that reaches the other process, so a retirement
 *   takes effect everywhere within a minute rather than at the next deploy.
 */
const ID_CACHE_TTL_MS = 60_000;

let idCache: Map<string, string> | null = null;
/** Keys the registry did not carry when it was last read — see above. */
let idCacheMisses = new Set<string>();
let idCacheAt = 0;

async function categoryIds(keys: readonly string[]): Promise<Map<string, string>> {
  const fresh = idCache !== null && Date.now() - idCacheAt < ID_CACHE_TTL_MS;
  if (fresh && keys.every((key) => idCache!.has(key) || idCacheMisses.has(key))) return idCache!;

  const rows = await db
    .select({ id: ticketCategories.id, key: ticketCategories.key })
    .from(ticketCategories)
    .where(eq(ticketCategories.isActive, true));

  idCache = new Map(rows.map((row) => [row.key, row.id]));
  idCacheAt = Date.now();
  idCacheMisses = new Set(keys.filter((key) => !idCache!.has(key)));
  return idCache;
}

/**
 * Forget the cached registry.
 *
 * Called by the admin editor so a rename or a retirement is visible in *this*
 * process immediately, and by tests. It cannot reach the worker — that is what
 * the TTL above is for.
 */
export function forgetCategoryIds(): void {
  idCache = null;
  idCacheMisses = new Set();
  idCacheAt = 0;
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
