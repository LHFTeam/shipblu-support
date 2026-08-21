import { describe, expect, it } from 'vitest';
import { effectiveCap, filterCandidates, HEARTBEAT_TTL_MS, type CandidateRow } from './eligibility';

const NOW = new Date('2026-08-21T10:00:00Z');

const member = (overrides: Partial<CandidateRow> = {}): CandidateRow => ({
  agentId: 'a',
  name: 'Agent',
  presence: 'online',
  lastSeenAt: new Date(NOW.getTime() - 10_000),
  isAcceptingTickets: true,
  maxOpenTickets: null,
  openTickets: 0,
  skillIds: [],
  ...overrides,
});

const run = (rows: CandidateRow[], opts: Partial<Parameters<typeof filterCandidates>[1]> = {}) =>
  filterCandidates(rows, {
    requiredSkillIds: [],
    groupDefaultMaxOpen: null,
    now: NOW,
    ...opts,
  });

describe('effectiveCap', () => {
  it('prefers the agent over the group, and the group over uncapped', () => {
    expect(effectiveCap(3, 10)).toBe(3);
    expect(effectiveCap(null, 10)).toBe(10);
    expect(effectiveCap(null, null)).toBeNull();
  });

  // Zero is a real cap — "this agent takes nothing right now" — and `??` on a
  // falsy check would silently turn it into "uncapped", which is its opposite.
  it('treats a cap of zero as a cap', () => {
    expect(effectiveCap(0, 10)).toBe(0);
    expect(effectiveCap(null, 0)).toBe(0);
  });
});

describe('filterCandidates', () => {
  it('lets a present, accepting, uncapped agent through', () => {
    expect(run([member()]).eligible).toHaveLength(1);
  });

  it('excludes an offline agent', () => {
    const { eligible, rejected } = run([member({ presence: 'offline' })]);
    expect(eligible).toHaveLength(0);
    expect(rejected.offline).toBe(1);
  });

  /*
   * The case a presence column alone cannot catch. An instance killed mid-stream
   * never runs its abort handler, so the row still reads `online` and would keep
   * receiving tickets forever. Reading the heartbeat too is what makes that heal
   * itself without a reaper.
   */
  it('excludes an agent whose row still says online but whose heartbeat is stale', () => {
    const stale = member({
      presence: 'online',
      lastSeenAt: new Date(NOW.getTime() - HEARTBEAT_TTL_MS - 1_000),
    });
    expect(run([stale]).eligible).toHaveLength(0);
    expect(run([stale]).rejected.offline).toBe(1);
  });

  it('excludes an agent who has never been seen', () => {
    expect(run([member({ lastSeenAt: null })]).eligible).toHaveLength(0);
  });

  it('excludes an agent who is here but not accepting', () => {
    const { eligible, rejected } = run([member({ isAcceptingTickets: false })]);
    expect(eligible).toHaveLength(0);
    expect(rejected.not_accepting).toBe(1);
  });

  it('excludes an agent at their own cap and admits one below it', () => {
    expect(run([member({ maxOpenTickets: 2, openTickets: 2 })]).eligible).toHaveLength(0);
    expect(run([member({ maxOpenTickets: 2, openTickets: 1 })]).eligible).toHaveLength(1);
  });

  it('falls back to the group cap when the agent has none', () => {
    const rows = [member({ maxOpenTickets: null, openTickets: 5 })];
    expect(run(rows, { groupDefaultMaxOpen: 5 }).eligible).toHaveLength(0);
    expect(run(rows, { groupDefaultMaxOpen: 6 }).eligible).toHaveLength(1);
  });

  it('lets an agent past their group cap when they carry their own', () => {
    const rows = [member({ maxOpenTickets: 20, openTickets: 9 })];
    expect(run(rows, { groupDefaultMaxOpen: 5 }).eligible).toHaveLength(1);
  });

  // All of them, not any of them. A ticket needing Arabic *and* customs is not
  // served by somebody who only speaks Arabic.
  it('requires every skill the ticket asked for', () => {
    const rows = [
      member({ agentId: 'one', skillIds: ['ar'] }),
      member({ agentId: 'two', skillIds: ['ar', 'customs'] }),
    ];
    const { eligible, rejected } = run(rows, { requiredSkillIds: ['ar', 'customs'] });
    expect(eligible.map((c) => c.agentId)).toEqual(['two']);
    expect(rejected.missing_skill).toBe(1);
  });

  it('ignores skills an agent holds that the ticket did not ask for', () => {
    const rows = [member({ skillIds: ['ar', 'french', 'customs'] })];
    expect(run(rows, { requiredSkillIds: ['ar'] }).eligible).toHaveLength(1);
  });

  /*
   * "Nobody was online" and "everybody was full" are different problems with
   * different fixes — a rota versus a number in a settings form — so an agent
   * who is both is counted at the hurdle they fell at first.
   */
  it('counts an offline agent as offline even when they are also full', () => {
    const rows = [member({ presence: 'offline', maxOpenTickets: 1, openTickets: 9 })];
    const { rejected } = run(rows);
    expect(rejected.offline).toBe(1);
    expect(rejected.at_capacity).toBe(0);
  });

  it('reports nothing rejected when everybody got through', () => {
    const { rejected } = run([member({ agentId: 'x' }), member({ agentId: 'y' })]);
    expect(rejected).toEqual({ offline: 0, not_accepting: 0, missing_skill: 0, at_capacity: 0 });
  });
});
