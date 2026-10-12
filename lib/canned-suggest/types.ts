/**
 * The shapes that cross the wire between the reply composer and
 * `/api/canned-suggestions`, and nothing else.
 *
 * Types only, so the composer — a client component — can name them with
 * `import type` and the `client-bundle` rule has nothing to follow: the module
 * that produces these values reaches `db/client`, and a value import of it from
 * the browser would ship the schema.
 */

/** One suggestion, as the composer needs it. No text: the composer already holds every body. */
export type CannedSuggestion = {
  /** The row's id, posted back with the reply so the outcome can be linked. */
  id: string;
  /**
   * What to show, or null for nothing — Jev said `none`, the agent waved this
   * one away, or the response has since been deleted. The id above is still
   * worth posting with the reply: a reply written from scratch after `none` is
   * Jev being right, and the report can only say so if the two are linked.
   */
  cannedResponseId: string | null;
  /** The message this answers. A suggestion for an older anchor is never shown. */
  anchorMessageId: string;
};

export type CannedSuggestionAnswer =
  | { state: 'ready'; suggestion: CannedSuggestion }
  /** Another tab or instance is asking the same question right now; ask again shortly. */
  | { state: 'pending'; retryAfterMs: number }
  /** Nothing to say: switched off, nothing to answer, nothing to offer, or the call failed. */
  | { state: 'none' };

export type SuggestionEvent = 'shown' | 'accepted' | 'dismissed';
