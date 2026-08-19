import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ImportForm } from './form';
import { ShipmentBackfillForm } from './shipment-backfill';

export const dynamic = 'force-dynamic';

type ShipmentCounts = {
  shipments: number;
  accounts: number;
  links: number;
  links_detected: number;
  account_links: number;
  unsynced: number;
};

export default async function ImportPage() {
  await requirePermission('admin.agents');

  const [runs, counts, backfillRuns, shipmentCounts] = await Promise.all([
    db
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
        createdAt: jobs.createdAt,
        completedAt: jobs.completedAt,
      })
      .from(jobs)
      .where(eq(jobs.type, 'import_freshdesk_kb'))
      .orderBy(desc(jobs.createdAt))
      .limit(10),

    // One round trip rather than seven, and it returns a row even when every
    // table is empty — which is exactly the state this page exists to explain.
    //
    // Broken down by language, not just totalled. A total is what hid a real
    // failure here: the import found no English at all, and "3 categories, 12
    // folders, 58 articles" read as a clean run rather than as half a knowledge
    // base. A zero against a language is the thing worth seeing.
    db.execute<{
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
    `),

    db
      .select({
        id: jobs.id,
        status: jobs.status,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
        createdAt: jobs.createdAt,
        completedAt: jobs.completedAt,
      })
      .from(jobs)
      .where(eq(jobs.type, 'backfill_shipment_links'))
      .orderBy(desc(jobs.createdAt))
      .limit(10),

    // Broken down by how a link came to exist, for the same reason the article
    // counts are broken down by language: the total cannot tell "the detector
    // is working" apart from "agents have been linking these by hand".
    db.execute<{
      shipments: number;
      accounts: number;
      links: number;
      links_detected: number;
      account_links: number;
      unsynced: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM shipments)                  AS shipments,
        (SELECT count(*)::int FROM shipping_accounts)          AS accounts,
        (SELECT count(*)::int FROM conversation_shipments)     AS links,
        (SELECT count(*)::int FROM conversation_shipments
           WHERE link_source = 'detected')                     AS links_detected,
        (SELECT count(*)::int FROM conversation_shipping_accounts) AS account_links,
        (SELECT count(*)::int FROM shipments WHERE sync_state = 'stub') AS unsynced
    `),
  ]);

  const row = (counts as unknown as Record<string, number>[])[0] ?? null;
  const shipmentRow = (shipmentCounts as unknown as ShipmentCounts[])[0] ?? null;

  return (
    <div className="flex flex-col gap-10">
      <ImportForm runs={runs} counts={row} />
      <ShipmentBackfillForm runs={backfillRuns} counts={shipmentRow} />
    </div>
  );
}
