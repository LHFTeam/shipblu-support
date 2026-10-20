'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type UIEvent } from 'react';
import { AgentAvatar, Avatar } from '@/components/avatar';
import { ChannelBadge, channelInfo } from '@/components/channel';
import { ConversationRow } from '@/components/conversation-row';
import { BookIcon, ReplyIcon } from '@/components/icons';
import { RelativeTime } from '@/components/relative-time';
import { SearchInput } from '@/components/search-input';
import { useNow } from '@/components/use-now';
import { Badge, Button, buttonClass, EmptyState, ErrorText, Select } from '@/components/ui';
import type { ViewsPanelSection } from '@/components/views-panel';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import type { InboxRow } from '@/lib/tickets/inbox';
import type { InboxFilters } from '@/lib/tickets/inbox-filters';
import { LOW_RATINGS_IN_WORDS, RATED_LOW_DAYS } from '@/lib/csat/limits';
import { FILTERABLE_CHANNELS, isRestrictedChannel } from '@/lib/tickets/channel-policy';
import { rowBadges } from '@/lib/tickets/inbox-badges';
import { messageLines } from '@/lib/tickets/inbox-lines';
import {
  inboxSignature,
  readInboxPosition,
  rememberInboxPages,
  rememberInboxScroll,
} from '@/lib/tickets/inbox-position';

/**
 * The ticket list.
 *
 * Avatar-first by default: who, then the last thing said — or the subject, on
 * the channels where somebody wrote one — then the row of things an agent
 * triages by. `layout="ticket"` is the older three-line row, subject over
 * message, kept for a queue where the subject leads.
 *
 * Its header carries the view: a title from 1366px, where the views have a
 * column of their own beside it, and a picker of the same views below that.
 */
export function InboxList({
  rows,
  nextCursor,
  filters,
  activeNumber,
  views,
  activeView,
  layout = 'avatar',
  canSeeBot = false,
  canSeeRatings = false,
  canViewAll = false,
  canViewGroups = false,
  canCreate = false,
  canViewContacts = false,
}: {
  rows: InboxRow[];
  nextCursor: string | null;
  filters: InboxFilters;
  activeNumber?: number;
  views: ViewsPanelSection[];
  activeView: string | null;
  layout?: 'avatar' | 'ticket';
  canSeeBot?: boolean;
  /** `report.view`: without it `listInbox` answers the rated view with nothing. */
  canSeeRatings?: boolean;
  /** `ticket.view.all`: without it every list is the agent's own tickets. */
  canViewAll?: boolean;
  /** `ticket.view.group`: their groups' tickets as well as their own. */
  canViewGroups?: boolean;
  canCreate?: boolean;
  /** The avatar route answers 404 without `contact.view`, so the tile is not asked for one. */
  canViewContacts?: boolean;
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
    listRef,
    onScroll,
  } = useOlderPages({ firstPage: rows, nextCursor, filters, params });

  function setParams(changes: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Strips the page number a bookmark or a still-open tab may carry from when
    // this list was paged. It no longer means anything, and leaving it in the
    // URL suggests it does.
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
  }

  function setParam(key: string, value: string) {
    setParams({ [key]: value });
  }

  // The server's first page is always the freshest view of the top of the
  // queue, so it wins: anything the scroll had already loaded that has since
  // moved up there is dropped from below rather than rendered twice.
  const seen = new Set(rows.map((row) => row.id));
  const visible = [...rows, ...olderRows.filter((row) => !seen.has(row.id))];

  const current = views.flatMap((section) => section.items).find((item) => item.id === activeView);
  // The view's count is the number of open and pending tickets in it, which is
  // this list's length only while nothing narrows it further.
  const count = filters.q ? undefined : current?.count;

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-(--color-border-subtle) px-3 py-2.5 md:px-4 md:pt-3.5 md:pb-3">
        <KnowledgeBaseLink className="min-[1366px]:hidden" />

        <div className="flex min-h-8 items-center gap-2">
          <h2 className="hidden min-w-0 truncate text-base leading-6 font-semibold min-[1366px]:block">
            {current?.label ?? 'Custom filter'}
          </h2>
          {/*
            The views column's choices, for the widths that have no room for the
            column. Each option navigates to the view's own link, so the picker
            and the column cannot set different filters. A list the Status and
            Channel selects narrowed to something no view names reads as
            "Custom filter" rather than as the nearest view, which it is not.
          */}
          <Select
            aria-label="View"
            className="w-auto! min-w-0 min-[1366px]:hidden"
            value={activeView ?? ''}
            onChange={(e) => {
              const view = views
                .flatMap((section) => section.items)
                .find((item) => item.id === e.target.value);
              if (view) router.push(view.href);
            }}
          >
            {activeView === null ? (
              <option value="" disabled>
                Custom filter
              </option>
            ) : null}
            {views.map((section) =>
              section.title ? (
                <optgroup key={section.title} label={section.title}>
                  {section.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              ) : (
                section.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              ),
            )}
          </Select>
          {count !== undefined ? (
            <span className="text-xs text-(--color-text-secondary) tabular-nums">
              {count}
              <span className="sr-only"> open</span>
            </span>
          ) : null}

          {/* In the header rather than floating over the list: this column is
              scrolled constantly, and a button that moves with it is a button
              that lands under a thumb mid-scroll. */}
          {canCreate ? (
            <Link
              href="/inbox/new"
              className={`ms-auto shrink-0 ${buttonClass({ variant: 'primary', size: 'sm' })}`}
            >
              New
            </Link>
          ) : null}
        </div>

        <SearchBox initial={filters.q} onSearch={(value) => setParam('q', value)} />

        {/*
          Beside the views rather than replaced by them: these say what no view
          does — Open alone, Closed, any status — and combine with each other.
        */}
        <div className="flex gap-2">
          {/* Status sizes itself to its longest option so "Open + pending"
              never clips in the 320px column; channel takes what is left. The
              `!` beats the field's own `w-full`, which sorts after `w-auto`. */}
          <Select
            value={filters.statusCategory}
            onChange={(e) => setParam('status', e.target.value)}
            aria-label="Status"
            className="w-auto! shrink-0"
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
            className="min-w-0 flex-1"
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

        {/*
          The rated view narrows by an axis no select shows, and the selects
          carry it, as they carry the view: change Status or Channel inside it
          and the header reads "Custom filter" over a list still cut to low
          ratings. So whatever the header says, this line says why the list is
          short, and how to stop it — including to somebody handed the link
          who may not see ratings, for whom the list is empty for that reason
          and not because nobody rated low.
        */}
        {filters.rating === 'low' ? (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-(--color-text-secondary)">
            {canSeeRatings
              ? `Only tickets a customer rated ${LOW_RATINGS_IN_WORDS} in the last ${RATED_LOW_DAYS} days.`
              : 'Low ratings are listed only for people who can see the satisfaction report.'}
            <Button
              variant="ghost"
              size="sm"
              // Every status was the view's choice, not the agent's: kept, the
              // button would land on a "Custom filter" of every ticket on any
              // status. Cleared, it lands on All open — or on a channel or a
              // status the agent narrowed to inside the view, which stays.
              onClick={() =>
                setParams({
                  rating: '',
                  ...(filters.statusCategory === 'all' ? { status: '' } : {}),
                })
              }
            >
              Stop filtering by rating
            </Button>
          </p>
        ) : null}
      </div>

      <ol
        ref={listRef}
        onScroll={onScroll}
        className="app-scroll min-h-0 flex-1 overflow-y-auto md:py-1.5"
        aria-busy={loading}
      >
        {visible.length === 0 ? (
          <li>
            <EmptyState
              title={
                activeView === 'rated-low' && !filters.q
                  ? // Said of what the list can reach: an agent who sees only
                    // their own tickets hears about theirs, not the team's.
                    `${canViewAll ? 'No ticket' : canViewGroups ? 'None of your or your groups’ tickets' : 'None of your tickets'} was rated ${LOW_RATINGS_IN_WORDS} in the last ${RATED_LOW_DAYS} days.`
                  : 'Nothing matches those filters.'
              }
            />
          </li>
        ) : null}

        {visible.map((row) => {
          const { headline, secondary } = messageLines(row);

          return (
            <li key={row.id}>
              <ConversationRow
                layout={layout}
                href={`/inbox/${row.number}?${params.toString()}`}
                active={row.number === activeNumber}
                name={row.requesterName ?? row.requesterHandle ?? 'Unknown'}
                time={<RelativeTime at={row.lastMessageAt} />}
                preview={headline}
                secondary={secondary}
                avatar={
                  <Avatar
                    name={row.requesterName}
                    contactId={row.requesterContactId}
                    hasAvatar={canViewContacts && row.requesterHasAvatar}
                    size={40}
                  />
                }
                channel={row.channel}
                meta={
                  <>
                    {layout === 'ticket' ? (
                      <ChannelBadge channel={row.channel} showLabel={false} />
                    ) : null}
                    <RowBadges row={row} layout={layout} />
                  </>
                }
                trailing={<RowOwner row={row} />}
              />
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
          <li ref={sentinelRef} className="p-3 text-center text-xs text-(--color-text-tertiary)">
            {error ? (
              <span className="flex flex-col items-center gap-1.5">
                {/* Scrolling already failed once here, so the retry is a button:
                    another scroll gesture would land on the same spot and look
                    like nothing happened. */}
                <ErrorText inline>{error}</ErrorText>
                <Button variant="secondary" size="sm" onClick={loadMore}>
                  Try again
                </Button>
              </span>
            ) : (
              <span aria-live="polite">Loading older tickets…</span>
            )}
          </li>
        ) : olderRows.length > 0 ? (
          // Only worth saying once the agent has actually been scrolling. Under
          // a first page that never filled, it would state the obvious.
          <li className="p-3 text-center text-xs text-(--color-text-tertiary)">End of the list</li>
        ) : null}
      </ol>
    </>
  );
}

/**
 * The public help centre's front door, named, on the screen an agent spends the
 * day on: in the views column from 1366px, and on a line of its own at the top
 * of the list below that.
 *
 * The public site rather than the console's `/kb`, which the rail still links
 * to: from the queue, the article an agent looks up is usually one to send, and
 * the help centre is the only copy of it a customer can open — a console link
 * is a sign-in page to them.
 *
 * A path on whichever host served this page rather than `publicBaseUrl()`, for
 * the reason `requestBaseUrl` gives: the published hostname is a 404 until the
 * domain serves this app, and `proxy.ts` rewrites a locale prefix into the help
 * centre on every host. A new tab, because leaving the console is a full
 * navigation and the place this list keeps (`lib/tickets/inbox-position`) lives
 * in memory, so the agent would come back to the top of the queue.
 *
 * Behind no permission: a link to a page any stranger can open is not a
 * capability, and gating it on `kb.view` hid nothing.
 *
 * Its own line in the list rather than a third control in either row below it,
 * because both of those are measured against the column's width: the view
 * picker shares its row with a count and New, and the filters are native
 * selects, which clip their longest option rather than wrap. One line of a
 * column that scrolls anyway is the cheaper side of that trade.
 */
export function KnowledgeBaseLink({ className = '' }: { className?: string }) {
  return (
    <a
      href={`/${DEFAULT_LOCALE}`}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-xs font-medium text-(--color-text-link) hover:bg-(--color-background-hover) ${className}`}
    >
      <BookIcon size={15} />
      Knowledge base
    </a>
  );
}

/**
 * The row's number and badges. Its own component so the clock it reads — the
 * shared half-minute one the ticket header counts down on, so a row and the
 * open ticket cannot disagree — re-renders the badges and not the row.
 *
 * The number leads the avatar row's line and follows the status in the ticket
 * row, where it always sat.
 */
function RowBadges({ row, layout }: { row: InboxRow; layout: 'avatar' | 'ticket' }) {
  const now = useNow();
  const badges = rowBadges(row, now, layout).map((badge) => (
    <Badge key={badge.key} tone={badge.tone}>
      {badge.label}
    </Badge>
  ));
  const number = (
    <span key="number" className="text-xs text-(--color-text-secondary) tabular-nums">
      #{row.number}
    </span>
  );

  return layout === 'ticket' ? [badges[0], number, ...badges.slice(1)] : [number, ...badges];
}

/** Whose move it is, and whose ticket. */
function RowOwner({ row }: { row: InboxRow }) {
  return (
    <>
      {/* Ours was the last word, so the next move is the customer's. */}
      {row.lastFromUs ? (
        <span>
          <ReplyIcon size={15} />
          <span className="sr-only">Last message from ShipBlu</span>
        </span>
      ) : null}

      {/* The assignee as a tile rather than a name. The name still goes to
          assistive technology as text, but to nobody on hover: `title=` never
          shows on a phone, and a Tooltip is a button, which cannot sit inside
          the row's link. The ticket's header names the assignee in full. */}
      {row.assigneeId ? (
        <>
          <AgentAvatar
            name={row.assigneeName}
            color={row.assigneeColor}
            avatarUrl={row.assigneeAvatarUrl}
            size={20}
          />
          <span className="sr-only">Assigned to {row.assigneeName}</span>
        </>
      ) : (
        <span>Unassigned</span>
      )}
    </>
  );
}

/**
 * Infinite scroll over the pages below the server-rendered first one.
 *
 * The first page stays a server render — it is the freshest data and costs no
 * round trip — and this only accumulates what the agent scrolls past it.
 *
 * The hard part is that live queue changes hand this component a brand new
 * `rows` and `nextCursor` while an agent may be deep into older pages. Resetting
 * the accumulated pages on either of those would collapse the list back to
 * thirty rows under an agent mid-scroll. So what resets is keyed on the
 * *filters* instead, and the accumulated pages are tagged with the filter
 * signature they were fetched under: a signature that no longer matches is
 * discarded without an effect, a state update or a flash of the wrong rows.
 *
 * For the same reason the fetch cursor is only seeded from `nextCursor` while
 * nothing has been loaded yet. After that the cursor comes from the last
 * response, so a refresh reshuffling the top of the queue cannot rewind the
 * scroll position to the end of page one.
 *
 * What a refresh cannot do, a navigation does: opening a conversation replaces
 * this whole subtree, because `/inbox` and `/inbox/[number]` are sibling
 * segments rather than a layout and its child. So the pages and the offset are
 * also mirrored into `lib/tickets/inbox-position`, which outlives the mount, and
 * seeded back from it below — otherwise every trip into a conversation and back
 * ended at the top of page one.
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
  const signature = inboxSignature(filters);

  const [loaded, setLoaded] = useState<{
    signature: string;
    rows: InboxRow[];
    /** `undefined` until a page has been fetched; `null` once the end is known. */
    cursor: string | null | undefined;
  }>(() => {
    // Seeded in the first render rather than from an effect, so the rows the
    // agent had scrolled into view are already in the DOM when the offset is put
    // back below. Restoring 4000px into a thirty-row list only clamps to its
    // bottom.
    const saved = readInboxPosition(signature);
    return saved
      ? { signature, rows: saved.rows, cursor: saved.cursor }
      : { signature, rows: [], cursor: undefined };
  });

  // Kept up to date as the pages accumulate rather than written on the way out:
  // a ref read in an unmount cleanup races React detaching it, and by then the
  // node can already be out of the document and reporting an offset of zero.
  useEffect(() => {
    rememberInboxPages(loaded.signature, loaded.rows, loaded.cursor);
  }, [loaded]);

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
  const scrollRef = useRef<HTMLOListElement | null>(null);
  const restored = useRef(false);

  /**
   * Puts the offset back as the list is attached.
   *
   * A ref callback rather than an effect because it runs inside the commit,
   * before the browser paints: an effect would show the list at the top for a
   * frame and then jump. Once per mount, deliberately — React calls a ref again
   * on every reattachment, and a second restore would yank the list out from
   * under an agent who had scrolled since.
   */
  const listRef = useCallback((node: HTMLOListElement | null) => {
    scrollRef.current = node;
    if (!node || restored.current) return;
    restored.current = true;

    const saved = readInboxPosition(signatureRef.current);
    if (saved) node.scrollTop = saved.scrollTop;
  }, []);

  // Cheap enough to do on every scroll event — it is one property assignment,
  // no React state and no re-render — which is what lets the offset survive a
  // navigation the list gets no other warning about.
  const onScroll = useCallback((event: UIEvent<HTMLOListElement>) => {
    rememberInboxScroll(signatureRef.current, event.currentTarget.scrollTop);
  }, []);

  // A filter change is a different list, and the offset of the old one is
  // meaningless in it: the accumulated pages go with the old signature, so the
  // list drops back to thirty rows and the browser clamps a deep offset to the
  // bottom of them. Its own ref rather than `signatureRef`, which is already
  // updated by the effect above by the time this one runs.
  const shown = useRef(signature);
  useEffect(() => {
    if (shown.current === signature) return;
    shown.current = signature;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [signature]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !cursor) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // `void` because `loadMore` cannot reject: a failed page becomes the
        // list's error state.
        if (entries.some((entry) => entry.isIntersecting)) void latest.current();
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
    listRef,
    onScroll,
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
 * What the search box matches, in one place because it is said twice: in the ⓘ
 * a reader opens and as the input's description a screen reader announces. It
 * names what is not searched too, since "anything" is a claim: an agent typing a
 * colleague's name or a tag gets an empty list, which otherwise reads as "no
 * such tickets" rather than "not searchable".
 */
const SEARCH_HINT =
  "Matches a ticket's number (#812) and subject, the requester's name, email or phone, and any words in a message or side conversation. Arabic spellings of the same letter match each other, so احمد finds أحمد. A pasted tracking number or SBID finds that shipment's tickets; start with track: or sbid: to search only those. A ticket number finds its ticket whatever the Status filter says; everything else follows it, and the Channel filter applies to all of it. Tags, custom fields and the assignee are not searched.";

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
  const hintId = useId();

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
    <div>
      {/* A claim rather than a list. The first list that sat here rendered
          373px and stopped at `sbid:`, and the three-item one after it filled a
          box shared with "New" and still said nothing about tracking numbers,
          which work pasted bare.

          What "anything" stands for — what `listInbox` matches, and the three
          things it does not — is one tap away in the ⓘ at the end of the
          field, and is the input's accessible description. It used to be a
          `title=`, which a phone never shows.

          Enter puts the box away rather than doing nothing, as every search
          box in the console does: the list already follows the typing. */}
      <SearchInput
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search for anything"
        aria-label="Search tickets and chats"
        aria-describedby={hintId}
        explain={SEARCH_HINT}
      />
      {/* The description the `title=` used to give a screen reader. The ⓘ
          cannot stand in for it: its tip describes the ⓘ, and only while
          open. */}
      <span id={hintId} className="sr-only">
        {SEARCH_HINT}
      </span>
    </div>
  );
}
