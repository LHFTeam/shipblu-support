import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentPresenceEnum, agentRoleEnum, assignmentStrategyEnum } from './enums';

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),

    /** argon2id. Null for an invited agent who has not set a password yet. */
    passwordHash: text('password_hash'),

    role: agentRoleEnum('role').notNull().default('agent'),

    /** Appended to outbound replies; per-agent, overrides the mailbox default. */
    signature: text('signature'),
    avatarUrl: text('avatar_url'),

    /**
     * Written by exactly one thing: the SSE stream at /api/events, which is open
     * while the agent has the console in front of them and closed when they do
     * not. The agent's own away switch is `isAcceptingTickets` below rather than
     * a second writer here, because a manual "away" that a reconnect silently
     * overwrites is worse than no away switch at all.
     *
     * `away` is therefore never stored. It is what the dashboard renders for an
     * agent who is connected but not accepting.
     */
    presence: agentPresenceEnum('presence').notNull().default('offline'),

    /**
     * Last heartbeat, refreshed on every SSE keepalive — not "last signed in".
     * Assignment treats a stale timestamp as offline whatever `presence` says,
     * which is what makes an instance that died without running its abort
     * handler heal itself with no reaper.
     */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),

    /**
     * The agent's own switch. Off means "I am here but do not route work to me"
     * — a meeting, a training call, the end of a shift spent finishing what they
     * already hold. Their existing tickets are untouched.
     */
    isAcceptingTickets: boolean('is_accepting_tickets').notNull().default(true),

    /**
     * How many open tickets this agent may hold at once under load-balanced
     * assignment. Null falls through to the group's default, and then to
     * uncapped — so a cap is something you opt into on either level.
     */
    maxOpenTickets: integer('max_open_tickets'),

    /** Deactivated agents keep their history but cannot sign in or be assigned. */
    isActive: boolean('is_active').notNull().default(true),

    /** Per-agent overrides layered on top of the role's default permissions. */
    permissions: jsonb('permissions').$type<Record<string, boolean>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Emails are normalised to lowercase before every write and lookup
    // (lib/auth/normalise.ts), so a plain unique index is enough.
    uniqueIndex('agents_email_idx').on(t.email),
    index('agents_active_idx').on(t.isActive),
  ],
);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),

    /** Unassigned tickets in this group escalate here after `escalateAfterMins`. */
    escalateToAgentId: uuid('escalate_to_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    escalateAfterMins: integer('escalate_after_mins'),

    /**
     * How a ticket in this group reaches a person.
     *
     * `manual` — the default, and what every group gets on the deploy that adds
     * this — leaves the ticket in the queue for somebody to pick up, which is
     * exactly what the product did before. A group starts routing when an admin
     * says so, never because a migration ran.
     */
    assignmentStrategy: assignmentStrategyEnum('assignment_strategy').notNull().default('manual'),

    /**
     * Narrow the candidates to agents holding every skill the ticket matched
     * before distributing. A filter rather than its own strategy, so switching it
     * on does not discard the group's answer to "round robin or load balanced?".
     */
    matchSkills: boolean('match_skills').notNull().default(false),

    /**
     * How long a ticket may go unassigned for want of a skilled agent before the
     * requirement is dropped and anyone eligible will do.
     *
     * Null means never — the ticket waits for somebody with the skill, forever if
     * that is what it takes. Setting it is the recommended configuration: without
     * a timeout, one typo in a skill's conditions is a ticket no human ever sees.
     */
    skillTimeoutMins: integer('skill_timeout_mins'),

    /** Fallback cap for members with no `maxOpenTickets` of their own. */
    defaultMaxOpenTickets: integer('default_max_open_tickets'),

    /**
     * Hand tickets out only while this group's calendar says it is open.
     *
     * On by default. An agent signed in at 23:00 to clear their own backlog has
     * not volunteered for the night shift, and a ticket assigned to them then is
     * one nobody looks at until morning while the queue view says it is handled.
     */
    assignWithinHoursOnly: boolean('assign_within_hours_only').notNull().default(true),

    /**
     * Take an unanswered ticket back off an agent who has gone offline for this
     * long, so it can be assigned to somebody who is here.
     *
     * Null — the default — means never. Only a ticket still awaiting its first
     * agent reply is ever reclaimed; see the reclaim pass in the sweep for why.
     */
    reclaimAfterMins: integer('reclaim_after_mins'),

    /**
     * The round-robin cursor: who this group handed a ticket to last.
     *
     * On the group rather than in a table of its own because there is exactly one
     * per group and it is read and written in the same transaction as the
     * assignment it describes. `set null` is the right behaviour on agent
     * deletion — a missing cursor restarts the ring at the top.
     */
    lastAssignedAgentId: uuid('last_assigned_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    /**
     * The group's own calendar: its operating days, hours and holidays.
     *
     * Null means the group works the global default schedule. Set, it overrides
     * it — for both SLA due dates and the working time reporting measures — for
     * every ticket in this group whose policy counts against the group's hours,
     * which is the default for a policy.
     *
     * FK to business_hours is added in SQL rather than here: config.ts imports
     * nothing from agents.ts and adding the reverse reference would make the two
     * modules circular.
     */
    businessHoursId: uuid('business_hours_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('groups_name_idx').on(t.name)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.agentId] }),
    index('group_members_agent_idx').on(t.agentId),
  ],
);

/**
 * A skill is a capability an agent has and a ticket may need — a language, a
 * channel, a product area, a tier.
 *
 * Which tickets need it is written in the same condition language as SLA
 * policies and automation rules (`lib/rules`), so an admin who can express
 * "urgent tickets from the shipping group" once can express it here. That is
 * also why a ticket carries no skill column: what a ticket needs is derived from
 * the ticket, and correcting a skill's conditions immediately corrects every
 * ticket in the queue instead of only the ones that arrive next.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),

    /** Same jsonb shape as `sla_policies.conditions`. `{}` matches everything. */
    conditions: jsonb('conditions').$type<unknown>().notNull().default({}),

    /** Evaluated in this order, so the list reads as a priority order. */
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('skills_name_idx').on(t.name), index('skills_position_idx').on(t.position)],
);

/** Who holds which skill. A ticket's requirement is met only by holding all of them. */
export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.skillId] }),
    index('agent_skills_skill_idx').on(t.skillId),
  ],
);

/**
 * Server-side sessions rather than JWTs, so an admin can revoke an agent's
 * access immediately (deactivation, offboarding) instead of waiting for a token
 * to expire.
 */
export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the cookie value. The raw token is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [index('sessions_agent_idx').on(t.agentId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the invite token; the raw token only ever exists in the email. */
    tokenHash: text('token_hash').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    role: agentRoleEnum('role').notNull().default('agent'),
    groupIds: jsonb('group_ids').$type<string[]>().notNull().default([]),

    invitedByAgentId: uuid('invited_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('invites_token_idx').on(t.tokenHash), index('invites_email_idx').on(t.email)],
);

/** Single-use tokens for the "forgot password" flow. */
export const passwordResets = pgTable(
  'password_resets',
  {
    tokenHash: text('token_hash').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_resets_agent_idx').on(t.agentId)],
);

export const agentsRelations = relations(agents, ({ many }) => ({
  groupMembers: many(groupMembers),
  sessions: many(sessions),
  skills: many(agentSkills),
}));

export const skillsRelations = relations(skills, ({ many }) => ({
  agents: many(agentSkills),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, { fields: [agentSkills.agentId], references: [agents.id] }),
  skill: one(skills, { fields: [agentSkills.skillId], references: [skills.id] }),
}));

export const groupsRelations = relations(groups, ({ many }) => ({
  members: many(groupMembers),
}));

export const groupMembersRelations = relations(groupMembers, ({ one }) => ({
  group: one(groups, { fields: [groupMembers.groupId], references: [groups.id] }),
  agent: one(agents, { fields: [groupMembers.agentId], references: [agents.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  agent: one(agents, { fields: [sessions.agentId], references: [agents.id] }),
}));
