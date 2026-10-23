import { describe, expect, it } from 'vitest';
import { defaultPrivateReplyOption, privateReplyOptions } from './private-reply-options';

/**
 * What the composer offers a private reply. Only the requester's comments, since
 * a private reply goes to whoever wrote the comment it names; and a comment that
 * Graph would refuse — deleted from the post, or answered privately already —
 * listed but never chosen for the agent.
 */

const AMIRA = 'contact-amira';
const BOB = 'contact-bob';

let next = 0;
function row(over: {
  direction?: 'inbound' | 'outbound';
  authorContactId?: string | null;
  meta: Record<string, unknown>;
  deliveryStatus?: string;
}) {
  next += 1;
  return {
    id: `message-${next}`,
    direction: over.direction ?? 'inbound',
    authorContactId: over.authorContactId ?? null,
    meta: over.meta,
    bodyText: `Body ${next}`,
    createdAt: new Date(Date.UTC(2026, 9, 20, 9, next)),
    deliveryStatus: over.deliveryStatus ?? 'delivered',
  };
}

const comment = (author: string, commentId: string, extra: Record<string, unknown> = {}) =>
  row({ authorContactId: author, meta: { metaKind: 'comment', commentId, ...extra } });

const privateReply = (commentId: string | undefined, deliveryStatus: string) =>
  row({
    direction: 'outbound',
    meta: {
      metaKind: 'comment',
      sendKind: 'private_reply',
      isPublic: false,
      ...(commentId ? { commentId } : {}),
    },
    deliveryStatus,
  });

describe('privateReplyOptions', () => {
  it('lists the requester’s comments newest first, and never a passer-by’s', () => {
    const root = comment(AMIRA, 'c1');
    const followUp = comment(AMIRA, 'c2');
    const passerBy = comment(BOB, 'c3');
    const publicReply = row({
      direction: 'outbound',
      meta: { metaKind: 'comment', sendKind: 'comment_reply', isPublic: true, commentId: 'c2' },
    });

    const options = privateReplyOptions([root, followUp, passerBy, publicReply], AMIRA);

    expect(options.map((option) => option.id)).toEqual([followUp.id, root.id]);
    expect(options[0]).toMatchObject({ text: followUp.bodyText, at: followUp.createdAt });
    expect(defaultPrivateReplyOption(options)).toBe(followUp.id);
  });

  it('marks a comment deleted from the post, and chooses the newest that is not', () => {
    const root = comment(AMIRA, 'c1');
    const deleted = comment(AMIRA, 'c2', { moderation: { deleted: true } });

    const options = privateReplyOptions([root, deleted], AMIRA);

    expect(options.map(({ id, deleted }) => ({ id, deleted }))).toEqual([
      { id: deleted.id, deleted: true },
      { id: root.id, deleted: false },
    ]);
    expect(defaultPrivateReplyOption(options)).toBe(root.id);
  });

  // Meta allows one private reply per comment: a sent or pending one spends it,
  // a failed one does not, and one stored before replies named their comment
  // cannot be matched to any.
  it('marks a comment already answered privately, unless the attempt failed', () => {
    const root = comment(AMIRA, 'c1');
    const followUp = comment(AMIRA, 'c2');
    const options = privateReplyOptions(
      [
        root,
        followUp,
        privateReply('c2', 'sent'),
        privateReply('c1', 'failed'),
        privateReply(undefined, 'sent'),
      ],
      AMIRA,
    );

    expect(options.map(({ id, answered }) => ({ id, answered }))).toEqual([
      { id: followUp.id, answered: true },
      { id: root.id, answered: false },
    ]);
    expect(defaultPrivateReplyOption(options)).toBe(root.id);

    const pending = privateReplyOptions([root, privateReply('c1', 'pending')], AMIRA);
    expect(pending[0]!.answered).toBe(true);
  });

  it('falls back to the newest when none can take a private reply, and to nothing when empty', () => {
    const root = comment(AMIRA, 'c1', { moderation: { deleted: true } });
    const followUp = comment(AMIRA, 'c2');
    const options = privateReplyOptions([root, followUp, privateReply('c2', 'sent')], AMIRA);

    expect(defaultPrivateReplyOption(options)).toBe(followUp.id);
    expect(defaultPrivateReplyOption([])).toBeUndefined();
    expect(privateReplyOptions([comment(BOB, 'c3')], AMIRA)).toEqual([]);
  });
});
