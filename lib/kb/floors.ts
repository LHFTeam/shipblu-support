import { roleAtLeast, roleSeniority, strictestRole, type AgentRole } from '@/lib/auth/permissions';
import type { kbVisibilityEnum } from '@/db/schema/enums';

/**
 * The role-floor rule, minus the database.
 *
 * Split from `./internal.ts` by which side of the wire runs it, the same way
 * `lib/forms/files.ts` is split from `./attachments.ts`: the console's editor
 * and the folder form need the labels, and the predicates need `kbArticles` and
 * `kbFolders`. One file for both put a value import of `@/db/schema` in three
 * client components, and the whole Drizzle schema — 87 KB of table definitions
 * no browser executes — in the first-load JS of `/kb/[id]`, `/kb/new` and
 * `/kb/structure`. Unlike `node:fs` in the browser bundle that split was made
 * for, this one is not a build error: it ships, and only a bundle report shows
 * it.
 *
 * Why the floor exists at all, and where it is applied, is `./internal.ts`.
 */

/** Taken from the schema rather than retyped, so the two cannot drift. */
export type ArticleVisibility = (typeof kbVisibilityEnum.enumValues)[number];

/**
 * The floor in force over two rows already in hand — the TypeScript twin of
 * `effectiveFloor`, for callers that have an article and its folder rather than
 * a query to add a clause to.
 *
 * Null in three cases, and the third is the one worth spelling out: the content
 * is not internal, or neither row names a floor, or the floor names the most
 * junior role. "Every agent" and "no floor set" are the same audience, so
 * `effectiveFloor` reports the first as null — and a twin that answered
 * `'agent'` there would disagree with every surface built on the SQL, which is
 * all of them.
 */
export function floorFor(row: {
  visibility: ArticleVisibility;
  minRole: AgentRole | null;
  folderVisibility: ArticleVisibility;
  folderMinRole: AgentRole | null;
}): AgentRole | null {
  if (row.visibility !== 'agents_only' && row.folderVisibility !== 'agents_only') return null;
  return floorOf(row.minRole, row.folderMinRole);
}

/**
 * The floor a folder puts on everything filed in it, or null where it puts
 * none.
 *
 * The folder's half of the same rule, for the pickers: a folder is internal on
 * its own row or it is not, so this needs no article beside it.
 */
export function folderFloor(folder: {
  visibility: string;
  minRole: AgentRole | null;
}): AgentRole | null {
  return folder.visibility === 'agents_only' ? floorOf(folder.minRole, null) : null;
}

/**
 * The stricter of two floors, with the most junior role reading as no floor —
 * the same `> 1` cut `FLOOR_ARMS` takes in `./internal.ts`, so the two halves
 * of the rule cannot disagree about what "agents and up" means.
 */
function floorOf(a: AgentRole | null, b: AgentRole | null): AgentRole | null {
  const floor = a && b ? strictestRole(a, b) : (a ?? b);
  return floor && roleSeniority(floor) > 1 ? floor : null;
}

/** Whether a reader clears a floor. A null floor is cleared by everybody. */
export function meetsFloor(role: AgentRole, floor: AgentRole | null): boolean {
  return floor === null || roleAtLeast(role, floor);
}

/**
 * How a floor is described to the person who set it, and to the person it keeps
 * out of the editor.
 *
 * English, like the rest of the console — the articles themselves are Arabic,
 * the chrome around them is not.
 */
export const FLOOR_LABELS: Record<AgentRole, string> = {
  agent: 'Agents and up',
  supervisor: 'Supervisors and up',
  admin: 'Admins and up',
  account_admin: 'Account admins only',
};
