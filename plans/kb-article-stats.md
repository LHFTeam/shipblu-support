# The knowledge base's reader counters in a table of their own

`kb_articles` carried three counters that readers write: `view_count`, one more
on every article view (`recordArticleView`, beaconed by the article page and rate
limited), and `helpful_count` / `unhelpful_count`, one more on every "Was this
helpful?" tap, in the transaction that stores its `kb_article_feedback` row. So
every reader wrote the article's own row.

That made `kb_articles.updated_at` follow readers, and #466 fixed only the date:
`touch_updated_at()` in `db/sql/001_extensions_and_triggers.sql` kept the old
date when an UPDATE changed nothing but those three, comparing
`to_jsonb(NEW) - not_an_edit` with `OLD`, and the `kb-edit-date` repo rule held
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
console edit touches. It takes two pull requests, because the column drop must
not reach production while code that reads or counts into the columns is still
running there. Even PR 1's code names them in an article INSERT, which leaves PR
2's deploy one short window of its own (below).

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
- **Rows are created lazily.** No console write creates one. A view or a vote
  creates it if it is the first; the Freshdesk import writes one for every
  article it brings in, its counts carried across, zeros included. Every reader
  reads a missing row as zero.
- **Every write that counts is in `lib/kb/stats.ts`**, with the join and the
  zero-for-missing counts the readers share; `011` was the one-off copy, which
  PR 2 moves into migration 0059.
  - `recordArticleView` inserts from a read of `kb_articles` where the id
    matches, `ON CONFLICT (article_id) DO UPDATE` adding one, so a view of an
    article that no longer exists inserts nothing and raises nothing, as the
    UPDATE it replaces did. A view racing the article's delete can still meet
    the foreign key — the delete committing between the statement's read and
    its check — and that 23503 is answered as though the delete came first.
  - `recordArticleVote` is the feedback route's: its `kb_article_feedback` row
    and the counter in one transaction, the same delete race answered the same
    way.
  - `setArticleStats` is the Freshdesk import's, in the transaction that writes
    the article. Each counter takes the greater of what is there and
    Freshdesk's running total: the import used to replace them, which would
    now throw away everything counted here since cutover, and zero a
    translation whose payload carries no counts.
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
  the table's unique keys — the slug, the locale, the external id — waits on.
  Measured on two connections against local Postgres 16.

## PR 1 — #472, in production

Adds the table, moves every writer and reader to it, and copies today's counts
across. #466 went first: it reached `main` through #470, and production's
`touch_updated_at` named `not_an_edit` when read on 2026-11-06 at 15:52 UTC.

Merged into `dev` as `62eae73`, released to `main` in #475 (`31c8973`), and
deployed on 2026-11-06: the web service by itself at 17:58 UTC, once `main`'s
checks had passed, and the worker by hand at 18:56. The web service deploying
itself was not the plan: `render.yaml` said `autoDeployTrigger: 'off'` for it,
but the running service read `autoDeploy: yes`, `autoDeployTrigger: checksPass`
that day. The worker and the four crons read `off` then, and were switched to
`checksPass` from 19:43 that evening; #479 records both in `render.yaml` and
PROJECT-STATE §2.

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
  `kb_article_feedback` row is kept regardless. The worker was deployed by hand
  after the web service — for #475, the web service at 17:58 UTC on 2026-11-06
  and the worker at 18:56 — and an `import_freshdesk_kb` run on the old worker
  in between would write its counts only to the old columns, where for an
  article already copied they never reach `kb_article_stats`. It is a cutover
  job, run by hand
  and on no schedule: **do not run it until the worker is on this build.**
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

Read-only, once it has deployed. Read on 2026-11-06 after the web deploy, and
again at 19:04 UTC: the answers follow each step.

1. `pg_get_functiondef('touch_updated_at'::regproc)` names `not_an_edit` —
   #466's own check, owed in §6.51. It did, and the six views the old release
   counted between 15:53 and 17:46 left every `updated_at` where it was: the
   newest stayed 2026-11-05 22:33.
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

   `missing` was 0, with 108 stats rows, and at 19:04 the sums were 63,848,
   548 and 2,313 — exactly what the old columns held, the six views above
   included, and no stats row below its article's columns.

3. One article's `xmin` and `updated_at` are the same before and after it is
   opened on the help centre, and its stats row's `view_count` is one more.
   Open it signed out of the console — a private window, or the help centre's
   own host, where the console's cookie is never sent — because the view route
   counts nothing for a console session, and the `xmin` half would then pass
   with nothing written.

   Still to be seen: no view or vote had reached the new release by 19:04, the
   totals unchanged since the copy. `app/api/kb/stats.db.test.ts` holds it in
   CI, against the real writers.

4. RLS is on and not forced, so the `db/sql/001` loop covered the new table:

   ```sql
   select relrowsecurity, relforcerowsecurity
   from pg_class where relname = 'kb_article_stats';  -- t, f
   ```

   `t`, `f`; and no trigger on the table.

### The way back from PR 1

Only until PR 2 has deployed; after that, PR 2's way back comes first.

Redeploy the build before it. The table and migration 0057 stay — the old code
never names them — and so does `011`, which only the new code's deploys replay.

The old code reads the old columns, which hold the counts as of the copy plus
the deploy window's; every view and vote since lives only in
`kb_article_stats`. Either copy them back onto the article rows just before
triggering the rollback deploy, or accept their loss:

```sql
update kb_articles a
set view_count = s.view_count, helpful_count = s.helpful_count,
    unhelpful_count = s.unhelpful_count
from kb_article_stats s
where s.article_id = a.id;
```

That UPDATE changes only the three counters, so #466's trigger, which the build
before this one has too, leaves every `updated_at` where it was. A rollback to a
build from before #466 would put the plain stamp back in its replay of
`db/sql/001`, and the same UPDATE run after that would date every one of those
articles to the rollback, so it runs before the deploy, not during it. Views and
votes between the copy and the old build going live are lost: run afterwards, it
would overwrite what the old build had counted by then. Rolling forward
again afterwards, `011` leaves the existing stats rows as they are, so the old
code's counts from the rollback are lost unless copied the other way by hand.

## PR 2 — this one

**It waited for PR 1 to be merged into `dev`, released to `main` and deployed —
on the web service and on the worker** — not merely for it to be in `dev`. `dev`
reaches production in batches, so PR 2 merged into `dev` before PR 1 had
shipped would have deployed with it: the drop would run in `preDeployCommand`
while the old web release still served, and every view and vote it made, and
every article it inserted (drizzle names every column in an INSERT, `default`
for the ones it was not given), would fail until the new release was live; an
old worker running `import_freshdesk_kb` would fail for as long as it stayed on
old code. PR 1 has been on both since 18:56 UTC on 2026-11-06, and its copy is
complete (above), so the drop loses nothing in production.

It does, in one change:

- **migration 0060 drops** `view_count`, `helpful_count` and `unhelpful_count`
  from `kbArticles`, through `db/schema/kb.ts` and `npm run db:generate`;
- **migration 0059 copies them first.** It is the copy `011` made, moved into a
  migration (`drizzle-kit generate --custom`, as 0047 is) so that it runs ahead
  of the drop in the same transaction. `011` replays after every migration, so
  on a database taking 0057 and 0060 in one deploy the columns would be gone
  before it ran, and every count with them. That is staging, suspended since
  August, or any database that skipped PR 1's release. In production it inserts
  nothing: every count was copied when PR 1 deployed, and nothing has written
  the columns since;
- deletes `db/sql/011_kb_article_stats_backfill.sql` and its test, since a
  replay reading a dropped column fails the deploy. The copy's test is now
  `db/kb-article-stats-copy.db.test.ts`, which puts the columns back in a
  transaction it rolls back and runs 0059 and 0060 from their files;
- puts `touch_updated_at()` back to its one-line body, `NEW.updated_at = now()`.
  That removes the whole `kb_articles` branch, including its other half, which
  keeps the date on an UPDATE that changes nothing at all. Every comment and
  test that relies on that half changes with it: §6.59,
  `seed-console-handbook.ts` and `normalise-kb-formatting.ts` and its test
  (which use `xmin` already),
  `db/sql/touch-updated-at.db.test.ts`'s `kb_articles` cases, and the
  `AdminArticleRow.updatedAt` comment in `lib/kb/admin.ts`;
- adds `worker/handlers/seed-console-handbook.db.test.ts`. With that half gone,
  the seed's own comparison is all that keeps a re-run from moving every
  handbook article's date, and CI's step counts articles and versions, which a
  structural re-assert changes neither of. The test reads `xmin`;
- deletes `scripts/ci/rules/kb-edit-date.mjs`, its test and its entry in `RULES`;
- drops the destructuring that leaves the three columns out of
  `getArticleForEdit`'s select, and with it the `Pick` that `EditableArticle`
  takes from it;
- adds `db/runbooks/kb-article-counters-restore.sql` and its test, the way back
  (below);
- and changes the comments that described the old columns, or the exception, as
  still there.

**Its own deploy window.** PR 1's code still names the three columns in every
INSERT into `kb_articles` — `saveArticle`'s for a new article, the Freshdesk
import's and `seed_console_handbook`'s — because drizzle names every column,
`default` for the ones it was not given. No release can stop doing that before
the one that drops them: CI's drift check refuses a schema that leaves out a
column the database still has. The web service's `preDeployCommand` copies
(0059) and drops (0060), and PR 2's worker names none of the three, so it works
against the table before the drop as after it. For the length of the web
service's deploy the old web release still counts views and votes and draws
every page — every read in PR 1's code names its columns, and none of
the three — and fails only on creating a new article in the console, which the
editor saves again once the new release is live.

Once 0060 has committed, that lasts until a deploy succeeds, not only for the
length of this one. Should the replay of `db/sql` fail after it, or the new
release fail its health check, Render keeps the old release serving. The way
out is to deploy the same commit again: its migrate finds 0060 applied and only
replays `db/sql`. The other way out is the runbook below, which gives the old
release its columns back. Redeploying PR 1's build without the runbook fails
its own preDeploy, on `011`.

Nothing orders the worker before the drop any more. Every production service
deploys itself once the checks on `main` pass, all six starting together. That
was read off Render on 2026-11-06; `render.yaml` and PROJECT-STATE §2 say so
once #479 lands, so read the dashboard rather than either file before relying
on it. On `eb69c8c` the worker went live at 20:04:00,
the second the web service's `preDeployCommand` began to migrate. So the old
worker may still be running when the columns go. Its only writes that name them
are the INSERTs of `import_freshdesk_kb` and `seed_console_handbook`, both run
by hand and on no schedule. Run neither from the release merge until the worker
is on this build (`list_deploys`, or `/api/health`'s commit). No cron touches
`kb_articles`.

The trigger goes back to the plain stamp in the same `preDeployCommand`, the
replay of `db/sql/001` after the migrations. From then on an UPDATE of an
article that changes nothing moves its date, as on every other table. So the
writers that may have nothing to say compare first (§6.59).
`seed_console_handbook` and `normalise_kb_formatting` already did, field by
field. PR 2 adds the console's Save and the `import_freshdesk_kb` re-run, which
ask `changesNothing` (`lib/kb/article-write.ts`). The Save wrote every field on
every save, and the re-run wrote every article it found as it was, so each
moved the whole of what it touched to the top of `/kb`. The Save also folds the
textarea's line breaks to LF before comparing. A browser posts CRLF whatever
the box holds, so a body stored with LF, the handbook's among them, came back
different on every unedited Save, which cut a version and moved the date.

Two writes still stamp a no-op, both rare and deliberate. One is a restore of
a version identical to the current text, which cuts a version as well. The
other is a stale Unpublish or Archive, posted from a page drawn before the
article reached that status: the sidebar never offers the status an article
already has. A stale Publish is a real write, since it re-dates `publishedAt`
and re-credits the approver.

`ALTER TABLE … DROP COLUMN` takes ACCESS EXCLUSIVE on `kb_articles` and writes
no row: a catalog change, held until the migrations' transaction commits. It
waits behind every open reader, up to the same ten-second `lock_timeout`, and
while it waits, every new read of the table queues behind it, the help centre's
pages included. A long transaction open on `kb_articles` is worth finding before
the merge (PROJECT-STATE §5.5's `pg_stat_activity` query). 0059's copy before it
reads the table under ACCESS SHARE and, in production, inserts nothing.

### Verifying PR 2 in production

Read-only, once the web service has deployed it:

1. 0059 and 0060 are the two newest rows Drizzle recorded:

   ```sql
   select created_at from drizzle.__drizzle_migrations
   order by created_at desc limit 2;  -- 1793998971121, 1793998969537
   ```

2. The columns are gone, and the trigger is the plain stamp:

   ```sql
   select column_name from information_schema.columns
   where table_schema = 'public' and table_name = 'kb_articles'
     and column_name in ('view_count', 'helpful_count', 'unhelpful_count');
   -- no rows
   select pg_get_functiondef('touch_updated_at'::regproc) like '%not_an_edit%';
   -- f
   ```

3. `kb_article_stats` still holds 108 rows or more, and their sums are at least
   63,848, 548 and 2,313.
4. One view, opened signed out as in PR 1's step 3, leaves the article's `xmin`
   and `updated_at` where they were and adds one to its stats row — the check
   PR 1 could not complete, if nobody has read an article since.

Record the answers in PROJECT-STATE §6.51, and put §6.51 and §6.59 into the
present tense there.

### The way back from PR 2

_The runbook below is gone from the tree, and stops being a way back once
`0061_kb_images` is applied: see the end of this section before following it._

`db/runbooks/kb-article-counters-restore.sql`, run by hand on the session
connection, never the transaction pooler:

```bash
psql "$DATABASE_URL_SESSION" -v ON_ERROR_STOP=1 -f db/runbooks/kb-article-counters-restore.sql
```

In one transaction, it puts the three columns back as `integer NOT NULL DEFAULT
0` and deletes 0060's row from `drizzle.__drizzle_migrations`. It refuses if a
migration newer than 0060 has been applied, and a second run refuses too.
Nothing is lost: the counts are in `kb_article_stats`, which the earlier build's
code reads, and its replay of `011` finds each restored column zero and copies
nothing. 0059 stays recorded, with nothing left to copy.

Then put the web service back on the build it ran before this release
(`eb69c8c` as this is written; record the exact commit at the release), by hand:

1. Turn auto-deploy off on every production service that has it on. Read the
   setting in the dashboard, since `render.yaml` and PROJECT-STATE §2 can lag
   it; on 2026-11-06 all six had it on (#479). Each has its own reason. The web
   service: its preDeploy is the only thing that migrates, so a commit on
   `main` still carrying 0060 would apply it again under the old build. The
   worker and the four crons: they would go live on newer code against a
   schema nothing has migrated.
2. Deploy the earlier build to the web service. The worker and the crons can
   stay on PR 2, whose code names none of the three.

Not by reverting the release. A revert deletes 0059 and 0060, and CI refuses a
pull request that deletes a migration (`generated-files`). Even forced through,
the work landing again later would carry 0060 under a `when` older than
whatever was generated in between, and Drizzle would skip it for good.

Deleting 0060's row is what lets the release roll forward again. Drizzle
applies only migrations newer than the newest row, so with the row left in
place a later deploy of PR 2 would skip 0060 and keep the columns for good.
With it gone, turning auto-deploy back on is the roll forward: the next deploy
of `main` drops them again.

Driven end to end on a scratch Postgres 16 with each build's own `db:migrate`:

1. PR 1;
2. PR 2: the columns gone, the one-line body;
3. the runbook;
4. PR 1 again: the columns there, #466's body back, no migration applied;
5. PR 2 again: the columns gone and the one-line body back.

The runbook's test runs it and then 0060 again on every CI run. It fails once a
migration follows 0060, and the PR adding that migration deletes the runbook
and writes the way back from there.

**Since `0061_kb_images` it is gone from the tree.** It was deleted with its
test in the PR that adds that migration (PR 1 of
`plans/freshdesk-disconnection.md`). Until that release's web preDeploy has
applied `0061` in production, the runbook still works from history,
unchanged: `git show b1032df:db/runbooks/kb-article-counters-restore.sql`. On
2026-11-08, `0060` was the newest migration applied in production, the three
columns were gone, and `kb_article_stats` held 108 rows.

Once `0061` is applied, PR 2 has no way back by the runbook. Deleting 0060's
row would not make a deploy apply it again behind a newer row, and the runbook
refuses for that reason before it changes anything. A problem found in PR 2
after that is fixed forward, the way going back past PR 1 is (below): a
migration of its own and a new commit.

Rolling the web service back to a build from before `0061` would also strand
the knowledge base's images. That build has no `/api/kb/images` route, so
`rehost_kb_images revert=true` has to run first, while Freshdesk still serves
the originals.

Going back past PR 1 is not prepared here, and is no longer a revert either.
Reverting #472 deletes 0057, which `generated-files` refuses. A redeploy of the
build before it would take #473 out as well. It would be a forward change:

- the old readers and writers restored in a new commit;
- the columns added back to the schema through a migration of its own, rather
  than this runbook, so that the schema and the database agree;
- `kb_article_stats` copied back onto the columns before that code reads them.
