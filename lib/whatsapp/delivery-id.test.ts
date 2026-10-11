import { describe, expect, it } from 'vitest';
import { deliveryId } from './delivery-id';
import type { WhatsAppWebhookPayload } from './types';

/**
 * The key a stored delivery is deduplicated on. Two properties matter and each
 * is a different way to lose data: two different deliveries must not share a
 * key (the second is answered "duplicate" and never processed), and a
 * redelivery must get the same one (or it is processed twice).
 */

const change = (field: string, value: Record<string, unknown>): WhatsAppWebhookPayload => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290129340398', changes: [{ field, value }] }],
});

const chunk = (wamids: string[]) =>
  change('history', {
    history: [
      {
        metadata: { phase: 0, chunk_order: 1, progress: 55 },
        threads: [{ id: '16505551234', messages: wamids.map((id) => ({ id })) }],
      },
    ],
  });

describe('deliveryId', () => {
  it('keys a history chunk on its messages, the same on every delivery of it', () => {
    expect(deliveryId(chunk(['wamid.B', 'wamid.A']))).toBe('hm:wamid.A|hm:wamid.B');
    expect(deliveryId(chunk(['wamid.A', 'wamid.B']))).toBe(
      deliveryId(chunk(['wamid.B', 'wamid.A'])),
    );
  });

  it('keeps the file behind a placeholder apart from the chunk that named it', () => {
    // Same wamid, sent later under the same field as a top-level `messages`
    // array. Keyed `hm:` too, the follow-up would be answered "duplicate".
    const media = change('history', {
      messages: [{ id: 'wamid.A', type: 'image', image: { id: '1' } }],
    });

    expect(deliveryId(media)).toBe('m:wamid.A');
    expect(deliveryId(media)).not.toBe(deliveryId(chunk(['wamid.A'])));
  });

  it('keys an address-book entry on its number, its action and its instant', () => {
    const entry = (action: string, timestamp: string) =>
      change('smb_app_state_sync', {
        state_sync: [
          {
            type: 'contact',
            contact: { phone_number: '16505551234' },
            action,
            metadata: { timestamp },
          },
        ],
      });

    expect(deliveryId(entry('add', '1739321024'))).toBe('c:16505551234:add:1739321024');
    // Removed and added back: three different events, none swallowed.
    expect(
      new Set([
        deliveryId(entry('add', '1739321024')),
        deliveryId(entry('remove', '1739321100')),
        deliveryId(entry('add', '1739321200')),
      ]).size,
    ).toBe(3);
  });

  it('keys an account update on nothing, so the second disconnect is not the first', () => {
    const update = change('account_update', {
      phone_number: '15550783881',
      event: 'PARTNER_REMOVED',
      disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
    });

    expect(deliveryId(update)).toBeNull();
  });

  it('keys a declined history on nothing — it carries no message to key on', () => {
    expect(
      deliveryId(change('history', { history: [{ errors: [{ code: 2593109 }] }] })),
    ).toBeNull();
  });
});

/**
 * This runs in the route before the row is written, so a throw is a 500 with
 * nothing stored, and Meta redelivers the same bytes into the same throw. Each
 * shape keeps a well-formed part beside the junk and must key on exactly that
 * part: the key a redelivery collides on is the one the worker's skip agrees
 * with.
 */
describe('deliveryId: a container that is not what Meta documents', () => {
  const batch = (...changes: unknown[]) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', changes }],
  });
  const value = (fields: Record<string, unknown>) => ({ field: 'history', value: fields });
  const thread = (messages: unknown) => ({ id: '16505551234', messages });
  const KEPT = thread([{ id: 'wamid.KEPT' }]);
  const wellFormed = value({ history: [{ threads: [KEPT] }] });
  const contact = {
    type: 'contact',
    contact: { phone_number: '16505551234' },
    action: 'add',
    metadata: { timestamp: '1739321024' },
  };

  it.each([
    ['a null chunk', batch(value({ history: [null, { threads: [KEPT] }] })), 'hm:wamid.KEPT'],
    ['a history that is not a list', batch(value({ history: {} }), wellFormed), 'hm:wamid.KEPT'],
    ['a null thread', batch(value({ history: [{ threads: [null, KEPT] }] })), 'hm:wamid.KEPT'],
    [
      'a thread whose messages are not a list',
      batch(value({ history: [{ threads: [thread({}), KEPT] }] })),
      'hm:wamid.KEPT',
    ],
    [
      'a null where the file behind a placeholder belongs',
      batch(value({ messages: [null, { id: 'wamid.FILE' }] })),
      'm:wamid.FILE',
    ],
    [
      'a null address-book entry',
      batch({ field: 'smb_app_state_sync', value: { state_sync: [null, contact] } }),
      'c:16505551234:add:1739321024',
    ],
    [
      'an address book that is not a list',
      batch({ field: 'smb_app_state_sync', value: { state_sync: {} } }, wellFormed),
      'hm:wamid.KEPT',
    ],
    [
      'a null message, echo and status',
      batch({
        field: 'messages',
        value: {
          messages: [null, { id: 'wamid.LIVE' }],
          message_echoes: [null],
          statuses: [null],
        },
      }),
      'm:wamid.LIVE',
    ],
    ['a null entry', { entry: [null, batch(wellFormed).entry[0]] }, 'hm:wamid.KEPT'],
    ['a null change', batch(null, wellFormed), 'hm:wamid.KEPT'],
  ])('skips %s and keys on the rest', (_what, payload, key) => {
    expect(deliveryId(payload)).toBe(key);
  });

  it('keys a body that is not a batch at all on nothing', () => {
    expect(deliveryId(null)).toBeNull();
  });
});
