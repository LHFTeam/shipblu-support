import type { conversations } from '@/db/schema';
import { normaliseCustom, type Facts } from './conditions';

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
  /**
   * The slug of the form the ticket was submitted through, when it was.
   *
   * The slug rather than the id: a rule is read and written by a person, and
   * `form.slug is damaged-parcel` says what it routes on where a uuid says
   * nothing. Undefined here and null in the facts mean the same thing to
   * `is_empty` — the caller does not have to look the form up to build facts.
   */
  formSlug?: string | null;
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
    'form.slug': source.formSlug ?? null,

    created_at: c.createdAt,
    hours_since_created: hoursSince(c.createdAt, now),
    hours_since_last_message: hoursSince(c.lastMessageAt, now),
    hours_since_last_customer_message: hoursSince(c.lastCustomerMessageAt, now),
    hours_since_last_agent_message: hoursSince(c.lastAgentMessageAt, now),
    // Null until software has answered, which `is_empty` catches and a
    // comparison does not — so a rule can say "overdue and nothing has gone out
    // yet" without the overdue flag having to lie about what the SLA knows.
    hours_since_auto_reply: hoursSince(c.firstAutoRepliedAt, now),
    hours_since_resolved: hoursSince(c.resolvedAt, now),
    // How long the current assignee has held it. Null when nobody does, which
    // `is_empty` catches and a comparison does not — so "assigned more than four
    // hours ago and still no reply" cannot accidentally match every unassigned
    // ticket in the queue.
    hours_since_assigned: hoursSince(c.assignedAt, now),

    // The overdue flags are what a time-based rule keys off to chase a ticket
    // that is about to embarrass someone, without having to restate the SLA's
    // own arithmetic in the rule.
    //
    // `firstRespondedAt` only, and an automated acknowledgement is not that.
    // Reading the auto-reply stamp here as well was an attempt to stop a rule
    // re-sending on every sweep, and it silenced far more than the sender: a
    // rule that escalates an overdue ticket — priority, an assignee, a watcher
    // — sends the customer nothing and never needed stopping, but stopped
    // firing for every ticket that had been auto-acknowledged, while the sweep
    // went on recording the breach nobody was now told about. The re-send is
    // the sender's problem and is guarded where the sending happens.
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
