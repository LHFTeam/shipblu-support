import { describe, expect, it } from 'vitest';
import { ROLES_BY_SENIORITY } from '@/lib/auth/permissions';
import { FLOOR_LABELS, floorFor, folderFloor, meetsFloor } from './floors';

/**
 * The half of the floor rule that runs without a database — and the half a
 * console page renders, so a disagreement with `effectiveFloor` shows up as a
 * badge that contradicts the list it sits in rather than as an error.
 */

const article = (over: Partial<Parameters<typeof floorFor>[0]> = {}) => ({
  visibility: 'agents_only' as const,
  minRole: null,
  folderVisibility: 'agents_only' as const,
  folderMinRole: null,
  ...over,
});

describe('floorFor', () => {
  it('has a label for every role, so a picker cannot show a bare enum value', () => {
    for (const role of ROLES_BY_SENIORITY) expect(FLOOR_LABELS[role]).toBeTruthy();
  });

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

  it('is null for the most junior role too, exactly as `effectiveFloor` is', () => {
    // The SQL generates arms only for the roles above the bottom of the ladder,
    // so a row floored at `agent` comes back null there. Answering `'agent'`
    // here would put an "Agents and up" badge on a row every other surface
    // reports as unrestricted.
    expect(floorFor(article({ minRole: 'agent' }))).toBeNull();
    expect(floorFor(article({ folderMinRole: 'agent' }))).toBeNull();
    expect(floorFor(article({ minRole: 'agent', folderMinRole: 'agent' }))).toBeNull();
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

describe('folderFloor', () => {
  it('is null on a folder a customer can open, floor column or not', () => {
    // The console badges a folder with this, and a `logged_in` folder wearing
    // "Admins and up" would say the opposite of the truth about who may read it.
    expect(folderFloor({ visibility: 'logged_in', minRole: 'admin' })).toBeNull();
    expect(folderFloor({ visibility: 'public', minRole: 'account_admin' })).toBeNull();
  });

  it('reports an internal folder’s own floor, and null where it names none', () => {
    expect(folderFloor({ visibility: 'agents_only', minRole: 'supervisor' })).toBe('supervisor');
    expect(folderFloor({ visibility: 'agents_only', minRole: null })).toBeNull();
    expect(folderFloor({ visibility: 'agents_only', minRole: 'agent' })).toBeNull();
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
