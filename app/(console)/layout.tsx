import Link from 'next/link';
import { ShipBluLogo } from '@/components/brand';
import { AgentActivity } from '@/components/agent-activity';
import { AgentPresence } from '@/components/agent-presence';
import { AgentAvatar } from '@/components/avatar';
import { Tooltip } from '@/components/tooltip';
import { Button } from '@/components/ui';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { warningLeadMs } from '@/lib/presence/idle';
import { loadPresencePolicy } from '@/lib/presence/policy';
import { inboxCounts } from '@/lib/tickets/inbox';
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
 * The frame is a fixed rail plus a content column, so the inbox can own the
 * full height and manage its own panes rather than the page scrolling as one
 * long document. The column is `min-h-0` and never scrolls itself: every page
 * brings its own scroll container (§6.53), and one here would put a second
 * scrollbar round the inbox's panes.
 *
 * From `md` the 56px header sits borderless on the console grey, which the
 * inbox continues down into the gaps between its white panels; every other page
 * paints the canvas from under the header to the bottom edge. On a phone the
 * header is white with a hairline, because there is no grey frame for it to
 * belong to.
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
      ? [{ href: '/kb', label: 'Knowledge base', short: 'KB', icon: 'kb' } as const]
      : []),
    ...(can(agent, 'report.view')
      ? [{ href: '/reports', label: 'Reports', icon: 'reports' } as const]
      : []),
    ...(can(agent, 'admin.agents')
      ? [{ href: '/admin', label: 'Admin', icon: 'admin' } as const]
      : []),
  ];

  return (
    <div className="flex h-dvh overflow-hidden bg-(--color-background-console)">
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
        <header className="flex h-(--header-height) shrink-0 items-center gap-3 border-b border-(--color-border-subtle) bg-(--color-background-surface) px-3 md:border-b-0 md:bg-transparent md:px-5">
          <Link href="/inbox" className="flex items-center gap-2 md:hidden">
            <ShipBluLogo className="size-7" />
            {/* The name gives way first on a narrow phone: logo, switch,
                avatar and Sign out already fill 390px, and the logo alone
                still says whose console this is. */}
            <span className="hidden text-sm font-semibold whitespace-nowrap min-[420px]:inline">
              ShipBlu Support
            </span>
          </Link>

          <div className="ms-auto flex shrink-0 items-center gap-3">
            <AvailabilitySwitch
              accepting={agent.isAcceptingTickets}
              offReason={agent.acceptingOffReason}
              awayAfterMins={policy.autoAwayAfterMins}
            />
            {/* The email behind the name rather than in a `title`, so a phone
                can reach it too. */}
            <span className="hidden text-xs sm:block">
              <Tooltip content={agent.email}>{agent.name ?? agent.email}</Tooltip>
            </span>
            <AgentAvatar
              name={agent.name}
              color={agent.avatarColor}
              avatarUrl={agent.avatarUrl}
              size={28}
            />
            {/* `type="submit"` said out loud: `Button` defaults to a plain
                button, and without it this form would never post. The `!` is
                the class-order trap — the ghost variant's own text colour
                otherwise wins by name, not by position. */}
            <form action="/api/auth/logout" method="post">
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="whitespace-nowrap text-(--color-text-secondary)!"
              >
                Sign out
              </Button>
            </form>
          </div>
        </header>

        {/* Clears the bottom navigation bar on mobile: its links' height, its
            1px top hairline, and whatever the home indicator needs. Reserving
            only the links left the bar sitting on top of the composer's send
            button on any phone with a safe area. Read from the same token the
            bar uses, so the two cannot drift apart. */}
        <div className="min-h-0 flex-1 bg-(--color-background-canvas) pb-[calc(var(--bottom-bar-height)+1px+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </div>
      </div>
    </div>
  );
}
