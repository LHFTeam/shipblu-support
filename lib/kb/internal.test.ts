import { describe, expect, it } from 'vitest';
import { agentRoleEnum } from '@/db/schema/enums';
import { ROLES_BY_SENIORITY, roleAtLeast, roleSeniority } from '@/lib/auth/permissions';
import { FLOOR_LABELS, floorFor, meetsFloor } from './internal';

/**
 * The SQL half of this rule is exercised by the `database` CI job, which plans
 * every statement against a real Postgres. What is left for a unit test is what
 * a plan cannot catch: the ladder the CASE arms are generated from, and the
 * TypeScript twin of the floor rule that answers for rows already in hand.
 */

const article = (over: Partial<Parameters<typeof floorFor>[0]> = {}) => ({
  visibility: 'agents_only' as const,
  minRole: null,
  folderVisibility: 'agents_only' as const,
  folderMinRole: null,
  ...over,
});

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

  it('has a label for every role, so a picker cannot show a bare enum value', () => {
    for (const role of ROLES_BY_SENIORITY) expect(FLOOR_LABELS[role]).toBeTruthy();
  });

  it('reads upwards: a senior role clears a junior floor and not the reverse', () => {
    expect(roleAtLeast('admin', 'agent')).toBe(true);
    expect(roleAtLeast('agent', 'admin')).toBe(false);
    expect(roleAtLeast('supervisor', 'supervisor')).toBe(true);
  });
});

describe('floorFor', () => {
  it('is null on anything a customer can reach, whatever the columns say', () => {
    // A floor here would hide from an agent what a stranger can read, which is
    // a broken console rather than a boundary.
    expect(
      floorFor(article({ visibility: 'public', folderVisibility: 'public', minRole: 'admin' })),
    ).toBeNull();
    expect(
      floorFor(
        article({ visibility: 'logged_in', folderVisibility: 'public', folderMinRole: 'admin' }),
      ),
    ).toBeNull();
  });

  it('is null on internal content that names no floor — every agent, as before', () => {
    expect(floorFor(article())).toBeNull();
  });

  it('takes the folder’s floor when the article has none', () => {
    // The production shape: fifteen articles marked `public` that are internal
    // only because of the folder they sit in.
    expect(floorFor(article({ visibility: 'public', folderMinRole: 'supervisor' }))).toBe(
      'supervisor',
    );
  });

  it('takes the stricter of the two when both name one', () => {
    expect(floorFor(article({ minRole: 'agent', folderMinRole: 'admin' }))).toBe('admin');
    expect(floorFor(article({ minRole: 'admin', folderMinRole: 'agent' }))).toBe('admin');
  });
});

describe('meetsFloor', () => {
  it('lets everybody past a null floor', () => {
    for (const role of ROLES_BY_SENIORITY) expect(meetsFloor(role, null)).toBe(true);
  });

  it('admits the floor’s own role and everyone above it', () => {
    expect(meetsFloor('supervisor', 'supervisor')).toBe(true);
    expect(meetsFloor('admin', 'supervisor')).toBe(true);
    expect(meetsFloor('account_admin', 'supervisor')).toBe(true);
    expect(meetsFloor('agent', 'supervisor')).toBe(false);
  });

  it('keeps an account-admin floor to account admins', () => {
    expect(meetsFloor('admin', 'account_admin')).toBe(false);
    expect(meetsFloor('account_admin', 'account_admin')).toBe(true);
  });
});
