import { ChevronLeftIcon } from '@/components/icons';
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { listCategoriesForAdmin, listFolderOptions, type FolderOption } from '@/lib/kb/admin';
import { FLOOR_LABELS, folderFloor } from '@/lib/kb/floors';
import { CategoryForm, FolderForm } from './forms';
import { sentenceCase } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function StructurePage() {
  await requirePermission('kb.edit');

  const [categories, folders] = await Promise.all([listCategoriesForAdmin(), listFolderOptions()]);

  return (
    <div className="app-scroll relative mx-auto flex h-full max-w-3xl flex-col gap-8 overflow-y-auto p-4 sm:p-6">
      <nav className="text-sm text-(--color-text-secondary)">
        <Link
          href="/kb"
          className="inline-flex items-center gap-1 hover:text-(--color-text-primary)"
        >
          <ChevronLeftIcon size={16} />
          Knowledge base
        </Link>
      </nav>

      <section>
        <h1 className="mb-1 text-lg font-semibold">Categories</h1>
        <p className="mb-3 text-sm text-(--color-text-secondary)">
          A category belongs to one language. English and Arabic are separate trees, which is what
          lets the two versions of the help centre be organised differently.
        </p>

        <ul className="mb-4 divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
          {categories.length === 0 ? (
            <li className="px-4 py-3 text-(--color-text-tertiary)">No categories yet.</li>
          ) : null}
          {categories.map((category) => (
            <li key={category.id} className="flex items-center gap-3 px-4 py-3">
              <span className="font-medium">{category.name}</span>
              <span className="text-(--color-text-tertiary)">{category.locale}</span>
              <span className="text-(--color-text-tertiary)">/{category.slug}</span>
              <span className="ms-auto text-xs text-(--color-text-tertiary)">
                {category.folderCount} folders
              </span>
            </li>
          ))}
        </ul>

        <CategoryForm />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Folders</h2>
        <p className="mb-3 text-sm text-(--color-text-secondary)">
          Every article lives in a folder. A folder marked anything other than public hides all of
          its articles from the help centre, whatever the articles themselves say. An internal
          folder can go further and name the most junior role on the team that may read it, which
          then holds for every article inside.
        </p>

        <ul className="mb-4 divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
          {folders.length === 0 ? (
            <li className="px-4 py-3 text-(--color-text-tertiary)">No folders yet.</li>
          ) : null}
          {folders.map((folder) => (
            <li key={folder.id} className="flex items-center gap-3 px-4 py-3">
              <span className="text-(--color-text-secondary)">{folder.categoryName}</span>
              <span aria-hidden className="text-(--color-text-tertiary)">
                ›
              </span>
              <span className="font-medium">{folder.name}</span>
              {folder.visibility !== 'public' ? (
                <Badge tone="warning">{audience(folder)}</Badge>
              ) : null}
              <span className="ms-auto text-xs text-(--color-text-tertiary)">
                {folder.categoryLocale}
              </span>
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
  if (floor) return FLOOR_LABELS[floor];
  // Sentence case, like every other badge: the level is stored as `agents_only`.
  const level = folder.visibility.replace('_', ' ');
  return sentenceCase(level);
}
