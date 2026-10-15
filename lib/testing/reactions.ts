/**
 * The two shapes a stored WhatsApp reaction takes, for one release: its own
 * kind, which ingest writes now, and a `reply` carrying the tag, which an old
 * worker keeps writing until it is redeployed and `db/sql/007` moves at the
 * next web deploy (`isReaction` says why).
 *
 * A reader's reaction test runs over both, since a reader keeps its tag check
 * exactly until the second shape is gone. When it is, this goes, and those
 * tests keep the first shape only.
 */
export const REACTION_SHAPES = [
  { shape: 'its own kind', kind: 'reaction' },
  { shape: 'a tagged reply from before the kind', kind: 'reply' },
] as const;
