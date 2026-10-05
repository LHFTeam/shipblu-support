import { describe, expect, it } from 'vitest';
import type { MetaConnection } from './connection';
import { parseMetaWebhook } from './parse';

/**
 * The connection is not in the payload — both Instagram connections send the
 * same body — so it is supplied by the caller. Defaulted here so the cases that
 * are about parsing say nothing about routing.
 */
function parse(payload: unknown, connection: MetaConnection = 'facebook_page') {
  return parseMetaWebhook(payload, connection);
}

/** A Messenger batch, in the shape Meta actually posts. */
function messengerPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: 'page',
    entry: [
      {
        id: '111222333',
        time: 1_755_000_000_000,
        messaging: [
          {
            sender: { id: 'psid-1' },
            recipient: { id: '111222333' },
            timestamp: 1_755_000_000_000,
            message: { mid: 'm_abc', text: 'Where is my shipment?' },
            ...overrides,
          },
        ],
      },
    ],
  };
}

describe('parseMetaWebhook', () => {
  it('reads a Messenger direct message', () => {
    const parsed = parse(messengerPayload());

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      platform: 'facebook',
      mid: 'm_abc',
      from: 'psid-1',
      accountId: '111222333',
      text: 'Where is my shipment?',
    });
  });

  it('reads an Instagram direct message', () => {
    const parsed = parse({
      object: 'instagram',
      entry: [
        {
          id: 'ig-account',
          messaging: [
            {
              sender: { id: 'igsid-9', username: 'shopper' },
              recipient: { id: 'ig-account' },
              timestamp: 1_755_000_000_000,
              message: { mid: 'ig_1', text: 'hello' },
            },
          ],
        },
      ],
    });

    expect(parsed.messages[0]).toMatchObject({
      platform: 'instagram',
      mid: 'ig_1',
      senderName: 'shopper',
    });
  });

  it('marks a message from the handover standby channel', () => {
    const parsed = parse({
      object: 'page',
      entry: [
        {
          id: '101449698657189',
          time: 1_787_517_241_500,
          standby: [
            {
              sender: { id: 'psid-9' },
              recipient: { id: '101449698657189' },
              timestamp: 1_787_517_239_729,
              message: { mid: 'm_standby', text: 'Testing' },
            },
          ],
        },
      ],
    });

    expect(parsed.messages).toHaveLength(1);
    // The whole point of reading it: the ticket is worth having, and answering
    // it from here is not possible. Flattening the two arrays lost the second
    // half of that and produced a reply Graph refused without saying why.
    expect(parsed.messages[0]).toMatchObject({ mid: 'm_standby', standby: true });
  });

  it('does not mark an ordinary message as standby', () => {
    const parsed = parse(messengerPayload());

    expect(parsed.messages[0]?.standby).toBe(false);
  });

  it('keeps the two apart when one batch carries both', () => {
    const parsed = parse({
      object: 'page',
      entry: [
        {
          id: '111222333',
          time: 1_755_000_000_000,
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: '111222333' },
              timestamp: 1_755_000_000_000,
              message: { mid: 'm_ours', text: 'ours' },
            },
          ],
          standby: [
            {
              sender: { id: 'psid-2' },
              recipient: { id: '111222333' },
              timestamp: 1_755_000_000_000,
              message: { mid: 'm_theirs', text: 'theirs' },
            },
          ],
        },
      ],
    });

    expect(parsed.messages.map((m) => [m.mid, m.standby])).toEqual([
      ['m_ours', false],
      ['m_theirs', true],
    ]);
  });

  it('ignores echoes of our own outbound messages', () => {
    // The bug this prevents: filing our own agent reply as if the customer had
    // written it, and then replying to ourselves forever.
    const parsed = parse(
      messengerPayload({ message: { mid: 'm_echo', text: 'our reply', is_echo: true } }),
    );

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.echoes).toBe(1);
  });

  it('drops a message with no id, which could not be deduplicated', () => {
    const parsed = parse(messengerPayload({ message: { text: 'no id' } }));
    expect(parsed.messages).toHaveLength(0);
  });

  it('describes an attachment-only message instead of leaving it blank', () => {
    const parsed = parse(
      messengerPayload({
        message: {
          mid: 'm_img',
          attachments: [{ type: 'image', payload: { url: 'https://cdn.example/1.jpg' } }],
        },
      }),
    );

    expect(parsed.messages[0]?.text).toBe('[image]');
    expect(parsed.messages[0]?.attachments).toEqual([
      { type: 'image', url: 'https://cdn.example/1.jpg', title: null },
    ]);
  });

  describe("Instagram's phone-number card", () => {
    /** The card exactly as the Page connection delivers it. */
    const card = { type: 'template', payload: { generic: { elements: [] } } };

    /** The shape of the 13 production deliveries: standby, keys `mid` and `attachments`. */
    function instagramStandby(message: Record<string, unknown>) {
      return {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account',
            time: 1_790_000_001_000,
            standby: [
              {
                sender: { id: 'igsid-7' },
                recipient: { id: 'ig-account' },
                timestamp: 1_790_000_000_760,
                message,
              },
            ],
          },
        ],
      };
    }

    it('files nothing for a message that was only the card', () => {
      // It was a customer bubble reading "[template]" and the inbox headline in
      // place of the number the customer had sent a second earlier.
      const parsed = parse(instagramStandby({ mid: 'ig_card', attachments: [card] }));

      expect(parsed.messages).toHaveLength(0);
      expect(parsed.emptyCards).toBe(1);
    });

    it('keeps a template that carries something, even one this parser cannot name', () => {
      const parsed = parse(
        instagramStandby({
          mid: 'ig_product',
          attachments: [
            { type: 'template', payload: { generic: { elements: [{ title: 'Box, large' }] } } },
          ],
        }),
      );

      expect(parsed.messages).toHaveLength(1);
      expect(parsed.emptyCards).toBe(0);
    });

    it('keeps the text and drops only the card when the two arrive together', () => {
      const parsed = parse(
        instagramStandby({ mid: 'ig_both', text: '01001234567', attachments: [card] }),
      );

      expect(parsed.messages[0]).toMatchObject({ text: '01001234567', attachments: [] });
      expect(parsed.emptyCards).toBe(0);
    });

    it('describes what is left when the card arrives beside a real attachment', () => {
      // Counted, it would have read "[2 attachments]" for one photo.
      const parsed = parse(
        instagramStandby({
          mid: 'ig_photo',
          attachments: [{ type: 'image', payload: { url: 'https://cdn.example/2.jpg' } }, card],
        }),
      );

      expect(parsed.messages[0]?.text).toBe('[image]');
      expect(parsed.messages[0]?.attachments).toEqual([
        { type: 'image', url: 'https://cdn.example/2.jpg', title: null },
      ]);
    });
  });

  it('reads a Facebook comment and knows a top-level one from a reply', () => {
    const top = parse({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: 'c_1',
                post_id: 'p_1',
                parent_id: 'p_1',
                created_time: 1_755_000_000,
                from: { id: 'user-1', name: 'Mona' },
                message: 'Is delivery free?',
              },
            },
          ],
        },
      ],
    });

    expect(top.comments[0]).toMatchObject({
      platform: 'facebook',
      commentId: 'c_1',
      // parent_id equals post_id, so this starts a thread rather than joining one.
      parentCommentId: null,
      postId: 'p_1',
      fromName: 'Mona',
    });

    const reply = parse({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: 'c_2',
                post_id: 'p_1',
                parent_id: 'c_1',
                from: { id: 'user-1' },
                message: 'still waiting',
              },
            },
          ],
        },
      ],
    });

    expect(reply.comments[0]?.parentCommentId).toBe('c_1');
  });

  it('ignores the page commenting on its own post', () => {
    // That is our agent's public reply coming back to us.
    const parsed = parse({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: 'c_3',
                post_id: 'p_1',
                from: { id: 'page-1', name: 'ShipBlu' },
                message: 'Thanks for asking!',
              },
            },
          ],
        },
      ],
    });

    expect(parsed.comments).toHaveLength(0);
  });

  it('ignores likes, shares and edits, which are not tickets', () => {
    const parsed = parse({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          changes: [
            { field: 'feed', value: { item: 'like', verb: 'add', post_id: 'p_1' } },
            { field: 'feed', value: { item: 'comment', verb: 'edited', comment_id: 'c_9' } },
            { field: 'feed', value: { item: 'comment', verb: 'remove', comment_id: 'c_8' } },
          ],
        },
      ],
    });

    expect(parsed.comments).toHaveLength(0);
  });

  it('reads an Instagram comment', () => {
    const parsed = parse({
      object: 'instagram',
      entry: [
        {
          id: 'ig-account',
          changes: [
            {
              field: 'comments',
              value: {
                id: 'igc_1',
                text: 'How much to Alexandria?',
                from: { id: 'igu_1', username: 'mona' },
                media: { id: 'igm_1' },
              },
            },
          ],
        },
      ],
    });

    expect(parsed.comments[0]).toMatchObject({
      platform: 'instagram',
      commentId: 'igc_1',
      postId: 'igm_1',
      fromName: 'mona',
      text: 'How much to Alexandria?',
    });
    expect(parsed.comments[0]?.parentCommentId).toBeNull();
  });

  it('keeps an Instagram reply threaded on its parent comment', () => {
    const parsed = parse({
      object: 'instagram',
      entry: [
        {
          id: 'ig-account',
          changes: [
            {
              field: 'comments',
              value: {
                id: 'igc_2',
                text: 'Same question',
                from: { id: 'igu_2', username: 'omar' },
                media: { id: 'igm_1' },
                parent_id: 'igc_1',
              },
            },
          ],
        },
      ],
    });

    expect(parsed.comments[0]?.parentCommentId).toBe('igc_1');
  });

  it('does not thread an Instagram comment onto its own media', () => {
    // `ingestMetaComment` keys the ticket on the parent, so a parent_id naming
    // the media would put every top-level comment on the post onto one ticket.
    const parsed = parse({
      object: 'instagram',
      entry: [
        {
          id: 'ig-account',
          changes: [
            {
              field: 'comments',
              value: {
                id: 'igc_3',
                text: 'Do you ship to Aswan?',
                from: { id: 'igu_3', username: 'sara' },
                media: { id: 'igm_1' },
                parent_id: 'igm_1',
              },
            },
          ],
        },
      ],
    });

    expect(parsed.comments[0]?.parentCommentId).toBeNull();
  });

  it('reads delivery and read receipts', () => {
    const parsed = parse({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            { sender: { id: 'psid-1' }, delivery: { mids: ['m_1'], watermark: 1_755_000_000_000 } },
            { sender: { id: 'psid-1' }, read: { mids: ['m_1'], watermark: 1_755_000_000_000 } },
          ],
        },
      ],
    });

    expect(parsed.receipts.map((r) => r.kind)).toEqual(['delivered', 'read']);
  });

  it('returns nothing rather than throwing on rubbish', () => {
    // A throw makes Meta redeliver the whole batch, including the parts we
    // understood, and repeated failures disable the subscription.
    expect(parse(null).messages).toEqual([]);
    expect(parse('nope').comments).toEqual([]);
    expect(parse({ object: 'whatsapp_business_account' }).messages).toEqual([]);
    expect(parse({ object: 'page', entry: [{}] }).messages).toEqual([]);
  });

  it('reads both second and millisecond timestamps', () => {
    // Comments arrive in seconds, messaging events in milliseconds, with
    // nothing in the payload to say which.
    const seconds = parse({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: 'c_t',
                created_time: 1_755_000_000,
                from: { id: 'u' },
                message: 'x',
              },
            },
          ],
        },
      ],
    });

    expect(seconds.comments[0]?.createdAt.getUTCFullYear()).toBe(2025);
    expect(parse(messengerPayload()).messages[0]?.sentAt.getUTCFullYear()).toBe(2025);
  });
});

describe('window-opening interactions', () => {
  /**
   * Every one of these used to fall off the end of `readMessagingEvent`, which
   * returned on any event without a `message`. Meta's messaging policy counts
   * all three alongside a message as things that open the standard 24-hour
   * window, so dropping them meant a customer who tapped a button existed to
   * this system only if they also typed.
   */

  /** A messaging event that is not a message. */
  function interactionPayload(event: Record<string, unknown>) {
    return {
      object: 'page',
      entry: [
        {
          id: '111222333',
          time: 1_755_000_000_000,
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: '111222333' },
              timestamp: 1_755_000_000_000,
              ...event,
            },
          ],
        },
      ],
    };
  }

  it('reads a Get Started postback as opening the window', () => {
    const parsed = parse(
      interactionPayload({
        postback: { mid: 'm_p', title: 'Get Started', payload: 'GET_STARTED' },
      }),
    );

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.interactions).toHaveLength(1);
    expect(parsed.interactions[0]).toMatchObject({
      kind: 'postback',
      from: 'psid-1',
      opensWindow: true,
      summary: 'Get Started',
    });
  });

  it('reads a referral, and names how the customer arrived', () => {
    const parsed = parse(
      interactionPayload({
        referral: { ref: 'tracking-help', source: 'SHORTLINK', type: 'OPEN_THREAD' },
      }),
    );

    expect(parsed.interactions[0]).toMatchObject({ kind: 'referral', opensWindow: true });
    expect(parsed.interactions[0]?.summary).toContain('tracking-help');
  });

  it('counts one interaction when an ad click also presses Get Started', () => {
    // Meta nests the referral inside the postback for somebody arriving from an
    // ad and pressing the button in the same motion. It is one act by one
    // customer, so two rows on the timeline would be a lie about what they did.
    const parsed = parse(
      interactionPayload({
        postback: { mid: 'm_p', payload: 'GET_STARTED', referral: { ad_id: '6045' } },
      }),
    );

    expect(parsed.interactions).toHaveLength(1);
    expect(parsed.interactions[0]?.kind).toBe('postback');
  });

  it('keeps the postback payload, which the title cannot stand in for', () => {
    // Two menu branches can carry the same title, so "which branch did they
    // take" is answerable only from the payload — and the event is the only
    // record of it.
    const parsed = parse(
      interactionPayload({ postback: { title: 'Track my order', payload: 'TRACK_ORDER_V2' } }),
    );

    expect(parsed.interactions[0]).toMatchObject({
      summary: 'Track my order',
      payload: 'TRACK_ORDER_V2',
    });
  });

  it('reads a reaction, but does not let it open the window', () => {
    // The one place the three part company: a reaction also moves the
    // next-response SLA target, and a customer answering our reply with a
    // thumbs-up has been served rather than left waiting.
    const parsed = parse(
      interactionPayload({ reaction: { mid: 'm_abc', action: 'react', emoji: '\u{1F44D}' } }),
    );

    expect(parsed.interactions[0]).toMatchObject({
      kind: 'reaction',
      opensWindow: false,
      summary: '\u{1F44D}',
    });
  });

  it('ignores a reaction being taken back', () => {
    const parsed = parse(interactionPayload({ reaction: { mid: 'm_abc', action: 'unreact' } }));

    expect(parsed.interactions).toHaveLength(0);
  });

  it('files a message carrying a referral as a message, not an interaction', () => {
    // The ordering that matters: somebody arriving from an ad and typing
    // straight away sends one event with both. Read as an interaction, their
    // actual question would never be filed.
    const parsed = parse(messengerPayload({ referral: { ref: 'promo' } }));

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toBe('Where is my shipment?');
    expect(parsed.interactions).toHaveLength(0);
  });

  it('carries the connection and the standby flag, as messages do', () => {
    const parsed = parseMetaWebhook(
      {
        object: 'instagram',
        entry: [
          {
            id: '999',
            standby: [
              {
                sender: { id: 'igsid-1' },
                recipient: { id: '999' },
                timestamp: 1_755_000_000_000,
                postback: { title: 'Track my order', payload: 'TRACK' },
              },
            ],
          },
        ],
      },
      'instagram_login',
    );

    expect(parsed.interactions[0]).toMatchObject({
      platform: 'instagram',
      connection: 'instagram_login',
      standby: true,
    });
  });

  it('ignores an interaction from nobody', () => {
    const parsed = parse(
      interactionPayload({ sender: undefined, postback: { payload: 'GET_STARTED' } }),
    );

    expect(parsed.interactions).toHaveLength(0);
  });

  it('still reads receipts, which are also messageless events', () => {
    const parsed = parse(interactionPayload({ delivery: { mids: ['m_abc'], watermark: 1 } }));

    expect(parsed.receipts).toHaveLength(1);
    expect(parsed.interactions).toHaveLength(0);
  });
});
