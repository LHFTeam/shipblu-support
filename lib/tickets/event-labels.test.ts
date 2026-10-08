import { describe, expect, it } from 'vitest';
import { describeEvent } from './event-labels';

/**
 * The branches where a timeline sentence goes wrong without anything failing:
 * a payload read back untyped from jsonb, a fallback that lets an empty string
 * through, a plural, and the default that prints the type and drops the data.
 */

describe('describeEvent', () => {
  it('names the claimed address, and the client address only when there is one', () => {
    expect(describeEvent('unverified_submitter', { email: 'a@b.test', ip: '203.0.113.9' })).toBe(
      'submitted without signing in, as a@b.test from 203.0.113.9',
    );
    expect(describeEvent('unverified_submitter', { email: 'a@b.test' })).toBe(
      'submitted without signing in, as a@b.test',
    );
    expect(describeEvent('unverified_submitter', {})).toBe(
      'submitted without signing in, as an unknown address',
    );
  });

  it('names why the due dates moved', () => {
    expect(describeEvent('sla_recalculated', { reason: 'priority', priority: 'urgent' })).toBe(
      're-counted the due dates for urgent priority',
    );
    expect(describeEvent('sla_recalculated', { reason: 'group_hours' })).toBe(
      "re-counted the due dates on the new group's business hours",
    );
  });

  it('explains a skipped assignment, and falls back to the raw reason it does not know', () => {
    expect(describeEvent('assignment_skipped', { reason: 'all_at_capacity' })).toBe(
      'could not assign it: everybody available was at their ticket limit',
    );
    expect(describeEvent('assignment_skipped', { reason: 'new_reason' })).toBe(
      'could not assign it: new_reason',
    );
  });

  it('pluralises detected shipments and accounts separately', () => {
    expect(describeEvent('shipments_detected', { trackingNumbers: ['SB1'], sbids: [] })).toBe(
      'linked shipment SB1 from a message',
    );
    expect(
      describeEvent('shipments_detected', { trackingNumbers: ['SB1', 'SB2'], sbids: ['42'] }),
    ).toBe('linked shipments SB1, SB2 and account 42 from a message');
    // Not a list: jsonb gives no guarantee, so it counts as none.
    expect(describeEvent('shipments_detected', { trackingNumbers: 'SB1', sbids: ['1', '2'] })).toBe(
      'linked accounts 1, 2 from a message',
    );
  });

  it('prints the value a custom field was set to, and says when it was cleared', () => {
    expect(describeEvent('custom_field_changed', { label: 'Warehouse', to: 'Cairo' })).toBe(
      'set Warehouse to Cairo',
    );
    expect(describeEvent('custom_field_changed', { key: 'tags', to: ['a', 'b'] })).toBe(
      'set tags to a, b',
    );
    for (const to of [null, undefined, '']) {
      expect(describeEvent('custom_field_changed', { label: 'Warehouse', to })).toBe(
        'cleared Warehouse',
      );
    }
  });

  // `||` rather than `??` in these three: an empty summary must fall back, or
  // the sentence ends mid-word.
  it.each([
    ['meta_postback', 'tapped a button'],
    ['meta_referral', 'arrived from a link'],
    ['meta_reaction', 'reacted with a reaction'],
  ])('%s falls back on an empty summary', (type, sentence) => {
    expect(describeEvent(type, { summary: '' })).toBe(sentence);
  });

  it('says whether the widget identity was verified', () => {
    expect(
      describeEvent('contact_identified', {
        name: 'Amira',
        accountName: 'Shop',
        accountId: 7,
        verified: true,
      }),
    ).toBe('identified the visitor as Amira, account Shop · 7');
    expect(describeEvent('contact_identified', { name: '  ' })).toBe(
      "identified the visitor as somebody it did not name — the dashboard's word, not verified",
    );
  });

  it('reads the categorisation payloads, including the unreachable empty one', () => {
    expect(describeEvent('categorised', { applied: ['wismo'], suggested: ['refund'] })).toBe(
      'filed it under wismo and suggested refund',
    );
    expect(describeEvent('categorised', {})).toBe('read the message and found nothing to file');
    expect(describeEvent('root_cause_set', { rootCauseKey: 'courier_delay' })).toBe(
      'recorded the cause as courier_delay',
    );
    expect(describeEvent('root_cause_set', { rootCauseKey: null })).toBe(
      'cleared the recorded cause',
    );
  });

  it('only treats a literal true as a permission refusal', () => {
    expect(describeEvent('profile_refresh_refused', { permission: 'true' })).toBe(
      'asked Meta for the customer’s profile and was refused',
    );
  });

  it('prints an unknown type with its underscores as spaces', () => {
    expect(describeEvent('something_new_happened', { anything: 1 })).toBe('something new happened');
  });
});
