import { describe, expect, it } from 'vitest';
import { evaluate, matches, parseCondition, type Facts } from './conditions';

const ticket: Facts = {
  priority: 'high',
  channel: 'email',
  'status.category': 'open',
  tags: ['VIP', 'cod'],
  subject: 'Where is my shipment?',
  'assignee.id': null,
  hours_since_created: 6,
  created_at: new Date('2026-08-17T09:00:00Z'),
};

describe('parseCondition', () => {
  it('accepts the empty object, which is how a default policy is written', () => {
    expect(parseCondition({})).toEqual({});
  });

  it('parses nested groups', () => {
    const parsed = parseCondition({
      all: [
        { field: 'priority', op: 'eq', value: 'high' },
        { any: [{ field: 'tags', op: 'contains', value: 'vip' }] },
      ],
    });
    expect(parsed).not.toBeNull();
  });

  it('rejects anything that is not a condition', () => {
    expect(parseCondition(null)).toBeNull();
    expect(parseCondition('priority = high')).toBeNull();
    expect(parseCondition([])).toBeNull();
    expect(parseCondition({ field: 'priority' })).toBeNull();
    expect(parseCondition({ field: 'priority', op: 'matches' })).toBeNull();
    expect(parseCondition({ all: 'everything' })).toBeNull();
    // One bad branch invalidates the group rather than being dropped silently:
    // a rule that quietly loses half its conditions is worse than one that
    // stops matching.
    expect(
      parseCondition({ all: [{ field: 'priority', op: 'eq' }, { nonsense: true }] }),
    ).toBeNull();
  });
});

describe('evaluate', () => {
  it('matches everything when there are no conditions', () => {
    expect(evaluate({}, ticket)).toBe(true);
  });

  it('compares scalars case-insensitively', () => {
    expect(matches({ field: 'priority', op: 'eq', value: 'HIGH' }, ticket)).toBe(true);
    expect(matches({ field: 'priority', op: 'ne', value: 'low' }, ticket)).toBe(true);
  });

  it('handles membership both ways round', () => {
    expect(matches({ field: 'priority', op: 'in', value: ['high', 'urgent'] }, ticket)).toBe(true);
    expect(matches({ field: 'priority', op: 'not_in', value: ['low'] }, ticket)).toBe(true);
    // `tags` is an array fact, so membership is `contains`.
    expect(matches({ field: 'tags', op: 'contains', value: 'vip' }, ticket)).toBe(true);
    expect(matches({ field: 'tags', op: 'not_contains', value: 'refund' }, ticket)).toBe(true);
  });

  it('does substring matching on text', () => {
    expect(matches({ field: 'subject', op: 'contains', value: 'shipment' }, ticket)).toBe(true);
    expect(matches({ field: 'subject', op: 'starts_with', value: 'where' }, ticket)).toBe(true);
    expect(matches({ field: 'subject', op: 'ends_with', value: '?' }, ticket)).toBe(true);
  });

  it('orders numbers and dates', () => {
    expect(matches({ field: 'hours_since_created', op: 'gte', value: 4 }, ticket)).toBe(true);
    expect(matches({ field: 'hours_since_created', op: 'lt', value: 4 }, ticket)).toBe(false);
    expect(matches({ field: 'created_at', op: 'lt', value: '2026-08-18T00:00:00Z' }, ticket)).toBe(
      true,
    );
  });

  it('tells absent from set', () => {
    expect(matches({ field: 'assignee.id', op: 'is_empty' }, ticket)).toBe(true);
    expect(matches({ field: 'assignee.id', op: 'is_set' }, ticket)).toBe(false);
    expect(matches({ field: 'priority', op: 'is_set' }, ticket)).toBe(true);
  });

  it('treats an unknown field as absent rather than as an error', () => {
    // Rules outlive the custom fields they were written against.
    expect(matches({ field: 'custom.deleted_field', op: 'is_empty' }, ticket)).toBe(true);
    expect(matches({ field: 'custom.deleted_field', op: 'eq', value: 'x' }, ticket)).toBe(false);
  });

  it('combines groups', () => {
    const condition = {
      all: [
        { field: 'status.category', op: 'eq', value: 'open' },
        {
          any: [
            { field: 'priority', op: 'eq', value: 'urgent' },
            { field: 'tags', op: 'contains', value: 'vip' },
          ],
        },
        { not: { field: 'channel', op: 'eq', value: 'whatsapp' } },
      ],
    };
    expect(matches(condition, ticket)).toBe(true);
    expect(matches(condition, { ...ticket, channel: 'whatsapp' })).toBe(false);
  });

  it('does not match when the condition is malformed', () => {
    // Fail closed. A policy whose conditions are corrupt must not silently
    // become the policy that applies to every ticket.
    expect(matches({ field: 'priority', op: 'wat', value: 'high' }, ticket)).toBe(false);
    expect(matches('anything', ticket)).toBe(false);
  });
});
