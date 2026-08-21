import { describe, expect, it } from 'vitest';
import { matchingSkills, type SkillRow } from './skills';
import type { Facts } from '@/lib/rules/conditions';

const facts: Facts = {
  channel: 'whatsapp',
  priority: 'urgent',
  tags: ['refund'],
};

const skill = (id: string, conditions: unknown): SkillRow => ({ id, name: id, conditions });

describe('matchingSkills', () => {
  it('requires a skill whose conditions the ticket meets', () => {
    const rows = [skill('ar', { field: 'channel', op: 'eq', value: 'whatsapp' })];
    expect(matchingSkills(rows, facts)).toEqual(['ar']);
  });

  it('does not require a skill whose conditions the ticket fails', () => {
    const rows = [skill('email-only', { field: 'channel', op: 'eq', value: 'email' })];
    expect(matchingSkills(rows, facts)).toEqual([]);
  });

  /*
   * The one place this project reads `{}` as "never" rather than "always". For an
   * SLA policy the empty condition is the catch-all every configuration needs;
   * for a skill it is almost always one somebody started and did not finish, and
   * read as "always" it would demand that skill of every ticket in the system and
   * stop the queue dead.
   */
  it('never requires a skill with no conditions', () => {
    expect(matchingSkills([skill('unfinished', {})], facts)).toEqual([]);
  });

  it('never requires a skill whose conditions are malformed', () => {
    expect(matchingSkills([skill('corrupt', { field: 'channel', op: 'wat' })], facts)).toEqual([]);
    expect(matchingSkills([skill('corrupt', 'not an object')], facts)).toEqual([]);
    expect(matchingSkills([skill('corrupt', null)], facts)).toEqual([]);
  });

  it('returns every skill that matches, in the order given', () => {
    const rows = [
      skill('first', { field: 'priority', op: 'eq', value: 'urgent' }),
      skill('skipped', { field: 'priority', op: 'eq', value: 'low' }),
      skill('second', { field: 'tags', op: 'contains', value: 'refund' }),
    ];
    expect(matchingSkills(rows, facts)).toEqual(['first', 'second']);
  });

  it('handles nested conditions the same way the rules engine does', () => {
    const rows = [
      skill('both', {
        all: [
          { field: 'channel', op: 'eq', value: 'whatsapp' },
          { field: 'priority', op: 'in', value: ['high', 'urgent'] },
        ],
      }),
    ];
    expect(matchingSkills(rows, facts)).toEqual(['both']);
  });
});
