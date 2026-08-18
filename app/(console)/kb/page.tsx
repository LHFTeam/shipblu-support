import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guard';
import { Badge } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { listArticlesForAdmin, parseArticleFilters } from '@/lib/kb/admin';
import { KbFilters } from './filters';

export const dynamic = 'force-dynamic';

export default async function KbListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('kb.view');

  const filters = parseArticleFilters(await searchParams);
  const articles = await listArticlesForAdmin(filters);

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Knowledge base</h1>
        <Link
          href="/kb/structure"
          className="text-sm opacity-60 underline underline-offset-4 hover:opacity-100"
        >
          Categories &amp; folders
        </Link>
        <Link
          href="/kb/new"
          className="ms-auto rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          New article
        </Link>
      </div>

      <KbFilters filters={filters} />

      <ul className="mt-4 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {articles.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm opacity-50">No articles yet.</li>
        ) : null}

        {articles.map((article) => (
          <li key={article.id}>
            <Link
              href={`/kb/${article.id}`}
              className="flex flex-wrap items-center gap-2 px-4 py-3 hover:bg-[var(--muted)]"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{article.title}</p>
                <p className="truncate text-xs opacity-50">
                  {article.categoryName} · {article.folderName} · /{article.slug}
                </p>
              </div>

              <Badge tone={article.status === 'published' ? 'open' : 'neutral'}>
                {article.status}
              </Badge>
              {article.visibility !== 'public' ? (
                <Badge tone="warning">{article.visibility.replace('_', ' ')}</Badge>
              ) : null}
              <Badge>{article.locale}</Badge>

              <span className="w-24 text-end text-xs opacity-50">{article.viewCount} views</span>
              <span className="w-20 text-end text-xs opacity-50">
                {formatRelative(article.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
