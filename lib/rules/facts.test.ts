import { describe, expect, it } from 'vitest';
import type { conversations } from '@/db/schema';
import { conversationFacts, type FactSource } from './facts';

const now = new Date('2026-09-02T12:00:00Z');
const overdue = new Date('2026-09-02T09:00:00Z');

function source(overrides: Partial<typeof conversations.$inferSelect>): FactSource {
  return {
    conversation: {
      customFields: {},
      tags: [],
      firstResponseDueAt: overdue,
      firstRespondedAt: null,
      firstAutoRepliedAt: null,
      resolutionDueAt: null,
      resolvedAt: null,
      ...overrides,
    } as typeof conversations.$inferSelect,
    statusCategory: 'open',
  };
}

describe('is_first_response_overdue', () => {
  it('is true while nothing has answered', () => {
    expect(conversationFacts(source({}), now).is_first_response_overdue).toBe(true);
  });

  it('is false once an agent has answered', () => {
    const facts = conversationFacts(source({ firstRespondedAt: overdue }), now);
    expect(facts.is_first_response_overdue).toBe(false);
  });

  // An acknowledgement is not a first response, so this stays true: the sweep
  // records the breach and a rule that escalates an overdue ticket — priority,
  // an assignee, a watcher — still fires. Reading the auto-reply stamp here to
  // stop a *sender* re-running silenced those escalations too, for every ticket
  // that had been auto-acknowledged. The re-send is guarded where the sending
  // happens instead.
  it('stays true after an automation has acknowledged', () => {
    const facts = conversationFacts(source({ firstAutoRepliedAt: overdue }), now);
    expect(facts.is_first_response_overdue).toBe(true);
  });

  it('exposes the acknowledgement separately, so a rule can ask for it by name', () => {
    const answered = conversationFacts(source({ firstAutoRepliedAt: overdue }), now);
    expect(answered.hours_since_auto_reply).toBe(3);

    // Null rather than 0 when nothing has gone out: `is_empty` catches that and
    // a comparison does not, so "no reply yet" cannot match every ticket.
    expect(conversationFacts(source({}), now).hours_since_auto_reply).toBeNull();
  });
});
