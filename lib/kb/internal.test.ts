import { describe, expect, it } from 'vitest';
import { agentRoleEnum } from '@/db/schema/enums';
import { ROLES_BY_SENIORITY, roleAtLeast, roleSeniority } from '@/lib/auth/permissions';

/**
 * The SQL half of this rule is exercised by the `database` CI job, which plans
 * every statement against a real Postgres. What is left for a unit test is what
 * a plan cannot catch: the ladder the CASE arms in `./internal.ts` are generated
 * from. The TypeScript twin of the rule is tested beside it, in
 * `./floors.test.ts`.
 */

describe('the seniority ladder', () => {
  it('names every role in the enum, exactly once', () => {
    // The CASE arms in `seniorityOf` are generated from this list, so a role
    // missing from it is not a compile error — it is a role that silently
    // grades as the most junior one and reads everything.
    expect([...ROLES_BY_SENIORITY].sort()).toEqual([...agentRoleEnum.enumValues].sort());
  });

  it('increases strictly, so no two roles grade the same', () => {
    const ranks = ROLES_BY_SENIORITY.map(roleSeniority);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('starts at 1, which is the seniority a null column grades as', () => {
    // `seniorityOf` falls to `else 1` for a row with no floor, and `FLOOR_ARMS`
    // has no arm for 1 — the two together are what makes "no floor" and "every
    // agent" the same answer. A ladder starting anywhere else would make a null
    // column grade below its most junior role and the pair stop lining up.
    expect(roleSeniority(ROLES_BY_SENIORITY[0]!)).toBe(1);
  });

  it('reads upwards: a senior role clears a junior floor and not the reverse', () => {
    expect(roleAtLeast('admin', 'agent')).toBe(true);
    expect(roleAtLeast('agent', 'admin')).toBe(false);
    expect(roleAtLeast('supervisor', 'supervisor')).toBe(true);
  });
});
