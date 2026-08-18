import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ImportForm } from './form';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requirePermission('admin.agents');

  const [runs, counts] = await Promise.all([
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

    // One round trip rather than four, and it returns a row even when every
    // table is empty — which is exactly the state this page exists to explain.
    db.execute<{
      categories: number;
      folders: number;
      articles: number;
      redirects: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM kb_categories) AS categories,
        (SELECT count(*)::int FROM kb_folders)    AS folders,
        (SELECT count(*)::int FROM kb_articles)   AS articles,
        (SELECT count(*)::int FROM kb_redirects)  AS redirects
    `),
  ]);

  const row = (counts as unknown as Record<string, number>[])[0] ?? null;

  return <ImportForm runs={runs} counts={row} />;
}
