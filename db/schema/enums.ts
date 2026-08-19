import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * `channel` is the discriminator that lets Freshdesk-style tickets and
 * Freshchat-style conversations share one table. Values are additive: later
 * phases append to this list without touching existing rows.
 */
export const channelEnum = pgEnum('channel', [
  'email',
  'whatsapp',
  'webchat',
  'facebook',
  'instagram',
  'portal',
  'api',
  // A WhatsApp number owned by another service — today the customer bot. Its
  // own value rather than `whatsapp` with a flag, because the discriminator is
  // what every read, filter and report already keys on, and because threading
  // is per channel: sharing `whatsapp` would collapse a customer's bot
  // transcript and their support ticket into one conversation.
  'whatsapp_bot',
]);

export const directionEnum = pgEnum('direction', ['inbound', 'outbound']);

/**
 * `note` is a private agent-only note; `system` is an automated entry such as
 * "SLA breached" or "merged from #123". Keeping all three in one table means the
 * conversation timeline is a single ordered query.
 */
export const messageKindEnum = pgEnum('message_kind', ['reply', 'note', 'system', 'forward']);

export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
  'bounced',
]);

export const priorityEnum = pgEnum('priority', ['low', 'medium', 'high', 'urgent']);

/**
 * Statuses themselves are user-configurable rows in `ticket_statuses`; this enum
 * is the fixed category each one rolls up to, which is what SLA and reporting
 * logic keys off.
 */
export const statusCategoryEnum = pgEnum('status_category', [
  'open',
  'pending',
  'resolved',
  'closed',
]);

export const agentRoleEnum = pgEnum('agent_role', [
  'account_admin',
  'admin',
  'supervisor',
  'agent',
]);

export const agentPresenceEnum = pgEnum('agent_presence', ['online', 'away', 'offline']);

export const automationTriggerEnum = pgEnum('automation_trigger', [
  'on_create',
  'on_update',
  'time_based',
]);

/**
 * Which calendar an SLA policy counts its targets against.
 *
 *  - `group`            the ticket's group's own schedule, falling back to the
 *                       default one. This is the flexible setting: a team with
 *                       its own operating days and holidays gets them without a
 *                       policy per team.
 *  - `schedule`         the one schedule named on the policy, whatever group the
 *                       ticket is in — an explicit opt out of the group override.
 *  - `round_the_clock`  no schedule at all: a 4-hour target means 4 real hours.
 */
export const slaHoursSourceEnum = pgEnum('sla_hours_source', [
  'group',
  'schedule',
  'round_the_clock',
]);

export const cannedVisibilityEnum = pgEnum('canned_visibility', ['personal', 'group', 'global']);

export const ticketFieldTypeEnum = pgEnum('ticket_field_type', [
  'text',
  'paragraph',
  'number',
  'decimal',
  'checkbox',
  'dropdown',
  'multi_select',
  'date',
  'datetime',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'dead',
]);

export const kbVisibilityEnum = pgEnum('kb_visibility', [
  'public',
  'logged_in',
  'agents_only',
  'selected_companies',
]);

export const kbArticleStatusEnum = pgEnum('kb_article_status', ['draft', 'published', 'archived']);

/**
 * Recorded on every imported row so Freshdesk/Freshchat importers can be
 * re-run idempotently against `(source_system, external_id)`.
 */
export const sourceSystemEnum = pgEnum('source_system', [
  'native',
  'freshdesk',
  'freshchat',
  'import',
]);
