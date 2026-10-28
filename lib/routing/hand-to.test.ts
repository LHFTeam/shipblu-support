import { describe, expect, it } from 'vitest';
import { handToTarget, type HandToTicket } from './hand-to';
import { ROUTING_GRACE_MS } from './hold';

/**
 * Which tickets are offered "Hand to <group>". The same answer the ticket page
 * draws the button from and the action re-asks of the locked row, so each
 * refusal here is one the server also makes.
 */

const NOW = new Date('2026-10-28T10:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const CARE = '00000000-0000-4000-8000-00000000000c';
const SALES = '00000000-0000-4000-8000-00000000000a';
const SALES_CATEGORY = '00000000-0000-4000-8000-0000000000c1';
const UNROUTED_CATEGORY = '00000000-0000-4000-8000-0000000000c2';

const routes = {
  categories: [
    { id: SALES_CATEGORY, routeGroupId: SALES },
    { id: UNROUTED_CATEGORY, routeGroupId: null },
  ],
  groups: [
    { id: CARE, name: 'Customer Care' },
    { id: SALES, name: 'Inbound Sales Team' },
  ],
};

const ticket = (overrides: Partial<HandToTicket> = {}): HandToTicket => ({
  statusCategory: 'open',
  channel: 'instagram',
  groupId: CARE,
  categoryId: SALES_CATEGORY,
  assigneeAgentId: 'agent-1',
  isSpam: false,
  mergedIntoId: null,
  deletedAt: null,
  routingWindowEndsAt: null,
  routingDecidedAt: null,
  ownerAnswers: false,
  coexistence: false,
  ...overrides,
});

const offer = (row: HandToTicket, canAssign = true) =>
  handToTarget(row, routes, { canAssign, now: NOW });
const refusal = (row: HandToTicket, canAssign = true) => {
  const answer = offer(row, canAssign);
  return answer.offered ? null : answer.reason;
};

describe('handToTarget', () => {
  it("offers the category's route group by name, held by somebody or by nobody", () => {
    expect(offer(ticket())).toEqual({
      offered: true,
      groupId: SALES,
      groupName: 'Inbound Sales Team',
    });
    expect(offer(ticket({ assigneeAgentId: null, statusCategory: 'pending' }))).toMatchObject({
      offered: true,
    });
  });

  it('is not offered to an agent who may not reassign tickets', () => {
    expect(refusal(ticket(), false)).toBe('not_permitted');
  });

  it('is offered only on work: open or pending, and not spam, merged, deleted or read-only', () => {
    expect(refusal(ticket({ statusCategory: 'resolved' }))).toBe('not_open');
    expect(refusal(ticket({ statusCategory: 'closed' }))).toBe('not_open');
    expect(refusal(ticket({ isSpam: true }))).toBe('not_open');
    expect(refusal(ticket({ mergedIntoId: 'other' }))).toBe('not_open');
    expect(refusal(ticket({ deletedAt: minutes(-1) }))).toBe('not_open');
    expect(refusal(ticket({ channel: 'whatsapp_bot' }))).toBe('not_open');
  });

  // During the hold a category edit routes the ticket, so the hand-over is
  // the router's to make; once it ends, by a decision or by the grace running
  // out on a stuck job, it is a person's.
  it('waits while the ticket is held for routing', () => {
    const held = { routingWindowEndsAt: minutes(3), routingDecidedAt: null, assigneeAgentId: null };
    expect(refusal(ticket(held))).toBe('held');
    // Past the window, inside the grace, the settle is still due.
    expect(refusal(ticket({ ...held, routingWindowEndsAt: minutes(-5) }))).toBe('held');

    expect(offer(ticket({ ...held, routingDecidedAt: minutes(-1) }))).toMatchObject({
      offered: true,
    });
    const lapsed = new Date(NOW.getTime() - ROUTING_GRACE_MS - 1);
    expect(offer(ticket({ ...held, routingWindowEndsAt: lapsed }))).toMatchObject({
      offered: true,
    });
    // Somebody holding it ends the hold whoever gave it to them.
    expect(offer(ticket({ ...held, assigneeAgentId: 'agent-1' }))).toMatchObject({
      offered: true,
    });
  });

  it("leaves an owned number's ticket to its owner, and a coexistence number to the phone", () => {
    expect(refusal(ticket({ channel: 'whatsapp', ownerAnswers: true }))).toBe('owned_number');
    expect(refusal(ticket({ channel: 'whatsapp', coexistence: true }))).toBe('coexistence');
  });

  it('needs a category whose route group is somewhere else', () => {
    expect(refusal(ticket({ categoryId: null }))).toBe('no_route');
    expect(refusal(ticket({ categoryId: UNROUTED_CATEGORY }))).toBe('no_route');
    // A category the page has no row for, or a route group deleted since.
    expect(refusal(ticket({ categoryId: '00000000-0000-4000-8000-0000000000c9' }))).toBe(
      'no_route',
    );
    expect(
      handToTarget(
        ticket(),
        { ...routes, groups: routes.groups.filter((g) => g.id !== SALES) },
        { canAssign: true, now: NOW },
      ),
    ).toEqual({ offered: false, reason: 'no_route' });

    expect(refusal(ticket({ groupId: SALES }))).toBe('already_there');
    // A ticket in no group at all is somewhere else.
    expect(offer(ticket({ groupId: null }))).toMatchObject({ offered: true, groupId: SALES });
  });
});
