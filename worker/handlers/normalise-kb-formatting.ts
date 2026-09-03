import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles } from '@/db/schema';
import { htmlToText, preview } from '@/lib/html/sanitize';
import { normaliseArticleHtml, rewriteLegacyArticleLinks } from '@/lib/kb/format';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Brings every article already in the database up to the formatting standard.
 *
 * The standard is enforced on write now — the console action and the Freshdesk
 * importer both run `normaliseArticleHtml` — but every article here predates
 * that, because the whole knowledge base arrived in one import. This is the
 * one-time pass over what is already stored, and it is a job rather than a
 * migration because it needs the normaliser itself: the rules are 200 lines of
 * markup transformation with a test suite behind them, and a hand-written SQL
 * twin of them in `db/migrations/` would be a second implementation to keep in
 * step with the first.
 *
 * Safe to run again, and worth knowing why rather than taking it on trust:
 * `normaliseArticleHtml` is idempotent, so a second run computes the same body
 * it already stored, finds it unchanged, and writes nothing — no version row,
 * no update. It is therefore enqueued **without a `dedupeKey`**: a key is spent
 * for good rather than until the job finishes (`jobs_dedupe_idx` is a plain
 * unique index over the whole table), so keying this would make the second run
 * silently do nothing, which is the opposite of what an idempotent backfill
 * wants.
 *
 * One visible side effect, called out because somebody will ask about it: every
 * table with an `updated_at` carries the `touch_updated_at` trigger from
 * `db/sql/001_extensions_and_triggers.sql`, so an article this changes shows
 * today's date under its title. It is not avoidable from here without disabling
 * a trigger on a live table, and it is not much of a change either: that column
 * is already moved by every page view, because `recordArticleView` increments
 * `view_count` on the same row (§6.51). The sitemap carries no `lastmod`, so
 * nothing is republished to a search engine on the strength of it.
 */

type Payload = {
  /** Count and report what would change, write nothing. */
  dryRun?: boolean;
  /** Stop after this many articles. Absent means all of them. */
  limit?: number;
  /** One locale only, for a cautious first run. */
  locale?: string;
};

type Tally = {
  articles: number;
  changed: number;
  bytesBefore: number;
  bytesAfter: number;
  linksRewritten: number;
};

function emptyTally(): Tally {
  return { articles: 0, changed: 0, bytesBefore: 0, bytesAfter: 0, linksRewritten: 0 };
}

/**
 * Freshdesk id → the article that id became, per locale.
 *
 * `external_id` is `<freshdeskId>:<locale>` — one Freshdesk article becomes one
 * row per language — and the older single-language form without the suffix is
 * accepted for the same reason `app/help/legacy/route.ts` accepts it.
 */
function legacyIndex(rows: { locale: string; slug: string; externalId: string | null }[]) {
  const index = new Map<string, Map<string, string>>();

  for (const row of rows) {
    if (!row.externalId) continue;
    const [freshdeskId] = row.externalId.split(':');
    if (!freshdeskId) continue;

    const byLocale = index.get(freshdeskId) ?? new Map<string, string>();
    byLocale.set(row.locale, row.slug);
    index.set(freshdeskId, byLocale);
  }

  return index;
}

export async function normaliseKbFormatting(job: ClaimedJob): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const dryRun = payload.dryRun === true;

  const rows = await db
    .select({
      id: kbArticles.id,
      locale: kbArticles.locale,
      slug: kbArticles.slug,
      title: kbArticles.title,
      bodyHtml: kbArticles.bodyHtml,
      externalId: kbArticles.externalId,
    })
    .from(kbArticles)
    .orderBy(asc(kbArticles.locale), asc(kbArticles.slug));

  const index = legacyIndex(rows);
  const selected = payload.locale ? rows.filter((row) => row.locale === payload.locale) : rows;
  const articles = payload.limit ? selected.slice(0, payload.limit) : selected;

  const tallies = new Map<string, Tally>();
  const changedSlugs: string[] = [];

  for (const article of articles) {
    const tally = tallies.get(article.locale) ?? emptyTally();

    /**
     * A cross-reference resolves to the same language as the URL asked for, and
     * failing that to the language of the article the link is *in* — not to the
     * default locale. An Arabic article linking to an id whose URL carries no
     * language is linking to the Arabic translation; sending that reader to the
     * English one is the kind of thing nobody notices in a diff and everybody
     * notices on the page.
     */
    const resolve = (freshdeskId: string, locale: string | undefined) => {
      const byLocale = index.get(freshdeskId);
      if (!byLocale) return undefined;

      for (const candidate of [locale, article.locale, DEFAULT_LOCALE]) {
        const slug = candidate ? byLocale.get(candidate) : undefined;
        if (slug && candidate) return { locale: candidate, slug };
      }

      const first = [...byLocale.entries()][0];
      return first ? { locale: first[0], slug: first[1] } : undefined;
    };

    const normalised = normaliseArticleHtml(article.bodyHtml);
    const bodyHtml = rewriteLegacyArticleLinks(normalised, resolve);

    tally.articles += 1;
    tally.bytesBefore += article.bodyHtml.length;
    tally.bytesAfter += bodyHtml.length;
    tally.linksRewritten += countLegacyLinks(article.bodyHtml) - countLegacyLinks(bodyHtml);
    tallies.set(article.locale, tally);

    if (bodyHtml === article.bodyHtml) continue;

    tally.changed += 1;
    changedSlugs.push(`${article.locale}/${article.slug}`);
    if (dryRun) continue;

    const bodyText = htmlToText(bodyHtml);

    await db.transaction(async (tx) => {
      // The body being replaced, kept where the console's own version history
      // keeps it, so this pass is undoable article by article from the UI
      // rather than only from a database backup. `edited_by_agent_id` stays
      // null: no agent made this edit.
      const next = await tx
        .select({ version: sql<number>`coalesce(max(${kbArticleVersions.version}), 0) + 1` })
        .from(kbArticleVersions)
        .where(eq(kbArticleVersions.articleId, article.id));

      await tx.insert(kbArticleVersions).values({
        articleId: article.id,
        version: next[0]?.version ?? 1,
        title: article.title,
        bodyHtml: article.bodyHtml,
      });

      await tx
        .update(kbArticles)
        .set({ bodyHtml, bodyText, excerpt: preview(bodyText, 200) })
        .where(eq(kbArticles.id, article.id));
    });
  }

  report(tallies, changedSlugs, dryRun);
}

function countLegacyLinks(html: string): number {
  return (html.match(/solutions\/articles\/\d+/g) ?? []).length;
}

function report(tallies: Map<string, Tally>, changedSlugs: string[], dryRun: boolean): void {
  const tag = '[normalise_kb_formatting]';

  console.log(
    `${tag} ${[...tallies.values()].reduce((sum, t) => sum + t.articles, 0)} articles ` +
      `(dry_run=${dryRun})`,
  );

  // Per locale rather than as one number, for the reason §7 of the working brief
  // gives: "108 articles normalised" reads as a clean run even if every Arabic
  // one was skipped, and Arabic is the half of this knowledge base whose
  // formatting problems — a `dir="ltr"` in the middle of a right-to-left page,
  // a callout forced into a left-to-right code block — do not show up in an
  // English spot check.
  console.log(
    `${tag} ${'locale'.padEnd(8)}${'articles'.padStart(9)}${'changed'.padStart(8)}` +
      `${'bytes'.padStart(12)}${'links'.padStart(7)}`,
  );

  for (const [locale, tally] of [...tallies.entries()].sort()) {
    const bytes = `${tally.bytesBefore}→${tally.bytesAfter}`;
    console.log(
      `${tag} ${locale.padEnd(8)}${String(tally.articles).padStart(9)}` +
        `${String(tally.changed).padStart(8)}${bytes.padStart(12)}` +
        `${String(tally.linksRewritten).padStart(7)}`,
    );
  }

  if (changedSlugs.length > 0) {
    console.log(`${tag} changed: ${changedSlugs.join(', ')}`);
  }
}
