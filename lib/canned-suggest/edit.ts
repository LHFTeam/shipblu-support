/**
 * How much of a canned response survived into the reply that went out.
 *
 * Pure and client-free so the rule is tested in one place. Three answers and no
 * threshold, for the reason `reply-form.tsx` gives about `usage_count`: a
 * similarity score needs a cut-off, and a cut-off is a number nobody can
 * defend. These two need none —
 *
 * - `unchanged`: the reply is the stored text.
 * - `extended`: the stored text is in the reply whole, with something added —
 *   a greeting, a name, a tracking number. The usual way a good suggestion is
 *   used, and worth separating from a rewrite, because it says the response
 *   was right and merely incomplete.
 * - `reworded`: anything else.
 *
 * Compared after normalising whitespace, because nothing about it is the agent's
 * doing: a submitted textarea posts CRLF, the composer adds blank lines around
 * an insert, and the stored body was normalised to LF on save. Without this
 * every reply sent unchanged would read as edited.
 */

export type EditKind = 'unchanged' | 'extended' | 'reworded';

function normalise(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * `candidates` are the bodies the response could have gone in as — normally the
 * one language the composer inserted, both when it did not say which.
 */
export function editKind(sent: string, candidates: readonly string[]): EditKind {
  const reply = normalise(sent);
  const bodies = candidates.map(normalise).filter(Boolean);

  if (bodies.some((body) => body === reply)) return 'unchanged';
  if (bodies.some((body) => reply.includes(body))) return 'extended';
  return 'reworded';
}
