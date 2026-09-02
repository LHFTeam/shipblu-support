/**
 * Whether a Facebook or Instagram message was public, read off its `meta`.
 *
 * Its own module, and tested, because the answer is three states out of two
 * fields that are written in two places — `ingestMetaComment` for what arrives,
 * the reply action for what goes out — and read in a third. The console badges
 * the result, so being wrong here is not a cosmetic bug: it tells an agent that
 * a sentence meant for one person is sitting under the post for everyone, or the
 * reverse.
 *
 * The trap is that `metaKind` does **not** answer it. A private reply is written
 * with `metaKind: 'comment'` — it belongs to the comment thread, it is addressed
 * to a comment id, and the ticket it lands on is a comment ticket — while going
 * out privately into the customer's DM inbox. Reading the kind badged every
 * private reply "posted publicly".
 */

export type MetaMessageMeta = {
  metaKind?: string;
  isPublic?: boolean;
};

/**
 * True when the message is on the public thread.
 *
 * `isPublic` decides it wherever it is present: it is written deliberately by
 * both producers and says exactly this. The fall back to `metaKind` is for rows
 * older than the field — those predate the private-reply control, so an outbound
 * comment-thread message of that vintage really was a public reply, and an
 * inbound one is a comment either way.
 */
export function isPublicMetaMessage(meta: MetaMessageMeta): boolean {
  return meta.isPublic ?? meta.metaKind === 'comment';
}

/**
 * True for an agent's reply that left the public thread for the DM inbox.
 *
 * Not simply `!isPublicMetaMessage`: an ordinary direct message is not public
 * either, and badging it "sent privately" on a DM ticket would state the
 * obvious. This is the narrower thing — the one-time move off a comment.
 */
export function isPrivateReplyMessage(
  meta: MetaMessageMeta,
  direction: 'inbound' | 'outbound',
): boolean {
  return direction === 'outbound' && meta.metaKind === 'comment' && !isPublicMetaMessage(meta);
}
