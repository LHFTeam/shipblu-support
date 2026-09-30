import { sql } from 'drizzle-orm';
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
import {
  agentPresenceEnum,
  agentRoleEnum,
  assignmentStrategyEnum,
  availabilityReasonEnum,
} from './enums';

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
     * The colour of this agent's tile in the inbox and the header: a key from
     * `AGENT_COLORS` in `lib/auth/agent-colors.ts`, never a CSS value.
     *
     * Stored rather than derived because it has to stay put. A colour hashed
     * from the id moves the moment the palette changes size, and one picked from
     * the agent's rank moves when anything ahead of them in the order does; an
     * agent who has learned "mine are the violet ones" would lose that silently.
     * So it is assigned once, as the palette's least-used colour, by a
     * `BEFORE INSERT` trigger in `db/sql/006_agent_avatar_colors.sql` — which
     * every path that creates an agent goes through without having to remember
     * — and nothing writes it after that.
     */
    avatarColor: text('avatar_color'),

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
     * Last input observed in the console — a key, a pointer, a scroll — not a
     * request and not a heartbeat.
     *
     * Deliberately a different fact from `lastSeenAt` beside it, and the
     * distinction is the whole of the idle policy. A connection proves the tab
     * is open; only input proves somebody is in front of it, and the two diverge
     * for exactly the case that matters — a console left open on an empty desk
     * beats every 25 seconds for as long as the laptop is awake.
     *
     * Nothing on the request path may write this. A background poll, an RSC
     * prefetch or the presence keepalive refreshing it would make every idle
     * timer unreachable while making the column look like it was working, which
     * is the failure mode that is invisible until somebody checks why nobody has
     * ever been marked away.
     */
    lastInputAt: timestamp('last_input_at', { withTimezone: true }),

    /**
     * The agent's own switch. Off means "I am here but do not route work to me"
     * — a meeting, a training call, the end of a shift spent finishing what they
     * already hold. Their existing tickets are untouched.
     *
     * Three parties write it now — the agent, the idle sweep and a supervisor —
     * so `acceptingOffReason` records which, and `acceptingChangedAt` when.
     */
    isAcceptingTickets: boolean('is_accepting_tickets').notNull().default(true),

    /** Null while accepting. See `availabilityReasonEnum` for why it is not a boolean. */
    acceptingOffReason: availabilityReasonEnum('accepting_off_reason'),

    /**
     * When the switch last moved, whoever moved it.
     *
     * The idle sweep measures from the later of this and `lastInputAt`, which is
     * what gives a supervisor's "start taking work again" a full idle window
     * before the sweep may undo it. Measuring from input alone would let the
     * sweep re-park an agent seconds after somebody deliberately un-parked them,
     * because their last keypress is by definition already old.
     */
    acceptingChangedAt: timestamp('accepting_changed_at', { withTimezone: true }),

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

    /**
     * Last input from the human holding *this* session, which is what the
     * inactivity sign-out is measured against.
     *
     * Separate from `lastUsedAt` next door, which any request refreshes — a
     * prefetch, the presence stream, a poll. That makes it the wrong clock for
     * a security timeout twice over: it never runs down while a tab is open, and
     * it is refreshed once an hour by design, which is coarser than the shortest
     * timeout an admin can set.
     *
     * Per session rather than per agent so the abandoned browser at home is
     * signed out while the laptop being typed on is not — the whole point of the
     * control.
     *
     * NOT NULL with a `now()` default, so the deploy that adds the column starts
     * every existing session's clock at the deploy rather than at the epoch. The
     * alternative signs the entire team out the moment the sweep first runs.
     */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),

    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    index('sessions_agent_idx').on(t.agentId),
    index('sessions_expires_idx').on(t.expiresAt),
    // The inactivity sweep's only predicate. Without it, signing out the idle
    // sessions is a sequential scan of every session in the system every five
    // minutes, to find the handful that have gone quiet.
    index('sessions_activity_idx').on(t.lastActivityAt),
  ],
);

/**
 * When the console decides somebody has stopped working, and what it does about
 * it.
 *
 * One row, because these are company-wide answers rather than per-team ones: an
 * agent belongs to several groups and would otherwise be governed by whichever
 * of their calendars was consulted first. `id` is pinned to 1 by a check
 * constraint in `db/sql/003_constraints.sql` — a second row would be a second
 * policy, silently applied to whoever the query happened to read.
 *
 * **Both windows are measured from the same clock**, `agents.last_input_at`, and
 * that is deliberate: two independent idle detectors would eventually disagree
 * about whether the same agent was at their desk, and the disagreement would
 * show up as somebody being signed out while the dashboard still had them
 * accepting tickets.
 *
 * Null means the timer is off. That is a real setting rather than an absence —
 * a team that does not want its people signed out mid-shift clears the field —
 * so nothing here falls back to a default once a row exists.
 *
 * The row is created on the first save. Until then `lib/presence/policy.ts`
 * answers with its own defaults, so the numbers live in exactly one place
 * instead of being duplicated between a seed migration and the code that reads
 * it back.
 */
export const presencePolicy = pgTable('presence_policy', {
  /** Always 1. The check constraint is what makes "one row" true rather than intended. */
  id: integer('id').primaryKey().default(1),

  /**
   * Minutes of no input before an agent stops being routed new work.
   *
   * Reversed automatically the moment they touch the keyboard, which is what
   * separates it from the other two ways the switch goes off — see
   * `availabilityReasonEnum`.
   */
  autoAwayAfterMins: integer('auto_away_after_mins'),

  /**
   * Minutes of no input before the session is destroyed and the agent has to
   * sign in again.
   *
   * Has to be at least the away window, and the action that writes this
   * enforces it: signing somebody out before ever marking them away means the
   * away state is unreachable, and the first symptom is a team that is
   * mysteriously signed out with nobody ever showing as away.
   */
  autoSignoutAfterMins: integer('auto_signout_after_mins'),

  /**
   * When the windows last changed, and the anchor for the grace period that
   * stops a newly-enabled timer acting retroactively — `StoredPresencePolicy`
   * in `lib/presence/idle.ts` explains why that is load-bearing rather than
   * cosmetic.
   *
   * Maintained by the `touch_updated_at` trigger that `db/sql/001` applies to
   * every table carrying the column, so a future writer that forgets to set it
   * still gets it right. That is worth knowing in the other direction too: an
   * UPDATE cannot backdate this, which is a nuisance to test against and
   * exactly the property the grace needs.
   */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByAgentId: uuid('updated_by_agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
});

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the invite token, used for the indexed acceptance lookup. */
    tokenHash: text('token_hash').notNull(),
    /**
     * AES-GCM ciphertext for showing the same link to an authenticated admin
     * while the invite is pending. Nullable because hashes from older invites
     * cannot be reversed; the database alone still contains no usable token.
     */
    tokenCiphertext: text('token_ciphertext'),
    email: text('email').notNull(),
    /**
     * Required, so the activation page can present a filled-in identity and ask
     * for nothing but a password. Nullable would push that decision to the one
     * place it cannot be made well: an invitee who has to type their own name
     * into a form the company sent them, or an agent record silently named
     * after an email address.
     */
    name: text('name').notNull(),
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

/**
 * The history `agents.presence` cannot keep.
 *
 * `presence`, `last_seen_at` and `is_accepting_tickets` are current-state
 * columns: they answer "is this agent at their desk right now", which is the
 * only question auto-assignment has. They cannot answer "when did the shift
 * start", "how long were they here" or "were they here when the queue was
 * busy", because yesterday's value is simply gone.
 *
 * One row per continuous stretch of connected time. The effective end is
 * `coalesce(ended_at, last_beat_at)` rather than `ended_at` alone, which is what
 * makes an instance killed mid-stream heal itself: it never runs its abort
 * handler, so `ended_at` stays null forever, and the last beat it managed is the
 * honest answer for when the agent stopped being there. Same reasoning as the
 * staleness check that already guards assignment eligibility — no reaper.
 *
 * `accepting` is on the interval rather than being a second table, because "here
 * but not taking new work" is a *span* of time exactly like being connected is,
 * and reporting has to add the two up the same way. Flipping the switch closes
 * the interval and opens a replacement, so available time is a `sum(...) where
 * accepting` instead of an interleaving of two event streams.
 *
 * Written only from `lib/assignment/presence.ts`. Presence still has exactly one
 * writer; this is the same writer keeping a record.
 */
export const agentPresenceIntervals = pgTable(
  'agent_presence_intervals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Moved by every SSE keepalive. The fallback end for a stream that died. */
    lastBeatAt: timestamp('last_beat_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set only on a clean sign-off. Null means "still open, or never closed". */
    endedAt: timestamp('ended_at', { withTimezone: true }),

    /** `is_accepting_tickets` as it stood for this span. */
    accepting: boolean('accepting').notNull().default(true),
  },
  (t) => [
    // The rollup's query: one agent's intervals overlapping a day.
    index('agent_presence_intervals_agent_idx').on(t.agentId, t.startedAt),
    // Finding the row to extend on a beat. Partial, because every lookup asks
    // for the open one and closed rows are the overwhelming majority within a
    // week of shipping.
    index('agent_presence_intervals_open_idx')
      .on(t.agentId, t.lastBeatAt)
      .where(sql`${t.endedAt} is null`),
  ],
);
