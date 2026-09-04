import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders } from '@/db/schema';
import type { AgentRole } from '@/lib/auth/permissions';
import { effectiveVisibility, readableByRole, type ArticleVisibility } from './internal';
import type { Locale } from './locale';
import { hybridMatch, hybridRank } from './rank';

/**
 * The knowledge base as an agent answering a ticket sees it.
 *
 * A third read model beside `./queries.ts` and `./admin.ts`, and separate from
 * both on purpose. `queries.ts` serves customers and takes a required
 * `KbViewer` so no query there can forget the visibility rule; `admin.ts` serves
 * the article editor, where a draft is the whole point. An agent in the
 * composer is neither: they may *read* anything published their role is senior
 * enough for, including the internal folders no customer can reach, and may
 * *link* only what the recipient can open. Folding that into either of the
 * others would mean putting an agent branch inside the rule that keeps internal
 * runbooks out of Google.
 *
 * Drafts are excluded everywhere here. An unpublished article has no URL that
 * resolves and no reviewer has agreed to its contents; reading one is the
 * editor's job, not the composer's.
 */

/**
 * How much of a body travels with a hit.
 *
 * Measured against production: mean body 995 characters, p95 2,830, longest
 * 3,904. At those sizes carrying the text with the search results costs less
 * than the round trip and the spinner that fetching it on expand would need,
 * against a page whose payload already includes an entire message timeline.
 * The cap is what keeps that true if the knowledge base grows.
 */
const MAX_BODY_CHARS = 4000;

/**
 * Whether a link to this article would resolve for the person on the other end.
 *
 * `blocked` covers two different levels for two different reasons.
 * `agents_only` is never servable to any customer, signed in or not. And
 * `selected_companies` is servable in principle but matches nobody today —
 * `visible_to_company_ids` is read by the visibility rule and written by
 * nothing — so a link to one is a guaranteed 404 rather than a narrow audience.
 */
export type Linkability = 'ok' | 'sign_in' | 'blocked';

/** Re-exported where it was first defined, so existing importers keep working. */
export type { ArticleVisibility };

export type AgentArticleHit = {
  id: string;
  title: string;
  slug: string;
  locale: string;
  categoryName: string;
  folderName: string;
  /** Plain text, capped at `MAX_BODY_CHARS`. Empty for the image-only articles. */
  bodyText: string;
  bodyTruncated: boolean;
  /** The stricter of the article's own visibility and its folder's. */
  visibility: ArticleVisibility;
  link: Linkability;
  /** Where the article lives on the help centre, whether or not it may be sent. */
  url: string;
};

/**
 * An exhaustive switch with no `default`, on purpose.
 *
 * The permissive answer is the dangerous one here, so a new visibility level
 * must not be able to acquire it by falling through. Written this way, adding a
 * member to `kb_visibility` stops the build until somebody has decided what it
 * means for a link — rather than shipping as `blocked` or, worse, `ok`.
 */
export function linkability(visibility: ArticleVisibility): Linkability {
  switch (visibility) {
    case 'public':
      return 'ok';
    case 'logged_in':
      return 'sign_in';
    case 'selected_companies':
    case 'agents_only':
      return 'blocked';
  }
}

const projection = {
  id: kbArticles.id,
  title: kbArticles.title,
  slug: kbArticles.slug,
  locale: kbArticles.locale,
  categoryName: kbCategories.name,
  folderName: kbFolders.name,
  // One character past the cap, so the row itself says whether it was cut
  // rather than needing a second `length()` over the same column.
  body: sql<string>`left(coalesce(${kbArticles.bodyText}, ''), ${MAX_BODY_CHARS + 1})`,
  visibility: effectiveVisibility,
};

type Row = {
  id: string;
  title: string;
  slug: string;
  locale: string;
  categoryName: string;
  folderName: string;
  body: string;
  visibility: ArticleVisibility;
};

function toHit(row: Row, origin: string): AgentArticleHit {
  const truncated = row.body.length > MAX_BODY_CHARS;

  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    locale: row.locale,
    categoryName: row.categoryName,
    folderName: row.folderName,
    bodyText: truncated ? row.body.slice(0, MAX_BODY_CHARS) : row.body,
    bodyTruncated: truncated,
    visibility: row.visibility,
    link: linkability(row.visibility),
    // The article's own locale, never the panel's: an Arabic search that
    // surfaced the English translation must link to the English one, or the
    // agent sends a URL for a row that does not exist.
    url: `${origin}/${row.locale}/a/${encodeURI(row.slug)}`,
  };
}

/**
 * Published, in this language, matching — and within this reader's reach.
 *
 * `readableByRole` is applied here rather than at each call site so the two
 * entry points below cannot diverge: a search and a suggestion that disagreed
 * about who may read an article would put a supervisor's runbook in front of an
 * agent the moment a ticket happened to mention it.
 */
function published(role: AgentRole, locale: Locale, match: SQL): SQL {
  return and(
    eq(kbArticles.status, 'published'),
    eq(kbArticles.locale, locale),
    readableByRole(role),
    match,
  )!;
}

/**
 * Articles matching what the agent typed, best first.
 *
 * `origin` and `role` come first for the same reason `searchArticles` in
 * `./queries.ts` takes its viewer first: they are the context the read happens
 * in, not options. The origin is passed rather than read here because only the
 * caller knows which one this is for — `requestBaseUrl()` for anything an agent
 * or their customer will click, `publicBaseUrl()` for anything we publish.
 */
export async function searchForAgent(
  origin: string,
  role: AgentRole,
  locale: Locale,
  query: string,
  limit = 8,
): Promise<AgentArticleHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const rank = hybridRank(trimmed);

  const rows = await db
    .select({ ...projection, rank })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(published(role, locale, hybridMatch(trimmed)))
    .orderBy(desc(rank), asc(kbArticles.title))
    .limit(limit);

  return rows.map((row) => toHit(row, origin));
}

/**
 * Articles the ticket itself suggests, from the terms `./seed.ts` pulled out of
 * it.
 *
 * A disjunction, and ranked on the vector alone. `websearch_to_tsquery` ANDs by
 * default, which for a bag of words drawn from one message means an empty
 * result nearly every time — the customer's phrasing and the article's have to
 * coincide on all six. Trigram similarity is dropped for the opposite reason:
 * it compares whole strings, so scoring a title against "شحنة OR تأخير OR
 * استلام" measures how much a title looks like that punctuation, not how much
 * it is about parcels.
 *
 * Terms arrive letter-only from `seedTerms` — it drops anything carrying a
 * digit and splits on every non-alphanumeric character — so none of them can
 * carry the quoting or `-` syntax `websearch_to_tsquery` would read as an
 * operator.
 */
export async function suggestForAgent(
  origin: string,
  role: AgentRole,
  locale: Locale,
  terms: string[],
  limit = 3,
): Promise<AgentArticleHit[]> {
  if (terms.length < 2) return [];

  const query = terms.join(' OR ');
  const rank = sql<number>`ts_rank(${kbArticles.searchVector}, websearch_to_tsquery('simple', ${query}))`;
  const matches = sql`${kbArticles.searchVector} @@ websearch_to_tsquery('simple', ${query})`;

  const rows = await db
    .select({ ...projection, rank })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(published(role, locale, matches))
    .orderBy(desc(rank), asc(kbArticles.title))
    .limit(limit);

  return rows.map((row) => toHit(row, origin));
}
