/**
 * Whether a stored message row is a WhatsApp reaction — 🙏 on a reply, ❤️ on a
 * photo — rather than something anybody said.
 *
 * A reaction is kept as a row of its own, `kind: 'reply'` like the message it
 * arrived as, because the console draws it on the message it names; and it is
 * told apart by the type WhatsApp gave it, which ingest keeps on `meta`. So
 * anything that picks "the latest message" or "what the customer last said" —
 * the inbox preview, the canned suggestion's anchor, the language a reply is
 * written in — asks this first, or a thumbs-up is the customer's last words.
 *
 * Client-safe, for the ticket page's own picks over rows it already holds; the
 * same rule for a query is `notReaction` in `lib/tickets/not-reaction.ts`, and
 * the two must agree.
 */
export function isReaction(meta: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return meta?.whatsappType === 'reaction';
}
