import { describe, expect, it } from 'vitest';
import { pickLoadBalanced, pickRoundRobin } from './strategies';
import type { Candidate } from './eligibility';

const candidate = (agentId: string, openTickets = 0): Candidate => ({
  agentId,
  name: agentId,
  openTickets,
});

describe('pickRoundRobin', () => {
  it('starts at the top of the ring when there is no cursor', () => {
    expect(pickRoundRobin([candidate('c'), candidate('a'), candidate('b')], null)).toBe('a');
  });

  it('takes the seat after the cursor', () => {
    expect(pickRoundRobin([candidate('a'), candidate('b'), candidate('c')], 'a')).toBe('b');
    expect(pickRoundRobin([candidate('a'), candidate('b'), candidate('c')], 'b')).toBe('c');
  });

  it('wraps around the end', () => {
    expect(pickRoundRobin([candidate('a'), candidate('b'), candidate('c')], 'c')).toBe('a');
  });

  // The cursor names whoever took the last ticket, and that agent is very often
  // no longer a candidate by the time the next one arrives — they went offline,
  // they hit their cap, they were moved out of the group. This must not stall
  // the rota, and it must not be an error.
  it('restarts at the top when the cursor is no longer a candidate', () => {
    expect(pickRoundRobin([candidate('b'), candidate('c')], 'a')).toBe('b');
  });

  it('re-picks the only candidate, cursor or not', () => {
    expect(pickRoundRobin([candidate('a')], 'a')).toBe('a');
  });

  it('returns null rather than throwing on an empty team', () => {
    expect(pickRoundRobin([], 'a')).toBeNull();
  });

  it('orders by id, so renaming an agent does not reshuffle the rota', () => {
    const first = pickRoundRobin([candidate('a'), candidate('b')], null);
    const renamed = [
      { agentId: 'a', name: 'zzz', openTickets: 0 },
      { agentId: 'b', name: 'aaa', openTickets: 0 },
    ];
    expect(pickRoundRobin(renamed, null)).toBe(first);
  });
});

describe('pickLoadBalanced', () => {
  it('takes the least loaded agent whatever the cursor says', () => {
    expect(pickLoadBalanced([candidate('a', 5), candidate('b', 1)], 'b')).toBe('b');
  });

  /*
   * The reason load balancing shares the round-robin ring. With three idle
   * agents every tie would otherwise go to whoever sorts first, and an admin who
   * switched the group to "load balanced" would watch one person receive
   * everything — a setting that looks broken while behaving exactly as written.
   */
  it('rotates between equally loaded agents instead of repeating one', () => {
    const team = [candidate('a'), candidate('b'), candidate('c')];
    expect(pickLoadBalanced(team, null)).toBe('a');
    expect(pickLoadBalanced(team, 'a')).toBe('b');
    expect(pickLoadBalanced(team, 'b')).toBe('c');
    expect(pickLoadBalanced(team, 'c')).toBe('a');
  });

  it('re-picks the agent who took the last ticket when they are still the freest', () => {
    expect(pickLoadBalanced([candidate('a', 0), candidate('b', 4)], 'a')).toBe('a');
  });

  it('returns null rather than throwing on an empty team', () => {
    expect(pickLoadBalanced([], null)).toBeNull();
  });
});
