/**
 * The colours an agent's tile can take, and what each one looks like.
 *
 * An agent is shown as two letters wherever the console is short of room, and
 * two letters collide — names can even repeat outright — so the colour is what
 * tells them apart down a list. Each agent keeps one colour for good:
 * `agents.avatar_color` holds a key from this list, assigned once by the
 * trigger in `db/sql/006_agent_avatar_colors.sql` as whichever colour the
 * fewest agents already have. That file spells the same list out for the
 * trigger, and `agent-colors.db.test.ts` fails if the two ever differ.
 *
 * **The keys are the stored identity; the classes are only how they render.**
 * Restyling a colour is an edit to its token and moves nobody. Removing or
 * reordering a key changes which colour the next agent gets, and removing one
 * leaves the agents holding it on `FALLBACK` — so add keys at the end.
 *
 * **Why these nine.** Each is a solid fill that carries white initials at 5:1
 * or better, so no tile reads as one of the pale badge tints on the same row
 * (channel, status, window). And each is a different hue at twenty pixels,
 * checked side by side: indigo and purple are too close to violet, teal to
 * emerald and cyan, orange to amber, rose to pink, sky to blue and green to
 * emerald, which is why the list stops here rather than at twelve. Blue comes
 * first because it is the circle the header drew before agents had colours.
 *
 * The fills themselves are the `--color-agent-*` tokens in `app/globals.css`,
 * where each one's contrast is written beside it. Blue is the brand blue, the
 * same as the action colour. Amber is a yellow-gold rather than an orange,
 * because an orange tile beside a coral count would read as one more thing
 * asking for attention. Lime is darker than the Tailwind lime-700 it replaced,
 * which carried white at 4.99:1 — just under the line drawn above.
 *
 * A plain module with no imports, because the header that uses it is a server
 * component and the inbox list a client one: a helper exported from a
 * `'use client'` file cannot be called on the server.
 */
export const AGENT_COLORS = [
  'blue',
  'emerald',
  'violet',
  'amber',
  'pink',
  'cyan',
  'lime',
  'fuchsia',
  'slate',
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

/** Written out in full so Tailwind's scanner finds every class. */
const TILE_CLASS: Record<AgentColor, string> = {
  blue: 'bg-(--color-agent-blue) text-white',
  emerald: 'bg-(--color-agent-emerald) text-white',
  violet: 'bg-(--color-agent-violet) text-white',
  amber: 'bg-(--color-agent-amber) text-white',
  pink: 'bg-(--color-agent-pink) text-white',
  cyan: 'bg-(--color-agent-cyan) text-white',
  lime: 'bg-(--color-agent-lime) text-white',
  fuchsia: 'bg-(--color-agent-fuchsia) text-white',
  slate: 'bg-(--color-agent-slate) text-white',
};

/**
 * For a row the trigger has not reached — an agent read in the moment between
 * the column arriving and the post-migration file running — or a key since
 * removed from the list. The first colour, so it is what the header always was.
 */
const FALLBACK: AgentColor = 'blue';

function isAgentColor(value: string | null): value is AgentColor {
  return (AGENT_COLORS as readonly (string | null)[]).includes(value);
}

/** The background and text classes for an agent's tile. */
export function agentColorClass(color: string | null): string {
  return TILE_CLASS[isAgentColor(color) ? color : FALLBACK];
}
