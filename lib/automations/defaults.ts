import type { Action } from './actions';
import type { Condition } from '@/lib/rules/conditions';

/**
 * Automation rules the system ships with, rather than waiting for an admin.
 *
 * Seeded rather than documented because the absence of the close rule is not a
 * missing convenience — it changes what the customer sees. Every channel
 * decides whether an inbound message continues the last thread or opens a new
 * one by stopping at `closed` (`lib/widget/session.ts`,
 * `lib/tickets/ingest-whatsapp.ts`, `lib/tickets/ingest-meta.ts`), so with
 * nothing ever reaching `closed` a customer who writes every week is answered
 * inside one thread that never ends: its subject is frozen on the first message
 * it ever carried, and its handling time is measured from that day.
 */

export type SeededRule = {
  name: string;
  trigger: 'on_create' | 'on_update' | 'time_based';
  conditions: Condition;
  actions: Action[];
  position: number;
};

/** Three days, in the hours `hours_since_resolved` is measured in. */
export const CLOSE_AFTER_HOURS = 72;

/**
 * Resolved means "we think this is finished"; closed means "and the next
 * message is a new conversation". The gap between them is the customer's window
 * to say we were wrong, and a reply inside it reopens the ticket on every
 * channel we run.
 *
 * Three days matches what the market settled on — Intercom auto-closes after 3,
 * Zendesk's stock automation closes 4 days after solved — and it is short
 * enough that a customer asking about a different shipment each week gets a
 * ticket per shipment rather than one endless thread.
 *
 * Wall-clock hours, not working hours, and that asymmetry is deliberate: an SLA
 * clock measures what we owe the customer and must not run over a weekend, but
 * this window is the customer's own to spend, and theirs includes Friday.
 *
 * `status.category` is redundant against `hours_since_resolved` today —
 * `resolved_at` is nulled whenever a ticket leaves resolved, so a reopened
 * ticket already reads null and null never satisfies `gte`. It is stated anyway
 * because this rule is editable in the admin screen, and an admin reading
 * "resolved for 72 hours" should not have to know that to trust it.
 */
export const CLOSE_RESOLVED_RULE: SeededRule = {
  name: 'Close resolved tickets after 3 days',
  trigger: 'time_based',
  conditions: {
    all: [
      { field: 'status.category', op: 'eq', value: 'resolved' },
      { field: 'hours_since_resolved', op: 'gte', value: CLOSE_AFTER_HOURS },
    ],
  },
  actions: [{ type: 'set_status', category: 'closed' }],
  // Last, so a team's own rules get the ticket first. A rule that closes is the
  // one rule where order is not cosmetic: anything meant to chase, tag or
  // survey a resolved ticket has to have run before it leaves the sweep's
  // population for good.
  position: 100,
};

export const SEEDED_RULES: SeededRule[] = [CLOSE_RESOLVED_RULE];
