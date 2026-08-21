import type { agents } from '@/db/schema';

export type AgentRole = (typeof agents.$inferSelect)['role'];

/**
 * Permission keys, mirroring the Freshdesk capabilities the team actually uses.
 * Kept as a flat string union rather than nested objects so per-agent overrides
 * in `agents.permissions` stay a simple Record<string, boolean>.
 */
export const PERMISSIONS = [
  'ticket.view.all',
  'ticket.view.group',
  'ticket.view.assigned',
  /** Conversations on a channel owned by another service — the customer bot. */
  'ticket.view.bot',
  'ticket.reply',
  'ticket.note',
  /**
   * Starting or answering a side conversation — a thread with a hub, a warehouse
   * or a vendor, hanging off a ticket.
   *
   * Not folded into `ticket.reply`. That one authorises writing back to somebody
   * who already wrote to us; this one authorises putting a customer's situation
   * in front of a third party who did not ask, which is a different thing to
   * hand out and a different thing to take away.
   */
  'ticket.side_conversation',
  'ticket.assign',
  'ticket.delete',
  'ticket.merge',
  'ticket.edit_fields',
  'contact.view',
  'contact.edit',
  /**
   * Folding one contact into another. Above `contact.edit` because it moves
   * somebody else's tickets onto a contact and retires a record, which is the
   * same weight as `ticket.merge` — and granted to the same roles for that
   * reason.
   */
  'contact.merge',
  'contact.delete',
  'kb.view',
  'kb.edit',
  'kb.publish',
  'report.view',
  /**
   * Per-agent productivity: shift times, availability, handling time.
   *
   * Separate from `report.view` because it is a different kind of data about a
   * different subject. The aggregate reports describe the queue; this one
   * describes named people — when they arrived, how long they were at their
   * desk, how long they spent on each ticket — and somebody who needs to know
   * how the team is coping does not automatically need that.
   *
   * Granted to supervisors, since coaching the people is their job, but as its
   * own key so it can be taken off one of them without taking reporting away
   * too.
   */
  'report.agents',
  'admin.agents',
  'admin.groups',
  'admin.locations',
  'admin.channels',
  'admin.automations',
  'admin.sla',
  /** Skills, and who holds them — the input to skill-based assignment. */
  'admin.skills',
  'admin.fields',
  'admin.billing',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const AGENT: Permission[] = [
  'ticket.view.group',
  'ticket.view.assigned',
  'ticket.reply',
  'ticket.note',
  'ticket.side_conversation',
  'ticket.assign',
  'ticket.edit_fields',
  'contact.view',
  'contact.edit',
  'kb.view',
];

const SUPERVISOR: Permission[] = [
  ...AGENT,
  'ticket.view.all',
  'ticket.merge',
  'contact.merge',
  'ticket.delete',
  'kb.edit',
  'kb.publish',
  'report.view',
  'report.agents',
];

const ADMIN: Permission[] = [
  ...SUPERVISOR,
  // Deliberately not on SUPERVISOR. Bot transcripts are conversations nobody on
  // the team took part in, kept for oversight rather than for working, so they
  // are off the shop floor by default. It is a plain permission, so a single
  // supervisor can be given it without being promoted.
  'ticket.view.bot',
  'contact.delete',
  'admin.agents',
  'admin.groups',
  'admin.locations',
  'admin.channels',
  'admin.automations',
  'admin.sla',
  'admin.skills',
  'admin.fields',
];

const ACCOUNT_ADMIN: Permission[] = [...ADMIN, 'admin.billing'];

const ROLE_PERMISSIONS: Record<AgentRole, Permission[]> = {
  agent: AGENT,
  supervisor: SUPERVISOR,
  admin: ADMIN,
  account_admin: ACCOUNT_ADMIN,
};

/**
 * Role grants the baseline; `agents.permissions` layers explicit true/false on
 * top, so a single agent can be given report access without promoting them.
 */
export function can(
  agent: { role: AgentRole; permissions: Record<string, boolean> },
  permission: Permission,
): boolean {
  const override = agent.permissions[permission];
  if (typeof override === 'boolean') return override;
  return ROLE_PERMISSIONS[agent.role].includes(permission);
}

export function permissionsForRole(role: AgentRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
