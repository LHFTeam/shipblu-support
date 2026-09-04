import Link from 'next/link';
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
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <nav className="mb-4 text-sm opacity-60">
        <Link href="/kb" className="hover:opacity-100">
          ← Knowledge base
        </Link>
      </nav>

      <h1 className="mb-4 text-lg font-semibold">New article</h1>

      {folders.length === 0 ? (
        <p className="rounded-lg border border-[var(--border)] p-4 text-sm opacity-70">
          There are no folders yet.{' '}
          <Link href="/kb/structure" className="underline">
            Create a category and folder
          </Link>{' '}
          first — every article lives in one.
        </p>
      ) : (
        <ArticleEditor article={null} folders={folders} />
      )}
    </div>
  );
}
