/**
 * Dropping a canned response into what an agent is already writing.
 *
 * Separate from the composer because this is the part with an off-by-one in it.
 * The naive version — append to the end, or replace the box outright — is wrong
 * in the case that actually happens: an agent types a sentence of their own,
 * realises the rest is boilerplate, and puts the cursor where the boilerplate
 * goes. Replacing would discard what they wrote, and appending would put it
 * after their sign-off.
 */

export type Insertion = { text: string; caret: number };

/**
 * Inserts `snippet` at the selection, replacing whatever is selected.
 *
 * The caret comes back at the end of what was inserted, so the agent carries on
 * typing after the boilerplate rather than in front of it.
 *
 * Blank lines around the seam are the other half of this. Pasting a paragraph
 * straight against the end of a sentence produces "…on its way.Hi there" —
 * correct by the letter and wrong on screen — so a break is added where one is
 * missing, and never where one is already there.
 */
export function insertCanned(
  current: string,
  snippet: string,
  selectionStart: number,
  selectionEnd: number,
): Insertion {
  const body = snippet.trim();
  if (!body) return { text: current, caret: selectionEnd };

  // A caret arriving out of range means the textarea and this disagree about
  // the value — clamp rather than produce a string neither of them expects.
  const start = clamp(selectionStart, 0, current.length);
  const end = clamp(Math.max(selectionEnd, selectionStart), start, current.length);

  const before = current.slice(0, start);
  const after = current.slice(end);

  const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const tail = after && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';

  const text = `${before}${lead}${body}${tail}${after}`;
  return { text, caret: before.length + lead.length + body.length };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(value, min), max);
}
