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

  it('leaves the in-window Instagram body exactly as it sends today', () => {
    /*
      Deliberately unchanged, and the asymmetry with the tagged case below is the
      point. This is the channel's working traffic: when INSTAGRAM_ACCESS_TOKEN
      is unset the call goes out over the Page connection to graph.facebook.com,
      where `messaging_type` is documented as part of every send. Nothing
      establishes the shape is wrong, and stripping it on the strength of a doc
      page describing a different host would risk every in-window Instagram reply
      to fix a send that has never worked.
    */
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
      messaging_type: 'RESPONSE',
    });
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

  it('changes only the tagged Instagram body, never the in-window one', () => {
    // Stated as its own case because it is a claim about evidence rather than
    // about Meta, and it is the thing a future reader is most likely to "tidy"
    // into consistency: the tagged path has never once succeeded, the in-window
    // path is live traffic, and only the first is being moved toward the docs.
    const inWindow = (platform: 'facebook' | 'instagram') =>
      directMessageRequest({ platform, recipientId: 'r', text: 't', tag: 'RESPONSE' });

    expect(inWindow('facebook')).toHaveProperty('messaging_type', 'RESPONSE');
    expect(inWindow('instagram')).toHaveProperty('messaging_type', 'RESPONSE');
  });
});
