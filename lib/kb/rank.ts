import { sql, type SQL } from 'drizzle-orm';
import { kbArticles } from '@/db/schema';

/**
 * How a typed phrase is matched and ordered against the article index.
 *
 * Extracted so the public help centre search and the agent console's search
 * cannot drift apart. They differ in exactly one thing — who is allowed to see
 * the row — and that difference belongs in the `where` clause, not in two
 * hand-copied ranking expressions that quietly stop agreeing about which
 * article is the best answer to the same words.
 *
 * Full text with a trigram fallback. Postgres ships no Arabic text search
 * configuration, so the vector is built with `simple` — which does no stemming
 * at all. That makes exact-ish matching good and morphological matching
 * nonexistent, in both languages. Trigram similarity covers the gap: it is what
 * finds "shippment" and what makes Arabic search work at all, since `simple`
 * will not relate a word to the same word with a prefixed conjunction.
 */
export function hybridRank(query: string): SQL<number> {
  return sql<number>`
    greatest(
      ts_rank(${kbArticles.searchVector}, websearch_to_tsquery('simple', ${query})),
      similarity(${kbArticles.title}, ${query}) * 0.6
    )
  `;
}

/** The rows `hybridRank` is worth ordering — everything else scores zero. */
export function hybridMatch(query: string): SQL {
  return sql`(
    ${kbArticles.searchVector} @@ websearch_to_tsquery('simple', ${query})
    OR ${kbArticles.title} % ${query}
  )`;
}
