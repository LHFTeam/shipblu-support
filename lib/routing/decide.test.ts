import { describe, expect, it } from 'vitest';
import { decide, isWorkable, type DecideInput, type DecidedOutcome } from './decide';

/**
 * The router's precedence, which `apply.ts` writes under the row lock and the
 * routing report counts by (`plans/ticket-category-routing.md`, decision 5).
 *
 * Each outcome is reached from a ticket that would otherwise fall through to
 * `fallback`, and every pair is then crossed: a ticket that answers two of
 * them must answer the earlier, or the report files a resolved ticket nobody
 * may work as routed, and a ticket somebody holds as moved.
 */

const HOME = 'group-home';
const SALES = 'group-sales';
const CATEGORY = 'category-sales';

/** A held ticket in its default group, on a channel routing live, with nothing settled. */
const base: DecideInput = {
  shadow: false,
  assigneeAgentId: null,
  statusCategory: 'open',
  deletedAt: null,
  isSpam: false,
  mergedIntoId: null,
  mode: 'category',
  groupId: HOME,
  categoryId: null,
  routeGroupId: null,
};

/** The least each outcome needs, over `base`, in `decide`'s own order. */
const TRIGGERS: [DecidedOutcome, Partial<DecideInput>][] = [
  ['taken', { assigneeAgentId: 'agent-amr' }],
  ['not_open', { statusCategory: 'resolved' }],
  ['released', { mode: 'default_group' }],
  ['category', { categoryId: CATEGORY, routeGroupId: SALES }],
  ['no_route_for_category', { categoryId: CATEGORY, routeGroupId: null }],
  ['fallback', {}],
];

describe('decide, each outcome', () => {
  it.each(TRIGGERS)('answers %s', (outcome, trigger) => {
    expect(decide({ ...base, ...trigger }).outcome).toBe(outcome);
  });

  it('moves the ticket only on `category`, to the route group', () => {
    expect(decide({ ...base, categoryId: CATEGORY, routeGroupId: SALES })).toEqual({
      outcome: 'category',
      toGroupId: SALES,
    });
  });

  it.each(TRIGGERS.filter(([outcome]) => outcome !== 'category'))(
    'leaves the ticket where it is on %s',
    (outcome, trigger) => {
      expect(decide({ ...base, ...trigger }).toGroupId).toBe(HOME);
    },
  );

  it('routes a ticket that arrived in no group', () => {
    expect(decide({ ...base, groupId: null, categoryId: CATEGORY, routeGroupId: SALES })).toEqual({
      outcome: 'category',
      toGroupId: SALES,
    });
  });

  it('answers no_route_for_category when the route group is where the ticket already is', () => {
    expect(decide({ ...base, categoryId: CATEGORY, routeGroupId: HOME })).toEqual({
      outcome: 'no_route_for_category',
      toGroupId: HOME,
    });
  });

  it('ignores a route group with no category settled', () => {
    // The route group is the category's, read only with one: on its own it is
    // a stale join, not a decision.
    expect(decide({ ...base, routeGroupId: SALES })).toEqual({
      outcome: 'fallback',
      toGroupId: HOME,
    });
  });
});

describe('decide, not_open', () => {
  it.each<[string, Partial<DecideInput>]>([
    ['resolved', { statusCategory: 'resolved' }],
    ['closed', { statusCategory: 'closed' }],
    ['deleted', { deletedAt: new Date('2026-10-21T10:00:00Z') }],
    ['spam', { isSpam: true }],
    ['merged into another ticket', { mergedIntoId: 'ticket-survivor' }],
  ])('a ticket %s is not open', (_label, trigger) => {
    expect(decide({ ...base, ...trigger, categoryId: CATEGORY, routeGroupId: SALES })).toEqual({
      outcome: 'not_open',
      toGroupId: HOME,
    });
  });

  it('routes a pending ticket, which somebody may still work', () => {
    expect(
      decide({ ...base, statusCategory: 'pending', categoryId: CATEGORY, routeGroupId: SALES })
        .outcome,
    ).toBe('category');
  });
});

// The resume path asks this of a ticket whose decision is already written, and
// must answer as `decide` would: a decision completed on a ticket deleted or
// resolved since runs no rules and sends nothing, exactly as a fresh one would
// have been recorded `not_open`.
describe('isWorkable', () => {
  it.each<[string, boolean, Partial<DecideInput>]>([
    ['open', true, {}],
    ['pending', true, { statusCategory: 'pending' }],
    ['resolved', false, { statusCategory: 'resolved' }],
    ['closed', false, { statusCategory: 'closed' }],
    ['deleted', false, { deletedAt: new Date('2026-10-21T10:00:00Z') }],
    ['spam', false, { isSpam: true }],
    ['merged', false, { mergedIntoId: 'ticket-survivor' }],
  ])('a ticket %s is workable: %s', (_label, workable, trigger) => {
    const ticket = { ...base, ...trigger };
    expect(isWorkable(ticket)).toBe(workable);
    expect(decide(ticket).outcome === 'not_open').toBe(!workable);
  });
});

describe('decide, the precedence between each pair', () => {
  // Every earlier outcome against every later one. `category` and
  // `no_route_for_category` read the same two fields, so they never meet.
  const pairs = TRIGGERS.flatMap(([earlier, earlierTrigger], i) =>
    TRIGGERS.slice(i + 1)
      .filter(([later]) => !(earlier === 'category' && later === 'no_route_for_category'))
      .map(
        ([later, laterTrigger]) =>
          [earlier, later, { ...laterTrigger, ...earlierTrigger }] as const,
      ),
  );

  it.each(pairs)('%s comes before %s', (earlier, _later, input) => {
    expect(decide({ ...base, ...input }).outcome).toBe(earlier);
  });

  it('crosses every pair it can', () => {
    // 6 outcomes, 15 pairs, less the one that cannot be built.
    expect(pairs).toHaveLength(14);
  });
});

describe('decide, a live row and the channel', () => {
  it('releases a live ticket whose channel went back to the default group', () => {
    expect(
      decide({ ...base, mode: 'default_group', categoryId: CATEGORY, routeGroupId: SALES }),
    ).toEqual({ outcome: 'released', toGroupId: HOME });
  });

  it('releases a live ticket whose channel went to shadow', () => {
    // A live hold on a channel now only recording: nothing is waiting for the
    // router any more, so what was held goes ahead where the ticket is.
    expect(
      decide({ ...base, mode: 'category_shadow', categoryId: CATEGORY, routeGroupId: SALES })
        .outcome,
    ).toBe('released');
  });
});

describe('decide, a shadow row', () => {
  const shadow: DecideInput = { ...base, shadow: true, mode: 'category_shadow' };

  it('ignores an assignee: nothing was held, and the rota assigning on arrival is expected', () => {
    expect(
      decide({
        ...shadow,
        assigneeAgentId: 'agent-amr',
        categoryId: CATEGORY,
        routeGroupId: SALES,
      }),
    ).toEqual({ outcome: 'category', toGroupId: SALES });
    expect(decide({ ...shadow, assigneeAgentId: 'agent-amr' }).outcome).toBe('fallback');
  });

  it('is never taken, whatever else it is', () => {
    for (const [, trigger] of TRIGGERS) {
      expect(decide({ ...shadow, ...trigger, assigneeAgentId: 'agent-amr' }).outcome).not.toBe(
        'taken',
      );
    }
  });

  it('is released only by default_group', () => {
    expect(decide({ ...shadow, mode: 'default_group' }).outcome).toBe('released');
    // A channel moved on to live routing still wants the shadow ticket's answer.
    expect(decide({ ...shadow, mode: 'category' }).outcome).toBe('fallback');
    expect(decide({ ...shadow, mode: 'category_shadow' }).outcome).toBe('fallback');
  });

  it('records not_open ahead of released, as a live row does', () => {
    expect(decide({ ...shadow, statusCategory: 'closed', mode: 'default_group' }).outcome).toBe(
      'not_open',
    );
  });

  it('records the would-be move and where the ticket would have stayed', () => {
    expect(decide({ ...shadow, categoryId: CATEGORY, routeGroupId: SALES })).toEqual({
      outcome: 'category',
      toGroupId: SALES,
    });
    expect(decide({ ...shadow, categoryId: CATEGORY, routeGroupId: HOME })).toEqual({
      outcome: 'no_route_for_category',
      toGroupId: HOME,
    });
  });
});
