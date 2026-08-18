import type { conversations } from '@/db/schema';
import type { Facts } from './conditions';

/**
 * The ticket vocabulary that conditions are written against.
 *
 * Deliberately a flat map of dotted names rather than the conversation row
 * itself. An admin writing a rule picks `status.category`, not a column, and
 * keeping the two apart means renaming a column does not silently break every
 * stored rule — this file is the one place the mapping lives.
 *
 * Time facts are in hours because that is how the rules read: "no reply for 4
 * hours", not "14400 seconds". They are computed against `now` rather than
 * stored so a rule sweeping at 09:00 sees the ticket as it is at 09:00.
 */

export type FactSource = {
  conversation: typeof conversations.$inferSelect;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  requesterEmail?: string | null;
};

export function conversationFacts(source: FactSource, now: Date = new Date()): Facts {
  const c = source.conversation;

  const facts: Facts = {
    channel: c.channel,
    priority: c.priority,
    type: c.type,
    subject: c.subject,
    tags: c.tags,
    is_spam: c.isSpam,
    reopen_count: c.reopenCount,

    'status.id': c.statusId,
    'status.category': source.statusCategory,
    'group.id': c.groupId,
    'assignee.id': c.assigneeAgentId,
    'requester.email': source.requesterEmail ?? null,

    created_at: c.createdAt,
    hours_since_created: hoursSince(c.createdAt, now),
    hours_since_last_message: hoursSince(c.lastMessageAt, now),
    hours_since_last_customer_message: hoursSince(c.lastCustomerMessageAt, now),
    hours_since_last_agent_message: hoursSince(c.lastAgentMessageAt, now),
    hours_since_resolved: hoursSince(c.resolvedAt, now),

    // The overdue flags are what a time-based rule keys off to chase a ticket
    // that is about to embarrass someone, without having to restate the SLA's
    // own arithmetic in the rule.
    is_first_response_overdue: isOverdue(c.firstResponseDueAt, c.firstRespondedAt, now),
    is_resolution_overdue: isOverdue(c.resolutionDueAt, c.resolvedAt, now),
    is_assigned: c.assigneeAgentId !== null,
  };

  // Custom fields are namespaced so a field keyed "priority" cannot shadow the
  // built-in one and quietly change what every existing rule means.
  for (const [key, value] of Object.entries(c.customFields)) {
    facts[`custom.${key}`] = normaliseCustom(value);
  }

  return facts;
}

/** Null for "never happened", which `is_empty` catches and comparisons do not. */
function hoursSince(at: Date | null, now: Date): number | null {
  if (!at) return null;
  return (now.getTime() - at.getTime()) / 3_600_000;
}

function isOverdue(dueAt: Date | null, satisfiedAt: Date | null, now: Date): boolean {
  if (!dueAt || satisfiedAt) return false;
  return dueAt.getTime() < now.getTime();
}

function normaliseCustom(value: unknown): Facts[string] {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}
