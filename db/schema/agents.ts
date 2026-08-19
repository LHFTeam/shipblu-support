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
import { agentPresenceEnum, agentRoleEnum } from './enums';

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

    presence: agentPresenceEnum('presence').notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),

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
