import { describe, expect, it } from 'vitest';
import { commentReplyTarget, commentRequest, rootCommentId } from './comments';

/**
 * Every assertion here is against Meta's reference rather than against
 * behaviour, because there is nothing else to check it with: no test in this
 * repo can call Graph, and Graph refuses a wrong-shaped comment request with
 * `100 "Unsupported post request"` — the same sentence it returns for a comment
 * that has been deleted. A mistake in these shapes is therefore invisible in
 * production too, which is exactly what happened: every one of these calls went
 * out in the Facebook shape on both platforms.
 */

const IG = { platform: 'instagram' as const, commentId: 'ig-comment-1', accountId: 'ig-account' };
const FB = { platform: 'facebook' as const, commentId: 'fb-comment-1', accountId: 'fb-page' };

describe('public replies', () => {
  it('posts to the replies edge on Instagram', () => {
    expect(commentRequest({ ...IG, operation: { kind: 'reply', message: 'hi' } })).toEqual({
      method: 'POST',
      path: 'ig-comment-1/replies',
      body: { message: 'hi' },
    });
  });

  it('posts to the comments edge on Facebook', () => {
    expect(commentRequest({ ...FB, operation: { kind: 'reply', message: 'hi' } })).toEqual({
      method: 'POST',
      path: 'fb-comment-1/comments',
      body: { message: 'hi' },
    });
  });
});

describe('private replies', () => {
  it('sends an Instagram private reply as a message addressed to the comment', () => {
    // Not `{comment}/private_replies`: Instagram has no such edge, and the send
    // is a message from the account with a comment id where a recipient id goes.
    expect(commentRequest({ ...IG, operation: { kind: 'private_reply', message: 'hi' } })).toEqual({
      method: 'POST',
      path: 'ig-account/messages',
      body: { recipient: { comment_id: 'ig-comment-1' }, message: { text: 'hi' } },
    });
  });

  it('uses the private_replies edge on Facebook', () => {
    expect(commentRequest({ ...FB, operation: { kind: 'private_reply', message: 'hi' } })).toEqual({
      method: 'POST',
      path: 'fb-comment-1/private_replies',
      body: { message: 'hi' },
    });
  });
});

describe('hiding', () => {
  it('spells the parameter `hide` on Instagram and `is_hidden` on Facebook', () => {
    expect(commentRequest({ ...IG, operation: { kind: 'hide', hidden: true } })).toEqual({
      method: 'POST',
      path: 'ig-comment-1',
      query: { hide: 'true' },
    });

    expect(commentRequest({ ...FB, operation: { kind: 'hide', hidden: true } })).toEqual({
      method: 'POST',
      path: 'fb-comment-1',
      query: { is_hidden: 'true' },
    });
  });

  it('unhides with the same call and a false value', () => {
    // The reversibility is the reason hiding is the moderation an agent reaches
    // for first, so unhide must not be a second endpoint that could drift.
    expect(commentRequest({ ...IG, operation: { kind: 'hide', hidden: false } }).query).toEqual({
      hide: 'false',
    });
  });
});

describe('deleting', () => {
  it('is a DELETE on the comment itself, identically on both platforms', () => {
    expect(commentRequest({ ...IG, operation: { kind: 'delete' } })).toEqual({
      method: 'DELETE',
      path: 'ig-comment-1',
    });
    expect(commentRequest({ ...FB, operation: { kind: 'delete' } })).toEqual({
      method: 'DELETE',
      path: 'fb-comment-1',
    });
  });
});

describe('rootCommentId', () => {
  it('reads the root out of a comment ticket', () => {
    expect(rootCommentId('instagram:comment:17984')).toBe('17984');
    expect(rootCommentId('facebook:comment:123_456')).toBe('123_456');
  });

  it('is null for anything that is not a comment ticket', () => {
    expect(rootCommentId(null)).toBeNull();
    expect(rootCommentId('email:message:abc')).toBeNull();
    // A ticket keyed on a comment id but by nothing this system wrote.
    expect(rootCommentId('whatsapp:comment')).toBeNull();
  });
});

describe('commentReplyTarget', () => {
  it('replies at the root of the thread on Instagram', () => {
    expect(
      commentReplyTarget({
        platform: 'instagram',
        externalId: 'instagram:comment:root-1',
        lastCommentId: 'reply-9',
      }),
    ).toBe('root-1');
  });

  it('replies under the customer’s own comment on Facebook', () => {
    expect(
      commentReplyTarget({
        platform: 'facebook',
        externalId: 'facebook:comment:root-1',
        lastCommentId: 'reply-9',
      }),
    ).toBe('reply-9');
  });

  it('falls back to whichever id it has', () => {
    // A thread whose root arrived before the webhook was subscribed has no
    // root in the ticket key; a ticket with no inbound comment yet has no last
    // one. Neither is a reason to refuse a reply that Graph would accept.
    expect(
      commentReplyTarget({ platform: 'instagram', externalId: null, lastCommentId: 'reply-9' }),
    ).toBe('reply-9');

    expect(
      commentReplyTarget({
        platform: 'facebook',
        externalId: 'facebook:comment:root-1',
        lastCommentId: null,
      }),
    ).toBe('root-1');

    expect(
      commentReplyTarget({ platform: 'instagram', externalId: null, lastCommentId: null }),
    ).toBeNull();
  });
});
