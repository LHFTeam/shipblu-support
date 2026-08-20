'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  nextCursor,
  filters,
  activeNumber,
  canSeeBot = false,
}: {
  rows: InboxRow[];
  nextCursor: string | null;
  filters: InboxFilters;
  activeNumber?: number;
  canSeeBot?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const {
    rows: olderRows,
    canLoadMore,
    loading,
    error,
    loadMore,
    sentinelRef,
    scrollRef,
  } = useOlderPages({ firstPage: rows, nextCursor, filters, params });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    // Strips the page number a bookmark or a still-open tab may carry from when
    // this list was paged. It no longer means anything, and leaving it in the
    // URL suggests it does.
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
  }

  // The server's first page is always the freshest view of the top of the
  // queue, so it wins: anything the scroll had already loaded that has since
  // moved up there is dropped from below rather than rendered twice.
  const seen = new Set(rows.map((row) => row.id));
  const visible = [...rows, ...olderRows.filter((row) => !seen.has(row.id))];

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

      <ol ref={scrollRef} className="app-scroll min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {visible.length === 0 ? (
          <li className="p-8 text-center text-sm text-[var(--muted-foreground)]">
            Nothing matches those filters.
          </li>
        ) : null}

        {visible.map((row) => {
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

                  {/* A ticket blocked on a hub looks identical to one nobody has
                      picked up, and "the hub answered an hour ago and nobody
                      noticed" is the failure this feature would otherwise
                      introduce. Only the answered state gets a loud colour: the
                      waiting one is a fact, the replied one is a job. */}
                  {row.sideState === 'replied' ? (
                    <Badge tone="success">hub replied</Badge>
                  ) : row.sideState === 'waiting' ? (
                    <Badge tone="neutral">awaiting hub</Badge>
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

        {/*
          The trigger sits inside the scrolling list rather than under it, so
          the observer measures it against the same box the agent is scrolling.
          It is only rendered while there is another page: no sentinel is what
          stops the list at the end.
        */}
        {canLoadMore ? (
          <li ref={sentinelRef} className="p-3 text-center text-xs text-[var(--muted-foreground)]">
            {error ? (
              <span className="flex flex-col items-center gap-1.5">
                {/* Scrolling already failed once here, so the retry is a button:
                    another scroll gesture would land on the same spot and look
                    like nothing happened. */}
                <span className="text-[var(--danger)]">{error}</span>
                <button
                  type="button"
                  onClick={loadMore}
                  className="rounded border border-[var(--border)] px-2 py-1 hover:bg-[var(--muted)]"
                >
                  Try again
                </button>
              </span>
            ) : (
              <span aria-live="polite">Loading older tickets…</span>
            )}
          </li>
        ) : olderRows.length > 0 ? (
          // Only worth saying once the agent has actually been scrolling. Under
          // a first page that never filled, it would state the obvious.
          <li className="p-3 text-center text-xs text-[var(--muted-foreground)]/70">
            End of the list
          </li>
        ) : null}
      </ol>
    </>
  );
}

/**
 * Infinite scroll over the pages below the server-rendered first one.
 *
 * The first page stays a server render — it is the freshest data and costs no
 * round trip — and this only accumulates what the agent scrolls past it.
 *
 * The hard part is that the console re-renders itself constantly: `LiveUpdates`
 * calls `router.refresh()` on every inbound message and delivery receipt, which
 * hands this component a brand new `rows` and `nextCursor` several times a
 * minute on a busy queue. Resetting the accumulated pages on either of those
 * would collapse the list back to thirty rows under an agent mid-scroll. So
 * what resets is keyed on the *filters* instead, and the accumulated pages are
 * tagged with the filter signature they were fetched under: a signature that no
 * longer matches is discarded without an effect, a state update or a flash of
 * the wrong rows.
 *
 * For the same reason the fetch cursor is only seeded from `nextCursor` while
 * nothing has been loaded yet. After that the cursor comes from the last
 * response, so a refresh reshuffling the top of the queue cannot rewind the
 * scroll position to the end of page one.
 */
function useOlderPages({
  firstPage,
  nextCursor,
  filters,
  params,
}: {
  firstPage: InboxRow[];
  nextCursor: string | null;
  filters: InboxFilters;
  params: URLSearchParams;
}) {
  const signature = `${filters.view}|${filters.statusCategory}|${filters.channel}|${filters.q}`;

  const [loaded, setLoaded] = useState<{
    signature: string;
    rows: InboxRow[];
    /** `undefined` until a page has been fetched; `null` once the end is known. */
    cursor: string | null | undefined;
  }>({ signature, rows: [], cursor: undefined });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = loaded.signature === signature ? loaded : null;
  const rows = current?.rows ?? [];
  const cursor = current?.cursor === undefined ? nextCursor : current.cursor;

  // Read at fetch time rather than closed over, so a response that arrives
  // after the agent changed a filter can be recognised as stale and dropped.
  const signatureRef = useRef(signature);
  useEffect(() => {
    signatureRef.current = signature;
  });

  // One request at a time. A single scroll can fire the observer repeatedly
  // before the first response lands, and each duplicate would append the same
  // page again.
  const inFlight = useRef(false);

  const search = params.toString();

  const loadMore = useCallback(async () => {
    if (!cursor || inFlight.current) return;

    inFlight.current = true;
    setLoading(true);
    setError(null);

    const requested = signatureRef.current;

    try {
      // Built from the live query string rather than from `filters`, so the
      // request carries exactly what the page was rendered with and a filter
      // added later needs no change here.
      const query = new URLSearchParams(search);
      query.set('cursor', cursor);

      const response = await fetch(`/api/inbox?${query.toString()}`);
      if (!response.ok) throw new Error(`inbox page request failed (${response.status})`);

      const body = (await response.json()) as { rows: SerialisedRow[]; nextCursor: string | null };

      if (signatureRef.current !== requested) return;

      setLoaded((previous) => {
        const base = previous.signature === requested ? previous.rows : [];
        // Guard against a row arriving twice — it can have moved between pages
        // while the agent was reading — so React never sees a duplicate key.
        const known = new Set(base.map((row) => row.id));
        const added = body.rows.filter((row) => !known.has(row.id)).map(reviveRow);

        return { signature: requested, rows: [...base, ...added], cursor: body.nextCursor };
      });
    } catch {
      if (signatureRef.current === requested) {
        setError('Could not load older tickets.');
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [cursor, search]);

  // Held in a ref so the observer below is not rebuilt on every live refresh —
  // the same reasoning as `SearchBox`, and the same failure if it were not:
  // an observer torn down and recreated mid-scroll can miss its intersection.
  const latest = useRef(loadMore);
  useEffect(() => {
    latest.current = loadMore;
  });

  const sentinelRef = useRef<HTMLLIElement>(null);
  const scrollRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !cursor) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      // Fires before the sentinel is actually on screen, so the next page is
      // usually already there by the time the agent scrolls to it.
      { root, rootMargin: '400px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
    // Re-observing when the cursor advances is what continues the sequence: the
    // fresh observer immediately re-checks a sentinel that is still in view.
  }, [cursor]);

  return {
    rows,
    // The first page not filling a page-size means there is nothing below it,
    // whatever the cursor says.
    canLoadMore: Boolean(cursor) && (firstPage.length > 0 || rows.length > 0),
    loading,
    error,
    loadMore,
    sentinelRef,
    scrollRef,
  };
}

/** `InboxRow` as it survives JSON: the two timestamps arrive as strings. */
type SerialisedRow = Omit<InboxRow, 'lastMessageAt' | 'lastCustomerMessageAt'> & {
  lastMessageAt: string;
  lastCustomerMessageAt: string | null;
};

function reviveRow(row: SerialisedRow): InboxRow {
  return {
    ...row,
    lastMessageAt: new Date(row.lastMessageAt),
    lastCustomerMessageAt: row.lastCustomerMessageAt ? new Date(row.lastCustomerMessageAt) : null,
  };
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
