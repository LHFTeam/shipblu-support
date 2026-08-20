'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Admin sections.
 *
 * Grouped by intent — the team, how work is routed, what the customer sees —
 * because "where do I change the SLA?" is a question about what you want to
 * happen, not about which table it is stored in.
 *
 * On a phone this becomes a horizontally scrolling strip rather than a menu
 * behind a button: there are only a dozen destinations and hiding them behind
 * a tap makes finding a setting a two-step search.
 */

const SECTIONS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: 'Overview',
    links: [{ href: '/admin/dashboard', label: 'Dashboard' }],
  },
  {
    title: 'Team',
    links: [
      { href: '/admin/agents', label: 'Agents' },
      { href: '/admin/groups', label: 'Groups' },
      { href: '/admin/locations', label: 'Locations' },
    ],
  },
  {
    title: 'Routing',
    links: [
      { href: '/admin/sla', label: 'SLA policies' },
      { href: '/admin/automations', label: 'Automations' },
      { href: '/admin/hours', label: 'Business hours' },
    ],
  },
  {
    title: 'Tickets',
    links: [
      { href: '/admin/statuses', label: 'Statuses' },
      { href: '/admin/fields', label: 'Fields' },
      { href: '/admin/canned', label: 'Canned responses' },
    ],
  },
  {
    title: 'Channels',
    links: [
      { href: '/admin/channels', label: 'Channels' },
      { href: '/admin/recipients', label: 'Internal recipients' },
      { href: '/admin/import', label: 'Freshdesk import' },
    ],
  },
];

export function AdminNav() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <nav
        aria-label="Admin sections"
        className="app-scroll hidden w-52 shrink-0 overflow-y-auto border-e border-[var(--border)] bg-[var(--surface)] p-3 lg:block"
      >
        <Link
          href="/admin"
          className={`mb-3 block rounded-md px-2 py-1.5 text-sm font-semibold ${
            pathname === '/admin' ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]'
          }`}
        >
          Settings
        </Link>

        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-4">
            <p className="mb-1 px-2 text-[11px] font-medium tracking-wide text-[var(--muted-foreground)] uppercase">
              {section.title}
            </p>
            <ul className="flex flex-col gap-0.5">
              {section.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={isActive(link.href) ? 'page' : undefined}
                    className={`block rounded-md px-2 py-1.5 text-sm ${
                      isActive(link.href)
                        ? 'bg-brand-500/12 font-medium text-brand-700 dark:text-brand-200'
                        : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]'
                    }`}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <nav
        aria-label="Admin sections"
        className="app-scroll fixed inset-x-0 top-12 z-20 flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 lg:hidden"
      >
        {SECTIONS.flatMap((section) => section.links).map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-full px-3 py-1 text-xs whitespace-nowrap ${
              isActive(link.href)
                ? 'bg-brand-600 font-medium text-white'
                : 'bg-[var(--muted)] text-[var(--muted-foreground)]'
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
