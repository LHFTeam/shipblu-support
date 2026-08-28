import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbVisibilityEnum } from '@/db/schema/enums';
import { kbArticles, kbCategories, kbFolders } from '@/db/schema';
import type { Locale } from './locale';
import { hybridMatch, hybridRank } from './rank';

/**
 * The knowledge base as an agent answering a ticket sees it.
 *
 * A third read model beside `./queries.ts` and `./admin.ts`, and separate from
 * both on purpose. `queries.ts` serves customers and takes a required
 * `KbViewer` so no query there can forget the visibility rule; `admin.ts` serves
 * the article editor, where a draft is the whole point. An agent in the
 * composer is neither: they may *read* anything published, including the
 * internal folders no customer can reach, and may *link* only what the
 * recipient can open. Folding that into either of the others would mean putting
 * an agent branch inside the rule that keeps internal runbooks out of Google.
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

/** Taken from the schema rather than retyped, so the two cannot drift. */
export type ArticleVisibility = (typeof kbVisibilityEnum.enumValues)[number];

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
 * The article's effective visibility: the stricter of its own and its folder's.
 *
 * Not a detail. In production every one of the 112 articles carries
 * `visibility = 'public'`, and four of them sit in folders marked
 * `agents_only` — working hours and one per internal team. Reading the article
 * row alone would offer an agent a one-click link to a page that 404s for every
 * customer, which is the exact hole `folderVisibleTo` in `./visibility.ts`
 * exists to close. Kept in step with `levelAllowed` there: a new level has to be
 * added in both places.
 *
 * Those four are empty Freshdesk placeholders today, so the gate currently
 * guards nothing anyone would want to send. That is the wrong way round to
 * reason about it — the first sentence somebody writes into the working-hours
 * article is the one that must not become a customer-facing link.
 */
const effectiveVisibility = sql<ArticleVisibility>`
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

function published(locale: Locale, match: SQL): SQL {
  return and(eq(kbArticles.status, 'published'), eq(kbArticles.locale, locale), match)!;
}

/**
 * Articles matching what the agent typed, best first.
 *
 * `origin` comes first for the same reason `searchArticles` in `./queries.ts`
 * takes its viewer first: it is the context the read happens in, not an option.
 * It is passed rather than read here because only the caller knows which origin
 * this is for — `requestBaseUrl()` for anything an agent or their customer will
 * click, `publicBaseUrl()` for anything we publish.
 */
export async function searchForAgent(
  origin: string,
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
    .where(published(locale, hybridMatch(trimmed)))
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
    .where(published(locale, matches))
    .orderBy(desc(rank), asc(kbArticles.title))
    .limit(limit);

  return rows.map((row) => toHit(row, origin));
}
