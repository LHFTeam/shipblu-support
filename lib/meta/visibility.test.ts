import { describe, expect, it } from 'vitest';
import { isPrivateReplyMessage, isPublicMetaMessage } from './visibility';

/*
  The bug these are written against: the console derived "was this public?" from
  `metaKind`, which is `'comment'` for a private reply as well as a public one,
  so every private reply was badged "posted publicly" — reported after a real one
  went out on Instagram on 2026-09-02.
*/

describe('isPublicMetaMessage', () => {
  it('is false for a private reply, which is a comment-kind message', () => {
    expect(isPublicMetaMessage({ metaKind: 'comment', isPublic: false })).toBe(false);
  });

  it('is true for a public reply and for an inbound comment', () => {
    expect(isPublicMetaMessage({ metaKind: 'comment', isPublic: true })).toBe(true);
  });

  it('is false for a direct message', () => {
    expect(isPublicMetaMessage({ metaKind: 'direct_message' })).toBe(false);
    expect(isPublicMetaMessage({})).toBe(false);
  });

  it('falls back to the kind for rows written before `isPublic` existed', () => {
    // Those predate the private-reply control, so a comment-thread message of
    // that vintage was public. Reading them as private would be the same error
    // in the other direction.
    expect(isPublicMetaMessage({ metaKind: 'comment' })).toBe(true);
  });
});

describe('isPrivateReplyMessage', () => {
  it('is true only for an outbound comment-thread message that is not public', () => {
    expect(isPrivateReplyMessage({ metaKind: 'comment', isPublic: false }, 'outbound')).toBe(true);
    expect(isPrivateReplyMessage({ metaKind: 'comment', isPublic: true }, 'outbound')).toBe(false);
  });

  it('does not badge an ordinary direct message', () => {
    // Not public either, but saying so on a DM ticket states the obvious.
    expect(isPrivateReplyMessage({ metaKind: 'direct_message' }, 'outbound')).toBe(false);
  });

  it('does not badge anything inbound', () => {
    // A customer's comment is public; nothing they send is a private reply.
    expect(isPrivateReplyMessage({ metaKind: 'comment', isPublic: false }, 'inbound')).toBe(false);
  });
});
