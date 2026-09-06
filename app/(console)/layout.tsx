import Link from 'next/link';
import { ShipBluLogo } from '@/components/brand';
import { AgentActivity } from '@/components/agent-activity';
import { AgentPresence } from '@/components/agent-presence';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { warningLeadMs } from '@/lib/presence/idle';
import { loadPresencePolicy } from '@/lib/presence/policy';
import { inboxCounts } from '@/lib/tickets/queries';
import { initials } from '@/lib/format';
import { AvailabilitySwitch } from './availability';
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
  // Memoised for thirty seconds inside the loader, so this costs nothing on
  // most requests — and `requireAgent()` above has already consulted it to
  // decide whether this session is still allowed to be here.
  const policy = await loadPresencePolicy();

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
      <AgentPresence />
      <AgentActivity
        accepting={agent.isAcceptingTickets}
        awayAfterMins={policy.autoAwayAfterMins}
        signoutAfterMins={policy.autoSignoutAfterMins}
        // The server's own measurement of this session, so the countdown in the
        // browser runs to the same deadline `getSessionAgent()` enforces rather
        // than to one up to a beat interval later.
        sessionIdleForMs={agent.sessionIdleForMs}
        warningLeadMs={warningLeadMs(policy)}
      />

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
            <AvailabilitySwitch accepting={agent.isAcceptingTickets} />
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

        {/* Clears the bottom navigation bar on mobile. The bar is 3.5rem plus
            whatever the home indicator needs, and reserving only the 3.5rem
            left it sitting on top of the composer's send button on any phone
            with a safe area. */}
        <div className="min-h-0 flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </div>
      </div>
    </div>
  );
}
