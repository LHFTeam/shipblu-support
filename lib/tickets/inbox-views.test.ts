import { describe, expect, it } from 'vitest';
import { FILTERABLE_CHANNELS } from './channel-policy';
import { parseFilters } from './inbox-filters';
import { activeViewId, inboxViews, viewHref } from './inbox-views';

const everything = { canSeeBot: true, canViewAll: true, canSeeRatings: true };

const CUSTOMER_CARE = '0861a48b-8bd8-4ea0-b288-54460a63deee';
const MERCHANT_CARE = 'b080b5d9-4237-45f3-a514-a6a8bc88e604';
const GROUPS = [
  { id: CUSTOMER_CARE, name: 'Customer Care', member: true },
  { id: MERCHANT_CARE, name: 'Merchant Care', member: false },
];

function parsed(href: string) {
  const query = href.split('?')[1] ?? '';
  return parseFilters(Object.fromEntries(new URLSearchParams(query)));
}

describe('inboxViews', () => {
  it('links every view to filters the parser reads back exactly', () => {
    for (const section of inboxViews({ ...everything, groups: GROUPS })) {
      for (const item of section.items) {
        const filters = parsed(viewHref('/inbox', item.filters, ''));
        expect({
          view: filters.view,
          statusCategory: filters.statusCategory,
          channel: filters.channel,
          rating: filters.rating,
          group: filters.group,
        }).toEqual(item.filters);
      }
    }
  });

  it('offers only channels the filter accepts, and the bot only to who may see it', () => {
    const channels = (canSeeBot: boolean) =>
      inboxViews({ canSeeBot, canViewAll: true, canSeeRatings: true })
        .flatMap((section) => section.items)
        .flatMap((item) => (item.channel ? [item.channel] : []));

    for (const channel of channels(true)) expect(FILTERABLE_CHANNELS).toContain(channel);
    expect(channels(true)).toContain('whatsapp_bot');
    expect(channels(false)).not.toContain('whatsapp_bot');
  });

  it('gives an agent who sees only their own tickets neither Unassigned nor All', () => {
    const ids = inboxViews({
      canSeeBot: false,
      canViewAll: false,
      canSeeRatings: false,
    })[0]!.items.map((item) => item.id);
    expect(ids).toEqual(['mine']);
  });

  it('offers Rated 1–2 only to who may see the ratings, over every status', () => {
    const ids = (canSeeRatings: boolean) =>
      inboxViews({ canSeeBot: false, canViewAll: true, canSeeRatings })
        .flatMap((section) => section.items)
        .map((item) => item.id);
    expect(ids(true)).toContain('rated-low');
    expect(ids(false)).not.toContain('rated-low');
    const rated = inboxViews(everything)
      .flatMap((section) => section.items)
      .find((item) => item.id === 'rated-low');
    expect(rated?.filters).toEqual({
      view: 'all',
      statusCategory: 'all',
      channel: 'all',
      rating: 'low',
      group: null,
    });
  });

  // `ticket.view.group` is what makes a group a queue: a ticket routed into a
  // group and not yet assigned is in nobody's Mine, so without Unassigned and
  // My groups an agent in that group had no list that showed it.
  it('gives an agent who sees their groups Unassigned, All and My groups', () => {
    const ids = inboxViews({
      canSeeBot: false,
      canViewAll: false,
      canViewGroups: true,
      groups: [{ id: CUSTOMER_CARE, name: 'Customer Care', member: true }],
      canSeeRatings: false,
    })[0]!.items.map((item) => item.id);
    expect(ids).toEqual(['mine', 'unassigned', 'all', 'groups']);
  });

  // The agent role holds `ticket.view.group` whether or not anybody has put
  // the agent in a group, and for one in none it widens nothing.
  it('gives an agent who may see their groups, and is in none, only Mine', () => {
    const ids = inboxViews({
      canSeeBot: false,
      canViewAll: false,
      canViewGroups: true,
      groups: [],
      canSeeRatings: false,
    })[0]!.items.map((item) => item.id);
    expect(ids).toEqual(['mine']);
  });

  it('offers My groups only to a member of one, and a view per group only where there are several', () => {
    const items = (groups: typeof GROUPS) =>
      inboxViews({ ...everything, groups }).flatMap((section) => section.items);

    expect(items([]).map((item) => item.id)).not.toContain('groups');
    expect(items([{ ...GROUPS[1]!, member: false }]).map((item) => item.id)).not.toContain(
      'groups',
    );

    const several = items(GROUPS);
    expect(several.map((item) => item.id)).toEqual(
      expect.arrayContaining(['groups', `group-${CUSTOMER_CARE}`, `group-${MERCHANT_CARE}`]),
    );
    expect(several.find((item) => item.id === `group-${MERCHANT_CARE}`)?.filters.group).toBe(
      MERCHANT_CARE,
    );
    expect(items([GROUPS[0]!]).map((item) => item.id)).not.toContain(`group-${CUSTOMER_CARE}`);
  });

  // "My groups" lists only the agent's own, so a supervisor who belongs to
  // none would otherwise have no way to the only group's queue.
  it('offers a supervisor the only group when they are not in it', () => {
    const ids = inboxViews({ ...everything, groups: [GROUPS[1]!] })
      .flatMap((section) => section.items)
      .map((item) => item.id);
    expect(ids).toContain(`group-${MERCHANT_CARE}`);
    expect(ids).not.toContain('groups');
  });
});

describe('viewHref', () => {
  it('leaves the defaults out, so All open is the bare inbox', () => {
    expect(viewHref('/inbox', parseFilters({}), '')).toBe('/inbox');
    expect(
      viewHref(
        '/inbox/812',
        { view: 'mine', statusCategory: 'unresolved', channel: 'all', rating: 'any', group: null },
        '',
      ),
    ).toBe('/inbox/812?view=mine');
  });

  it('carries the search across a change of view', () => {
    const href = viewHref(
      '/inbox',
      { view: 'all', statusCategory: 'pending', channel: 'all', rating: 'any', group: null },
      'أحمد',
    );
    expect(parsed(href)).toMatchObject({ statusCategory: 'pending', q: 'أحمد' });
  });
});

describe('activeViewId', () => {
  const sections = inboxViews(everything);

  it('reads the bare inbox, and the admin dashboard’s explicit link to it, as All open', () => {
    expect(activeViewId(sections, parseFilters({}), everything)).toBe('all');
    expect(activeViewId(sections, parseFilters({ status: 'unresolved' }), everything)).toBe('all');
  });

  it('ignores the search', () => {
    expect(
      activeViewId(sections, parseFilters({ channel: 'email', q: 'refund' }), everything),
    ).toBe('ch-email');
  });

  it('names no view for a combination only the selects reach', () => {
    expect(
      activeViewId(sections, parseFilters({ view: 'mine', channel: 'email' }), everything),
    ).toBe(null);
    expect(activeViewId(sections, parseFilters({ status: 'closed' }), everything)).toBe(null);
  });

  it('tells Rated 1–2 from the plain any-status list, and from a narrower one', () => {
    expect(activeViewId(sections, parseFilters({ status: 'all', rating: 'low' }), everything)).toBe(
      'rated-low',
    );
    expect(activeViewId(sections, parseFilters({ status: 'all' }), everything)).toBe(null);
    expect(
      activeViewId(
        sections,
        parseFilters({ status: 'all', rating: 'low', channel: 'email' }),
        everything,
      ),
    ).toBe(null);
  });

  it('reads All as Mine for an agent who sees only their own tickets', () => {
    const own = { canViewAll: false };
    const theirs = inboxViews({ canSeeBot: false, canSeeRatings: false, ...own });
    expect(activeViewId(theirs, parseFilters({}), own)).toBe('mine');
    expect(activeViewId(theirs, parseFilters({ view: 'mine' }), own)).toBe('mine');
    expect(activeViewId(theirs, parseFilters({ view: 'mine', channel: 'email' }), own)).toBe(
      'ch-email',
    );
    expect(activeViewId(theirs, parseFilters({ view: 'unassigned' }), own)).toBe(null);
  });

  it('keeps All and Mine apart for an agent who sees their groups', () => {
    const team = {
      canViewAll: false,
      canViewGroups: true,
      groups: [{ id: CUSTOMER_CARE, name: 'Customer Care', member: true }],
    };
    const theirs = inboxViews({ canSeeBot: false, canSeeRatings: false, ...team });
    expect(activeViewId(theirs, parseFilters({}), team)).toBe('all');
    expect(activeViewId(theirs, parseFilters({ view: 'mine' }), team)).toBe('mine');
    expect(activeViewId(theirs, parseFilters({ view: 'groups' }), team)).toBe('groups');
  });

  // Given the bare permission, as every caller holds it: the function, not the
  // caller, decides that a member of no group sees only their own.
  it('reads All as Mine for an agent who may see their groups and is in none', () => {
    const own = { canViewAll: false, canViewGroups: true, groups: [] };
    const theirs = inboxViews({ canSeeBot: false, canSeeRatings: false, ...own });
    expect(activeViewId(theirs, parseFilters({}), own)).toBe('mine');
    expect(activeViewId(theirs, parseFilters({ view: 'mine', channel: 'email' }), own)).toBe(
      'ch-email',
    );
  });

  it('tells one group’s view from the unfiltered list', () => {
    const sections = inboxViews({ ...everything, groups: GROUPS });
    expect(activeViewId(sections, parseFilters({ group: MERCHANT_CARE }), everything)).toBe(
      `group-${MERCHANT_CARE}`,
    );
    expect(activeViewId(sections, parseFilters({}), everything)).toBe('all');
  });
});
