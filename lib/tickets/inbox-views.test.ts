import { describe, expect, it } from 'vitest';
import { FILTERABLE_CHANNELS } from './channel-policy';
import { parseFilters } from './inbox-filters';
import { activeViewId, inboxViews, viewHref } from './inbox-views';

const everything = { canSeeBot: true, canViewAll: true, canSeeRatings: true };

function parsed(href: string) {
  const query = href.split('?')[1] ?? '';
  return parseFilters(Object.fromEntries(new URLSearchParams(query)));
}

describe('inboxViews', () => {
  it('links every view to filters the parser reads back exactly', () => {
    for (const section of inboxViews(everything)) {
      for (const item of section.items) {
        const filters = parsed(viewHref('/inbox', item.filters, ''));
        expect({
          view: filters.view,
          statusCategory: filters.statusCategory,
          channel: filters.channel,
          rating: filters.rating,
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
    });
  });
});

describe('viewHref', () => {
  it('leaves the defaults out, so All open is the bare inbox', () => {
    expect(viewHref('/inbox', parseFilters({}), '')).toBe('/inbox');
    expect(
      viewHref(
        '/inbox/812',
        { view: 'mine', statusCategory: 'unresolved', channel: 'all', rating: 'any' },
        '',
      ),
    ).toBe('/inbox/812?view=mine');
  });

  it('carries the search across a change of view', () => {
    const href = viewHref(
      '/inbox',
      { view: 'all', statusCategory: 'pending', channel: 'all', rating: 'any' },
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
});
