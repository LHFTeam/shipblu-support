import { ChevronLeftIcon } from '@/components/icons';
import Link from 'next/link';
import { Notice } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { listFolderOptionsForRole } from '@/lib/kb/admin';
import { ArticleEditor } from '../editor';

export const dynamic = 'force-dynamic';

export default async function NewArticlePage() {
  const agent = await requirePermission('kb.edit');

  // The reader's own folders, not every folder: `kb.edit` starts at supervisor,
  // and the handbook's admin folders are above some of the people who hold it.
  const folders = await listFolderOptionsForRole(agent.role);

  return (
    <div className="app-scroll mx-auto h-full max-w-5xl overflow-y-auto p-4 sm:p-6">
      <nav className="mb-4 text-sm text-(--color-text-secondary)">
        <Link
          href="/kb"
          className="inline-flex items-center gap-1 hover:text-(--color-text-primary)"
        >
          <ChevronLeftIcon size={16} />
          Knowledge base
        </Link>
      </nav>

      <h1 className="mb-4 text-lg font-semibold">New article</h1>

      {folders.length === 0 ? (
        <Notice tone="neutral">
          There are no folders yet.{' '}
          <Link href="/kb/structure" className="text-(--color-text-link) underline">
            Create a category and folder
          </Link>{' '}
          first — every article lives in one.
        </Notice>
      ) : (
        <ArticleEditor article={null} folders={folders} />
      )}
    </div>
  );
}
