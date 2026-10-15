/**
 * The kind a WhatsApp message of this type is stored as: `reaction` for a
 * reaction — 🙏 on a reply, ❤️ on a photo, from either side — and `reply` for
 * everything somebody said.
 *
 * Decided here, from the type Meta gave it, and called by every row builder
 * that stores one — the customer's, the echo's and the copied history's —
 * rather than set by the paths that happen to know they hold a reaction. The
 * column defaults to `reply`, so a builder that forgot would store every
 * reaction as the customer's words, and every reader that picks those by
 * `kind = 'reply'` would take a thumbs-up for them.
 */
export function storedKind(whatsappType: string): 'reply' | 'reaction' {
  return whatsappType === 'reaction' ? 'reaction' : 'reply';
}

/**
 * Whether a stored message row is a WhatsApp reaction rather than something
 * anybody said.
 *
 * A reaction is kept as a row of its own, because the timeline reads it from
 * the row — and can pair it with the message it names, which `raw_body`
 * records. It is `kind: 'reaction'`. A reader picking the customer's words
 * asks for `kind = 'reply'`, which leaves it out, and asks this as well only
 * for the tag below; the fold that draws reactions finds them with it.
 *
 * **The tag on `meta` still counts, for one release.** Rows stored before the
 * kind existed were `reply`, told apart only by `meta.whatsappType`.
 * `db/sql/007_message_kind_reaction.sql` moves them, but only on a deploy of
 * the web services, and the worker that stores reactions is deployed
 * separately — so an old worker keeps writing the old shape until it is
 * replaced, and until the next web deploy moves what it wrote. Once production
 * holds no `reply` row with the tag, this is `kind === 'reaction'` and the tag
 * half goes.
 *
 * Client-safe, for the ticket page's own picks over rows it already holds; the
 * same rule for a query is `notReaction` in `lib/tickets/not-reaction.ts`, and
 * the two must agree.
 */
export function isReaction(message: { kind: string; meta: unknown }): boolean {
  if (message.kind === 'reaction') return true;
  const { meta } = message;
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as { whatsappType?: unknown }).whatsappType === 'reaction'
  );
}
