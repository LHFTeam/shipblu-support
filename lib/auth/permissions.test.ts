import { describe, expect, it } from 'vitest';
import { can, permissionsForRole } from './permissions';

describe('permissions', () => {
  it('grants role baseline without overrides', () => {
    expect(can({ role: 'agent', permissions: {} }, 'ticket.reply')).toBe(true);
    expect(can({ role: 'agent', permissions: {} }, 'admin.agents')).toBe(false);
  });

  it('lets an explicit override grant beyond the role', () => {
    // The point of per-agent overrides: give one agent reporting access without
    // promoting them to supervisor.
    expect(can({ role: 'agent', permissions: { 'report.view': true } }, 'report.view')).toBe(true);
  });

  it('lets an explicit override revoke a role default', () => {
    expect(can({ role: 'admin', permissions: { 'ticket.delete': false } }, 'ticket.delete')).toBe(
      false,
    );
  });

  it('treats a missing override as absent rather than false', () => {
    // `undefined` must fall through to the role, not be coerced to a denial.
    expect(
      can({ role: 'supervisor', permissions: { 'kb.edit': undefined as never } }, 'kb.edit'),
    ).toBe(true);
  });

  it('escalates privileges monotonically across roles', () => {
    const agent = permissionsForRole('agent');
    const supervisor = permissionsForRole('supervisor');
    const admin = permissionsForRole('admin');
    const accountAdmin = permissionsForRole('account_admin');

    for (const p of agent) expect(supervisor).toContain(p);
    for (const p of supervisor) expect(admin).toContain(p);
    for (const p of admin) expect(accountAdmin).toContain(p);
  });

  it('reserves billing for the account admin', () => {
    expect(can({ role: 'admin', permissions: {} }, 'admin.billing')).toBe(false);
    expect(can({ role: 'account_admin', permissions: {} }, 'admin.billing')).toBe(true);
  });
});
