'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BookIcon, ChartIcon, ContactsIcon, InboxIcon, SettingsIcon } from '@/components/icons';
import { CountBadge } from '@/components/ui';
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
 *
 * The one colour on the rail that is not navy or white is coral, and it only
 * ever means attention: the 2px bar on the start edge of the current section,
 * and the inbox count. The count is the shared `CountBadge`, so it is 11px
 * like every other count, not a smaller private size for the bar.
 */

export type NavItem = {
  href: string;
  label: string;
  /** The bottom bar's label, where a fifth of a phone's width is all a word gets. */
  short?: string;
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
        className="hidden w-(--rail-width) shrink-0 flex-col items-center gap-1 bg-(--color-background-rail) py-3 text-(--color-text-rail) md:flex"
      >
        <div className="mb-3">{brand}</div>
        {liveItems.map((item) => (
          <RailLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
      </nav>

      {/* Mobile: the same destinations along the bottom. */}
      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-(--color-border-subtle) bg-(--color-background-surface) pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {liveItems.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              // The full name, because the visible word may be the short one.
              aria-label={linkName(item)}
              className="flex min-h-(--bottom-bar-height) flex-1 flex-col items-center gap-0.5 py-2 text-2xs font-medium text-(--color-text-secondary) aria-[current=page]:text-(--color-text-brand)"
            >
              <span className="relative flex">
                <Icon size={20} />
                <CountBadge
                  count={item.badge ?? 0}
                  label="open"
                  ring="surface"
                  className="absolute -end-2.5 -top-1"
                />
              </span>
              {item.short ?? item.label}
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
      // The label below is `display: none` until hover, which takes it out of
      // the accessibility tree too — without this the link was named only by
      // its count, or by nothing at all.
      aria-label={linkName(item)}
      className="group relative flex size-11 items-center justify-center rounded-lg text-(--color-text-rail-muted) transition-colors hover:bg-(--color-rail-hover) hover:text-(--color-text-rail) focus-visible:outline-(--color-text-rail) aria-[current=page]:bg-(--color-rail-active) aria-[current=page]:text-(--color-text-rail)"
    >
      {/* The active marker is a bar on the rail edge rather than only a filled
          background: it survives the hover state without the two fighting. */}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1 start-0 w-0.5 rounded-full bg-(--color-attention-marker)"
        />
      ) : null}

      <Icon size={21} />

      <CountBadge
        count={item.badge ?? 0}
        label="open"
        ring="rail"
        className="absolute end-0.5 top-0.5"
      />

      {/* Label on hover and on keyboard focus, so the rail stays narrow without
          being a guessing game. */}
      <span
        aria-hidden
        className="pointer-events-none absolute start-full z-40 ms-2 hidden rounded-md bg-(--color-background-rail) px-2 py-1 text-xs whitespace-nowrap text-(--color-text-rail) shadow-float group-hover:block group-focus-visible:block"
      >
        {item.label}
      </span>
    </Link>
  );
}

/** "Inbox, 12 open" — the section, then what its count counts. */
function linkName(item: NavItem): string {
  return item.badge ? `${item.label}, ${item.badge} open` : item.label;
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
