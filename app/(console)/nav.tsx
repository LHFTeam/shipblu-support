'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BookIcon, ChartIcon, ContactsIcon, InboxIcon, SettingsIcon } from '@/components/icons';
import { RefreshScheduler } from '@/lib/realtime/refresh-scheduler';

/**
 * The primary navigation rail.
 *
 * Modelled on Freshdesk: a narrow column of destinations pinned to the side,
 * so the inbox keeps the full width of the window and moving between areas
 * never costs a page of scrolling. On a phone the same list becomes a bottom
 * bar, which is where a thumb already is.
 *
 * `usePathname` rather than a prop, because the layout is a server component
 * and threading the current path through it would make every page pass
 * something it does not otherwise care about.
 */

export type NavItem = {
  href: string;
  label: string;
  icon: 'inbox' | 'contacts' | 'kb' | 'reports' | 'admin';
  badge?: number;
};

const ICONS = {
  inbox: InboxIcon,
  contacts: ContactsIcon,
  kb: BookIcon,
  reports: ChartIcon,
  admin: SettingsIcon,
};

export function Rail({ items, brand }: { items: NavItem[]; brand: ReactNode }) {
  const pathname = usePathname();
  const inboxActive = isActive(pathname, '/inbox');
  const serverInboxBadge = items.find((item) => item.href === '/inbox')?.badge ?? 0;
  const [liveInboxBadge, setLiveInboxBadge] = useState<{
    serverBaseline: number;
    count: number;
  } | null>(null);

  useEffect(() => {
    // The inbox already owns the one LISTEN connection for this agent. Outside
    // it, the rail takes over that connection and refreshes only its count — it
    // never asks Contacts, Reports or Admin to re-render because a ticket moved.
    if (inboxActive) return;

    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const abort = new AbortController();
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(() => scheduler.request(), 60_000);
    };

    const refreshCount = async () => {
      try {
        const response = await fetch('/api/inbox-counts', {
          cache: 'no-store',
          signal: abort.signal,
        });
        if (!response.ok) {
          startPolling();
          return;
        }

        const counts = (await response.json()) as { all?: unknown };
        if (typeof counts.all === 'number') {
          setLiveInboxBadge({ serverBaseline: serverInboxBadge, count: counts.all });
        }
      } catch {
        if (!abort.signal.aborted) startPolling();
      } finally {
        scheduler.complete();
      }
    };

    const scheduler = new RefreshScheduler({
      visible: document.visibilityState === 'visible',
      start: () => void refreshCount(),
    });
    // Closes the small route-transition gap between the inbox stream stopping
    // and this one finishing its LISTEN registrations.
    scheduler.request();

    const onVisibilityChange = () => {
      scheduler.setVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    try {
      source = new EventSource('/api/events?channel=all');
      source.addEventListener('conversation', () => scheduler.request());
      source.addEventListener('degraded', startPolling);
      source.addEventListener('ready', () => {
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
      });
      source.onerror = startPolling;
    } catch {
      startPolling();
    }

    return () => {
      source?.close();
      abort.abort();
      if (poll) clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      scheduler.dispose();
    };
  }, [inboxActive, serverInboxBadge]);

  // A newer server render always wins over an override derived from an older
  // baseline. Outside the inbox, the immediate lightweight fetch above then
  // supplies the continuously updated value for that baseline.
  const inboxBadge =
    !inboxActive && liveInboxBadge?.serverBaseline === serverInboxBadge
      ? liveInboxBadge.count
      : serverInboxBadge;

  const liveItems = items.map((item) =>
    item.href === '/inbox' ? { ...item, badge: inboxBadge } : item,
  );

  return (
    <>
      {/* Desktop: a vertical rail. */}
      <nav
        aria-label="Sections"
        className="hidden w-16 shrink-0 flex-col items-center gap-1 bg-[var(--rail)] py-3 text-[var(--rail-foreground)] md:flex"
      >
        <div className="mb-3">{brand}</div>
        {liveItems.map((item) => (
          <RailLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
      </nav>

      {/* Mobile: the same destinations along the bottom. */}
      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {liveItems.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
                active ? 'text-brand-600 dark:text-brand-300' : 'text-[var(--muted-foreground)]'
              }`}
            >
              <span className="relative">
                <Icon size={20} />
                {item.badge ? (
                  <span className="absolute -end-2 -top-1 rounded-full bg-accent-600 px-1 text-[9px] leading-4 text-white">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                ) : null}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = ICONS[item.icon];

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className="group relative flex size-11 items-center justify-center rounded-lg transition-colors hover:bg-white/10"
    >
      {/* The active marker is a bar on the rail edge rather than a filled
          background: it survives the hover state without the two fighting. */}
      {active ? (
        <span className="absolute inset-y-1 start-0 w-0.5 rounded-full bg-accent-500" />
      ) : null}

      <span className={active ? 'text-white' : 'text-white/70 group-hover:text-white'}>
        <Icon size={21} />
      </span>

      {item.badge ? (
        <span className="absolute end-1 top-1 min-w-4 rounded-full bg-accent-600 px-1 text-center text-[10px] leading-4 font-medium text-white">
          {item.badge > 99 ? '99+' : item.badge}
        </span>
      ) : null}

      {/* Label on hover, so the rail stays narrow without being a guessing game. */}
      <span className="pointer-events-none absolute start-full z-40 ms-2 hidden rounded-md bg-[var(--rail)] px-2 py-1 text-xs whitespace-nowrap text-white shadow-lg group-hover:block">
        {item.label}
      </span>
    </Link>
  );
}

/**
 * `/inbox` must not light up for `/inbox/42` only by prefix — it should, but
 * `/kb` must not light up for `/kbx`. Comparing whole segments does both.
 */
function isActive(pathname: string, href: string): boolean {
  const target = href.split('?')[0]!;
  if (pathname === target) return true;
  return pathname.startsWith(`${target}/`);
}
