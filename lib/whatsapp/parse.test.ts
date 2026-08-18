import { describe, expect, it } from 'vitest';
import { displayText, parseTimestamp, parseWebhook } from './parse';
import type { WhatsAppWebhookPayload } from './types';

function envelope(value: Record<string, unknown>): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '201000000000', phone_number_id: '1234' },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

describe('parseWebhook', () => {
  it('normalises a text message with its profile name', () => {
    const parsed = parseWebhook(
      envelope({
        contacts: [{ profile: { name: 'Nour' }, wa_id: '201001234567' }],
        messages: [
          {
            id: 'wamid.ABC',
            from: '201001234567',
            timestamp: '1755500000',
            type: 'text',
            text: { body: 'Where is my shipment?' },
          },
        ],
      }),
    );

    expect(parsed.messages).toHaveLength(1);
    const message = parsed.messages[0]!;
    expect(message.wamid).toBe('wamid.ABC');
    expect(message.from).toBe('201001234567');
    expect(message.profileName).toBe('Nour');
    expect(message.phoneNumberId).toBe('1234');
    expect(message.text).toBe('Where is my shipment?');
    expect(message.media).toBeNull();
    // Meta sends seconds, not milliseconds.
    expect(message.sentAt.getTime()).toBe(1755500000 * 1000);
  });

  it('extracts media and strips codec parameters from the mime type', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.MEDIA',
            from: '201001234567',
            timestamp: '1755500000',
            type: 'audio',
            audio: { id: '987', mime_type: 'audio/ogg; codecs=opus', voice: true },
          },
        ],
      }),
    );

    const media = parsed.messages[0]!.media;
    expect(media).toEqual({
      mediaId: '987',
      mimeType: 'audio/ogg',
      filename: null,
      sha256: null,
      isVoice: true,
    });
    expect(parsed.messages[0]!.text).toBe('[voice note]');
  });

  it('carries the reply context so quoted replies can be linked', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.REPLY',
            from: '201001234567',
            timestamp: '1755500000',
            type: 'text',
            text: { body: 'yes please' },
            context: { from: '201000000000', id: 'wamid.ORIGINAL' },
          },
        ],
      }),
    );

    expect(parsed.messages[0]!.replyToWamid).toBe('wamid.ORIGINAL');
  });

  it('drops a message with no wamid rather than risking a duplicate', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [{ from: '201001234567', timestamp: '1755500000', type: 'text' } as never],
      }),
    );

    expect(parsed.messages).toHaveLength(0);
  });

  it('reads messages and statuses from the same batch', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.NEW',
            from: '201001234567',
            timestamp: '1755500000',
            type: 'text',
            text: { body: 'hi' },
          },
        ],
        statuses: [
          {
            id: 'wamid.SENT',
            status: 'delivered',
            timestamp: '1755500100',
            recipient_id: '201001234567',
            conversation: { id: 'conv1', expiration_timestamp: '1755586400' },
          },
        ],
      }),
    );

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.statuses).toHaveLength(1);
    expect(parsed.statuses[0]!.status).toBe('delivered');
    expect(parsed.statuses[0]!.conversationExpiresAt?.getTime()).toBe(1755586400 * 1000);
  });

  it('flattens a failed status into a readable error', () => {
    const parsed = parseWebhook(
      envelope({
        statuses: [
          {
            id: 'wamid.FAIL',
            status: 'failed',
            timestamp: '1755500100',
            recipient_id: '201001234567',
            errors: [
              {
                code: 131047,
                title: 'Re-engagement message',
                error_data: { details: 'Message failed to send because more than 24 hours' },
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.statuses[0]!.error).toContain('131047');
    expect(parsed.statuses[0]!.error).toContain('more than 24 hours');
  });

  it('ignores status values it does not model', () => {
    const parsed = parseWebhook(
      envelope({
        statuses: [
          { id: 'wamid.X', status: 'deleted', timestamp: '1', recipient_id: '2' } as never,
        ],
      }),
    );

    expect(parsed.statuses).toHaveLength(0);
  });

  it('walks every entry and change in a batch', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'w1',
                    from: '1',
                    timestamp: '1755500000',
                    type: 'text',
                    text: { body: 'a' },
                  },
                ],
              },
            },
            {
              value: {
                messages: [
                  {
                    id: 'w2',
                    from: '2',
                    timestamp: '1755500000',
                    type: 'text',
                    text: { body: 'b' },
                  },
                ],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'w3',
                    from: '3',
                    timestamp: '1755500000',
                    type: 'text',
                    text: { body: 'c' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.messages.map((m) => m.wamid)).toEqual(['w1', 'w2', 'w3']);
  });

  it('never throws on junk', () => {
    expect(parseWebhook(null).messages).toHaveLength(0);
    expect(parseWebhook('nonsense').messages).toHaveLength(0);
    expect(parseWebhook({ entry: 'not an array' }).messages).toHaveLength(0);
  });
});

describe('displayText', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ type: 'text', text: { body: 'hello' } }, 'hello'],
    [{ type: 'image', image: { id: '1', caption: 'the label' } }, 'the label'],
    [{ type: 'image', image: { id: '1' } }, '[image]'],
    [{ type: 'document', document: { id: '1', filename: 'awb.pdf' } }, '[document: awb.pdf]'],
    [
      { type: 'location', location: { latitude: 30.04, longitude: 31.23, name: 'Zamalek' } },
      '[location: Zamalek (30.04, 31.23)]',
    ],
    [{ type: 'button', button: { text: 'Track order' } }, 'Track order'],
    [{ type: 'interactive', interactive: { button_reply: { id: 'b1', title: 'Yes' } } }, 'Yes'],
    [{ type: 'system', system: { body: 'user changed number' } }, 'user changed number'],
  ];

  for (const [message, expected] of cases) {
    it(`renders ${String(message.type)}`, () => {
      expect(displayText(message as never)).toBe(expected);
    });
  }

  it('explains an unsupported message rather than showing a blank row', () => {
    expect(
      displayText({
        id: 'w',
        from: '1',
        timestamp: '1',
        type: 'unsupported',
        errors: [{ code: 131051, title: 'Message type is not currently supported' }],
      }),
    ).toBe('[unsupported message: Message type is not currently supported]');
  });
});

describe('parseTimestamp', () => {
  it('treats the value as seconds', () => {
    expect(parseTimestamp('1755500000').toISOString()).toBe('2025-08-18T06:53:20.000Z');
  });

  it('falls back to now rather than 1970 when unparseable', () => {
    const before = Date.now();
    const parsed = parseTimestamp('not a number');
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before);
  });
});
