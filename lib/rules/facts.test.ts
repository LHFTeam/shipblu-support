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

  // The fifteen-minute sweep re-reads this fact on every run, and an automation
  // is the one actor that cannot clear it by replying. Leaving it true after an
  // acknowledgement went out is what turns a chase rule into a rule that sends
  // the customer the same message four times an hour until somebody opens the
  // ticket.
  it('is false once an automation has acknowledged, so the rule stops re-firing', () => {
    const facts = conversationFacts(source({ firstAutoRepliedAt: overdue }), now);
    expect(facts.is_first_response_overdue).toBe(false);
  });

  // The other half of the same decision: the ticket is still unanswered as far
  // as the SLA is concerned. `firstRespondedAt` is what the breach sweep and
  // every report read, and an acknowledgement must not have touched it.
  it('leaves the SLA column an automation must not satisfy alone', () => {
    const acknowledged = source({ firstAutoRepliedAt: overdue });
    expect(acknowledged.conversation.firstRespondedAt).toBeNull();
  });
});
