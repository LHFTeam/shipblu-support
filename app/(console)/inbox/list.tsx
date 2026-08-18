'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Select } from '@/components/ui';
import { channelLabel, formatRelative } from '@/lib/format';
import type { InboxFilters, InboxRow } from '@/lib/tickets/queries';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';

export function InboxList({
  rows,
  hasMore,
  filters,
  activeNumber,
}: {
  rows: InboxRow[];
  hasMore: boolean;
  filters: InboxFilters;
  activeNumber?: number;
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
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border)] p-2">
        <SearchBox initial={filters.q} onSearch={(value) => setParam('q', value)} />

        <div className="flex gap-2">
          <Select
            value={filters.statusCategory}
            onChange={(e) => setParam('status', e.target.value)}
          >
            <option value="unresolved">Open + pending</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
            <option value="all">Any status</option>
          </Select>

          <Select value={filters.channel} onChange={(e) => setParam('channel', e.target.value)}>
            <option value="all">All channels</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </Select>
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <li className="p-8 text-center text-sm opacity-50">Nothing here.</li>
        ) : null}

        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={`/inbox/${row.number}?${params.toString()}`}
              className={`block border-b border-[var(--border)] px-3 py-2.5 hover:bg-[var(--muted)] ${
                row.number === activeNumber ? 'bg-[var(--muted)]' : ''
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium">
                  {row.requesterName ?? row.requesterHandle ?? 'Unknown'}
                </span>
                <span className="ml-auto shrink-0 text-xs opacity-50">
                  {formatRelative(row.lastMessageAt)}
                </span>
              </div>

              <p className="mt-0.5 truncate text-sm opacity-80">{row.subject ?? '(no subject)'}</p>
              {row.preview ? (
                <p className="mt-0.5 truncate text-xs opacity-50">{row.preview}</p>
              ) : null}

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge tone={row.statusCategory}>{row.statusName}</Badge>
                <span className="text-xs opacity-50">#{row.number}</span>
                <span className="text-xs opacity-50">{channelLabel(row.channel)}</span>
                {row.channel === 'whatsapp' ? (
                  <WindowBadge lastCustomerMessageAt={row.lastCustomerMessageAt} />
                ) : null}
                {row.priority === 'urgent' || row.priority === 'high' ? (
                  <Badge tone="danger">{row.priority}</Badge>
                ) : null}
                {row.assigneeName ? (
                  <span className="ml-auto truncate text-xs opacity-50">{row.assigneeName}</span>
                ) : (
                  <span className="ml-auto text-xs opacity-40">unassigned</span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ol>

      {hasMore || filters.page > 1 ? (
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--border)] p-2 text-xs">
          <button
            type="button"
            disabled={filters.page <= 1}
            onClick={() => setParam('page', String(filters.page - 1))}
            className="rounded px-2 py-1 hover:bg-[var(--muted)] disabled:opacity-30"
          >
            ← Newer
          </button>
          <span className="opacity-50">Page {filters.page}</span>
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
 */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (value: string) => void }) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (value === initial) return;
    const timer = setTimeout(() => onSearch(value), 350);
    return () => clearTimeout(timer);
  }, [value, initial, onSearch]);

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Search #number, subject, customer…"
      className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
    />
  );
}

/** The 24-hour window at a glance, so agents can triage by what is expiring. */
function WindowBadge({ lastCustomerMessageAt }: { lastCustomerMessageAt: Date | string | null }) {
  const state = windowState(lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null);

  if (!state.isOpen) return <Badge tone="closed">window closed</Badge>;
  // Under two hours is when it starts mattering; above that it is just noise.
  if (state.remainingMs < 2 * 60 * 60 * 1000) {
    return <Badge tone="warning">{formatRemaining(state.remainingMs)}</Badge>;
  }
  return null;
}
