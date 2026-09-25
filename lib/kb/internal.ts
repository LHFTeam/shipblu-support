import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { kbArticles, kbFolders } from '@/db/schema';
import { ROLES_BY_SENIORITY, roleSeniority, type AgentRole } from '@/lib/auth/permissions';
import type { ArticleVisibility } from './floors';

/**
 * Which of *us* may read an internal article.
 *
 * `lib/kb/visibility.ts` answers the other question — may a customer read this
 * — and the two are deliberately separate axes rather than one enum with more
 * members. `agents_only` is already the answer to "no customer, ever", and it
 * is that whoever is signed in; adding `supervisors_only` beside it would put a
 * role branch inside the predicate whose entire job is keeping internal
 * runbooks out of Google, and would make every exhaustive switch over
 * `kb_visibility` — `linkability()` in `./agent-search.ts` is one — answer a
 * question it was not asked.
 *
 * So the floor is its own nullable column on both the article and the folder,
 * and it is read **only where the content is internal**. A floor on something a
 * customer can open is not a security boundary, it is a console that hides from
 * an agent what a stranger can read; the rules below drop it rather than honour
 * it, and the editor only offers the control once the article is internal.
 *
 * The folder participates for the same reason it participates in visibility,
 * and it is not hypothetical: production's fifteen internal articles are each
 * marked `visibility = 'public'` on the article row and are internal only
 * because their folder is — the unnumbered §6 trap in `docs/PROJECT-STATE.md`,
 * "A `published`/`public` article can sit inside a folder nobody may read". A
 * floor read off the article alone would be null on every one of them.
 *
 * This file is the database half. The labels a control shows, and the twin of
 * the rule for rows already in hand, are in `./floors.ts` — imported by client
 * components, which is why they may not sit beside a value import of the
 * schema.
 */

/**
 * The stricter of an article's own visibility and its folder's.
 *
 * Kept in step with `levelAllowed` in `./visibility.ts`: a new level has to be
 * added in both places. Lives here rather than in `./agent-search.ts`, where it
 * started, because the floor below is defined in terms of it and both of the
 * read models that apply the floor need it.
 */
export const effectiveVisibility = sql<ArticleVisibility>`
  case
    when ${kbArticles.visibility} = 'agents_only'
      or ${kbFolders.visibility} = 'agents_only' then 'agents_only'
    when ${kbArticles.visibility} = 'selected_companies'
      or ${kbFolders.visibility} = 'selected_companies' then 'selected_companies'
    when ${kbArticles.visibility} = 'logged_in'
      or ${kbFolders.visibility} = 'logged_in' then 'logged_in'
    else 'public'
  end
`;

/** True for a row no customer may read, whoever they are signed in as. */
const isInternal = sql`(${kbArticles.visibility} = 'agents_only' or ${kbFolders.visibility} = 'agents_only')`;

/**
 * A role column as a number, so the comparison never depends on enum order.
 *
 * `agent_role` happens to be declared most-senior-first, which would make
 * `least(a, b)` and `<=` do the right thing today by accident. Writing it that
 * way would mean a role inserted into the middle of the enum silently
 * re-grading every article, and the failure would be an admin runbook becoming
 * readable rather than an error anybody sees.
 *
 * So the ladder is spelled out — and generated from the one in
 * `lib/auth/permissions.ts` rather than retyped beside it, because a second
 * copy of a mapping like this drifts in the direction that grants access. The
 * arms are interpolated with `sql.raw`, which is safe here and only here: every
 * value comes from `ROLES_BY_SENIORITY`, a module-level const of literals, and
 * none of it is reachable from a request.
 *
 * The column is compared as text so no `agent_role` operator is needed — the
 * shape that had `backfill_meta_profiles` die on its first real run
 * (`docs/PROJECT-STATE.md`). A null column falls to the `else`, which is the
 * same "no floor" every row already in the table means.
 */
const SENIORITY_ARMS = ROLES_BY_SENIORITY.map(
  (role) => `when '${role}' then ${roleSeniority(role)}`,
).join(' ');

function seniorityOf(column: AnyPgColumn): SQL<number> {
  return sql<number>`case ${column}::text ${sql.raw(SENIORITY_ARMS)} else 1 end`;
}

/**
 * The floor actually in force: the stricter of the article's and the folder's.
 *
 * Reported as a number rather than a role because that is what the predicate
 * compares; `floorFor` in `./floors.ts` is the same rule in TypeScript, for the
 * callers that have rows in hand rather than a query to add a clause to.
 */
const floorSeniority = sql<number>`greatest(${seniorityOf(kbArticles.minRole)}, ${seniorityOf(kbFolders.minRole)})`;

/**
 * The floor in force, as a role name, or null where there is none.
 *
 * The inverse of the ladder above, generated from the same list so the two
 * cannot disagree about what a 3 means. Seniority 1 comes back null rather than
 * `'agent'`: "every agent" and "no floor set" are the same audience, and
 * rendering the first as a badge on 112 imported articles would make the
 * console look like somebody had restricted the whole knowledge base.
 */
const FLOOR_ARMS = ROLES_BY_SENIORITY.filter((role) => roleSeniority(role) > 1)
  .map((role) => `when ${roleSeniority(role)} then '${role}'`)
  .join(' ');

export const effectiveFloor = sql<AgentRole | null>`
  case when not ${isInternal} then null
       else case ${floorSeniority} ${sql.raw(FLOOR_ARMS)} else null end
  end
`;

/**
 * Rows this reader's role may read, for a query that has joined `kb_folders`.
 *
 * Every internal read model applies it — `listArticlesForAdmin` and
 * `getArticleForEdit` in `./admin.ts`, `searchForAgent` and `suggestForAgent`
 * in `./agent-search.ts`. Taking the role as a required argument is the same
 * device `articleVisibleTo` uses for the viewer: there is no zero-argument
 * version to call by accident, so a new internal read model cannot forget the
 * rule without failing to compile.
 */
export function readableByRole(role: AgentRole): SQL {
  return sql`(not ${isInternal} or ${floorSeniority} <= ${roleSeniority(role)})`;
}
