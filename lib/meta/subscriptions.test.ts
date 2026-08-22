import { describe, expect, it } from 'vitest';
import {
  type GraphSubscription,
  GraphSubscriptionError,
  planFieldSubscription,
  REQUIRED_WHATSAPP_FIELDS,
} from './subscriptions';

/**
 * The merge, not the Graph call, is what these cover.
 *
 * `POST /{app-id}/subscriptions` replaces the subscribed field list rather than
 * adding to it, and Meta answers a list that drops `messages` with a 200. So the
 * failure this guards against is silent and total — every inbound WhatsApp
 * message and delivery status stops arriving, and nothing anywhere reports an
 * error. Every case below is really the same assertion: whatever else happens,
 * what was subscribed stays subscribed.
 */

const subscription = (fields: string[], overrides: Partial<GraphSubscription> = {}) =>
  ({
    object: 'whatsapp_business_account',
    callback_url: 'https://support.shipblu.com/api/webhooks/whatsapp',
    active: true,
    fields: fields.map((name) => ({ name, version: 'v23.0' })),
    ...overrides,
  }) satisfies GraphSubscription;

describe('planFieldSubscription', () => {
  it('adds the missing field and keeps the one already there', () => {
    const plan = planFieldSubscription(subscription(['messages']), REQUIRED_WHATSAPP_FIELDS);

    expect(plan.adding).toEqual(['message_echoes']);
    expect(plan.merged).toEqual(['messages', 'message_echoes']);
  });

  it('keeps fields nothing in this repo asks for', () => {
    // The dashboard has fields this code never reads — template approvals, phone
    // number quality. They are somebody's alerting and the write must not
    // silently cancel them.
    const plan = planFieldSubscription(
      subscription(['messages', 'message_template_status_update', 'phone_number_quality_update']),
      REQUIRED_WHATSAPP_FIELDS,
    );

    expect(plan.merged).toContain('message_template_status_update');
    expect(plan.merged).toContain('phone_number_quality_update');
    expect(plan.merged).toContain('message_echoes');
  });

  it('is a no-op once everything is subscribed', () => {
    const plan = planFieldSubscription(
      subscription(['messages', 'message_echoes']),
      REQUIRED_WHATSAPP_FIELDS,
    );

    expect(plan.adding).toEqual([]);
    expect(plan.merged).toEqual(['messages', 'message_echoes']);
  });

  it('does not list a field twice', () => {
    const plan = planFieldSubscription(
      subscription(['message_echoes', 'messages']),
      REQUIRED_WHATSAPP_FIELDS,
    );

    expect(plan.merged).toHaveLength(2);
  });

  it('never drops a subscribed field, whatever it is asked for', () => {
    const existing = ['messages', 'account_update', 'security'];
    const plan = planFieldSubscription(subscription(existing), ['message_echoes']);

    for (const field of existing) expect(plan.merged).toContain(field);
  });

  it('reports the callback URL it will write back, not one it built', () => {
    const plan = planFieldSubscription(
      subscription(['messages'], { callback_url: 'https://override.example/hook' }),
      REQUIRED_WHATSAPP_FIELDS,
    );

    expect(plan.callbackUrl).toBe('https://override.example/hook');
  });

  it('refuses a subscription with no callback URL rather than inventing one', () => {
    expect(() =>
      planFieldSubscription(subscription(['messages'], { callback_url: '' }), [
        ...REQUIRED_WHATSAPP_FIELDS,
      ]),
    ).toThrow(GraphSubscriptionError);
  });

  it('still adds echoes to a subscription that has somehow lost messages', () => {
    // Not a case to "fix" by dropping the write: the merge restores `messages`
    // because it is in REQUIRED_WHATSAPP_FIELDS, which is why that constant
    // lists a field nothing was expected to be missing.
    const plan = planFieldSubscription(subscription([]), REQUIRED_WHATSAPP_FIELDS);

    expect(plan.merged).toEqual(['messages', 'message_echoes']);
  });
});
