import { requireAnyPermission } from '@/lib/auth/guard';
import { AdminNav, type NavSection } from './nav';
import { SETTINGS_PERMISSIONS, sectionsFor } from './sections';

export const dynamic = 'force-dynamic';

/**
 * Settings shell.
 *
 * A section list beside the content, grouped by what an admin is trying to do
 * rather than by which table each setting lives in (`sections.ts` says how the
 * groups were chosen).
 *
 * Anybody holding one page's key may come in, and the list shows them only the
 * pages they can open. The gate used to be `admin.agents` for everything, which
 * made "may manage agents" the same thing as "may open settings": a per-agent
 * grant of `admin.sla` alone reached nothing, and the sidebar offered every
 * page to everybody who got in. Each page still requires its own key.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const agent = await requireAnyPermission(SETTINGS_PERMISSIONS);

  // Only what the sidebar draws crosses to the client: the descriptions and
  // search words are the settings home's, which renders them on the server.
  const sections: NavSection[] = sectionsFor(agent).map((section) => ({
    title: section.title,
    links: section.pages.map((page) => ({
      href: page.href,
      label: page.label,
      children: (page.children ?? []).map((child) => ({ href: child.href, label: child.label })),
    })),
  }));

  return (
    <div className="flex h-full min-h-0">
      <AdminNav sections={sections} />
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
