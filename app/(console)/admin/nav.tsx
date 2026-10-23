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
      { href: '/admin/skills', label: 'Skills' },
      { href: '/admin/locations', label: 'Locations' },
    ],
  },
  {
    title: 'Routing',
    links: [
      { href: '/admin/sla', label: 'SLA policies' },
      { href: '/admin/automations', label: 'Automations' },
      { href: '/admin/hours', label: 'Business hours' },
      { href: '/admin/auto-responses', label: 'Out-of-hours replies' },
      { href: '/admin/csat', label: 'Satisfaction surveys' },
    ],
  },
  {
    title: 'Tickets',
    links: [
      { href: '/admin/statuses', label: 'Statuses' },
      { href: '/admin/categories', label: 'Categories' },
      { href: '/admin/fields', label: 'Fields' },
      { href: '/admin/forms', label: 'Forms' },
      { href: '/admin/canned', label: 'Canned responses' },
    ],
  },
  {
    title: 'Help centre',
    links: [{ href: '/admin/tracking', label: 'Tracking wording' }],
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

/*
 * The design system's views-panel item: the section you are in wears the
 * selected tint with brand text, never a filled blue, because a filled blue is
 * what an action looks like. `aria-current` is the hook for the styling as well
 * as the fact for a screen reader, so the two cannot disagree.
 */
const ITEM =
  'flex min-h-9 items-center rounded-md px-2 text-sm text-(--color-text-primary) transition-colors hover:bg-(--color-background-hover) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)';

const CHIP =
  'rounded-full bg-(--color-background-surface-sunken) px-3 py-1 text-xs whitespace-nowrap text-(--color-text-secondary) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)';

export function AdminNav() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <nav
        aria-label="Admin sections"
        className="app-scroll relative hidden w-(--views-width) shrink-0 flex-col gap-4.5 overflow-y-auto border-e border-(--color-border-subtle) bg-(--color-background-surface) px-2.5 py-4 lg:flex"
      >
        <Link
          href="/admin"
          aria-current={pathname === '/admin' ? 'page' : undefined}
          className={`${ITEM} font-semibold`}
        >
          Settings
        </Link>

        {SECTIONS.map((section) => (
          <div key={section.title}>
            <p className="mb-1 px-2 text-xs font-semibold text-(--color-text-secondary)">
              {section.title}
            </p>
            <ul className="flex flex-col gap-0.5">
              {section.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={isActive(link.href) ? 'page' : undefined}
                    className={ITEM}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Pinned under the console header, and clear of the rail from `md`,
          where the rail appears and this strip is still showing. */}
      <nav
        aria-label="Admin sections"
        className="app-scroll fixed inset-x-0 top-(--header-height) z-20 flex gap-1 overflow-x-auto border-b border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2 md:start-(--rail-width) lg:hidden"
      >
        {SECTIONS.flatMap((section) => section.links).map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive(link.href) ? 'page' : undefined}
            className={CHIP}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
