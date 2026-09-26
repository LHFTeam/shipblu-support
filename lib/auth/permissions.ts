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
  /**
   * Hiding or deleting a customer's public comment on one of our own social
   * posts.
   *
   * Separate from `ticket.reply` because it is not a reply: it changes what
   * everybody else can see on the brand's post, and one of the two verbs cannot
   * be undone by anybody, us included. An agent who should answer every comment
   * is not automatically somebody who should be able to remove one.
   *
   * Granted from supervisor up, which is where `ticket.delete` and
   * `ticket.merge` sit for the same reason — the action is irreversible and
   * visible outside the team. It is a plain permission, so a front-line agent
   * who moderates all day can be given it without being promoted.
   */
  'ticket.moderate_comment',
  /**
   * Moving a ticket into a closed status.
   *
   * Separate from every other status change because closing is not a stronger
   * way of saying resolved — it is the thing that ends the customer's thread.
   * Every channel decides whether an inbound message continues the last
   * conversation or opens a new one by stopping at `closed`
   * (`lib/widget/session.ts`, `lib/tickets/ingest-whatsapp.ts`,
   * `lib/tickets/ingest-meta.ts`), so an agent closing a ticket is deciding that
   * the customer's next message arrives as a stranger with no history attached,
   * and there is no undo an agent can reach for: the customer has to write in
   * again before anyone can put it back.
   *
   * Withheld from agents so that the ordinary way a ticket closes is the
   * three-day rule in `lib/automations/defaults.ts` — time, after the customer
   * has had the window to disagree — rather than a judgement made at the moment
   * somebody wants the ticket off their screen. Resolving is still theirs, and
   * resolving is what the reports measure.
   *
   * Supervisor and up, alongside `ticket.delete` and `ticket.merge`, for the
   * reason those two sit there: the effect is outside the team and outside the
   * console. It is a plain permission, so one trusted agent can be given it
   * without being promoted.
   */
  'ticket.close',
  'ticket.delete',
  /**
   * Destroying a ticket outright — the row, its messages, its attachments, its
   * timeline and its side conversations, with nothing left to restore from.
   *
   * Separate from `ticket.delete`, and above it, because they are different
   * verbs that happen to share a word. `conversations.deleted_at` exists and
   * every query already filters on it, so `ticket.delete` has a well-defined
   * meaning waiting for it: hide this from the inbox, and put it back if that
   * was wrong. This one has no way back — which is why it is admin-only while
   * `ticket.delete` sits at supervisor.
   */
  'ticket.purge',
  'ticket.merge',
  /**
   * Adding, confirming or rejecting a category on a ticket.
   *
   * Separate from `ticket.edit_fields`, which it superficially resembles,
   * because the two change different things. A custom field changes what one
   * ticket says about itself. A category is the label every report is built
   * from *and* the training signal the rules are tuned against — so an agent
   * clearing a suggestion they did not understand moves a number on a
   * supervisor's report and teaches the detector to stop finding that case.
   *
   * Held by agents anyway, and it has to be: they are the only people who read
   * enough tickets for the corrections to happen at all, and a review queue
   * only an admin can work is a review queue nobody finishes. Its own key so it
   * can be taken off one person without taking their field editing with it.
   */
  'ticket.categorise',
  'ticket.edit_fields',
  /**
   * Opening a ticket on a customer's behalf, from a form.
   *
   * Separate from `ticket.reply` because answering what arrived and
   * manufacturing what did not are different acts. Every ticket an agent opens
   * counts in first-response time, in volume per channel and in whatever the
   * team is measured on, so this is a reporting-integrity permission rather than
   * a security one — which is also why it is in the agent baseline: a team that
   * takes tickets over the phone needs it, and one that does not can take it
   * away from everybody at once.
   */
  'ticket.create',
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
  /**
   * Destroying a customer outright: the contact, every address and number it
   * answers on, its portal sign-in, and **every ticket it ever raised** —
   * because `conversations.requester_contact_id` is `on delete restrict` and a
   * ticket with no requester is not a thing this schema can hold.
   *
   * The widest blast radius any single click in the console has, which is the
   * whole reason it is its own key rather than a stronger reading of
   * `contact.delete`. Somebody who should be able to retire a duplicate record
   * is not automatically somebody who should be able to erase a customer's
   * entire history with us in one action.
   */
  'contact.purge',
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
  /**
   * Setting another agent's availability, and seeing who is at their desk now.
   *
   * Its own key rather than part of `report.agents`, which it sits beside,
   * because the two differ in tense and in consequence. That one is a record of
   * what happened, read after the fact; this one changes where the next ticket
   * goes — a supervisor parking somebody who has walked off, or putting them
   * back in the rota when the queue is backing up.
   *
   * Granted from supervisor up, since covering the queue is what a supervisor is
   * for. It does not override the agent: their own switch still works, and an
   * agent who disagrees with being parked can un-park themselves. Making it
   * stick would need a lock the product does not have, and the honest failure —
   * two people disagreeing in the open — is better than a silent one.
   */
  'agent.availability',
  'admin.agents',
  'admin.groups',
  'admin.locations',
  'admin.channels',
  'admin.automations',
  'admin.sla',
  /** Skills, and who holds them — the input to skill-based assignment. */
  'admin.skills',
  'admin.fields',
  /**
   * The category and root-cause taxonomy, and the review queue.
   *
   * Above `ticket.categorise` and not folded into `admin.fields`, which owns
   * statuses and custom fields, because the blast radius is different in time
   * rather than in size. A field definition changes what can be recorded next.
   * Retiring or renaming a category rewrites what the archive already means —
   * retroactively, since the nightly rollup rebuilds from the current taxonomy,
   * so a rename quietly re-labels every report anybody has ever drawn.
   */
  'admin.categories',

  /**
   * Ticket forms, separate from `admin.fields` because the blast radius is.
   *
   * Defining a field adds a question to an internal sidebar. Publishing a form
   * changes what the public help centre shows a customer and which queue the
   * tickets it opens land in — the same reach an automation has, reached by
   * somebody who only wanted to reword a question.
   */
  'admin.forms',
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
  'ticket.categorise',
  'ticket.create',
  'contact.view',
  'contact.edit',
  'kb.view',
];

const SUPERVISOR: Permission[] = [
  ...AGENT,
  'ticket.view.all',
  'ticket.close',
  'ticket.merge',
  'contact.merge',
  'ticket.moderate_comment',
  'ticket.delete',
  'kb.edit',
  'kb.publish',
  'report.view',
  'report.agents',
  'agent.availability',
];

const ADMIN: Permission[] = [
  ...SUPERVISOR,
  // Deliberately not on SUPERVISOR. Bot transcripts are conversations nobody on
  // the team took part in, kept for oversight rather than for working, so they
  // are off the shop floor by default. It is a plain permission, so a single
  // supervisor can be given it without being promoted.
  'ticket.view.bot',
  'contact.delete',
  // The two irreversible ones. Admin and no lower, and deliberately not on
  // SUPERVISOR even though `ticket.delete` is: everything else a supervisor can
  // do to a ticket can be undone by somebody who disagrees with them.
  'ticket.purge',
  'contact.purge',
  'admin.agents',
  'admin.groups',
  'admin.locations',
  'admin.channels',
  'admin.automations',
  'admin.sla',
  'admin.skills',
  'admin.fields',
  'admin.categories',
  'admin.forms',
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

/**
 * Seniority, as a number, for the one question that is genuinely ordered.
 *
 * Capabilities deliberately are not: `PERMISSIONS` is a flat union and
 * `agents.permissions` layers explicit true/false on top, so a supervisor can
 * hold something an admin has had taken away and "higher role" says nothing
 * about who can do what. Audience is the exception. "Supervisors and up" is a
 * statement about the ladder rather than about a capability, and a knowledge
 * base article that is only for the people above a line has no permission key
 * to hang on — inventing one per article is how a taxonomy becomes a hundred
 * booleans.
 *
 * So this is exported for that use and named for it. Do not reach for it to
 * decide whether somebody may perform an action: `can()` is the answer there,
 * and it is the answer precisely because it can be overridden per agent.
 */
const ROLE_SENIORITY: Record<AgentRole, number> = {
  agent: 1,
  supervisor: 2,
  admin: 3,
  account_admin: 4,
};

/** True when `role` is `floor` or senior to it. */
export function roleAtLeast(role: AgentRole, floor: AgentRole): boolean {
  return ROLE_SENIORITY[role] >= ROLE_SENIORITY[floor];
}

/** The more senior of two floors — the one that admits fewer people. */
export function strictestRole(a: AgentRole, b: AgentRole): AgentRole {
  return roleAtLeast(a, b) ? a : b;
}

/** How senior a role is, for the SQL side of the same rule. */
export function roleSeniority(role: AgentRole): number {
  return ROLE_SENIORITY[role];
}

/** Every role, most junior first — the order a "minimum role" picker reads in. */
export const ROLES_BY_SENIORITY: AgentRole[] = ['agent', 'supervisor', 'admin', 'account_admin'];

/**
 * Whether a value out of a request names a role. The list it checks against is
 * held to the `agent_role` enum by `lib/tickets/vocabulary.test.ts`.
 */
export function isAgentRole(value: unknown): value is AgentRole {
  return (ROLES_BY_SENIORITY as readonly unknown[]).includes(value);
}
