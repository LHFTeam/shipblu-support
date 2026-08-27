import { describe, expect, it } from 'vitest';
import { parseMetaWebhook } from './parse';

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
    const parsed = parseMetaWebhook(messengerPayload());

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
    const parsed = parseMetaWebhook({
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
    const parsed = parseMetaWebhook({
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
    const parsed = parseMetaWebhook(messengerPayload());

    expect(parsed.messages[0]?.standby).toBe(false);
  });

  it('keeps the two apart when one batch carries both', () => {
    const parsed = parseMetaWebhook({
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
    const parsed = parseMetaWebhook(
      messengerPayload({ message: { mid: 'm_echo', text: 'our reply', is_echo: true } }),
    );

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.echoes).toBe(1);
  });

  it('drops a message with no id, which could not be deduplicated', () => {
    const parsed = parseMetaWebhook(messengerPayload({ message: { text: 'no id' } }));
    expect(parsed.messages).toHaveLength(0);
  });

  it('describes an attachment-only message instead of leaving it blank', () => {
    const parsed = parseMetaWebhook(
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

  it('reads a Facebook comment and knows a top-level one from a reply', () => {
    const top = parseMetaWebhook({
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

    const reply = parseMetaWebhook({
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
    const parsed = parseMetaWebhook({
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
    const parsed = parseMetaWebhook({
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
    const parsed = parseMetaWebhook({
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
  });

  it('reads delivery and read receipts', () => {
    const parsed = parseMetaWebhook({
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
    expect(parseMetaWebhook(null).messages).toEqual([]);
    expect(parseMetaWebhook('nope').comments).toEqual([]);
    expect(parseMetaWebhook({ object: 'whatsapp_business_account' }).messages).toEqual([]);
    expect(parseMetaWebhook({ object: 'page', entry: [{}] }).messages).toEqual([]);
  });

  it('reads both second and millisecond timestamps', () => {
    // Comments arrive in seconds, messaging events in milliseconds, with
    // nothing in the payload to say which.
    const seconds = parseMetaWebhook({
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
    expect(parseMetaWebhook(messengerPayload()).messages[0]?.sentAt.getUTCFullYear()).toBe(2025);
  });
});

describe('handover events', () => {
  /*
    These arrive on the `messaging_handovers` field, in the same `messaging`
    array as ordinary messages and carrying no `message` object at all. The
    parser used to return early on that, which meant every one of them was
    dropped — and a dropped handover is what leaves the console confidently
    offering a reply box over a thread another app has taken back.
  */
  it('reads a pass_thread_control event', () => {
    const parsed = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE',
          messaging: [
            {
              sender: { id: 'PSID-1' },
              recipient: { id: 'PAGE' },
              timestamp: 1458692752478,
              pass_thread_control: {
                previous_owner_app_id: '263902037430900',
                new_owner_app_id: 123456789,
                metadata: 'over to you',
              },
            },
          ],
        },
      ],
    });

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.handovers).toHaveLength(1);
    expect(parsed.handovers[0]).toMatchObject({
      platform: 'facebook',
      kind: 'passed',
      psid: 'PSID-1',
      accountId: 'PAGE',
      previousOwnerAppId: '263902037430900',
      // Numeric in Meta's own example, string in the field beside it.
      newOwnerAppId: '123456789',
      metadata: 'over to you',
    });
  });

  it('reads a take_thread_control event that came from an idle thread', () => {
    const parsed = parseMetaWebhook({
      object: 'instagram',
      entry: [
        {
          id: 'IG',
          messaging: [
            {
              sender: { id: 'PSID-2' },
              timestamp: 1458692752478,
              take_thread_control: {
                previous_owner_app_id: null,
                new_owner_app_id: '999',
              },
            },
          ],
        },
      ],
    });

    expect(parsed.handovers[0]).toMatchObject({
      platform: 'instagram',
      kind: 'taken',
      previousOwnerAppId: null,
      newOwnerAppId: '999',
    });
  });

  it('reads a request as an ask that names only the asker', () => {
    const parsed = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE',
          messaging: [
            {
              sender: { id: 'PSID-3' },
              timestamp: 1458692752478,
              request_thread_control: { requested_owner_app_id: 123456789 },
            },
          ],
        },
      ],
    });

    expect(parsed.handovers[0]).toMatchObject({
      kind: 'requested',
      requestedByAppId: '123456789',
      newOwnerAppId: null,
      previousOwnerAppId: null,
    });
  });

  /*
    An app that loses thread control keeps receiving the conversation in
    `standby` — so the handover that took it away is delivered there too, and
    dropping standby handovers would lose exactly the events that make a stored
    "we own this" wrong.
  */
  it('reads a handover delivered in the standby channel', () => {
    const parsed = parseMetaWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE',
          standby: [
            {
              sender: { id: 'PSID-4' },
              timestamp: 1458692752478,
              take_thread_control: { previous_owner_app_id: '1', new_owner_app_id: '2' },
            },
          ],
        },
      ],
    });

    expect(parsed.handovers).toHaveLength(1);
    expect(parsed.handovers[0]?.newOwnerAppId).toBe('2');
  });
});
