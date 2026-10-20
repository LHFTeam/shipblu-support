import { FILTERABLE_CHANNELS, isRestrictedChannel, type FilterableChannel } from './channel-policy';
import { LOW_RATINGS_RANGE } from '@/lib/csat/limits';
import type { InboxFilters } from './inbox-filters';

/**
 * The inbox's views — Mine, Unassigned, All open, My groups, one per group,
 * one per channel, Pending, Resolved and Rated 1–2 — as presets over the
 * filters the URL already carries.
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

type ViewFilters = Pick<InboxFilters, 'view' | 'statusCategory' | 'channel' | 'rating' | 'group'>;

export type ViewIcon = 'user' | 'users' | 'inbox' | 'list' | 'clock' | 'check' | 'thumbs-down';

export type InboxView = {
  id: string;
  /** Null for a channel, which `channelInfo()` names. */
  label: string | null;
  icon?: ViewIcon;
  channel?: FilterableChannel;
  filters: ViewFilters;
  /**
   * Which of `inboxCounts()`' numbers belongs beside it. Only these four have
   * one: the counts are open and pending tickets over every unrestricted
   * channel, which is exactly these views' list and nobody else's.
   */
  count?: 'mine' | 'unassigned' | 'groups' | 'all';
  /** Drawn as the coral count: an unassigned ticket is waiting on somebody to take it. */
  attention?: boolean;
};

export type InboxViewSection = { title: string | null; items: InboxView[] };

const OPEN_WORK: ViewFilters = {
  view: 'all',
  statusCategory: 'unresolved',
  channel: 'all',
  rating: 'any',
  group: null,
};

export type InboxGroup = { id: string; name: string; member: boolean };

/**
 * Whether `ticket.view.group` widens anything for this agent. The permission is
 * granted to the whole agent role, and an agent in no group holds it as well:
 * for them Unassigned is always empty and All is Mine again, exactly as for an
 * agent without it. So the views, the active view and the list's empty state
 * all ask this rather than the permission, or such an agent is offered two
 * lists that never hold anything and a channel view that never lights up.
 * `inboxViews` and `activeViewId` take the permission and the groups and ask it
 * themselves, so no caller can hand either the bare permission by mistake.
 */
export function seesGroupQueues(canViewGroups: boolean, groups: InboxGroup[]): boolean {
  return canViewGroups && groups.some((group) => group.member);
}

export function inboxViews({
  canSeeBot,
  canViewAll,
  canViewGroups = false,
  groups = [],
  canSeeRatings,
}: {
  canSeeBot: boolean;
  canViewAll: boolean;
  /** `ticket.view.group`: their groups' tickets as well as their own. */
  canViewGroups?: boolean;
  /** `inboxGroupsFor()`: every group for `canViewAll`, the agent's own otherwise. */
  groups?: InboxGroup[];
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

  // An agent who sees only their own tickets has an Unassigned that is always
  // empty and an All that is their own list again — `listInbox` forces the
  // assignee for them — so they are offered neither. One who sees their groups'
  // has both, each inside what they may see: Unassigned is what is waiting in
  // their groups, which is the reason a group is a queue at all.
  const seesTeam = canViewAll || seesGroupQueues(canViewGroups, groups);
  const memberOf = groups.filter((group) => group.member);

  return [
    {
      title: null,
      items: seesTeam
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
            ...(memberOf.length
              ? [
                  {
                    id: 'groups',
                    label: 'My groups',
                    icon: 'users' as const,
                    filters: { ...OPEN_WORK, view: 'groups' as const },
                    count: 'groups' as const,
                  },
                ]
              : []),
          ]
        : [mine],
    },
    // One view per group wherever "My groups" does not already cover them: a
    // supervisor reading each team's queue (members or not — "My groups" is
    // only their own), or an agent in several groups. An agent in one group,
    // and nothing else offered, has it as "My groups".
    ...(seesTeam && (groups.some((group) => !group.member) || memberOf.length > 1)
      ? [
          {
            title: 'Groups',
            items: groups.map((group) => ({
              id: `group-${group.id}`,
              label: group.name,
              icon: 'users' as const,
              filters: { ...OPEN_WORK, group: group.id },
            })),
          },
        ]
      : []),
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
  if (filters.group) params.set('group', filters.group);
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
 * view stays recognisable from either spelling. Not for one who sees their
 * groups' tickets, whose All is wider than Mine.
 */
export function activeViewId(
  sections: InboxViewSection[],
  filters: InboxFilters,
  {
    canViewAll,
    canViewGroups = false,
    groups = [],
  }: { canViewAll: boolean; canViewGroups?: boolean; groups?: InboxGroup[] },
): string | null {
  const seesOnlyOwn = !canViewAll && !seesGroupQueues(canViewGroups, groups);
  const scope = (view: InboxFilters['view']) => (seesOnlyOwn && view === 'all' ? 'mine' : view);

  for (const section of sections) {
    for (const item of section.items) {
      if (
        scope(item.filters.view) === scope(filters.view) &&
        item.filters.statusCategory === filters.statusCategory &&
        item.filters.channel === filters.channel &&
        item.filters.rating === filters.rating &&
        item.filters.group === filters.group
      ) {
        return item.id;
      }
    }
  }
  return null;
}
