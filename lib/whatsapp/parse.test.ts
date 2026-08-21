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

describe('location extraction', () => {
  // The envelope Meta actually sends, so the test exercises parseWebhook rather
  // than the extractor in isolation.
  function webhookWith(location: unknown) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '+20 100 000 0000', phone_number_id: 'pn1' },
                contacts: [{ wa_id: '201111111111', profile: { name: 'Nadia' } }],
                messages: [
                  {
                    id: 'wamid.loc1',
                    from: '201111111111',
                    timestamp: '1755600000',
                    type: 'location',
                    location,
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it('keeps the coordinates a customer pinned', () => {
    // Real shape from the archive: a bare pin, fourteen significant digits.
    const parsed = parseWebhook(
      webhookWith({ latitude: 29.988094329834, longitude: 31.282814025879 }),
    );

    expect(parsed.messages[0]!.location).toEqual({
      latitude: 29.988094329834,
      longitude: 31.282814025879,
      name: null,
      address: null,
    });
  });

  it('keeps the place name and geocoded address when Meta sends them', () => {
    const parsed = parseWebhook(
      webhookWith({
        latitude: 26.566639495368,
        longitude: 31.687916368246,
        name: 'HM8Q+P64',
        address: 'El-Khouly, Sohag 1, Sohag Governorate 1681044, Egypt',
      }),
    );

    expect(parsed.messages[0]!.location).toMatchObject({
      name: 'HM8Q+P64',
      address: 'El-Khouly, Sohag 1, Sohag Governorate 1681044, Egypt',
    });
  });

  it('still ingests the message when the pin is unusable', () => {
    // A pin we cannot read is not a reason to drop a customer's message: the
    // text still reaches the inbox, just without a map link.
    const parsed = parseWebhook(webhookWith({ latitude: 'north', longitude: 31 }));

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]!.location).toBeNull();
    expect(parsed.messages[0]!.text).toContain('[location');
  });

  it('is null on every message that is not a pin', () => {
    const parsed = parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '+20 100 000 0000' },
                contacts: [{ wa_id: '201111111111' }],
                messages: [
                  {
                    id: 'wamid.text',
                    from: '201111111111',
                    timestamp: '1755600000',
                    type: 'text',
                    text: { body: 'where is my parcel' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.messages[0]!.location).toBeNull();
  });

  it('keeps a pin the bot sent, on the echo', () => {
    // The bot shares hub and pickup-point pins, and an agent reading the
    // transcript needs to see where they pointed.
    const parsed = parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { display_phone_number: '+20 100 000 0000' },
                contacts: [{ wa_id: '201111111111' }],
                message_echoes: [
                  {
                    id: 'wamid.echo1',
                    from: '201000000000',
                    to: '201111111111',
                    timestamp: '1755600000',
                    type: 'location',
                    location: { latitude: 30.0444, longitude: 31.2357, name: 'Maadi hub' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.echoes[0]!.location).toMatchObject({
      latitude: 30.0444,
      longitude: 31.2357,
      name: 'Maadi hub',
    });
  });

  it('leaves body_text alone, so search keeps working on it', () => {
    // The structured pin is an addition, not a replacement: body_text feeds the
    // search vector and every text-only consumer.
    const parsed = parseWebhook(webhookWith({ latitude: 30.04, longitude: 31.23 }));
    expect(parsed.messages[0]!.text).toBe('[location (30.04, 31.23)]');
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

describe('parseWebhook: echoes', () => {
  it('normalises an echo, taking the customer from `to`', () => {
    const parsed = parseWebhook(
      envelope({
        message_echoes: [
          {
            id: 'wamid.echo1',
            from: '201000000000',
            to: '201001234567',
            timestamp: '1755500000',
            type: 'text',
            text: { body: 'Your parcel is on its way' },
          },
        ],
      }),
    );

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.echoes).toHaveLength(1);
    expect(parsed.echoes[0]).toMatchObject({
      wamid: 'wamid.echo1',
      to: '201001234567',
      from: '201000000000',
      phoneNumberId: '1234',
      text: 'Your parcel is on its way',
    });
  });

  it('reads media and reply context on an echo like any other message', () => {
    const parsed = parseWebhook(
      envelope({
        message_echoes: [
          {
            id: 'wamid.echo2',
            from: '201000000000',
            to: '201001234567',
            timestamp: '1755500000',
            type: 'document',
            document: { id: 'media-9', mime_type: 'application/pdf', filename: 'label.pdf' },
            context: { id: 'wamid.customer1' },
          },
        ],
      }),
    );

    expect(parsed.echoes[0]).toMatchObject({
      text: '[document: label.pdf]',
      replyToWamid: 'wamid.customer1',
    });
    expect(parsed.echoes[0]!.media).toMatchObject({ mediaId: 'media-9', filename: 'label.pdf' });
  });

  it('treats a message from our own number as an echo, not as a customer writing in', () => {
    // The defensive half. If Meta ever delivers an echo in `messages` — or the
    // field is named differently than assumed — the alternative is a contact
    // invented for our own phone number and a ticket we opened against
    // ourselves. The display number is formatted, so the match is on digits.
    const parsed = parseWebhook(
      envelope({
        contacts: [{ wa_id: '201001234567' }],
        messages: [
          {
            id: 'wamid.echo3',
            from: '+20 100 000 0000',
            timestamp: '1755500000',
            type: 'text',
            text: { body: 'Sent by the bot' },
          },
        ],
      }),
    );

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.echoes).toHaveLength(1);
    expect(parsed.echoes[0]).toMatchObject({ to: '201001234567', text: 'Sent by the bot' });
  });

  it('drops an echo it cannot attribute to one customer', () => {
    // Two contacts in the batch and no `to`: filing it would attach one side of
    // somebody's conversation to the wrong person.
    const parsed = parseWebhook(
      envelope({
        contacts: [{ wa_id: '201001234567' }, { wa_id: '201007654321' }],
        messages: [
          { id: 'wamid.echo4', from: '201000000000', timestamp: '1755500000', type: 'text' },
        ],
      }),
    );

    expect(parsed.echoes).toHaveLength(0);
    expect(parsed.messages).toHaveLength(0);
  });

  it("parses Meta's own sample payload, field name and all", () => {
    // Copied from a real delivery: Meta's "Send test" for the `message_echoes`
    // subscription, which is what confirmed the field name and shape this was
    // written against. Kept verbatim — placeholder numbers, 2017 timestamp and
    // all — so a change to our parsing is checked against Meta's document
    // rather than against our own idea of it.
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '0',
          changes: [
            {
              field: 'message_echoes',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  phone_number_id: '123456123',
                  display_phone_number: '16505551111',
                },
                message_echoes: [
                  {
                    id: 'ABGGFlA5Fpa',
                    to: '11234567890',
                    from: '16315551181',
                    text: { body: 'this is a text message' },
                    type: 'text',
                    timestamp: '1504902988',
                    message_creation_type: 'created_by_1p_bot',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.echoes).toHaveLength(1);
    expect(parsed.echoes[0]).toMatchObject({
      wamid: 'ABGGFlA5Fpa',
      to: '11234567890',
      from: '16315551181',
      phoneNumberId: '123456123',
      text: 'this is a text message',
      creationType: 'created_by_1p_bot',
    });
  });

  it('keeps customer messages and echoes apart in one batch', () => {
    const parsed = parseWebhook(
      envelope({
        contacts: [{ profile: { name: 'Nour' }, wa_id: '201001234567' }],
        messages: [
          {
            id: 'wamid.in1',
            from: '201001234567',
            timestamp: '1755500000',
            type: 'text',
            text: { body: 'where is my order' },
          },
        ],
        message_echoes: [
          {
            id: 'wamid.echo5',
            from: '201000000000',
            to: '201001234567',
            timestamp: '1755500060',
            type: 'text',
            text: { body: 'Let me check that for you' },
          },
        ],
      }),
    );

    expect(parsed.messages.map((m) => m.wamid)).toEqual(['wamid.in1']);
    expect(parsed.messages[0]!.profileName).toBe('Nour');
    expect(parsed.echoes.map((e) => e.wamid)).toEqual(['wamid.echo5']);
  });
});
