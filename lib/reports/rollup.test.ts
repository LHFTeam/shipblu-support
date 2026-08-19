import { describe, expect, it } from 'vitest';
import { slicesFor } from './rollup';

/**
 * `metrics_daily` stores four slices per day — the totals, and then by group, by
 * agent and by channel — with null meaning "all" in each dimension. The reports
 * page reads its headline figures from the totals slice, so a ticket landing in
 * that slice twice inflates every number on the page.
 */
describe('slicesFor', () => {
  it('puts a fully dimensioned ticket in the totals and one row per dimension', () => {
    expect(slicesFor({ groupId: 'group-1', agentId: 'agent-1', channel: 'email' })).toEqual([
      { groupId: null, agentId: null, channel: null },
      { groupId: 'group-1', agentId: null, channel: null },
      { groupId: null, agentId: 'agent-1', channel: null },
      { groupId: null, agentId: null, channel: 'email' },
    ]);
  });

  it('counts an unassigned ticket in the totals exactly once', () => {
    // The regression this guards: an unassigned ticket's "by agent" slice is
    // itself all nulls, which is indistinguishable from the totals slice unless
    // the dimension is checked rather than the nulls.
    const slices = slicesFor({ groupId: 'group-1', agentId: null, channel: 'email' });

    const totals = slices.filter((slice) => !slice.groupId && !slice.agentId && !slice.channel);
    expect(totals).toHaveLength(1);
    expect(slices).toHaveLength(3);
  });

  it('counts a ticket with no group and no assignee in the totals exactly once', () => {
    expect(slicesFor({ groupId: null, agentId: null, channel: 'webchat' })).toEqual([
      { groupId: null, agentId: null, channel: null },
      { groupId: null, agentId: null, channel: 'webchat' },
    ]);
  });

  it('never emits a row keyed on a dimension the ticket does not have', () => {
    for (const slice of slicesFor({ groupId: null, agentId: 'agent-1', channel: null })) {
      expect(slice.groupId).toBeNull();
      expect(slice.channel).toBeNull();
    }
  });
});
