import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { kbArticles, kbFolders } from '@/db/schema';

/**
 * Who is reading the help centre, and what that lets them see.
 *
 * Until this existed, `publiclyVisible()` served `public` and nothing else. That
 * was the honest reading of an unevaluated rule — an article marked `logged_in`
 * being hidden from a signed-in customer is a disappointment, and one served to
 * an anonymous crawler is an incident — but it left two of the four levels inert
 * in an editor that still offered them.
 *
 * The viewer is a required argument on every predicate here, and every query in
 * `./queries.ts` takes one. That is the structural guarantee, and it is
 * deliberately the type system's job rather than a reviewer's: there is no
 * zero-argument version to call by accident, so a new query cannot be written
 * that forgets the rule, and a missed call site is a compile error rather than
 * an internal runbook in Google's index.
 */
export type KbViewer =
  | { kind: 'anonymous' }
  | {
      kind: 'customer';
      contactId: string;
      /** `contacts.company_id`. Null is normal — most contacts have no company. */
      companyId: string | null;
    };

/**
 * The only viewer a crawler, a sitemap or the embedded widget ever gets.
 *
 * Exported as a value rather than left to each caller to spell, so that reading
 * `ANONYMOUS` at a call site is a statement of intent that shows up in a diff.
 */
export const ANONYMOUS: KbViewer = { kind: 'anonymous' };

/**
 * Published, and visible to this viewer.
 *
 * `agents_only` appears in no branch: it is not a level the public help centre
 * can ever serve, whoever is signed in. A customer with the right company still
 * cannot read one, which is the point of having it in the same table as the
 * public articles.
 */
export function articleVisibleTo(viewer: KbViewer): SQL {
  return and(eq(kbArticles.status, 'published'), levelAllowed(viewer, 'article'))!;
}

/**
 * A folder's own visibility, which gates the articles inside it.
 *
 * Checked separately rather than folded in, because a public article in a
 * `logged_in` folder must follow the folder. The folder is the thing the
 * navigation exposes, and an article reachable by URL from a folder nobody can
 * list is a hole in exactly the place that is hardest to notice.
 */
export function folderVisibleTo(viewer: KbViewer): SQL {
  return levelAllowed(viewer, 'folder');
}

function levelAllowed(viewer: KbViewer, on: 'article' | 'folder'): SQL {
  const table = on === 'article' ? kbArticles : kbFolders;

  const branches: SQL[] = [eq(table.visibility, 'public')];

  if (viewer.kind === 'customer') {
    branches.push(eq(table.visibility, 'logged_in'));

    // Only when they actually have one. A contact with no company must not
    // match an article with an empty allowlist — `= any('{}')` is false in
    // Postgres, so that already holds, but a null companyId would make the
    // comparison null rather than false and `or()` would drop the branch
    // silently. Leaving the branch out entirely says the same thing and cannot
    // be misread.
    if (viewer.companyId) {
      branches.push(
        and(
          eq(table.visibility, 'selected_companies'),
          sql`${viewer.companyId}::uuid = any(${table.visibleToCompanyIds})`,
        )!,
      );
    }
  }

  return or(...branches)!;
}
