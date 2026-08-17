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
