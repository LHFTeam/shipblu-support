'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChannelBadge, channelInfo } from '@/components/channel';
import { SearchIcon } from '@/components/icons';
import { Badge, Select } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import type { InboxFilters, InboxRow } from '@/lib/tickets/queries';
import { FILTERABLE_CHANNELS, isRestrictedChannel } from '@/lib/tickets/channel-policy';
import { metaWindowState } from '@/lib/meta/window';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';

/**
 * The ticket list.
 *
 * Modelled on Freshchat's conversation column: one line of who, one of what,
 * and a row of the things an agent triages by. Density matters more than
 * breathing room here — this is the list you scan a hundred times a day — so
 * each row is three tight lines rather than a card.
 */
export function InboxList({
  rows,
  hasMore,
  filters,
  activeNumber,
  canSeeBot = false,
}: {
  rows: InboxRow[];
  hasMore: boolean;
  filters: InboxFilters;
  activeNumber?: number;
  canSeeBot?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current page number.
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border)] bg-[var(--surface)] p-2">
        <SearchBox initial={filters.q} onSearch={(value) => setParam('q', value)} />

        <div className="flex gap-2">
          <Select
            value={filters.statusCategory}
            onChange={(e) => setParam('status', e.target.value)}
            aria-label="Status"
          >
            <option value="unresolved">Open + pending</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
            <option value="all">Any status</option>
          </Select>

          <Select
            value={filters.channel}
            onChange={(e) => setParam('channel', e.target.value)}
            aria-label="Channel"
          >
            <option value="all">All channels</option>
            {/*
              Built from the list the parser accepts, and labelled from the same
              place as the badges, so an option cannot exist that the filter
              ignores or that reads differently here than on the row.
            */}
            {FILTERABLE_CHANNELS.filter(
              (channel) => canSeeBot || !isRestrictedChannel(channel),
            ).map((channel) => (
              <option key={channel} value={channel}>
                {channelInfo(channel).label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ol className="app-scroll min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <li className="p-8 text-center text-sm text-[var(--muted-foreground)]">
            Nothing matches those filters.
          </li>
        ) : null}

        {rows.map((row) => {
          const active = row.number === activeNumber;

          return (
            <li key={row.id}>
              <Link
                href={`/inbox/${row.number}?${params.toString()}`}
                aria-current={active ? 'page' : undefined}
                className={`relative block border-b border-[var(--border)] py-2.5 pe-3 ps-3 transition-colors ${
                  active ? 'bg-brand-500/10' : 'bg-[var(--surface)] hover:bg-[var(--muted)]'
                }`}
              >
                {/* The active row is marked on its edge, which survives the
                    hover state and reads at a glance down a long list. */}
                {active ? <span className="absolute inset-y-0 start-0 w-0.5 bg-brand-600" /> : null}

                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">
                    {row.requesterName ?? row.requesterHandle ?? 'Unknown'}
                  </span>
                  <span className="ms-auto shrink-0 text-xs text-[var(--muted-foreground)]">
                    {formatRelative(row.lastMessageAt)}
                  </span>
                </div>

                <p className="mt-0.5 truncate text-sm">{row.subject ?? '(no subject)'}</p>

                {/* The preview repeats the subject on channels that have none of
                    their own, so it is only shown when it adds something. */}
                {row.preview && row.preview !== row.subject ? (
                  <p className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]">
                    {row.preview}
                  </p>
                ) : null}

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <ChannelBadge channel={row.channel} showLabel={false} />
                  <Badge tone={row.statusCategory}>{row.statusName}</Badge>
                  <span className="text-xs text-[var(--muted-foreground)]">#{row.number}</span>

                  {row.channel === 'whatsapp' ? (
                    <WhatsAppWindow lastCustomerMessageAt={row.lastCustomerMessageAt} />
                  ) : null}
                  {row.channel === 'facebook' || row.channel === 'instagram' ? (
                    <MetaWindow lastCustomerMessageAt={row.lastCustomerMessageAt} />
                  ) : null}

                  {row.priority === 'urgent' || row.priority === 'high' ? (
                    <Badge tone="danger">{row.priority}</Badge>
                  ) : null}

                  {row.assigneeName ? (
                    <span className="ms-auto truncate text-xs text-[var(--muted-foreground)]">
                      {row.assigneeName}
                    </span>
                  ) : (
                    <span className="ms-auto text-xs text-[var(--muted-foreground)]/70">
                      unassigned
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ol>

      {hasMore || filters.page > 1 ? (
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
          <button
            type="button"
            disabled={filters.page <= 1}
            onClick={() => setParam('page', String(filters.page - 1))}
            className="rounded px-2 py-1 hover:bg-[var(--muted)] disabled:opacity-30"
          >
            ← Newer
          </button>
          <span className="text-[var(--muted-foreground)]">Page {filters.page}</span>
          <button
            type="button"
            disabled={!hasMore}
            onClick={() => setParam('page', String(filters.page + 1))}
            className="rounded px-2 py-1 hover:bg-[var(--muted)] disabled:opacity-30"
          >
            Older →
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Debounced so typing a ticket number does not fire a query per keystroke —
 * each one is a full server render of the list.
 *
 * `onSearch` is held in a ref and kept out of the effect's dependencies, which
 * is what makes the debounce survive a busy inbox. The console refreshes itself
 * on every inbound message and every delivery receipt, and each refresh renders
 * this component with a fresh `onSearch` closure. With that closure in the
 * dependency array the effect tore down and rebuilt on every one of them,
 * restarting the timer — and refreshes arrive closer together than 350ms when
 * WhatsApp is busy, so the search fired late, erratically, or never.
 */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (value: string) => void }) {
  const [value, setValue] = useState(initial);

  const latest = useRef(onSearch);
  useEffect(() => {
    latest.current = onSearch;
  });

  useEffect(() => {
    if (value === initial) return;
    const timer = setTimeout(() => latest.current(value), 350);
    return () => clearTimeout(timer);
  }, [value, initial]);

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 start-2 flex items-center text-[var(--muted-foreground)]">
        <SearchIcon size={15} />
      </span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search #number, track:, sbid:, name, phone…"
        aria-label="Search tickets and chats"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-1.5 pe-2.5 ps-7 text-sm outline-none focus:border-brand-500"
      />
    </div>
  );
}

/** The 24-hour window at a glance, so agents can triage by what is expiring. */
function WhatsAppWindow({
  lastCustomerMessageAt,
}: {
  lastCustomerMessageAt: Date | string | null;
}) {
  const state = windowState(lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null);

  if (!state.isOpen) return <Badge tone="closed">window closed</Badge>;
  // Under two hours is when it starts mattering; above that it is just noise.
  if (state.remainingMs < 2 * 60 * 60 * 1000) {
    return <Badge tone="warning">{formatRemaining(state.remainingMs)}</Badge>;
  }
  return null;
}

/**
 * The Messenger and Instagram equivalent.
 *
 * Only shown once a reply needs the human-agent tag or has become impossible —
 * the first 24 hours are unremarkable and a badge on every row would say
 * nothing.
 */
function MetaWindow({ lastCustomerMessageAt }: { lastCustomerMessageAt: Date | string | null }) {
  const state = metaWindowState(lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null);

  if (state.isClosed) return <Badge tone="closed">window closed</Badge>;
  if (state.needsHumanAgentTag) return <Badge tone="warning">outside 24h</Badge>;
  return null;
}
