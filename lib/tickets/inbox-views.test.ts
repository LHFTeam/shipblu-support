import { describe, expect, it } from 'vitest';
import { FILTERABLE_CHANNELS } from './channel-policy';
import { parseFilters } from './inbox-filters';
import { activeViewId, inboxViews, viewHref } from './inbox-views';

const everything = { canSeeBot: true, canViewAll: true };

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
        }).toEqual(item.filters);
      }
    }
  });

  it('offers only channels the filter accepts, and the bot only to who may see it', () => {
    const channels = (canSeeBot: boolean) =>
      inboxViews({ canSeeBot, canViewAll: true })
        .flatMap((section) => section.items)
        .flatMap((item) => (item.channel ? [item.channel] : []));

    for (const channel of channels(true)) expect(FILTERABLE_CHANNELS).toContain(channel);
    expect(channels(true)).toContain('whatsapp_bot');
    expect(channels(false)).not.toContain('whatsapp_bot');
  });

  it('gives an agent who sees only their own tickets neither Unassigned nor All', () => {
    const ids = inboxViews({ canSeeBot: false, canViewAll: false })[0]!.items.map(
      (item) => item.id,
    );
    expect(ids).toEqual(['mine']);
  });
});

describe('viewHref', () => {
  it('leaves the defaults out, so All open is the bare inbox', () => {
    expect(viewHref('/inbox', parseFilters({}), '')).toBe('/inbox');
    expect(
      viewHref('/inbox/812', { view: 'mine', statusCategory: 'unresolved', channel: 'all' }, ''),
    ).toBe('/inbox/812?view=mine');
  });

  it('carries the search across a change of view', () => {
    const href = viewHref(
      '/inbox',
      { view: 'all', statusCategory: 'pending', channel: 'all' },
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

  it('reads All as Mine for an agent who sees only their own tickets', () => {
    const own = { canViewAll: false };
    const theirs = inboxViews({ canSeeBot: false, ...own });
    expect(activeViewId(theirs, parseFilters({}), own)).toBe('mine');
    expect(activeViewId(theirs, parseFilters({ view: 'mine' }), own)).toBe('mine');
    expect(activeViewId(theirs, parseFilters({ view: 'mine', channel: 'email' }), own)).toBe(
      'ch-email',
    );
    expect(activeViewId(theirs, parseFilters({ view: 'unassigned' }), own)).toBe(null);
  });
});
