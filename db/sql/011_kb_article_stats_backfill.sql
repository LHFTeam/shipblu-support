-- Post-migration SQL: the reader counters an article carried before they had a
-- table of their own.
--
-- Migration 0057 created `kb_article_stats`, and from this release
-- `recordArticleView`, the feedback endpoint and the Freshdesk import write the
-- counters there and every reader reads them there (`lib/kb/stats.ts`). The
-- counts each article had until now are on its own row, in `view_count`,
-- `helpful_count` and `unhelpful_count`, which nothing reads any more; without
-- this every article would read as never opened and never rated, the help
-- centre's "most read" list would hide itself, and a year of Freshdesk's views
-- carried across at cutover would be gone.
--
-- Each article with any count is given a stats row holding them. An article
-- with none is left without one, since the readers read a missing row as zero
-- and a view or a vote creates it when there is something to count.
--
-- **Never overwrites.** `ON CONFLICT DO NOTHING`, so a row the new code has
-- written since — the first view after the deploy creates one — is left as it
-- is, and a replay on every later deploy inserts nothing for an article it has
-- already copied. Migrations run in `preDeployCommand`, while the old release
-- still serves, so a view or a vote in the minutes between this copy and the
-- new code going live lands on the old columns after they were read, and is
-- lost for an article already copied. Accepted rather than written twice:
-- `view_count` orders a shortlist and is never a business metric
-- (`popularArticles`), and a vote's own `kb_article_feedback` row is kept
-- whatever happens to its count. A replay does pick up a count of that window
-- for an article that had none before it and has had no view or vote since,
-- which can only add what the old release counted.
--
-- No lock beyond what an insert needs: ROW EXCLUSIVE on the new table, a read
-- of `kb_articles`, and the foreign key's KEY SHARE on each article it copies.
-- The old release's view and vote UPDATEs do not wait on that, nor does any
-- edit but one changing a column under one of the table's unique keys (the
-- slug, the locale, the external id); that edit, or a delete, waits until this
-- file's transaction commits. A replay that finds every row already there
-- inserts nothing and takes no row lock.
--
-- **Removed before the columns are.** The release after this one drops the
-- three columns (`plans/kb-article-stats.md`, PR 2), and deletes this file in
-- the same change, because a replay reading a dropped column fails the deploy.
insert into kb_article_stats (article_id, view_count, helpful_count, unhelpful_count)
select id, view_count, helpful_count, unhelpful_count
from kb_articles
where view_count <> 0 or helpful_count <> 0 or unhelpful_count <> 0
on conflict (article_id) do nothing;
