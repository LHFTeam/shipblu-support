import { describe, expect, it } from 'vitest';
import { displayText, parseTimestamp, parseWebhook } from './parse';
import type { NormalisedWebhook, WhatsAppWebhookPayload } from './types';

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

  it('falls back to now for a finite value no Date can hold, rather than an Invalid Date', () => {
    const before = Date.now();
    const parsed = parseTimestamp('99999999999999');
    // The throw this guards against is downstream: an Invalid Date passes
    // through here quietly and fails the first `toISOString()` in the worker.
    expect(() => parsed.toISOString()).not.toThrow();
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

/**
 * The four fields a number connected through coexistence adds, each parsed from
 * Meta's own example payload, copied verbatim from the webhook references
 * (history, smb_app_state_sync, account_update) and the Business-app
 * onboarding guide — because the field decides what `messages` means, and a
 * shape guessed from the syntax block is how a parser comes to read six-month-old
 * media as live messages.
 */
describe('parseWebhook: a number on the WhatsApp Business app', () => {
  const HISTORY_SAMPLE = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
              history: [
                {
                  metadata: { phase: 0, chunk_order: 1, progress: 55 },
                  threads: [
                    {
                      id: '16505551234',
                      messages: [
                        {
                          from: '15550783881',
                          id: 'wamid.HBgLMTY0NjcwNDM1OTUVAgARGBIyNDlBOEI5QUQ4NDc0N0FCNjMA',
                          timestamp: '1739230955',
                          type: 'text',
                          text: {
                            body: "Here's the info you requested! https://www.meta.com/quest/quest-3/",
                          },
                          history_context: { status: 'READ' },
                        },
                        {
                          from: '15550783881',
                          id: 'wamid.QyNUEHBgLMTY0NjcwNDM1OTUVAgARGBI1Rj3NEYxMzAzMzQ5MkEA',
                          timestamp: '1739230970',
                          type: 'media_placeholder',
                          history_context: { status: 'PLAYED' },
                        },
                        {
                          from: '16505551234',
                          id: 'wamid.N0FCNjMAHBgLMTY0NjcwNDM1OTUVAgARGBIyNDlBOEI5QUQ4NDc0',
                          timestamp: '1739230970',
                          type: 'text',
                          text: { body: 'Thanks!' },
                          history_context: { status: 'READ' },
                        },
                      ],
                    },
                    {
                      id: '12125557890',
                      messages: [
                        {
                          from: '15550783881',
                          id: 'wamid.BIyNDlBOEI5N0FCNjMAHBgLMTY0NjcwNDM1OTUVAgARGQUQ4NDc0',
                          timestamp: '1739230970',
                          type: 'text',
                          text: {
                            body: 'Thanks for your order! As a thank you, use code THANKS30 to get 30% of your next order.',
                          },
                          history_context: { status: 'DELIVERED' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            field: 'history',
          },
        ],
      },
    ],
  };

  it('reads a history chunk: both sides of each thread, the customer as the thread', () => {
    const parsed = parseWebhook(HISTORY_SAMPLE);

    expect(parsed.messages).toEqual([]);
    expect(parsed.echoes).toEqual([]);
    expect(parsed.history).toHaveLength(1);

    const [chunk] = parsed.history;
    expect(chunk).toMatchObject({
      phoneNumberId: '106540352242922',
      phase: 0,
      chunkOrder: 1,
      progress: 55,
      declined: null,
    });
    expect(
      chunk!.messages.map(({ customer, direction, type, text, mediaPlaceholder, phoneStatus }) => ({
        customer,
        direction,
        type,
        text,
        mediaPlaceholder,
        phoneStatus,
      })),
    ).toEqual([
      {
        customer: '16505551234',
        direction: 'outbound',
        type: 'text',
        text: "Here's the info you requested! https://www.meta.com/quest/quest-3/",
        mediaPlaceholder: false,
        phoneStatus: 'READ',
      },
      {
        customer: '16505551234',
        direction: 'outbound',
        type: 'media_placeholder',
        text: '[media]',
        mediaPlaceholder: true,
        phoneStatus: 'PLAYED',
      },
      {
        customer: '16505551234',
        direction: 'inbound',
        type: 'text',
        text: 'Thanks!',
        mediaPlaceholder: false,
        phoneStatus: 'READ',
      },
      {
        customer: '12125557890',
        direction: 'outbound',
        type: 'text',
        text: 'Thanks for your order! As a thank you, use code THANKS30 to get 30% of your next order.',
        mediaPlaceholder: false,
        phoneStatus: 'DELIVERED',
      },
    ]);
    expect(chunk!.messages[0]!.sentAt.toISOString()).toBe('2025-02-10T23:42:35.000Z');
  });

  it('reads the file behind a placeholder as history media, never as a live message', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: '106540352242922',
                },
                messages: [
                  {
                    from: '16505551234',
                    id: 'wamid.QyNUEHBgLMTY0NjcwNDM1OTUVAgARGBI1Rj3NEYxMzAzMzQ5MkEA',
                    timestamp: '1738796547',
                    type: 'image',
                    image: {
                      caption: 'Black Prince echeveria',
                      mime_type: 'image/jpeg',
                      sha256: '3f9d94d399fa61c191bc1d4ca71375a035cd9b9f5b1128e1f0963a415c16b0cc',
                      id: '24230790383178626',
                    },
                  },
                ],
              },
              field: 'history',
            },
          ],
        },
      ],
    });

    expect(parsed.messages).toEqual([]);
    expect(parsed.historyMedia).toEqual([
      {
        wamid: 'wamid.QyNUEHBgLMTY0NjcwNDM1OTUVAgARGBI1Rj3NEYxMzAzMzQ5MkEA',
        phoneNumberId: '106540352242922',
        text: expect.stringContaining('Black Prince echeveria'),
        media: expect.objectContaining({ mediaId: '24230790383178626', mimeType: 'image/jpeg' }),
      },
    ]);
  });

  it('reads a business declining to share its history', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'history',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: '106540352242922',
                },
                history: [
                  {
                    errors: [
                      {
                        code: 2593109,
                        title:
                          'History sync is turned off by the business from the WhatsApp Business App',
                        message:
                          'History sync is turned off by the business from the WhatsApp Business App',
                        error_data: { details: 'History sharing is turned off by the business' },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed.history).toEqual([
      expect.objectContaining({
        phoneNumberId: '106540352242922',
        messages: [],
        declined: {
          code: 2593109,
          message: 'History sync is turned off by the business from the WhatsApp Business App',
        },
      }),
    ]);
  });

  it('reads an address-book entry from the phone', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: '106540352242922',
                },
                state_sync: [
                  {
                    type: 'contact',
                    contact: {
                      full_name: 'Pablo Morales',
                      first_name: 'Pablo',
                      phone_number: '16505551234',
                    },
                    action: 'add',
                    metadata: { timestamp: '1739321024' },
                  },
                ],
              },
              field: 'smb_app_state_sync',
            },
          ],
        },
      ],
    });

    expect(parsed.contactSyncs).toEqual([
      {
        phoneNumberId: '106540352242922',
        phone: '16505551234',
        name: 'Pablo Morales',
        action: 'add',
        at: new Date(1739321024 * 1000),
      },
    ]);
  });

  it('reads the phone disconnecting, with why — the WABA from the entry', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          time: 1739212624,
          changes: [
            {
              value: {
                phone_number: '15550783881',
                event: 'PARTNER_REMOVED',
                disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
              },
              field: 'account_update',
            },
          ],
        },
      ],
    });

    expect(parsed.accountUpdates).toEqual([
      {
        wabaId: '102290129340398',
        phoneNumber: '15550783881',
        event: 'PARTNER_REMOVED',
        reason: 'PRIMARY_INACTIVITY',
        initiatedBy: 'SYSTEM',
        at: new Date(1739212624 * 1000),
      },
    ]);
  });

  it('reads an offboarding that names nothing but the event', () => {
    const parsed = parseWebhook({
      entry: [
        {
          id: '862475293675413',
          time: 1768477204,
          changes: [{ value: { event: 'ACCOUNT_OFFBOARDED' }, field: 'account_update' }],
        },
      ],
      object: 'whatsapp_business_account',
    });

    expect(parsed.accountUpdates).toEqual([
      expect.objectContaining({
        wabaId: '862475293675413',
        phoneNumber: null,
        event: 'ACCOUNT_OFFBOARDED',
        reason: null,
      }),
    ]);
  });

  it('degrades on a shape it does not know rather than throwing', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            { field: 'history', value: { history: [{ threads: [{ messages: [{}] }] }, {}] } },
            { field: 'smb_app_state_sync', value: { state_sync: [{ type: 'label' }, {}] } },
            { field: 'account_update', value: {} },
          ],
        },
      ],
    });

    expect(parsed.history.flatMap((chunk) => chunk.messages)).toEqual([]);
    expect(parsed.contactSyncs).toEqual([]);
    expect(parsed.accountUpdates).toEqual([]);
  });
});

/**
 * A list the payload says holds objects, holding something else — or not a list
 * at all. `?? []` and `?.` answer only for a field that is missing, so every one
 * of these threw: in the worker a retry of the whole delivery until it went
 * `dead`, and through `deliveryId` a 500 in the route before the row was stored.
 *
 * Each case keeps a well-formed sibling beside the junk, because "skipped" has
 * to be told apart from "the whole delivery read as nothing" — the second would
 * pass a bare no-throw assertion and lose the customer's message.
 */
describe('parseWebhook: a container that is not what Meta documents', () => {
  const METADATA = { display_phone_number: '15550783881', phone_number_id: '106540352242922' };
  const batch = (...changes: unknown[]) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', changes }],
  });

  const KEPT = {
    from: '16505551234',
    id: 'wamid.KEPT',
    timestamp: '1739230970',
    type: 'text',
    text: { body: 'Thanks!' },
  };
  const thread = (messages: unknown) => ({ id: '16505551234', messages });
  const history = (chunks: unknown) => ({
    field: 'history',
    value: { metadata: METADATA, history: chunks },
  });
  const wellFormed = history([{ threads: [thread([KEPT])] }]);

  it.each([
    ['a null chunk', [history([null, { threads: [thread([KEPT])] }])]],
    ['a history that is not a list', [history({}), wellFormed]],
    ['a null thread', [history([{ threads: [null, thread([KEPT])] }])]],
    ['threads that are not a list', [history([{ threads: {} }]), wellFormed]],
    [
      'a thread whose messages are not a list',
      [history([{ threads: [thread({}), thread([KEPT])] }])],
    ],
    ['chunk errors that are not a list', [history([{ errors: {}, threads: [thread([KEPT])] }])]],
  ])('skips %s and reads the rest of the history', (_what, changes) => {
    const parsed = parseWebhook(batch(...changes));

    expect(parsed.history.flatMap((chunk) => chunk.messages.map((m) => m.wamid))).toEqual([
      'wamid.KEPT',
    ]);
  });

  it('skips a null where the file behind a placeholder belongs, and reads the file beside it', () => {
    const parsed = parseWebhook(
      batch({
        field: 'history',
        value: {
          metadata: METADATA,
          messages: [
            null,
            {
              from: '16505551234',
              id: 'wamid.FILE',
              timestamp: '1',
              type: 'image',
              image: { id: '9' },
            },
          ],
        },
      }),
    );

    expect(parsed.historyMedia.map((media) => media.wamid)).toEqual(['wamid.FILE']);
    expect(parsed.messages).toEqual([]);
  });

  it('skips an address book that is not a list, and a null entry in one that is', () => {
    const contact = {
      type: 'contact',
      contact: { phone_number: '16505551234' },
      action: 'add',
      metadata: { timestamp: '1739321024' },
    };
    const parsed = parseWebhook(
      batch(
        { field: 'smb_app_state_sync', value: { metadata: METADATA, state_sync: {} } },
        { field: 'smb_app_state_sync', value: { metadata: METADATA, state_sync: [null, contact] } },
      ),
    );

    expect(parsed.contactSyncs.map((sync) => sync.phone)).toEqual(['16505551234']);
  });

  /** The live fields share the walk, and a coexistence number's traffic is mostly these. */
  const LIVE = {
    from: '16505551234',
    id: 'wamid.LIVE',
    timestamp: '1739230970',
    type: 'text',
    text: { body: 'Where is my order?' },
  };
  const live = (value: Record<string, unknown>) =>
    batch({ field: 'messages', value: { metadata: METADATA, messages: [LIVE], ...value } });

  it.each([
    ['a null message', live({ messages: [null, LIVE] })],
    ['a null contact profile', live({ contacts: [null] })],
    ['echoes that are not a list', live({ message_echoes: {} })],
    ['statuses that are not a list', live({ statuses: {} })],
    ['a null account error', live({ errors: [null] })],
    ['a null entry', { entry: [null, live({}).entry[0]] }],
    ['a null change', { entry: [{ changes: [null, live({}).entry[0]!.changes[0]] }] }],
  ])('skips %s and still reads the message the customer sent', (_what, payload) => {
    expect(parseWebhook(payload).messages.map((m) => m.wamid)).toEqual(['wamid.LIVE']);
  });

  /**
   * The leaves the parser calls a string method on. `?.trim()` guards null and
   * undefined, not a number, so the same delivery-wide throw was one level down.
   */
  it.each([
    [
      'our own number',
      live({ metadata: { ...METADATA, display_phone_number: 15550783881 } }),
      (parsed: NormalisedWebhook) => expect(parsed.messages).toHaveLength(1),
    ],
    [
      'a caption',
      live({ messages: [{ ...LIVE, type: 'image', image: { id: '9', caption: 5 } }] }),
      (parsed: NormalisedWebhook) => expect(parsed.messages[0]!.text).toBe('[image]'),
    ],
    [
      'a mime type',
      live({ messages: [{ ...LIVE, type: 'image', image: { id: '9', mime_type: 5 } }] }),
      (parsed: NormalisedWebhook) =>
        expect(parsed.messages[0]!.media).toMatchObject({ mediaId: '9', mimeType: null }),
    ],
    [
      'an address-book name',
      batch({
        field: 'smb_app_state_sync',
        value: {
          state_sync: [
            {
              type: 'contact',
              contact: { phone_number: '16505551234', full_name: 5, first_name: 'Pablo' },
              action: 'add',
            },
          ],
        },
      }),
      (parsed: NormalisedWebhook) =>
        expect(parsed.contactSyncs).toEqual([expect.objectContaining({ name: 'Pablo' })]),
    ],
  ])('reads %s that is not a string as absent', (_what, payload, check) => {
    check(parseWebhook(payload));
  });
});

describe('displayText: what a Business-app number adds', () => {
  it('names an edit and a deletion instead of calling them unsupported', () => {
    const base = { id: 'wamid.1', from: '1', timestamp: '1' };
    expect(displayText({ ...base, type: 'revoke', revoke: { original_message_id: 'x' } })).toBe(
      '[deleted a message]',
    );
    expect(
      displayText({
        ...base,
        type: 'edit',
        edit: {
          original_message_id: 'x',
          message: { ...base, type: 'text', text: { body: 'Tomorrow at 10' } },
        },
      }),
    ).toBe('[edited a message: Tomorrow at 10]');
  });
});
