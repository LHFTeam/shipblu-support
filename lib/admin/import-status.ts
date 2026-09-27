import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import type { JobType } from '@/lib/queue';

/**
 * What the import page reports: the recent runs of each hand-started job, and
 * the counts that say whether a run did what it was for.
 *
 * Here rather than in the page for the reason `./settings` gives, and more so:
 * three of these are raw SQL, which no static check reads, so a page is the
 * only place they would otherwise ever run. `import-status.db.test.ts` runs
 * each one against a real database.
 *
 * Authorisation is the page's, which calls `requirePermission` first.
 */

/** The last ten runs of one job type, newest first. */
export function recentRuns(type: JobType) {
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
      createdAt: jobs.createdAt,
      completedAt: jobs.completedAt,
    })
    .from(jobs)
    .where(eq(jobs.type, type))
    .orderBy(desc(jobs.createdAt))
    .limit(10);
}

/**
 * What the knowledge base holds, by language.
 *
 * One round trip rather than seven, and it returns a row even when every
 * table is empty — which is exactly the state this page exists to explain.
 *
 * Broken down by language, not just totalled. A total is what hid a real
 * failure here: the import found no English at all, and "3 categories, 12
 * folders, 58 articles" read as a clean run rather than as half a knowledge
 * base. A zero against a language is the thing worth seeing.
 */
export async function knowledgeBaseCounts(): Promise<Record<string, number> | null> {
  const rows = await db.execute<{
    categories: number;
    folders: number;
    articles: number;
    redirects: number;
    categories_en: number;
    articles_en: number;
    categories_ar: number;
    articles_ar: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM kb_categories) AS categories,
      (SELECT count(*)::int FROM kb_folders)    AS folders,
      (SELECT count(*)::int FROM kb_articles)   AS articles,
      (SELECT count(*)::int FROM kb_redirects)  AS redirects,
      (SELECT count(*)::int FROM kb_categories WHERE locale = 'en') AS categories_en,
      (SELECT count(*)::int FROM kb_articles   WHERE locale = 'en') AS articles_en,
      (SELECT count(*)::int FROM kb_categories WHERE locale = 'ar') AS categories_ar,
      (SELECT count(*)::int FROM kb_articles   WHERE locale = 'ar') AS articles_ar
  `);
  return (rows as unknown as Record<string, number>[])[0] ?? null;
}

type ShipmentCounts = {
  shipments: number;
  accounts: number;
  links: number;
  links_detected: number;
  account_links: number;
  unsynced: number;
};

/**
 * Shipments, accounts and the links between them and tickets.
 *
 * Broken down by how a link came to exist, for the same reason the article
 * counts are broken down by language: the total cannot tell "the detector
 * is working" apart from "agents have been linking these by hand".
 */
export async function shipmentCounts(): Promise<ShipmentCounts | null> {
  const rows = await db.execute<ShipmentCounts>(sql`
    SELECT
      (SELECT count(*)::int FROM shipments)                  AS shipments,
      (SELECT count(*)::int FROM shipping_accounts)          AS accounts,
      (SELECT count(*)::int FROM conversation_shipments)     AS links,
      (SELECT count(*)::int FROM conversation_shipments
         WHERE link_source = 'detected')                     AS links_detected,
      (SELECT count(*)::int FROM conversation_shipping_accounts) AS account_links,
      (SELECT count(*)::int FROM shipments WHERE sync_state = 'stub') AS unsynced
  `);
  return (rows as unknown as ShipmentCounts[])[0] ?? null;
}

type LocationCounts = {
  candidates: number;
  recovered: number;
};

/**
 * Shared pins: how many messages might hold one, and how many were recovered.
 *
 * The gap between these two is the whole point of the card: how many
 * shared pins an agent still cannot open on a map. `candidates` uses the
 * same prefilter as the job, so the two cannot disagree about what counts.
 */
export async function locationCounts(): Promise<LocationCounts | null> {
  const rows = await db.execute<LocationCounts>(sql`
    SELECT
      count(*)::int                                              AS candidates,
      count(*) FILTER (WHERE meta -> 'location' IS NOT NULL)::int AS recovered
    FROM messages
    WHERE raw_body IS NOT NULL AND raw_body LIKE '%"location"%'
  `);
  return (rows as unknown as LocationCounts[])[0] ?? null;
}
