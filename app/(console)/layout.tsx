import Link from 'next/link';
import { LiveUpdates } from '@/components/live-updates';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { inboxCounts } from '@/lib/tickets/queries';
import { initials } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Console shell.
 *
 * `requireAgent()` here is the real access check — middleware only sees the
 * cookie. Every page nested under this layout is therefore behind a database
 * session lookup, which is what makes deactivating an agent take effect on
 * their next request rather than in thirty days.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const agent = await requireAgent();
  const counts = await inboxCounts(agent);

  return (
    <div className="flex h-dvh flex-col">
      <LiveUpdates />

      <header className="flex shrink-0 items-center gap-6 border-b border-[var(--border)] px-4 py-2">
        <Link href="/inbox" className="text-sm font-semibold">
          ShipBlu Support
        </Link>

        <nav className="flex items-center gap-1 text-sm">
          <NavLink href="/inbox?view=all">
            All open <Count value={counts.all} />
          </NavLink>
          <NavLink href="/inbox?view=mine">
            Mine <Count value={counts.mine} />
          </NavLink>
          <NavLink href="/inbox?view=unassigned">
            Unassigned <Count value={counts.unassigned} />
          </NavLink>
          {can(agent, 'kb.view') ? <NavLink href="/kb">Knowledge base</NavLink> : null}
          {can(agent, 'report.view') ? <NavLink href="/reports">Reports</NavLink> : null}
          {can(agent, 'admin.agents') ? <NavLink href="/admin/agents">Admin</NavLink> : null}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span
            title={agent.email}
            className="flex size-7 items-center justify-center rounded-full bg-brand-600 text-xs font-medium text-white"
          >
            {initials(agent.name)}
          </span>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="text-xs opacity-60 hover:opacity-100">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 hover:bg-[var(--muted)]"
    >
      {children}
    </Link>
  );
}

function Count({ value }: { value: number }) {
  if (!value) return null;
  return (
    <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-xs opacity-70">{value}</span>
  );
}
