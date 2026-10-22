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
      {/* Positioned for the `sr-only` text on every admin page, which is
          `position: absolute`: unpositioned, this pane let an onboarding
          card's step states be placed against the document, and scrolling
          past the end of /admin/channels took the whole console off the
          screen (PROJECT-STATE §6.81, `scroll-positioned`). */}
      <div className="app-scroll relative min-w-0 flex-1 overflow-y-auto">
        {/* The top padding clears the horizontal section strip that replaces
            the sidebar below `lg`. It is restated at `md` because `md:p-6`
            sets every side, top included, and on its own put the first row of
            each page under the strip between `md` and `lg`. */}
        <div className="mx-auto max-w-5xl p-4 pt-14 md:p-6 md:pt-16 lg:pt-6">{children}</div>
      </div>
    </div>
  );
}
