import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { requirePermission } from '@/lib/auth/guard';
import { getArticleForEdit, listFolderOptions, listVersions } from '@/lib/kb/admin';
import { requestBaseUrl } from '@/lib/kb/site';
import { ArticleEditor } from '../editor';
import { ArticleSidebar } from './sidebar';

export const dynamic = 'force-dynamic';

export default async function EditArticlePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('kb.edit');

  const { id } = await params;
  const article = await getArticleForEdit(id);
  if (!article) notFound();

  const [folders, versions] = await Promise.all([listFolderOptions(), listVersions(id)]);

  // Built from the host this editor is being served on rather than from
  // `publicBaseUrl()`. This link exists to be clicked by the person who just
  // wrote the article, and the published hostname is only the right answer once
  // it serves this app — until the domain cuts over it is a 404 wearing the
  // canonical address.
  const publicUrl =
    article.status === 'published' && article.visibility === 'public'
      ? `${requestBaseUrl(await headers())}/${article.locale}/a/${encodeURI(article.slug)}`
      : null;

  return (
    <div className="mx-auto flex h-full max-w-6xl gap-6 overflow-y-auto p-6">
      <div className="min-w-0 flex-1">
        <nav className="mb-4 text-sm opacity-60">
          <Link href="/kb" className="hover:opacity-100">
            ← Knowledge base
          </Link>
        </nav>

        <ArticleEditor
          article={{
            id: article.id,
            title: article.title,
            slug: article.slug,
            bodyHtml: article.bodyHtml,
            locale: article.locale,
            folderId: article.folderId,
            visibility: article.visibility,
            tags: article.tags,
            seo: article.seo,
          }}
          folders={folders}
        />
      </div>

      <ArticleSidebar
        articleId={article.id}
        status={article.status}
        publicUrl={publicUrl}
        versions={versions}
        stats={{
          views: article.viewCount,
          helpful: article.helpfulCount,
          unhelpful: article.unhelpfulCount,
        }}
      />
    </div>
  );
}
