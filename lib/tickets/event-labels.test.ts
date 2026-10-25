import { describe, expect, it } from 'vitest';
import { describeActorLabel, describeEvent } from './event-labels';

/**
 * The branches where a timeline sentence goes wrong without anything failing:
 * a payload read back untyped from jsonb, a fallback that lets an empty string
 * through, a plural, and the default that prints the type and drops the data.
 */

describe('describeEvent', () => {
  it('says what the survey did, and why it did nothing', () => {
    expect(describeEvent('csat_sent', { delivery: 'email_link' })).toBe(
      'sent a satisfaction survey by email',
    );
    expect(describeEvent('csat_sent', { delivery: 'text_link' })).toBe(
      'sent a satisfaction survey as a message',
    );
    expect(describeEvent('csat_skipped', { reason: 'agent_suppressed' })).toBe(
      'did not send a satisfaction survey: an agent asked that this ticket not be surveyed',
    );
    expect(describeEvent('csat_skipped', { reason: 'rule_suppressed' })).toBe(
      'did not send a satisfaction survey: an automation rule asked that this ticket not be surveyed',
    );
    // A reason written by a later version, read by this one, still makes a sentence.
    expect(describeEvent('csat_skipped', { reason: 'expired' })).toBe(
      'did not send a satisfaction survey: for a reason this version does not know',
    );
    expect(describeEvent('csat_sent', { delivery: 'widget_card' })).toBe(
      'sent a satisfaction survey as a card in the chat',
    );
    expect(describeEvent('csat_received', { rating: 4, source: 'widget' })).toBe(
      'rated the support 4 / 5 in the chat widget',
    );
    expect(describeEvent('csat_received', { rating: 2, source: 'page' })).toBe(
      'rated the support 2 / 5 on the survey page',
    );
    expect(describeEvent('csat_sent', { delivery: 'meta_template' })).toBe(
      'sent a satisfaction survey as Messenger’s feedback card',
    );
    expect(describeEvent('csat_received', { rating: 5, source: 'meta_feedback' })).toBe(
      'rated the support 5 / 5 on Messenger’s feedback card',
    );
    expect(describeEvent('csat_received', { rating: 3, source: 'meta_quick_reply' })).toBe(
      'rated the support 3 / 5 with a rating button in the conversation',
    );
    expect(describeEvent('csat_fell_back', { delivery: 'meta_quick_reply' })).toBe(
      'switched the satisfaction survey to rating buttons: Messenger refused its feedback card',
    );
    expect(describeEvent('csat_thanked', {})).toBe('thanked the customer for their rating');
    expect(describeEvent('csat_skipped', { reason: 'no_privacy_url' })).toBe(
      'did not send a satisfaction survey: past the 24 hours only Messenger’s survey card sends, and it needs a privacy policy link that is not set',
    );
    // Recorded before the event carried a source.
    expect(describeEvent('csat_received', { rating: 4 })).toBe('rated the support 4 / 5');
    expect(describeEvent('csat_received', {})).toBe('rated the support');
  });

  it('says who a low rating’s email was queued for, and when it reached nobody', () => {
    expect(describeEvent('csat_low_rating', { rating: 1, agentIds: ['a', 'b'] })).toBe(
      'queued an email to 2 supervisors about the 1 / 5 rating',
    );
    expect(describeEvent('csat_low_rating', { rating: 2, agentIds: ['a'] })).toBe(
      'queued an email to 1 supervisor about the 2 / 5 rating',
    );
    expect(describeEvent('csat_low_rating', { rating: 2, agentIds: [] })).toBe(
      'had nobody to email about the 2 / 5 rating: nobody who can sign in sees both the satisfaction report and every ticket',
    );
    // An untyped payload makes a sentence, not "undefined".
    expect(describeEvent('csat_low_rating', {})).toBe(
      'had nobody to email about the rating: nobody who can sign in sees both the satisfaction report and every ticket',
    );
  });

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

  it('says how sure the classifier was, and nothing extra for a person', () => {
    expect(describeEvent('priority_changed', { to: 'urgent', probability: 0.824 })).toBe(
      'set priority to urgent (82% likely)',
    );
    expect(describeEvent('priority_changed', { to: 'high' })).toBe('set priority to high');
    expect(describeEvent('priority_changed', { to: 'high', probability: null })).toBe(
      'set priority to high',
    );
  });

  it('names the category chosen, as it was called then, and how sure Jev was', () => {
    expect(describeEvent('category_changed', { to: 'c-1', key: 'sales', label: 'Sales' })).toBe(
      'set the category to Sales',
    );
    expect(describeEvent('category_changed', { to: 'c-1', key: 'sales', label: null })).toBe(
      'set the category to sales',
    );
    expect(
      describeEvent('category_changed', { to: 'c-1', label: 'Sales', probability: 0.912 }),
    ).toBe('set the category to Sales (91% likely)');
    expect(describeEvent('category_changed', { from: 'c-1', to: null })).toBe(
      'cleared the category',
    );
  });

  it('names the policy a ticket is held to once its category or group chose it', () => {
    expect(
      describeEvent('sla_recalculated', { reason: 'policy', cause: 'category', policy: 'Sales' }),
    ).toBe('held the ticket to the Sales SLA policy, which matches its category now');
    expect(
      describeEvent('sla_recalculated', { reason: 'policy', cause: 'group', policy: 'Merchant' }),
    ).toBe('held the ticket to the Merchant SLA policy, which matches its group now');
  });

  it('names why the due dates moved', () => {
    expect(describeEvent('sla_recalculated', { reason: 'priority', priority: 'urgent' })).toBe(
      're-counted the due dates for urgent priority',
    );
    expect(describeEvent('sla_recalculated', { reason: 'group_hours' })).toBe(
      "re-counted the due dates on the new group's business hours",
    );
  });

  it('says why the requester moved to the author of the thread’s first comment', () => {
    expect(describeEvent('requester_changed', { reason: 'thread_root' })).toBe(
      'made the author of the thread’s first comment the requester: a reply under it had arrived first and opened the ticket',
    );
    expect(describeEvent('requester_changed', {})).toBe('changed the requester');
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

  it('reads the subcategorisation payloads, including the unreachable empty one', () => {
    for (const type of ['categorised', 'subcategorised']) {
      expect(describeEvent(type, { applied: ['wismo'], suggested: ['refund'] })).toBe(
        'filed it under wismo and suggested refund',
      );
      expect(describeEvent(type, {})).toBe('read the message and found nothing to file');
    }
    expect(describeEvent('root_cause_set', { rootCauseKey: 'courier_delay' })).toBe(
      'recorded the cause as courier_delay',
    );
    expect(describeEvent('root_cause_set', { rootCauseKey: null })).toBe(
      'cleared the recorded cause',
    );
  });

  // Written under the old names and key until Stage 2.A and the new ones since;
  // stored rows keep theirs, so a ticket's history holds both for good.
  it('reads an agent’s subcategory decisions under both names and both keys', () => {
    for (const [prefix, key] of [
      ['category', 'categoryKey'],
      ['subcategory', 'subcategoryKey'],
    ] as const) {
      expect(describeEvent(`${prefix}_added`, { [key]: 'wismo' })).toBe('filed this under wismo');
      expect(describeEvent(`${prefix}_confirmed`, { [key]: 'wismo' })).toBe('confirmed wismo');
      expect(describeEvent(`${prefix}_rejected`, { [key]: 'wismo' })).toBe('rejected wismo');
      expect(describeEvent(`${prefix}_removed`, { [key]: 'wismo' })).toBe('removed wismo');
    }
    expect(describeEvent('subcategory_added', {})).toBe('filed this under a subcategory');
    expect(describeEvent('subcategory_rejected', {})).toBe('rejected a suggested subcategory');
  });

  it('prints the rules detector under one name, whichever it signed with', () => {
    expect(describeActorLabel('category-detector')).toBe('subcategory-detector');
    expect(describeActorLabel('subcategory-detector')).toBe('subcategory-detector');
    expect(describeActorLabel('shipment-detector')).toBe('shipment-detector');
    expect(describeActorLabel(null)).toBeNull();
  });

  it('only treats a literal true as a permission refusal', () => {
    expect(describeEvent('profile_refresh_refused', { permission: 'true' })).toBe(
      'asked Meta for the customer’s profile and was refused',
    );
  });

  // Every one of these is an `assigned` or an `accountable_changed` written by
  // nobody, so without the reason the timeline said "reassigned the ticket" and
  // the reason a ticket is somebody's could not be read anywhere.
  it('says when a ticket went to its WhatsApp number’s owner, and why', () => {
    expect(describeEvent('assigned', { to: 'a', reason: 'number_owner' })).toBe(
      'gave the ticket to the owner of the WhatsApp number it arrived on',
    );
    expect(describeEvent('assigned', { to: 'a', reason: 'number_handover' })).toBe(
      'gave the ticket to the new owner of its WhatsApp number',
    );
    // Any other assignment, from before the reason existed or by a person.
    expect(describeEvent('assigned', { to: 'a' })).toBe('reassigned the ticket');
    expect(describeEvent('assigned', { to: 'a', strategy: 'round_robin' })).toBe(
      'reassigned the ticket',
    );
  });

  it('says who answers for the SLA after a handover, a reopen, or the number going to nobody', () => {
    expect(
      describeEvent('accountable_changed', { from: null, to: 'a', reason: 'number_handover' }),
    ).toBe(
      'made the new owner of its WhatsApp number accountable for the ticket: breaches on it count against them',
    );
    expect(
      describeEvent('accountable_changed', { from: 'a', to: null, reason: 'number_handover' }),
    ).toBe(
      'cleared who is accountable for the ticket: its WhatsApp number has no owner now, so breaches count against whoever holds it',
    );
    expect(
      describeEvent('accountable_changed', {
        from: 'a',
        to: 'b',
        reason: 'reopened_after_handover',
      }),
    ).toBe(
      "made the owner of its WhatsApp number accountable for the ticket when the customer wrote again: it did not name the number's current owner",
    );
    expect(
      describeEvent('accountable_changed', {
        from: 'a',
        to: null,
        reason: 'reopened_after_handover',
      }),
    ).toBe(
      'cleared who is accountable for the ticket when the customer wrote again: its WhatsApp number has no active owner now, so breaches count against whoever holds it',
    );
    // An agent or a rule reopening it says so, rather than crediting a message
    // the customer never sent.
    expect(
      describeEvent('accountable_changed', { from: 'a', to: 'b', reason: 'reopened_by_status' }),
    ).toBe(
      "made the owner of its WhatsApp number accountable for the ticket when it was reopened: it did not name the number's current owner",
    );
  });

  it('prints an unknown type with its underscores as spaces', () => {
    expect(describeEvent('something_new_happened', { anything: 1 })).toBe('something new happened');
  });
});
