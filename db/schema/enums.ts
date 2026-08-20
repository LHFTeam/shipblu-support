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
 * Single-use links emailed to a customer setting up, or recovering, their
 * portal sign-in. One table covers both because the lifecycle is identical —
 * issue, email, redeem once, expire — and only the effect of redeeming differs.
 */
export const contactTokenPurposeEnum = pgEnum('contact_token_purpose', [
  'verify_email',
  'reset_password',
]);

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

/**
 * How much we actually know about a shipment or a shipping account.
 *
 * A row is created the moment a tracking number or an SBID is seen in a message,
 * long before anything authoritative is known about it. `stub` says so out loud:
 * the row exists to hang links off, and every other column on it is null.
 *
 * `not_found` is the value that earns its place. It is what a detection false
 * positive becomes once the platform has been asked, which is what makes one
 * cleanable — nulls alone cannot tell "we have not asked" apart from "we asked
 * and there is nothing there", and those are different sentences to put in front
 * of an agent.
 */
export const shipmentSyncStateEnum = pgEnum('shipment_sync_state', ['stub', 'synced', 'not_found']);

/**
 * Who asserted a link.
 *
 * Kept on every link table because the three carry very different weight:
 * `platform` is authoritative, `manual` is an agent taking responsibility, and
 * `detected` is a regular expression's opinion. Only the last is ever removed in
 * bulk when a pattern turns out to have been wrong, which is the whole reason
 * the column exists.
 */
export const linkSourceEnum = pgEnum('link_source', ['detected', 'manual', 'platform']);

/**
 * Where a side conversation stands.
 *
 * Two values on purpose. A side conversation is a question and its answer, not a
 * ticket: it is open until the agent has what they asked for, and then it is
 * done. Giving it the four-category status vocabulary of `conversations` would
 * invite an SLA policy, a queue and a report onto a thread that has none of
 * those things — and `done` is the word both Zendesk and Freshworks settled on.
 */
export const sideConversationStateEnum = pgEnum('side_conversation_state', ['open', 'done']);

/**
 * What kind of internal party a directory entry names.
 *
 * Only used to group the recipient picker. It is deliberately not a permission
 * or a routing rule — a hub and a vendor are written to identically, and the
 * only difference an agent cares about is finding the right one in a list that
 * will eventually hold every hub in the country.
 */
export const internalRecipientKindEnum = pgEnum('internal_recipient_kind', [
  'hub',
  'team',
  'vendor',
]);
