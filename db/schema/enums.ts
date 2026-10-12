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

/**
 * Why an agent is not being routed work.
 *
 * Null whenever they are accepting; set only alongside the switch going off. It
 * exists because the three ways it can go off have to be undone differently, and
 * a bare boolean cannot tell them apart:
 *
 * - `self` — the agent's own switch. Only they turn it back on.
 * - `idle` — the console saw no input for the configured window. This is the
 *   one the system may undo by itself, the moment they touch the keyboard
 *   again, because nobody decided it.
 * - `supervisor` — somebody else set it. Never auto-restored: a supervisor who
 *   parks an agent must not have that undone by a mouse move, and an agent who
 *   disagrees can still turn their own switch back on.
 *
 * Without the distinction, returning from lunch would silently resurrect an
 * "away" a supervisor set for a reason, or a manual away would be treated as
 * idleness and re-enabled by the first keypress.
 */
export const availabilityReasonEnum = pgEnum('availability_reason', ['self', 'idle', 'supervisor']);

/**
 * How a group hands a ticket to a person.
 *
 * `manual` is the default and means what the product did before this existed:
 * the ticket sits in the group queue until somebody picks it up. Skills are not
 * a fourth value here — they are a *filter* over the candidates, kept as a
 * separate `match_skills` flag on the group, so turning skill matching on does
 * not make an admin re-choose how the survivors are distributed.
 */
export const assignmentStrategyEnum = pgEnum('assignment_strategy', [
  'manual',
  'round_robin',
  'load_balanced',
]);

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
 * **No `hub`.** A hub is a `locations` row — that register already exists, holds
 * the places ShipBlu works out of, and carries the shared mailbox that reaches
 * whoever is there. Repeating hubs here would mean a hub's address is
 * maintained in two admin screens with nothing keeping them in step, which is
 * the exact failure `locations` was entered to prevent.
 *
 * What is left is everything that is not a place: Finance, a courier partner, a
 * customs broker. Only used to group the picker — the two are written to
 * identically, and the difference an agent cares about is finding the right one
 * in a list.
 */
export const internalRecipientKindEnum = pgEnum('internal_recipient_kind', ['team', 'vendor']);

/**
 * Which kind of customer a ticket came from.
 *
 * ShipBlu serves two populations whose support needs barely overlap. A
 * **merchant** asks about payouts, price lists, pickups and integrations; a
 * **recipient** asks where their parcel is and why nobody called. Reporting them
 * together averages two different businesses into one meaningless line, which is
 * why this is a dimension rather than something inferred at read time from
 * whether a shipping account happens to be linked.
 *
 * `prospect` is separate from `merchant` because it is the one that pays for
 * itself: somebody asking for a price list before they have signed up is a sales
 * lead sitting in a support queue, and until it can be counted nobody knows how
 * many are being answered as though they were complaints.
 *
 * `other` is for real inbound that is not support at all — job applications and
 * couriers offering to distribute, both of which arrive often enough on Facebook
 * to distort every other number if they are filed as customers.
 *
 * **Only `merchant` and `recipient` are written**, by `requesterKindFrom()` in
 * `lib/categorise/requester.ts`, and only from records — the contact's role
 * flags and whether they hold a shipping account. Null means "not established",
 * which is a different claim from any of these four and the only honest one
 * when the records do not say: `refreshContactRoles()` is documented as
 * additive, so a recipient whose parcel has not synced carries no flag at all
 * and calling them a `prospect` would be inventing the very number the column
 * exists to make countable.
 *
 * `prospect` and `other` are therefore unreachable by detection on purpose.
 * Deciding a stranger is a sales lead needs somebody to read what they wrote,
 * and a detector guessing it from vocabulary is the same mistake as a detector
 * guessing a root cause.
 */
export const requesterKindEnum = pgEnum('requester_kind', [
  'merchant',
  'recipient',
  'prospect',
  'other',
]);

/**
 * Who a category is meant for.
 *
 * Only used to narrow the picker an agent sees: offering `billing.payout` on a
 * recipient's "where is my parcel" ticket is how a taxonomy of fifty entries
 * becomes one where people choose the first plausible row and move on. `any` is
 * the honest answer for the categories both populations really do raise — a
 * damaged parcel is the same complaint whichever end of it you are on.
 */
export const categoryAudienceEnum = pgEnum('category_audience', ['merchant', 'recipient', 'any']);

/**
 * Where a category assignment stands with a human.
 *
 * `auto` was applied without asking because the evidence named the category
 * outright; `suggested` is waiting for one click; `confirmed` and `rejected` are
 * a person's answer.
 *
 * **A rejected row is kept, never deleted**, and that is the whole
 * human-in-the-loop mechanism rather than an audit nicety. The natural key is
 * (conversation, category), so a rejected row still occupies it: a later message
 * that would re-assert the same category hits `onConflictDoNothing` and writes
 * nothing. An agent's judgement therefore survives every subsequent message with
 * no extra machinery, and the row keeps the `rule_key` and `confidence` that
 * were wrong — the only copy of that evidence anyone will ever have, and what
 * the next round of rule tuning is measured against.
 */
export const categoryReviewStateEnum = pgEnum('category_review_state', [
  'auto',
  'suggested',
  'confirmed',
  'rejected',
]);

/**
 * Who owns fixing the thing that caused a ticket.
 *
 * Stored on the cause rather than on the ticket, so accountability is a join and
 * cannot drift: an agent records *why* it happened and the owner follows from
 * that, instead of two fields that can disagree about the same failure.
 *
 * `platform` is the value that earns its place. A ticket caused by our own app —
 * a customer who tried to cancel in the portal and could not — is one the
 * product could have prevented, and it is invisible in any taxonomy that only
 * names the parties who touch the parcel. `none` covers the two endings that are
 * not failures at all: a plain enquiry, and a parcel behaving exactly as
 * designed while the customer expected something else.
 */
export const rootCauseOwnerEnum = pgEnum('root_cause_owner', [
  'courier',
  'hub',
  'merchant',
  'recipient',
  'platform',
  'external',
  'none',
]);

/**
 * How much of a suggested canned response survived into the reply that was sent.
 *
 * Three steps rather than a similarity score, for the reason `reply-form.tsx`
 * gives about `usage_count`: a threshold on a diff is a number nobody can defend.
 * `unchanged` and `extended` need none — the stored text went out exactly, or
 * went out whole with something added round it (a greeting, a tracking number) —
 * and everything else is `reworded`, which is a fact about the reply rather than
 * a judgement about how far it moved.
 */
export const suggestionEditEnum = pgEnum('suggestion_edit', ['unchanged', 'extended', 'reworded']);
