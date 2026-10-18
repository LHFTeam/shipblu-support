import { FILTERABLE_CHANNELS, isRestrictedChannel, type FilterableChannel } from './channel-policy';
import { LOW_RATINGS_RANGE } from '@/lib/csat/limits';
import type { InboxFilters } from './inbox-filters';

/**
 * The inbox's views — Mine, Unassigned, All open, one per channel, Pending,
 * Resolved and Rated 1–2 — as presets over the filters the URL already
 * carries.
 *
 * A view sets every axis at once rather than toggling one, so choosing one
 * always lands on the same list whatever was selected before it, and the link
 * it draws is a bookmarkable URL any agent can open. That also means a view can
 * only ever name what `parseFilters` accepts: there is no view without a filter
 * behind it, and visibility stays inside `listInbox`, so a view's link cannot
 * widen what an agent sees.
 *
 * The search is not a view's business. It is carried across a change of view,
 * as the Status and Channel selects carry it, and ignored when deciding which
 * view the current list is.
 *
 * Client-safe, like `inbox-lines` beside it: the console list builds its view
 * picker from this, and nothing here reaches `db/schema`. Channel labels are
 * left to `channelInfo()`, so a view and a badge cannot name a channel twice.
 */

type ViewFilters = Pick<InboxFilters, 'view' | 'statusCategory' | 'channel' | 'rating'>;

export type ViewIcon = 'user' | 'inbox' | 'list' | 'clock' | 'check' | 'thumbs-down';

export type InboxView = {
  id: string;
  /** Null for a channel, which `channelInfo()` names. */
  label: string | null;
  icon?: ViewIcon;
  channel?: FilterableChannel;
  filters: ViewFilters;
  /**
   * Which of `inboxCounts()`' numbers belongs beside it. Only these three have
   * one: the counts are open and pending tickets over every unrestricted
   * channel, which is exactly these views' list and nobody else's.
   */
  count?: 'mine' | 'unassigned' | 'all';
  /** Drawn as the coral count: an unassigned ticket is waiting on somebody to take it. */
  attention?: boolean;
};

export type InboxViewSection = { title: string | null; items: InboxView[] };

const OPEN_WORK: ViewFilters = {
  view: 'all',
  statusCategory: 'unresolved',
  channel: 'all',
  rating: 'any',
};

export function inboxViews({
  canSeeBot,
  canViewAll,
  canSeeRatings,
}: {
  canSeeBot: boolean;
  canViewAll: boolean;
  /** `report.view`, which `listInbox` requires of the rated view too. */
  canSeeRatings: boolean;
}): InboxViewSection[] {
  const mine: InboxView = {
    id: 'mine',
    label: 'Mine',
    icon: 'user',
    filters: { ...OPEN_WORK, view: 'mine' },
    count: 'mine',
  };

  return [
    {
      title: null,
      // An agent who sees only their own tickets has an Unassigned that is
      // always empty and an All that is their own list again — `listInbox`
      // forces the assignee for them — so they are offered neither.
      items: canViewAll
        ? [
            mine,
            {
              id: 'unassigned',
              label: 'Unassigned',
              icon: 'inbox',
              filters: { ...OPEN_WORK, view: 'unassigned' },
              count: 'unassigned',
              attention: true,
            },
            { id: 'all', label: 'All open', icon: 'list', filters: OPEN_WORK, count: 'all' },
          ]
        : [mine],
    },
    {
      title: 'Channels',
      // The same list the Channel select is built from, so a view cannot exist
      // that the parser ignores, and the bot only where that select offers it.
      items: FILTERABLE_CHANNELS.filter(
        (channel) => canSeeBot || !isRestrictedChannel(channel),
      ).map((channel) => ({
        id: `ch-${channel}`,
        label: null,
        channel,
        filters: { ...OPEN_WORK, channel },
      })),
    },
    {
      title: 'Status',
      items: [
        {
          id: 'pending',
          label: 'Pending',
          icon: 'clock',
          filters: { ...OPEN_WORK, statusCategory: 'pending' },
        },
        {
          id: 'resolved',
          label: 'Resolved',
          icon: 'check',
          filters: { ...OPEN_WORK, statusCategory: 'resolved' },
        },
      ],
    },
    ...(canSeeRatings
      ? [
          {
            title: 'Satisfaction',
            items: [
              {
                // Any status: a rating outlives the resolve it was asked
                // about, and the ticket may since have been closed, reopened
                // or set pending. A link to it returns nothing for anybody
                // without `report.view`, whom it is not offered.
                id: 'rated-low',
                label: `Rated ${LOW_RATINGS_RANGE}`,
                icon: 'thumbs-down' as const,
                filters: { ...OPEN_WORK, statusCategory: 'all' as const, rating: 'low' as const },
              },
            ],
          },
        ]
      : []),
  ];
}

/**
 * A view's link: `base` with the view's filters and the current search, and a
 * default left out, so "All open" is the bare inbox. Nothing else survives —
 * not a cursor, a page or an error the old URL carried.
 */
export function viewHref(base: string, filters: ViewFilters, q: string): string {
  const params = new URLSearchParams();
  if (filters.view !== OPEN_WORK.view) params.set('view', filters.view);
  if (filters.statusCategory !== OPEN_WORK.statusCategory) {
    params.set('status', filters.statusCategory);
  }
  if (filters.channel !== OPEN_WORK.channel) params.set('channel', filters.channel);
  if (filters.rating !== OPEN_WORK.rating) params.set('rating', filters.rating);
  if (q) params.set('q', q);

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * The view the current list is, or null when the filters name a combination no
 * view does — Mine on Email, say, which only the selects can reach.
 *
 * For an agent who sees only their own tickets, "all" and "mine" are the same
 * list, so they are compared as one: their bare inbox is Mine, and a channel
 * view stays recognisable from either spelling.
 */
export function activeViewId(
  sections: InboxViewSection[],
  filters: InboxFilters,
  { canViewAll }: { canViewAll: boolean },
): string | null {
  const scope = (view: InboxFilters['view']) => (!canViewAll && view === 'all' ? 'mine' : view);

  for (const section of sections) {
    for (const item of section.items) {
      if (
        scope(item.filters.view) === scope(filters.view) &&
        item.filters.statusCategory === filters.statusCategory &&
        item.filters.channel === filters.channel &&
        item.filters.rating === filters.rating
      ) {
        return item.id;
      }
    }
  }
  return null;
}
