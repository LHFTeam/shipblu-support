/**
 * Which suggestion a reply is graded against — the id the composer posts with
 * Send as `cannedSuggestionId`.
 *
 * Imports nothing, for the reason `keyboard.ts` gives: the composer is a client
 * component, and this is pure so the rule is tested rather than read.
 *
 * The one offered for the message on screen wins, shown or not, `none`
 * included, because the reply answers that message. When the conversation has
 * moved on and nothing newer was asked, the one the agent took earlier is
 * linked instead — but only while its response is still among those inserted
 * since the box was last empty. Without that check the fallback linked it on
 * the assumption that its text was still in the box: an agent who took a
 * suggestion, saw the customer write again, emptied the box and answered the
 * new message in their own words had that reply graded as Jev being wrong
 * about a message it never saw.
 */

export type AcceptedSuggestion = { id: string; cannedResponseId: string | null };

export function suggestionLink(
  current: { id: string } | null,
  accepted: AcceptedSuggestion | null,
  inserted: readonly string[],
): string | null {
  if (current) return current.id;
  if (accepted?.cannedResponseId && inserted.includes(accepted.cannedResponseId)) {
    return accepted.id;
  }
  return null;
}
