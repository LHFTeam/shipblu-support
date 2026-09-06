import { describe, expect, it } from 'vitest';
import { directMessageRequest } from './send';

/**
 * Asserted against Meta's node references rather than against a response, for
 * the reason `lib/meta/comments.ts` gives at length: Graph refuses a body it
 * dislikes with a sentence that names nothing, so a wrong shape here would read
 * in the log as a customer who blocked the account.
 */

describe('directMessageRequest', () => {
  it('sends the documented Messenger body, messaging_type and all', () => {
    expect(
      directMessageRequest({
        platform: 'facebook',
        recipientId: 'psid-1',
        text: 'hello',
        tag: 'RESPONSE',
      }),
    ).toEqual({
      recipient: { id: 'psid-1' },
      message: { text: 'hello' },
      messaging_type: 'RESPONSE',
    });
  });

  it('carries a Messenger tag with MESSAGE_TAG, which is what carries it', () => {
    expect(
      directMessageRequest({
        platform: 'facebook',
        recipientId: 'psid-1',
        text: 'still here',
        tag: 'HUMAN_AGENT',
      }),
    ).toEqual({
      recipient: { id: 'psid-1' },
      message: { text: 'still here' },
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
    });
  });

  it('leaves messaging_type off Instagram entirely', () => {
    // Neither Instagram send reference has the parameter — not the one for
    // Instagram messaging over a Page, and not the Instagram-Login one on
    // graph.instagram.com. Both list recipient, message, sender_action, payload
    // and reply_to and nothing else.
    expect(
      directMessageRequest({
        platform: 'instagram',
        recipientId: 'igsid-1',
        text: 'hello',
        tag: 'RESPONSE',
      }),
    ).toEqual({
      recipient: { id: 'igsid-1' },
      message: { text: 'hello' },
    });
  });

  it('tags an Instagram human agent reply without messaging_type', () => {
    const body = directMessageRequest({
      platform: 'instagram',
      recipientId: 'igsid-1',
      text: 'sorry for the delay',
      tag: 'HUMAN_AGENT',
    });

    expect(body).toEqual({
      recipient: { id: 'igsid-1' },
      message: { text: 'sorry for the delay' },
      tag: 'HUMAN_AGENT',
    });
    expect(body).not.toHaveProperty('messaging_type');
  });

  it('splits on the platform, not the connection', () => {
    // The surprising half, and the reason this is a test rather than a comment:
    // `lib/meta/connection.ts` exists because the two Instagram connections
    // differ in host, token, ids and field vocabulary — but `messaging_type` is
    // absent from the Instagram product on *both* of them. Branching on the
    // connection would leave the Page-borne half of Instagram sending a
    // Messenger body into an Instagram inbox.
    const viaEitherConnection = directMessageRequest({
      platform: 'instagram',
      recipientId: 'igsid-1',
      text: 'hello',
      tag: 'HUMAN_AGENT',
    });

    expect(viaEitherConnection).not.toHaveProperty('messaging_type');
  });
});
