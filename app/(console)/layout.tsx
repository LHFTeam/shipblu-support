import Link from 'next/link';
import { ShipBluLogo } from '@/components/brand';
import { LiveUpdates } from '@/components/live-updates';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { inboxCounts } from '@/lib/tickets/queries';
import { initials } from '@/lib/format';
import { Rail, type NavItem } from './nav';

export const dynamic = 'force-dynamic';

/**
 * Console shell.
 *
 * `requireAgent()` here is the real access check — the proxy only sees the
 * cookie. Every page nested under this layout is therefore behind a database
 * session lookup, which is what makes deactivating an agent take effect on
 * their next request rather than in thirty days.
 *
 * The frame is a fixed rail plus a scrolling content column, so the inbox can
 * own the full height and manage its own panes rather than the page scrolling
 * as one long document.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const agent = await requireAgent();
  const counts = await inboxCounts(agent);

  const items: NavItem[] = [
    { href: '/inbox', label: 'Inbox', icon: 'inbox', badge: counts.all },
    ...(can(agent, 'contact.view')
      ? [{ href: '/contacts', label: 'Contacts', icon: 'contacts' } as const]
      : []),
    ...(can(agent, 'kb.view')
      ? [{ href: '/kb', label: 'Knowledge base', icon: 'kb' } as const]
      : []),
    ...(can(agent, 'report.view')
      ? [{ href: '/reports', label: 'Reports', icon: 'reports' } as const]
      : []),
    ...(can(agent, 'admin.agents')
      ? [{ href: '/admin', label: 'Admin', icon: 'admin' } as const]
      : []),
  ];

  return (
    <div className="flex h-dvh overflow-hidden">
      <LiveUpdates />

      <Rail
        items={items}
        brand={
          <Link href="/inbox" aria-label="ShipBlu Support">
            <ShipBluLogo className="size-9" />
          </Link>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 md:px-4">
          <Link href="/inbox" className="flex items-center gap-2 md:hidden">
            <ShipBluLogo className="size-7" />
            <span className="text-sm font-semibold">ShipBlu Support</span>
          </Link>

          <div className="ms-auto flex items-center gap-3">
            <span className="hidden text-xs text-[var(--muted-foreground)] sm:block">
              {agent.name ?? agent.email}
            </span>
            <span
              title={agent.email}
              className="flex size-7 items-center justify-center rounded-full bg-brand-600 text-xs font-medium text-white"
            >
              {initials(agent.name)}
            </span>
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        {/* pb-14 on mobile clears the bottom navigation bar. */}
        <div className="min-h-0 flex-1 pb-14 md:pb-0">{children}</div>
      </div>
    </div>
  );
}
