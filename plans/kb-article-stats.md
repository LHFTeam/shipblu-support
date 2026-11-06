# The knowledge base's reader counters in a table of their own

`kb_articles` carried three counters that readers write: `view_count`, one more
on every article view (`recordArticleView`, beaconed by the article page and rate
limited), and `helpful_count` / `unhelpful_count`, one more on every "Was this
helpful?" tap, in the transaction that stores its `kb_article_feedback` row. So
every reader wrote the article's own row.

That made `kb_articles.updated_at` follow readers, and #466 fixed only the date:
`touch_updated_at()` in `db/sql/001_extensions_and_triggers.sql` now keeps the
old date when an UPDATE changes nothing but those three, comparing
`to_jsonb(NEW) - not_an_edit` with `OLD`, and the `kb-edit-date` repo rule holds
that list to the schema (`docs/PROJECT-STATE.md` §6.51). Two costs were left,
raised in #466's review and decided then to remove:

- **Every view rewrote the whole article row.** The stored `search_vector` was
  regenerated from the title and the body each time, and #466's jsonb comparison
  reads the row twice more. Measured with pgbench on local Postgres 16 before
  this work, a view's UPDATE cost 2.15 ms on an 8 KB body and 8.5 ms on a 49 KB
  one, against 1.5 and 5.0 before #466.
- **Every view took the article's row lock** for its UPDATE, which a console
  save waits on.

The counters therefore move to `kb_article_stats`, one row per article, which no
edit touches. It takes two pull requests, because the column drop must not reach
production while code that reads or counts into the columns is still running
there. Even PR 1's code names them in an article INSERT, which leaves PR 2's
deploy one short window of its own (below).

## What production held

Read on 2026-11-06 at 15:14 UTC, read-only: 112 articles, 108 of them carrying a
count; 63,842 views, 548 helpful and 2,313 unhelpful votes in all; and **no**
`kb_article_feedback` rows, so every vote counted there came across from
Freshdesk at cutover. No `kb_article_stats` table yet.

## The shape

- **`kb_article_stats`** (`db/schema/kb.ts`, migration 0057): `article_id`, the
  primary key, references `kb_articles` with `ON DELETE CASCADE`; `view_count`,
  `helpful_count`, `unhelpful_count`, `integer NOT NULL DEFAULT 0`. No
  `updated_at`, so the `touch_updated_at` loop attaches no trigger: it is a
  counter, not content. RLS comes from the loop in `db/sql/001`, as for every
  table.
- **Rows are created lazily.** Nothing writes one when an article is written. A
  view or a vote creates it if it is the first; the Freshdesk import writes one
  for every article it brings in, its counts carried across. Every reader reads
  a missing row as zero.
- **Every writer and every reader's SQL is in `lib/kb/stats.ts`.**
  - `recordArticleView` inserts from a read of `kb_articles` where the id
    matches, `ON CONFLICT (article_id) DO UPDATE` adding one, so a view of an
    article that no longer exists inserts nothing and raises nothing, as the
    UPDATE it replaces did. A view racing the article's delete can still meet
    the foreign key — the delete committing between the statement's read and
    its check — and that 23503 is answered as though the delete came first.
  - `countArticleVote` is the feedback route's, in the transaction that writes
    its `kb_article_feedback` row.
  - `setArticleStats` is the Freshdesk import's, in the transaction that writes
    the article, replacing what is there: a re-import carries Freshdesk's
    running totals, as it always did.
  - The readers join through `statsOfArticle` and read `articleViews`,
    `articleHelpful` and `articleUnhelpful`, each a `coalesce(…, 0)`, through a
    left join — `folderNeighbours`' related list, `listArticlesForAdmin`,
    `getArticleForEdit` (as `stats`, which the editor's sidebar takes as it is).
    `popularArticles` inner-joins, because it keeps only articles with views,
    and an article with no row has none.
- **Locks.** A view after an article's first updates the stats row alone: the
  read of `kb_articles` takes no lock, and Postgres skips the foreign-key check
  on an update that leaves the key alone, so the article's row is untouched
  (`xmin`, and here `xmax` too, unchanged). The first view inserts, and the
  insert's foreign-key check takes KEY SHARE on the article for the length of
  one statement, which only a delete, or an edit changing a column under one of
  the table's unique keys — the slug, the locale, the external id — waits on. Measured on two connections against local Postgres 16.

## PR 1 — this one

Adds the table, moves every writer and reader to it, and copies today's counts
across. Into `dev`; it reaches production on the first deploy after `dev` is
merged into `main`. #466 is on `dev` and not yet on `main`, so unless a release
goes out between them the two deploy together.

- **The copy** is `db/sql/011_kb_article_stats_backfill.sql`: `INSERT … SELECT`
  from `kb_articles` for every article with a non-zero count,
  `ON CONFLICT (article_id) DO NOTHING`, so a replay — every deploy — never
  overwrites a row, whoever wrote it, and inserts nothing once every article is
  copied. It follows `004`, `007` and `009`, and says in its comment that PR 2
  deletes it before the columns go.
- **Accepted loss.** Migrations run in `preDeployCommand`, while the old web
  release still serves. A view or a vote the old code makes between the copy
  and the new code going live lands on the old columns after they were read, and
  is lost for an article already copied. Not written twice: `view_count` orders a
  shortlist and is never a business metric (`popularArticles`), and a vote's
  `kb_article_feedback` row is kept regardless. The worker deploys by hand after
  the web service, so an `import_freshdesk_kb` run on the old worker in between
  would write its counts to the old columns too; it is a cutover job, run by
  hand and on no schedule.
- **Left alone:** the three old columns, the `kb_articles` exception in
  `touch_updated_at()` and the `kb-edit-date` rule. During the deploy window
  the old code still writes those columns, and the exception still keeps its
  writes from moving the date. Comments that described the counters as written
  by readers now say they were; the function's body is byte-for-byte as #466
  left it.
- **What a view costs now.** pgbench, one client for 15 seconds, two rounds,
  local Postgres 16, bodies of distinct pseudo-words (which give the
  `search_vector` more to rebuild than prose does, so the old figures sit above
  the 2.15 and 8.5 ms measured earlier): the old UPDATE of the article row took
  3.5–3.9 ms on an 8 KB body and 17.9–18.1 ms on a 49 KB one; the stats upsert
  took 0.97–1.0 ms and 0.82–0.93 ms, the same at both sizes because it never
  reads the body.
- **What deploying it locks.** Migration 0057 creates the table and adds its
  foreign key, which takes SHARE ROW EXCLUSIVE on `kb_articles` until the
  migrations' transaction commits — validation is instant on the empty table,
  so that is milliseconds, during which the old release's view and vote UPDATEs
  and any edit queue behind it, and it waits for any open write first, up to
  `db/migrate.ts`'s ten-second `lock_timeout`. The copy then takes ROW
  EXCLUSIVE on the new table, a read of `kb_articles`, and KEY SHARE on each of
  the 108 rows it copies until its file commits.

### Verifying PR 1 in production

Read-only, once it has deployed:

1. `pg_get_functiondef('touch_updated_at'::regproc)` names `not_an_edit` —
   #466's own check, owed in §6.51.
2. Every article with a count on the old columns has a stats row, and the
   totals are at least what was copied:

   ```sql
   select count(*) filter (where s.article_id is null) as missing,
          sum(s.view_count) as views, sum(s.helpful_count) as helpful,
          sum(s.unhelpful_count) as unhelpful
   from kb_articles a
   left join kb_article_stats s on s.article_id = a.id
   where a.view_count <> 0 or a.helpful_count <> 0 or a.unhelpful_count <> 0;
   ```

   `missing` is 0, and the sums are at least 63,842, 548 and 2,313 (more by
   whatever was read and rated since). An article with no count at the copy —
   one of the four, or one created since — that the old release viewed or rated
   in the deploy window has a count on its columns and no stats row until its
   next view or vote, or the next deploy's replay of `011`, so a `missing` of
   one or two is the window, not a failed copy.

3. One article's `xmin` and `updated_at` are the same before and after it is
   opened on the help centre, and its stats row's `view_count` is one more.
   Open it signed out of the console — a private window, or the help centre's
   own host, where the console's cookie is never sent — because the view route
   counts nothing for a console session, and the `xmin` half would then pass
   with nothing written.
4. RLS is on and not forced, so the `db/sql/001` loop covered the new table:

   ```sql
   select relrowsecurity, relforcerowsecurity
   from pg_class where relname = 'kb_article_stats';  -- t, f
   ```

### The way back from PR 1

Redeploy the build before it. The table and migration 0057 stay — the old code
never names them — and so does `011`, which only the new code's deploys replay.
If that build is `main` as it stands today, it is from before #466 as well: its
replay of `db/sql/001` puts back the trigger that stamps every UPDATE, so the
rollback undoes #466 too, and a view moves `updated_at` again.

The old code reads the old columns, which hold the counts as of the copy plus
the deploy window's; every view and vote since lives only in
`kb_article_stats`. Either copy them back onto the article rows **before
triggering the rollback deploy**, while #466's function is still installed, or
accept their loss:

```sql
update kb_articles a
set view_count = s.view_count, helpful_count = s.helpful_count,
    unhelpful_count = s.unhelpful_count
from kb_article_stats s
where s.article_id = a.id;
```

That UPDATE changes only the three counters, so #466's trigger leaves every
`updated_at` where it was; run after a pre-#466 build's replay, the same UPDATE
stamps every one of those articles with the time of the rollback. Views and
votes between the copy and the old build going live are lost. Rolling forward
again afterwards, `011` leaves the existing stats rows as they are, so the old
code's counts from the rollback are lost unless copied the other way by hand.

## PR 2 — not before PR 1 is in production

**Waits for PR 1 to be merged into `dev`, released to `main` and deployed — on
the web service and on the worker** — not merely for it to be in `dev`. `dev`
reaches production in batches, so PR 2 merged into `dev` before PR 1 has
shipped would deploy with it: the drop would run in `preDeployCommand` while the
old web release still serves, and every view and vote it makes, and every
article it inserts (drizzle names every column in an INSERT, `default` for the
ones it was not given), would fail until the new release was live; and an old
worker running `import_freshdesk_kb` would fail for as long as it stayed on old
code. And with `011` deleted, no copy would ever run.

It does, in one change:

- drops `view_count`, `helpful_count` and `unhelpful_count` from `kbArticles`,
  through `db/schema/kb.ts` and `npm run db:generate`;
- deletes `db/sql/011_kb_article_stats_backfill.sql` and its test, since a replay
  reading a dropped column fails the deploy;
- puts `touch_updated_at()` back to its one-line body, `NEW.updated_at = now()`.
  That removes the whole `kb_articles` branch, including its other half, which
  keeps the date on an UPDATE that changes nothing at all. Every comment and
  test that relies on that half changes with it: §6.59, `seed-console-handbook.ts`
  and `normalise-kb-formatting.ts` and its test (which use `xmin` already),
  `db/sql/touch-updated-at.db.test.ts`'s `kb_articles` cases, and the
  `AdminArticleRow.updatedAt` comment in `lib/kb/admin.ts`;
- deletes `scripts/ci/rules/kb-edit-date.mjs`, its test and its entry in `RULES`;
- drops the destructuring that leaves the three columns out of
  `getArticleForEdit`'s select, and the `Omit` on `EditableArticle`.

**Its own deploy window.** PR 1's code still names the three columns in every
INSERT into `kb_articles` — `saveArticle`'s for a new article, the Freshdesk
import's and `seed_console_handbook`'s — because drizzle names every column,
`default` for the ones it was not given. No release can stop doing that before
the one that drops them: CI's drift check refuses a schema that leaves out a
column the database still has. So PR 2 deploys the **worker first**, whose code
names none of the three and works against the table before the drop as after
it, and the web service second, whose `preDeployCommand` drops them. For the
length of that deploy the old web release still counts views and votes and
draws every page, and fails only on creating a new article in the console,
which the editor saves again once the new release is live.

`ALTER TABLE … DROP COLUMN` takes ACCESS EXCLUSIVE on `kb_articles`, briefly,
behind every open reader, under the same ten-second `lock_timeout`.

### The way back from PR 2

The column drop cannot be undone by redeploying PR 1's build alone: that build's
inserts name the three columns, and its replay of `011` reads them. Restore the
columns first — a migration adding them back as `integer NOT NULL DEFAULT 0` —
and then redeploy. Nothing is lost: the counts are in `kb_article_stats`, which
PR 1's code reads, and `011` finds every restored column zero and copies
nothing.
