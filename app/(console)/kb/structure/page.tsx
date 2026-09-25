import Link from 'next/link';
import { Badge } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { listCategoriesForAdmin, listFolderOptions, type FolderOption } from '@/lib/kb/admin';
import { FLOOR_LABELS, folderFloor } from '@/lib/kb/floors';
import { CategoryForm, FolderForm } from './forms';

export const dynamic = 'force-dynamic';

export default async function StructurePage() {
  await requirePermission('kb.edit');

  const [categories, folders] = await Promise.all([listCategoriesForAdmin(), listFolderOptions()]);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-8 overflow-y-auto p-6">
      <nav className="text-sm opacity-60">
        <Link href="/kb" className="hover:opacity-100">
          ← Knowledge base
        </Link>
      </nav>

      <section>
        <h1 className="mb-1 text-lg font-semibold">Categories</h1>
        <p className="mb-3 text-sm opacity-60">
          A category belongs to one language. English and Arabic are separate trees, which is what
          lets the two versions of the help centre be organised differently.
        </p>

        <ul className="mb-4 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
          {categories.length === 0 ? (
            <li className="px-3 py-2.5 opacity-50">No categories yet.</li>
          ) : null}
          {categories.map((category) => (
            <li key={category.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="font-medium">{category.name}</span>
              <span className="opacity-50">{category.locale}</span>
              <span className="opacity-40">/{category.slug}</span>
              <span className="ms-auto text-xs opacity-50">{category.folderCount} folders</span>
            </li>
          ))}
        </ul>

        <CategoryForm />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Folders</h2>
        <p className="mb-3 text-sm opacity-60">
          Every article lives in a folder. A folder marked anything other than public hides all of
          its articles from the help centre, whatever the articles themselves say. An internal
          folder can go further and name the most junior role on the team that may read it, which
          then holds for every article inside.
        </p>

        <ul className="mb-4 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
          {folders.length === 0 ? (
            <li className="px-3 py-2.5 opacity-50">No folders yet.</li>
          ) : null}
          {folders.map((folder) => (
            <li key={folder.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="opacity-60">{folder.categoryName}</span>
              <span aria-hidden className="opacity-30">
                ›
              </span>
              <span className="font-medium">{folder.name}</span>
              {folder.visibility !== 'public' ? (
                <Badge tone="warning">{audience(folder)}</Badge>
              ) : null}
              <span className="ms-auto text-xs opacity-50">{folder.categoryLocale}</span>
            </li>
          ))}
        </ul>

        <FolderForm categories={categories} />
      </section>
    </div>
  );
}

/**
 * Who this folder is for, in one badge.
 *
 * The floor rather than the level where there is one — "agents only" and
 * "supervisors and up" are different audiences — but only where the floor is
 * the thing in force. `folderFloor` is null on anything a customer can open, so
 * a `logged_in` folder still carrying a stray `min_role` reads as "signed-in
 * customers" instead of claiming an audience nothing enforces.
 */
function audience(folder: FolderOption): string {
  const floor = folderFloor(folder);
  return floor ? FLOOR_LABELS[floor] : folder.visibility.replace('_', ' ');
}
