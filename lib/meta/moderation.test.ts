import { describe, expect, it } from 'vitest';
import {
  failed,
  moderatableComment,
  moderationRefusal,
  readCommentModeration,
  requested,
  settled,
} from './moderation';

const NOW = new Date('2026-08-26T18:00:00Z');

const COMMENT_META = {
  metaKind: 'comment',
  platform: 'instagram',
  commentId: 'ig-comment-1',
  postId: 'media-1',
};

describe('moderatableComment', () => {
  it('reads the comment a message names', () => {
    expect(moderatableComment(COMMENT_META)).toEqual({
      platform: 'instagram',
      commentId: 'ig-comment-1',
    });
  });

  it('is null for a direct message, a note and an outbound reply', () => {
    expect(moderatableComment({ metaKind: 'direct_message', platform: 'instagram' })).toBeNull();
    expect(moderatableComment({})).toBeNull();
    expect(moderatableComment(null)).toBeNull();

    // The console writes this shape for an agent's public reply: it is a comment
    // ticket, but no comment id exists until Graph has accepted the reply — and
    // moderating our own answer is not what these controls are for.
    expect(
      moderatableComment({ metaKind: 'comment', platform: 'instagram', sendKind: 'comment_reply' }),
    ).toBeNull();
  });
});

describe('moderationRefusal', () => {
  const clean = readCommentModeration(COMMENT_META);

  it('refuses a hide that has already happened', () => {
    const hidden = settled(clean, 'hide', NOW);
    expect(moderationRefusal(hidden, 'hide')).toMatch(/already hidden/);
    expect(moderationRefusal(hidden, 'unhide')).toBeNull();
  });

  it('refuses an unhide of something visible', () => {
    expect(moderationRefusal(clean, 'unhide')).toMatch(/not hidden/);
    expect(moderationRefusal(clean, 'hide')).toBeNull();
  });

  it('refuses everything once the comment is deleted', () => {
    const deleted = settled(clean, 'delete', NOW);
    for (const action of ['hide', 'unhide', 'delete'] as const) {
      expect(moderationRefusal(deleted, action)).toMatch(/already been deleted/);
    }
  });

  it('refuses a second, different action while one is in flight', () => {
    // The window is a second or two, which is exactly long enough for a
    // double-click to arrive as hide-then-delete.
    const hiding = requested(clean, 'hide', 'agent-1', NOW);
    expect(moderationRefusal(hiding, 'delete')).toMatch(/still in progress/);
    // The same action again is the double-submit case and is simply idempotent.
    expect(moderationRefusal(hiding, 'hide')).toBeNull();
  });
});

describe('the recorded state', () => {
  it('does not claim an outcome that failed', () => {
    // The bug worth a test: writing the requested state anyway is how a console
    // comes to show a comment as hidden while it is still on the post.
    const asked = requested(readCommentModeration(COMMENT_META), 'hide', 'agent-1', NOW);
    const refused = failed(asked, 'Unsupported post request');

    expect(refused.hidden).toBe(false);
    expect(refused.pending).toBeNull();
    expect(refused.error).toBe('Unsupported post request');
  });

  it('keeps hidden as it was through a delete', () => {
    // A hidden comment that is then deleted was still hidden, and the timeline
    // should not read as though somebody unhid it on the way out.
    const hidden = settled(readCommentModeration(COMMENT_META), 'hide', NOW);
    const deleted = settled(hidden, 'delete', NOW);

    expect(deleted).toMatchObject({ hidden: true, deleted: true, pending: null });
  });

  it('round-trips through the message meta it is stored in', () => {
    const stored = {
      ...COMMENT_META,
      moderation: requested(readCommentModeration(COMMENT_META), 'delete', 'agent-7', NOW),
    };

    expect(readCommentModeration(stored)).toMatchObject({
      pending: 'delete',
      byAgentId: 'agent-7',
      at: NOW.toISOString(),
    });
    // And the comment it describes is still readable beside it.
    expect(moderatableComment(stored)?.commentId).toBe('ig-comment-1');
  });

  it('reads a hostile or half-written moderation object as nothing done', () => {
    expect(readCommentModeration({ moderation: 'yes' })).toMatchObject({
      hidden: false,
      deleted: false,
      pending: null,
    });
    expect(readCommentModeration({ moderation: { pending: 'drop-table' } }).pending).toBeNull();
  });
});
