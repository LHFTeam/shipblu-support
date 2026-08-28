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

describe('ticket.view.bot', () => {
  it('is off for agents and supervisors, on for admins', () => {
    // The customer bot channel is oversight, not work in progress, so it does
    // not appear on the shop floor.
    expect(can({ role: 'agent', permissions: {} }, 'ticket.view.bot')).toBe(false);
    expect(can({ role: 'supervisor', permissions: {} }, 'ticket.view.bot')).toBe(false);
    expect(can({ role: 'admin', permissions: {} }, 'ticket.view.bot')).toBe(true);
    expect(can({ role: 'account_admin', permissions: {} }, 'ticket.view.bot')).toBe(true);
  });
});

describe('contact.merge', () => {
  it('sits with ticket.merge rather than with contact.edit', () => {
    // An agent can correct a contact; folding two people's histories together
    // is a supervisor's call, and undoing it is not a click.
    expect(can({ role: 'agent', permissions: {} }, 'contact.edit')).toBe(true);
    expect(can({ role: 'agent', permissions: {} }, 'contact.merge')).toBe(false);
    expect(can({ role: 'supervisor', permissions: {} }, 'contact.merge')).toBe(true);
  });
});

describe('ticket.close', () => {
  it('is withheld from agents but not from supervisors', () => {
    // Resolving is the agent's judgement and the reports measure it. Closing is
    // what stops the customer's next message landing on this history, and the
    // three-day rule is meant to be what usually makes that call.
    expect(can({ role: 'agent', permissions: {} }, 'ticket.close')).toBe(false);
    expect(can({ role: 'supervisor', permissions: {} }, 'ticket.close')).toBe(true);
    expect(can({ role: 'admin', permissions: {} }, 'ticket.close')).toBe(true);
  });

  it('can be handed to one agent without promoting them', () => {
    expect(can({ role: 'agent', permissions: { 'ticket.close': true } }, 'ticket.close')).toBe(
      true,
    );
  });
});

describe('admin.locations', () => {
  it('is an admin setting, like the rest of the register of who works where', () => {
    expect(can({ role: 'supervisor', permissions: {} }, 'admin.locations')).toBe(false);
    expect(can({ role: 'admin', permissions: {} }, 'admin.locations')).toBe(true);
  });
});
