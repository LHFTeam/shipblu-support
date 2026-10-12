import { describe, expect, it } from 'vitest';
import { deliveryOf, type ThreadMessage, voiceOf } from './thread';

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    direction: 'outbound',
    kind: 'reply',
    authorName: null,
    authorIsAgent: false,
    deliveryStatus: 'sent',
    deliveryError: null,
    meta: null,
    ...overrides,
  };
}

describe('voiceOf', () => {
  it("names the business's own phone, and no agent, on a coexistence echo", () => {
    const voice = voiceOf(message(), { echo: true, echoSource: 'business_app' });

    expect(voice).toMatchObject({
      from: 'out',
      kind: 'message',
      author: 'WhatsApp Business app',
      avatar: 'business-app',
    });
    // A person typed it, so it is not badged as the machine's.
    expect(voice.badges).toEqual([]);
  });

  it('calls an echo with no source the customer bot, written by a machine', () => {
    const voice = voiceOf(message(), { echo: true });

    expect(voice).toMatchObject({
      from: 'out',
      kind: 'bot',
      author: 'Customer bot',
      avatar: 'bot',
    });
    expect(voice.badges).toEqual([{ tone: 'automated', label: 'Automated' }]);
  });

  it('badges an automation as automated, in a dashed bot bubble', () => {
    const voice = voiceOf(message(), {});

    expect(voice).toMatchObject({ from: 'out', kind: 'bot', author: 'Automation', avatar: 'bot' });
    expect(voice.badges).toEqual([{ tone: 'automated', label: 'Automated' }]);
  });

  it("gives an agent's reply their name and face, and no badge", () => {
    const voice = voiceOf(message({ authorName: 'Mona', authorIsAgent: true }), {});

    expect(voice).toEqual({
      from: 'out',
      kind: 'message',
      author: 'Mona',
      avatar: 'agent',
      badges: [],
    });
  });

  it('puts the customer on the inbound side, by name where one is known', () => {
    expect(voiceOf(message({ direction: 'inbound', authorName: 'Ahmed' }), {})).toEqual({
      from: 'in',
      kind: 'message',
      author: 'Ahmed',
      avatar: 'contact',
      badges: [],
    });
    expect(voiceOf(message({ direction: 'inbound' }), {}).author).toBe('Customer');
  });

  it('keeps a note on our side, locked, whichever way it was filed', () => {
    const voice = voiceOf(
      message({ direction: 'inbound', kind: 'note', authorName: 'Mona', authorIsAgent: true }),
      {},
    );

    expect(voice).toMatchObject({ from: 'out', kind: 'note', avatar: 'agent' });
    expect(voice.badges).toEqual([{ tone: 'note', label: 'Private note' }]);
  });

  it('states whether a social reply was public, and which way a DM went', () => {
    expect(
      voiceOf(message({ direction: 'inbound' }), { metaKind: 'comment', isPublic: true }).badges,
    ).toEqual([{ tone: 'public', label: 'Public comment' }]);
    expect(
      voiceOf(message({ authorName: 'Mona', authorIsAgent: true }), {
        metaKind: 'comment',
        isPublic: true,
      }).badges,
    ).toEqual([{ tone: 'public', label: 'Posted publicly' }]);
    expect(
      voiceOf(message({ authorName: 'Mona', authorIsAgent: true }), {
        metaKind: 'comment',
        isPublic: false,
      }).badges,
    ).toEqual([{ tone: 'private', label: 'Sent privately' }]);
    expect(
      voiceOf(message({ authorName: 'Mona', authorIsAgent: true }), { metaKind: 'direct_message' })
        .badges,
    ).toEqual([{ tone: 'private', label: 'Direct message' }]);
  });
});

describe('deliveryOf', () => {
  it('shows a receipt for each status Meta reports on', () => {
    expect(deliveryOf(message({ deliveryStatus: 'pending' }))).toEqual({ receipt: 'sending' });
    expect(deliveryOf(message({ deliveryStatus: 'sent' }))).toEqual({ receipt: 'sent' });
    expect(deliveryOf(message({ deliveryStatus: 'delivered' }))).toEqual({ receipt: 'delivered' });
    expect(deliveryOf(message({ deliveryStatus: 'read' }))).toEqual({ receipt: 'read' });
  });

  it("says a failure as one, with the provider's words, or without them", () => {
    expect(
      deliveryOf(message({ deliveryStatus: 'failed', deliveryError: 'Message failed to send' })),
    ).toEqual({ error: 'Not delivered — Message failed to send' });
    expect(deliveryOf(message({ deliveryStatus: 'failed' }))).toEqual({
      error: 'Not delivered — unknown error',
    });
  });

  it('calls a bounce a failure', () => {
    expect(deliveryOf(message({ deliveryStatus: 'bounced' }))).toEqual({ error: 'Bounced' });
  });

  it('replaces the bare "sent" with a warning when the confirmation was lost', () => {
    const delivery = deliveryOf(message({ deliveryStatus: 'sent', meta: { wamidLost: true } }));

    expect(delivery.receipt).toBeUndefined();
    expect(delivery.note?.tone).toBe('warning');
    expect(delivery.note?.text).toMatch(/confirmation was lost/);
  });

  it('lets a failure beat a lost confirmation', () => {
    expect(
      deliveryOf(
        message({ deliveryStatus: 'failed', deliveryError: 'rejected', meta: { wamidLost: true } }),
      ),
    ).toEqual({ error: 'Not delivered — rejected' });
  });

  it('quotes a status it has no word for', () => {
    expect(deliveryOf(message({ deliveryStatus: 'queued' }))).toEqual({
      note: { text: 'queued', tone: 'muted' },
    });
  });
});
