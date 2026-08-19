import { requirePermission } from '@/lib/auth/guard';
import { AdminNav } from './nav';

export const dynamic = 'force-dynamic';

/**
 * Admin shell.
 *
 * A section list beside the content, grouped by what an admin is actually
 * trying to do — set up who works here, how work is routed, and what the
 * customer sees — rather than by which table each setting happens to live in.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('admin.agents');

  return (
    <div className="flex h-full min-h-0">
      <AdminNav />
      <div className="app-scroll min-w-0 flex-1 overflow-y-auto">
        {/* pt-12 clears the horizontal section strip that replaces the
            sidebar below `lg`. */}
        <div className="mx-auto max-w-5xl p-4 pt-14 md:p-6 lg:pt-6">{children}</div>
      </div>
    </div>
  );
}
