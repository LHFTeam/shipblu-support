# Comment channels, subcategories, a ticket category, and routing by it

Five requests, from the support lead on 2026-10-19:

1. Facebook comments and Instagram comments become channels of their own.
2. The ticket field called "category" becomes "subcategory", everywhere.
3. A new ticket field called "category" says whose work a ticket is: sales,
   customer support or merchant support, with more values to come.
4. Jev — TypeSafe's System One, already the provider behind priority — sets
   that category on incoming messages.
5. Each channel chooses whether a new ticket goes to the channel's default
   group or to the group its category names, and the ticket is then assigned
   to a member of that group. The example given: a Messenger message that Jev
   reads as sales goes to the Sales group, and somebody in Sales gets it.

The fifth came with a question: should this be a per-channel setting, or an
automation? **It should be a setting, with automations able to refine what it
does.** An automation alone cannot do it, for four reasons that are each
facts about the code rather than preferences:

- **The category arrives after everything that would act on it.** A new
  ticket's `on_create` rules, SLA, auto-assignment and out-of-hours reply run
  inline, in that order (`lib/tickets/lifecycle.ts:65-70`). Jev's answer comes
  from a queued job, about 2 s after the message on production's priority runs
  (p90 3 s, p99 6 s). So an `on_create` rule almost never sees a category.
  Nothing guarantees it never does: priority documents the same race in
  `lib/priority-ai/run.ts:286-299`, and only provider latency keeps the job
  second.
- **The first message often says nothing.** On Facebook, five identical
  greetings of 10–13 characters open 137 of 248 DM tickets (55%), and each is
  followed by unrelated topics. The informative message is the second one at
  the median, arriving 0.3 min later, and at p90 it arrives 9.5 min later.
  Something has to wait for it without assigning the ticket first, and the
  engine has no way to hold anything.
- **`on_update` fires on every touch and remembers nothing.** It runs on every
  customer reply, every sidebar edit and every applied priority answer
  (`lib/tickets/lifecycle.ts:76-77,86-89`). It keeps no per-ticket record of
  having run (`lib/automations/index.ts:392-395`). A rule "category is sales →
  move to Sales" moves the ticket back to Sales every time the customer
  writes, after an agent has deliberately moved it to Support.
- **A per-channel choice becomes rules multiplied by channels.** Three
  categories on five channels is fifteen rules to author. A typo in any of them
  silently leaves tickets in the default group, and nothing says why.

Making the engine able to do this means adding a hold, a fire-once trigger, a
fallback timer and SLA re-selection. That builds the routing feature inside the
engine, against the README's stated reason for keeping one engine. So the
initial route is decided once, by one tested module, from a channel setting and
a group named on the category's row. After that, the ordinary `on_update` pass
runs **before** anybody is assigned, so a rule can still say "sales on the
merchant number goes to Merchant Care".

The rest of this file covers what the research found, the decisions and what
each one rules out, the deploy rules every stage obeys, the work in the order it
has to ship, how each stage is verified and rolled back, and the questions only
the support lead can answer. The plan went through two rounds of adversarial
review against the code before this version. The first covered deploy order,
rollback, migrations, routing races and the classifier. The second covered the
redesigned routing hold and consistency between sections. Every finding that
held is folded in. The support lead answered every open question on
2026-10-20; [Decisions taken](#decisions-taken-with-the-support-lead-2026-10-20)
records the answers, and the plan below already reflects them.

## Status and handoff

As of 2026-10-29, 14:45 UTC. A session picking this plan up starts here.
Everything after this section is the design as it was reasoned and as each stage
was built. This section says where the work stands, what comes next and how, and
what has already bitten. Whoever moves any of it updates this section in the
same PR. Every figure here was read from production, Render or GitHub at that
time, or at the time it gives: re-read before acting on one. The time is on this
line rather than in the heading so that links to the section survive each
update.

### Where it stands

| Stage | Code                                                                                                                                              | Production                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Merged: #386 (`01488c9`)                                                                                                                          | Live since 2026-10-20. Its two operational steps were never done (below)                                                                                                                                                                                                                                                                                         |
| 1.1   | Merged: #387, then `dev` → `main` in #389 (`1f89219`)                                                                                             | Live since 2026-10-21 10:13 UTC                                                                                                                                                                                                                                                                                                                                  |
| 1.2   | Merged: #391 (`31f7379`) and follow-up #392 (`7b7d276`), then `dev` → `main` in #393 (`634a28d`), which also carried another session's #390       | **Done.** All six services live on `634a28d` by 17:38 UTC on 2026-10-21, worker first. The user ran the backfill and the rollup from a shell, leaving no `jobs` row. Every check below reads clean                                                                                                                                                               |
| 1.3   | Merged: #395 (`58c5ed9`), then `dev` → `main` in #397 (`447d8be`), which also carried #394, #396 and #398. As built below                         | **Done.** All six services live on `447d8be` by 18:36 UTC, web first. Its checks read clean (below), though no comment has arrived since                                                                                                                                                                                                                         |
| 2.A   | Merged: #400 (`a558c5b`), then `dev` → `main` in #406 (`e88d357`), which also carried #399, #401 and #402. As built below                         | **Done.** All six services live on `e88d357` by 22:13 UTC on 2026-10-23, deployed at once by an environment update. Its checks read clean (below)                                                                                                                                                                                                                |
| 2.B   | Merged: #403 (`1d21cdc`), then `dev` → `main` in #413 (`516c8ff`) and #415 (`48cb284`). As built below                                            | **Done.** All six services live on `48cb284` by 06:01 UTC on 2026-10-25, web first, with nothing suspended. Its checks read clean, and a new message was subcategorised; one read left (below)                                                                                                                                                                   |
| 3.1   | Merged: #419 (`ff3bbfd`), then `dev` → `main` in #420 (`b9a4743`), which also carried #411, #416, #417 and #418. As built below                   | **Done.** Web live on `b9a4743` at 19:44 UTC on 2026-10-25, the worker and the four crons by 08:05 UTC on 2026-10-26, and the four categories seeded at 08:13. Its checks read clean (below); the signed-in ones are left                                                                                                                                        |
| 3.2   | Merged: #424 (`07a5527`), then `dev` → `main` in #426 (`f761e5e`), which also carried #421, #422 and #423. As built below                         | **Done.** All six services live on `f761e5e` by 23:32 UTC on 2026-10-26, web first. Its checks read clean (below); the signed-in ones are left                                                                                                                                                                                                                   |
| 4.0   | Merged: #425 (`1c733c2`), then `dev` → `main` in #428 (`156004d`). As built below                                                                 | **Done.** All six services live on `156004d` by 07:45:42 UTC on 2026-10-27, web first. Its checks read clean (below)                                                                                                                                                                                                                                             |
| 4.1   | Merged: #427 (`959404a`), then `dev` → `main` in #430 (`dbf4376`). As built below                                                                 | **Done.** All six services live on `dbf4376` by 12:07:54 UTC on 2026-10-27, web first, with `0050` applied. Shipped off: no settings row. Its checks read clean (below)                                                                                                                                                                                          |
| 4.2   | Merged: #429 (`c6eb1ac`), then `dev` → `main` in #431 (`ad6a062`). As built below                                                                 | **Done.** All six services live on `ad6a062` by 21:49:08 UTC on 2026-10-27, web first; code only. Its checks read clean (below). Its first step is under way: the archive record run is done, and Shadow has run since 06:00:32 UTC on 2026-10-29, for two weeks at least, while a supervisor labels (below). Apply and the backlog wait for the user's go-ahead |
| 5.1   | Merged: #432 (`9d5b4fb`), then `dev` → `main` in #435 (`1470902`). As built below                                                                 | **Done.** All six services live on `1470902` by 06:35:36 UTC on 2026-10-29, web first, with `0051` applied. Shipped off: every channel on `default_group`. Its checks read clean (below); the signed-in one is left                                                                                                                                              |
| 5.2   | Not started (operations: turning routing on)                                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                |
| 6     | Merged: #434 (`1daf6a5`), then `dev` → `main` in #437 (`9b4bc5b`); its screenshot pass in #438 (`b237858`), then #439 (`063e477`). As built below | **Done.** All six services live on `9b4bc5b` by 11:29:28 UTC on 2026-10-29, web first, with `0052`–`0055` applied, and on the screenshot pass's `063e477` by 14:27:51. Both sets of checks read clean (below); the first Stage 6 nightly and the signed-in reads are left                                                                                        |

**The screenshot pass's deploy and checks, read on Render and production on
2026-10-29.** Code and copy only: no migration, no `db/sql` change, no env var.

- **Before** (read 14:16 UTC): all six services on `9b4bc5b`; `/api/health`
  reported nothing pending or processing and the one dead job; no service had
  logged a warning or an error in the hour before. `origin/main..origin/dev`
  held `b237858` alone, whose tree is #438's reviewed head `67bda1f`.
- **The release.** #438 was squashed into `dev` as `b237858`, and #439 merged
  `dev` into `main` as `063e477` once its nine checks were green, the database
  tier included. Web was deployed through Render's API at 14:22:14; its
  preDeploy found no migration to apply and replayed the nine `db/sql` files
  in about a second (14:24:32–33), and `/api/health` reported `063e477` at
  14:25:29. The worker and the four crons were triggered at 14:25:37–46: the
  crons were live at 14:26:26–28 and the worker at 14:27:51.
- **The checks** (read 14:26–14:35 UTC):
  - none of the six services logged a warning or an error from 14:22, and web
    served no 5xx after it went live;
  - all 531 jobs created since 14:22 completed, none was overdue, and the dead
    job is still the one from 2026-09-21; 56 migrations, as before;
  - the first runs on the new code finished cleanly: `shipblu-sla-sweep` at
    14:30:50 (`sla_sweep`, `presence_sweep` and `assign_sweep`, each ok) and
    `shipblu-time-automations` at 14:31:33 (`run_time_automations` ok, one
    rule over 552 tickets, nothing changed);
  - `/api/health` reports `063e477`.

  Left, as before: the first Stage 6 nightly, and the signed-in reads, which
  now cover the screenshot pass's pages too.

**6's deploy and checks, read on Render and production on 2026-10-29.**

- **Before** (read 11:16 UTC): 52 migrations; the duplicate-slice and
  two-dimension queries both 0, over 341 `metrics_daily` rows and 61
  `rollup_days`; no transaction older than a minute, none waiting on a lock or
  idle in one, and no strong lock on `metrics_daily`, `rollup_days` or
  `routing_decisions`; every job created in the hour before completed (2,515),
  and the same one dead job. All six services ran `1470902`, and
  `origin/main..origin/dev` held `1daf6a5` alone.
- **The release and web.** #434 was squashed into `dev` as `1daf6a5`, its tree
  identical to the reviewed head `13f977d`. #437 merged `dev` into `main` as
  `9b4bc5b` once its nine checks were green. Web was deployed on it through
  Render's API at 11:17:07. Its preDeploy logged `Applying drizzle
migrations...` at 11:19:30.7 and was applying `001` by 11:19:30.9, so
  `0052`–`0055` took under 0.3 s; all nine `db/sql` files were done at
  11:19:31.7. Web was live at 11:20:15.
- **Then the worker and the four crons.** The worker was triggered at 11:25:53
  and live at 11:28:10. The crons were triggered at 11:28:37–43 and live at
  11:29:14–28. The old worker took jobs until 11:30:32, about two and a half
  minutes after Render reported the new one live.
- **The checks** (read 11:25–11:56 UTC):
  - 56 migrations; `metrics_daily.category_id`; `metrics_daily_slice_key` over
    the day and the four dimensions, `NULLS NOT DISTINCT`;
    `metrics_daily_one_dimension` present and validated;
    `routing_decisions_started_idx` and `routing_decisions_undecided_idx`;
    `rollup_days.categories_computed_at`, nullable, on no day yet;
  - the Stage 6 verification rows: 0 duplicate slices, 0 rows naming two
    dimensions, and no category row, since nothing in production carries a
    category;
  - all 2,615 jobs created since the migration completed, none overdue, and
    the same one dead job;
  - none of the six services logged a warning or an error, and web served no
    5xx;
  - every cron run since was successful: `shipblu-sla-sweep` from 11:32 and
    `shipblu-time-automations` from 11:31;
  - `/api/health` reports `9b4bc5b`; all nine channels still on
    `default_group`, no `routing_decisions` row, the classifier in Shadow.

  Left: the first Stage 6 nightly, at 00:00 UTC on 2026-10-30, which proves the
  writer; and the signed-in reads of `/reports`, `/reports/routing` and
  `/admin/dashboard`.

**5.1's deploy and checks, read on Render and production on 2026-10-29.**

- **Before** (read 06:18–06:26 UTC): 51 migrations; no transaction waiting on a
  lock and none idle in one; every job created in the hour before completed,
  and the same one dead job, a `subscribe_meta_webhooks` from 2026-09-21. All
  six services ran `ad6a062`, and `origin/main..origin/dev` held `9d5b4fb`
  alone. The classifier was in Shadow (below), so nothing could be held.
- **The release and web.** #432 was squashed into `dev` as `9d5b4fb`, its tree
  identical to the reviewed head `ec8487b`. #435 merged `dev` into `main` as
  `1470902` once its nine checks were green. Web was deployed on it through
  Render's API at 06:26:10. Its preDeploy logged `Applying drizzle
migrations...` at 06:28:24.4, and all nine `db/sql` files were done at
  06:28:25.5. Web was live at 06:29:13.
- **Then the worker and the four crons.** The worker was triggered at 06:32:46
  and live at 06:34:39. The crons were triggered at 06:34:50–56 and live at
  06:35:31–36. The old worker took jobs until 06:37:31 (its instance's last
  line, a `process_webhook … ok`), about three minutes after Render reported
  the new one live, against a schema `0051` only adds to.
- **The checks** (read 06:30–08:28 UTC):
  - 52 migrations; the three types, `channels.routing_mode`,
    `conversations.routing_window_ends_at` and `routing_decided_at`, and
    `routing_decisions` with RLS enabled, not forced, and no policy;
  - `routing_decisions_decided_complete` present, and
    `notify_conversation_change` naming both routing columns;
  - all nine channels on `default_group`; no `routing_decisions` row, no
    `settle_routing` job, and no ticket with either routing column set;
  - all 783 jobs created since the migration completed, none overdue and none
    dead;
  - none of the six services logged a warning or an error, and web served no
    5xx;
  - every cron run since was successful: `shipblu-sla-sweep` from 06:36,
    `shipblu-time-automations` from 06:46, `shipblu-whatsapp-template-sync` at
    07:03 and 08:03;
  - `/api/health` reports `1470902`;
  - eleven tickets created since; the new worker's first customer message,
    at 06:40:24 on the bot number, was appended to its ticket with nothing
    routed;
  - still no console handbook (no `handbook-` article, no
    `seed_console_handbook` job), so nothing to re-seed.

  Left: the signed-in read, that `/admin/channels` shows the Routing select on
  each form and the readiness panel.

**4.2's first operation, 2026-10-29.**

- **The archive record run.** `backfill_category_ai mode=record
runLabel=archive-1`, job `28da8309`, enqueued at 05:55:54 UTC at the user's
  go-ahead, completed on its first attempt. It wrote 1,467 rows over 509
  tickets between 05:55:57 and 05:58:52, for messages from 2026-08-16 to
  2026-10-28, under one question fingerprint and with no error. 923 asked Jev:
  590 `unknown`, 257 `would_apply`, 76 `below_threshold`. 544 were recorded
  without a call: 501 `after_settle`, 43 `capped`.
- **Shadow.** `category_ai_settings` was written at 06:00:32 UTC: mode `shadow`,
  minimum probability 0.6, routing window five minutes.
- **Its first live answer** (read 08:26 UTC): one `classify_category` job since,
  completed in 545 ms on its first attempt; one `live` row, `shadow`,
  `unknown`, with no error; no `category_changed` event since 06:00:32 and no
  ticket carrying a category; no warning or error from the worker or web since
  06:00.
- **Next**: labelling (4.2, step 2) from `/reports/category-ai`, during at least
  two weeks of Shadow, so until 2026-11-12 at the earliest. The way back is the
  switch: `mode` to `off` on `/admin/categories`.

**4.2's deploy and checks, read on Render and production on 2026-10-27.**

- **Before**: 51 migrations; nothing pending or processing in `jobs`, and the
  same one dead job. All six services ran `dbf4376`, and
  `origin/main..origin/dev` held `c6eb1ac` alone. 4.2 is code only, with no
  migration, `db/sql` change or variable.
- **The release and web.** #429 was squashed into `dev` as `c6eb1ac`, and #431
  merged `dev` into `main` as `ad6a062`. Web was deployed on it through
  Render's API at 21:43:12. Its preDeploy ran `db:migrate` at 21:45:22 with
  nothing to migrate, and all nine `db/sql` files were done at 21:45:24. Web was
  live at 21:46:42.
- **Then the rest, on the same commit.** The worker and the four crons were
  triggered at 21:47:20–28. The crons were live at 21:48:02–21:48:09, and the
  worker at 21:49:08.
- **The checks** (read 21:49–21:52 UTC):
  - every job created since the deploy completed, 25 `process_webhook`;
  - none of the six services logged a warning or an error, and web served no
    5xx;
  - `shipblu-sla-sweep`'s first run on `ad6a062`, at 21:50, finished, its
    `assign_sweep` logging `reclaimed=0 assigned=0 escalated=0`;
  - `/api/health` reports `ad6a062`, with nothing pending or processing and
    the same one dead job;
  - no `category_ai_settings` row, so the classifier is still off. Still none
    at 10:06 UTC on 2026-10-28.

**4.1's deploy and checks, read on Render and production on 2026-10-27.**

- **Before** (read 12:02 UTC): 50 migrations, the newest `1793037218791`
  (`0049`); neither `ai_category_runs` nor `category_ai_settings` existed; no
  transaction older than a minute and no strong lock held; nothing pending or
  running in `jobs`, and the same one dead job. Web and the worker ran
  `156004d`, and `origin/main` was `dbf4376`.
- **The release and web.** #427 was squashed into `dev` as `959404a`, its tree
  identical to the reviewed head `080a5a4`. #430 merged `dev` into `main` as
  `dbf4376` once its checks were green. Web was deployed on it through Render's
  API at 12:02:29. Its preDeploy logged `Applying drizzle migrations...` at
  12:04:23.6 and was applying `001` by 12:04:23.9, so `0050` took under 0.31 s;
  all nine `db/sql` files were done at 12:04:24.7. Web was live at 12:05:10.
  The worker followed at 12:05:41 and the four crons at 12:05:43–50. The crons
  were live by 12:06:29 and the worker at 12:07:54.
- **The checks** (read 12:04–12:32 UTC):
  - 51 migrations, the newest `1793058419292`;
  - both tables exist with RLS on, and carry their five CHECKs
    (`ai_category_runs_failed_has_error` and the four on the settings row);
  - no settings row, so the classifier is off and nothing is queued for it;
    `ai_category_runs` is empty;
  - all 1,531 jobs created since the deploy completed;
  - none of the six services logged a warning or an error, and web served no
    5xx;
  - `/api/health` reports `dbf4376`, with nothing pending or processing and
    the same one dead job.

**4.0's deploy and checks, read on Render and production on 2026-10-27.**

- **Before** (read 07:31–07:41 UTC): all six services ran `f761e5e`;
  `origin/main..origin/dev` held `1c733c2` alone; nothing pending or running in
  `jobs`, and the same one dead job, `subscribe_meta_webhooks` of 2026-09-21.
  4.0 is code only, with no migration, `db/sql` change or variable.
- **The release.** #425 was squashed into `dev` as `1c733c2`, its tree
  identical to the reviewed head `4a41a24`. #428 merged `dev` into `main` as
  `156004d` once its nine checks were green. Web was deployed on it through
  Render's API at 07:41:11, replayed the nine `db/sql` files by 07:42:50 with
  nothing to migrate, and was live at 07:43:42. The four crons followed at
  07:43:51–56 and were live by 07:44:34, and the worker was live at 07:45:42.
- **The checks** (read 07:43–07:47 UTC):
  - every job created since the deploy completed;
  - neither web nor the worker logged a warning or an error, and web served no
    5xx;
  - the worker started and processed webhooks, and `sla-sweep` and
    `time-automations` started their first runs at 07:46;
  - `/api/health` reports `156004d`, with nothing pending or processing and
    the same one dead job.

**3.2's deploy and checks, read on Render and production on 2026-10-26.**

- **Before** (read 23:00 and again at 23:24 UTC): 49 migrations, the newest
  `1792909175828`; `ticket_forms` empty and without `default_category_id`; no
  long transaction and no strong lock on `ticket_forms` or
  `ticket_categories`; nothing queued; the same one dead job. All six services
  ran `b9a4743`, and `origin/main..origin/dev` held 3.2 and the three plan PRs
  #421, #422 and #423, none of which touches `db/`.
- **The release and web.** #424 was squashed into `dev` as `07a5527`, its tree
  identical to the reviewed head `e773fd6`. #426 merged `dev` into `main` as
  `f761e5e`, and web was deployed on it through Render's API at 23:25:06. Its
  preDeploy logged `Applying drizzle migrations...` at 23:27:08.9 and was
  applying `001` by 23:27:09.1, so `0049` took under 0.2 s; all nine `db/sql`
  files were done at 23:27:09.7. Web was live at 23:27:54.
- **Then the rest, on the same commit**, through Render's API at 23:29:

  | Service                          | Live     |
  | -------------------------------- | -------- |
  | `shipblu-time-automations`       | 23:30:03 |
  | `shipblu-whatsapp-template-sync` | 23:30:07 |
  | `shipblu-sla-sweep`              | 23:30:07 |
  | `shipblu-nightly`                | 23:30:08 |
  | worker `shipblu-support-worker`  | 23:31:58 |

- **The checks** (read 23:29–23:41 UTC):
  - 50 migrations, the newest `1793037218791` (`0049`);
  - `ticket_forms.default_category_id` a nullable `uuid`, its foreign key
    `restrict`;
  - the four categories active, no ticket categorised, no form with a default
    and no `category_changed` event, since production holds no form;
  - all 67 jobs created since the migration completed, none with an error;
  - neither web nor the worker logged a warning or an error, and web served no
    5xx;
  - `/api/health` reports `f761e5e`, with nothing pending or processing and
    the same one dead job.
- **Still to read**, signed in: `/admin/forms` offers the Default category
  select, and the console's New form draws the Category chooser for an agent
  holding `ticket.set_category`.

**3.1's deploy and checks, read on Render and production on 2026-10-25 and
2026-10-26.**

- **Before** (read 19:40 UTC on 2026-10-25): 47 migrations, the newest
  `1792781241219`; no `ticket_categories` relation; no long transaction and no
  strong lock; one dead job, the `subscribe_meta_webhooks` from 2026-09-21.
  `origin/main..origin/dev` held 3.1 and, beside it, #411, #416, #417 and #418,
  none of which touches `db/migrations` or `db/sql`.
- **The release and web.** #420 merged `dev` into `main` at 19:41:31 UTC as
  `b9a4743`. Web was deployed on it through Render's API at 19:41:45. Its
  preDeploy logged
  `Applying drizzle migrations...` at 19:43:50.1 and
  `Done: 9 post-migration file(s) applied.` at 19:43:52.5, so `0047`, `0048`
  and `db/sql` took under 3 s between them, `0048`'s lock on `conversations`
  included. Web was live at 19:44:45.
- **Not as planned: the rest followed twelve hours later.** The worker and the
  four crons stayed on `48cb284` overnight and were deployed on `b9a4743`
  through Render's API the next morning:

  | Service                          | Started  | Live     |
  | -------------------------------- | -------- | -------- |
  | worker `shipblu-support-worker`  | 08:03:18 | 08:05:33 |
  | `shipblu-time-automations`       | 08:03:28 | 08:04:05 |
  | `shipblu-sla-sweep`              | 08:03:26 | 08:04:07 |
  | `shipblu-nightly`                | 08:03:32 | 08:04:08 |
  | `shipblu-whatsapp-template-sync` | 08:03:30 | 08:04:13 |

  The order exists so that an old time-automations cron never meets a
  `set_category` action. In the gap it met none:
  - no automation rule, SLA policy or skill names `set_category` or
    `category.id` (the newest rule edit is from 2026-10-21);
  - no `category_changed` event was written, and nothing under `/inbox` or
    `/admin` was requested;
  - all 2,709 jobs created since 19:43:50 completed, none with an error;
  - neither web nor the worker logged a warning or an error, and web served no
    5xx.

  The old code against the new schema is the rollback's own state, which
  [Rolling back 3.1](#31-as-built) already covers.

- **The seed.** `seed_ticket_categories` was queued at 08:13:58.9 with
  `ticket_categories` still empty. The worker logged
  `[seed_ticket_categories] done created=sales,customer_support,merchant_support,courier_jobs present=0`
  and completed it in 52 ms. The four rows are seeded, active, and have no
  route group. The handbook step had nothing to do: production still holds no
  `handbook:` folder, article or category.
- **The checks** (read 08:14–08:17 UTC):
  - 49 migrations;
  - `ticket_categories_key_format`, `ticket_categories_labels_not_blank`,
    `ticket_categories_pkey` and the route group's foreign key;
  - the four keys in order;
  - `notify_conversation_change` names `category_id`;
  - no conversation holds a category yet;
  - `/api/health` reports `b9a4743`, with nothing pending or processing and
    the same one dead job.
- **Still to read**, signed in: `/admin/categories` lists the four, a ticket
  page shows the select, and setting a category writes one `category_changed`
  event naming the agent. 2.B's page loads are still unread too (below): the
  user chose to release 3.1 without them.
- **2.B has no way back by renaming any more.** `0047` and `0048` are applied,
  so [Rolling back 2.B](#2b-as-built) is fixed forward from here.

**2.B's deploy and checks, read on Render and production on 2026-10-25.**

- **The release.** #403 merged into `dev` as `1d21cdc` at 22:52 UTC on
  2026-10-23, after 2.A was live, as its hold required. Then #413 took `dev`
  into `main` at 23:01 UTC, and #415 again at 16:37 UTC on 2026-10-24. Neither
  was deployed at once, so for about 31 hours `main` held a migration nothing
  had run. In that state an environment variable change, which makes Render
  redeploy every service at once (2.A's deploy, below), or a deploy of any one
  service would have shipped 2.B outside its sequence. Nothing did.
- **The deploy.** The user deployed web by hand on `48cb284` at 05:53:02 UTC on
  2026-10-25, clearing the build cache. Its preDeploy logged
  `Applying drizzle migrations...` at 05:55:10.4 and was applying `001` by
  05:55:13.1, so 0046 committed in under 3 s; all nine `db/sql` files were done
  at 05:55:13.8, and web was live at 05:56:10. Then, by hand on the same commit:

  | Service                          | Live     |
  | -------------------------------- | -------- |
  | `shipblu-time-automations`       | 05:59:43 |
  | `shipblu-whatsapp-template-sync` | 05:59:48 |
  | `shipblu-nightly`                | 06:00:37 |
  | `shipblu-sla-sweep`              | 06:01:07 |
  | worker `shipblu-support-worker`  | 06:01:12 |

- **Not as planned: nothing was suspended.** From 05:55:10 to 06:01:12 the old
  worker (`e88d357`) ran against the renamed tables, and `shipblu-sla-sweep`
  ran once on old code at 05:55:57, successfully. It cost nothing that can be
  measured:
  - no job run since 05:50 carries an error;
  - neither web nor the worker logged a warning, an error or a line naming a
    missing relation after 05:55, and web served no 5xx;
  - the six inbound messages in the window were all on `whatsapp_bot`, which
    the subcategoriser leaves out, and none came through web, so step 7's list
    under [Deploying 2.B](#2b-as-built) is empty.
- **The checks** (read 06:02–06:03 UTC):
  - no relation or type keeps an old name;
  - the six CHECKs, the composite primary key and the three `_pkey`s have the
    new names;
  - the four tables hold 55, 836, 408 and 647 rows, as before;
  - `/api/health` reports `48cb284` with an empty queue (its one dead job is a
    `subscribe_meta_webhooks` from 2026-09-21);
  - `/admin/categories` answers 307 to `/admin/subcategories`.
- **A new message, subcategorised** (read 16:20 UTC): 14 `subcategorised`
  events between 07:22 and 16:05 UTC, on customers' replies on Instagram,
  Facebook and WhatsApp, the first non-bot traffic after the deploy. Each wrote
  its `conversation_subcategories` row under the message it names, with
  `subcategory_key` equal to the key of the registry row it points at:
  `service.request_human`, `billing.payout`, `delivery.no_contact`,
  `delivery.late` and `meta.unclassified`.
- **Still to read:** step 4's page loads, which need a person signed in: a
  ticket page, a web chat ticket, `/admin/subcategories` and its shadow page.
  Render's request log holds none since the deploy (read 16:20 UTC), nor
  since 3.1's (read 08:17 UTC on 2026-10-26). The rollback runbook was the way
  back until a migration followed 0046, which 3.1's did at 19:43:50 UTC on
  2026-10-25.

**2.A's deploy and checks, read on Render and production on 2026-10-23 and
2026-10-25.**

- **The release.** #406 merged `dev` (`a3fb23d`) into `main` at 22:08:48 UTC on
  2026-10-23 as `e88d357`, carrying 2.A, #399, #401 and #402. Nobody deployed it
  by hand. At 22:10 Render started a deploy on all six services at once, each
  with `envUpdated` as its trigger: an environment variable changed, and Render
  redeploys from `main` when one does. Web's preDeploy ran from 22:12:14 to
  22:12:53 and applied no migration. All six were live between 22:11:20 and
  22:13:27, the crons first. Web was not first, and 2.A, with no migration,
  allowed that. `autoDeploy` read `no` on all six at 22:55.
- **The checks** (read at 05:51 UTC on 2026-10-25):
  - Nine detector events since the deploy, all `subcategorised` with actor
    `subcategory-detector`: facebook 6, whatsapp 2, instagram 1. The first was
    at 12:23 UTC on 2026-10-24.
  - No `categorised` event since 20:50 UTC on 2026-10-23, before the deploy.
  - 30,144 jobs run since 22:10 on 2026-10-23; none failed or died.
  - No agent holds an override naming an old permission key.
  - Render's logs for web and the worker hold no `CATEGORISE_*` line since the
    deploy. 2.A logs one, once per process, for a value still set under an old
    name, so none was left there. The same search finds the worker's
    `process_webhook` lines, so it reads the right logs.
  - The console handbook is still unseeded, so 2.A's handbook step has nothing
    to do.

**1.3's deploy, read on Render and production on 2026-10-23.**

- **The release.** #397 merged `dev` (`e7376bf`) into `main` at 18:28:11 UTC
  as `447d8be`. It carried #396 beside 1.3, and #396's migration 0044 adds
  columns that its worker and cron code reads (0045 adds an index). So rule 7
  asked for web first on #396's account, beside 1.3's own reason for it: only
  web's preDeploy replays `db/sql`. An earlier version of this section said
  the merge shipped only #394 beside 1.3 and that rule 7 asked nothing more of
  the deploy order. That was written before #396 landed on `dev`.
- **The order held.** Each service was deployed by hand on `447d8be`:

  | Service                          | Deploy                     | Started  | Live     |
  | -------------------------------- | -------------------------- | -------- | -------- |
  | web `shipblu-support`            | `dep-dbdqf4t9fdbs738ak5cg` | 18:29:39 | 18:33:07 |
  | worker `shipblu-support-worker`  | `dep-dbdqgvgm7kps73bc1tdg` | 18:33:34 | 18:35:46 |
  | `shipblu-sla-sweep`              | `dep-dbdqi38n74is73eild2g` | 18:35:57 | 18:36:34 |
  | `shipblu-time-automations`       | `dep-dbdqi49srm7s73cl8g30` | 18:36:01 | 18:36:40 |
  | `shipblu-nightly`                | `dep-dbdqi5psrm7s73cl8lh0` | 18:36:07 | 18:36:38 |
  | `shipblu-whatsapp-template-sync` | `dep-dbdqi6oae00c73am2j8g` | 18:36:11 | 18:36:47 |

  Web's preDeploy logged `Applying drizzle migrations...` at 18:32:19 and
  `Done: 9 post-migration file(s) applied.` at 18:32:23, with `008` taking
  about 180 ms of that. So no new code ran before the schema it reads.

  Old code did run against the new schema, which is additive. The old worker
  finished its last job at 18:38:02 (its instance's last log line is that
  `process_webhook … ok`), two minutes after Render reported the new one live.
  That is about five and a half minutes against the new schema, the last two of
  them beside the new worker. The only old cron run against it was
  `shipblu-sla-sweep`'s at 18:35:07–18:35:49, which succeeded. `/api/health`
  reported `447d8be` at 18:36:30, and `autoDeploy` read `no` / `off` on all six
  afterwards.

- **What has run on it** (read at 21:35:51). The gate still reads 0, 0, 0,
  and no job run since 18:29:39 carries an error. The first ticket after the
  deploy, #70381 at 18:37:49, was filed by the old worker, which was still
  taking jobs (above). The new worker's first was #70382, on the bot channel at
  19:28:31, so its `conversations` insert, which names the new column, works.
  No support or coexistence WhatsApp ticket has been created yet.

  Three crons have run on `447d8be`, each successfully by Render's run
  events:
  - `shipblu-sla-sweep`, first at 18:40:00–18:40:55;
  - `shipblu-time-automations`, first at 18:45:16–18:46:17;
  - `shipblu-whatsapp-template-sync` at 19:01:01–19:02:44, its backlog
    snapshot at 19:02:28.

  `shipblu-nightly` first runs on `447d8be` at 00:00 UTC on 2026-10-24.

**1.3's checks, read at 21:10 UTC.** `<X>` is 18:29:39 UTC, when Render began
web's deploy, which precedes the preDeploy that added the CHECK.

- **The CHECK.** `conversations_comment_channel_matches_external_id` is one
  row, validated, and its definition matches `db/sql/008`. `0045` is the newest
  migration applied, so #396's two came with it. No conversation's channel and
  external id disagree.
- **Nothing refused since.** No `process_webhook` attempt since `<X>` has
  failed on an insert into `conversations`, and no verified Meta delivery
  received since an hour before `<X>` is unprocessed. All 154 jobs run since
  `<X>` completed, and none carries an error.
- **Not yet exercised.** Facebook sent four deliveries after `<X>`, all
  processed, and they opened one direct-message ticket. No comment has arrived,
  so the CHECK has not yet met a new one. Re-read the two queries under
  [1.3, as built](#13-as-built) once one has, and within seven days of it,
  because `cleanup` deletes a completed job a week after it completes.

**1.2's checks, read at 21:54 UTC on 2026-10-21.**

- **The backfill.** All 52 comment tickets are on `facebook_comment` or
  `instagram_comment`, and none is left on a platform channel. No row
  disagrees with 1.3's CHECK, in either the loose or the strict spelling
  below. No frozen copy was left behind, and the one canned-suggestion copy
  moved.
- **The rollup.** `metrics_daily` holds comment rows from 2026-08-29 to
  2026-10-18, exactly the days comment tickets exist. `restore_resolved_at`,
  the documented prerequisite of any history rebuild (`docs/PROJECT-STATE.md`
  §6.98), had run on 2026-10-19.
- **The Stage 1 verification rows.**
  - No comment reply has been queued as `send_email`.
  - No comment ticket created after 1.2 lacks an SLA policy. The four comment
    tickets with no policy (#10939, #10942, #13745 and #13746) are from
    2026-08-29 and 08-30.
  - The 48 others are on Live Support (Customer Care), and all 52 are in
    Support, as Q11 expected.
- **Nothing else has changed.**
  - No comments channel row exists.
  - No out-of-hours rule names a comment channel.
  - No automation rule sends a reply.
- **The worker-first order ran ahead of a migration.** `634a28d` carried #390's
  migration `0043` (`whatsapp_onboardings.origin`), and only web applies
  migrations. So for about three minutes a worker that names the new column
  ran against a database without it. Nothing claimed the one job that reads
  it in that window: the two `complete_coexistence_onboarding` jobs since then
  both completed, and no job has failed since 17:25. Deploy rule 7 below
  exists because of this.

**Stage 0's operational steps were never done.** Read on 2026-10-21:

- **0.2's SLA reorder.** The policies are still in the "Now" order of 0.2's
  table: Live Support (Customer Care) at position 1, and the default. Its
  conditions match every chat ticket, so until the reorder a ticket routed to
  Merchant Care gets Customer Care's policy. It must be done before 5.2 turns
  routing on. It is a console change made by a person, and the support lead
  approved it (Q15).
- **0.6's staffing.** Customer Care, Inbound Sales Team and Merchant Care have
  no members. Support has three, none of whom `assign_sweep` may pick, and holds
  129 open unassigned tickets. Every channel defaults to Support except
  "Nayera Mohamed", which defaults to Merchant Care, and the bot, which has no
  group. `assign_sweep` last assigned anything on 2026-10-07. This is
  operations, not code, and it blocks Stage 5.

### Next, in order

Every production write needs the user's go-ahead for that step, and the
`AGENTS.md` sequence: read the state first, say the change, have the way back.

1. **1.3 is deployed.** #395 was squashed into `dev` as `58c5ed9`, and #397
   (`447d8be`) took it to `main` on 2026-10-23 with #394, #396 and #398, quoting
   the gate at 0, 0, 0 on production at 18:26:49 UTC. All six services were
   live on it by 18:36 UTC, web first. Its checks read clean at 21:10 UTC
   (above), with one re-read left for the first comment. Its reviews are
   answered under [1.3, as built](#13-as-built).
2. **2.A is deployed.** #406 (`e88d357`) took it to `main` on 2026-10-23, and
   an environment update deployed all six services at once by 22:13 UTC. Its
   checks read clean on 2026-10-25 (above).
3. **2.B is deployed.** The user deployed it by hand on 2026-10-25, all six on
   `48cb284` by 06:01 UTC, and its checks read clean (above), a new message's
   subcategorisation included. One read is left: the four page loads. Since
   3.1's migrations ran it is fixed forward, not rolled back.
4. **3.1 is deployed.** #419 was squashed into `dev` as `ff3bbfd`, and #420
   (`b9a4743`) took it to `main` on 2026-10-25 with #411, #416, #417 and #418.
   The user chose to release it with 2.B's page loads still unread. Web was
   live on it at 19:44 UTC, and the worker and the four crons by 08:05 UTC the
   next morning, with no effect from the gap. Its checks read clean (above),
   the seed included; the signed-in ones are left. Its review decisions are
   under [3.1, as built](#31-as-built).
5. **3.2 is deployed.** #424 was squashed into `dev` as `07a5527`, and #426
   (`f761e5e`) took it to `main` on 2026-10-26 with #421, #422 and #423, the
   user having left the review's two races as they are. All six services were
   live on it by 23:32 UTC, web first, and its checks read clean (above); the
   signed-in ones are left.
6. **4.0 is deployed.** #425 was squashed into `dev` as `1c733c2`, and #428
   (`156004d`) took it to `main` on 2026-10-27. All six services were live on
   it by 07:45:42 UTC, web first, and its checks read clean (above).
7. **4.1 and 4.2 are deployed, and the classifier is in Shadow.** #427 was squashed
   into `dev` as `959404a`, and #430 (`dbf4376`) took it to `main` on
   2026-10-27; all six services were live on it by 12:07:54 UTC, web first.
   #429, 4.2's report with the fixes to the live job's locked ticket read, was
   squashed into `dev` as `c6eb1ac`, and #431 (`ad6a062`) took it to `main` the
   same day; all six were live on it by 21:49:08 UTC, web first. Both sets of
   checks read clean (above). At the user's go-ahead the archive record run
   went first, and the classifier has been in Shadow since 06:00:32 UTC on
   2026-10-29 (4.2's first operation, above). A supervisor labels from
   `/reports/category-ai` during Shadow; apply and then the backlog each wait
   for the user's go-ahead, in turn. The way back starts with the switch, `off` on
   `/admin/categories`; the code's way back is then 5.1's (Rolling it back,
   under [5.1, as built](#51-as-built): `ad6a062`, once no `settle_routing` job
   is pending or processing), and only below that `dbf4376` for 4.2 and `156004d` for 4.1, whose tables stay, since
   nothing reads them there.
8. **5.1 is deployed, and routes nothing.** #432 was squashed into `dev` as
   `9d5b4fb`, and #435 (`1470902`) took it to `main` on 2026-10-29; all six
   services were live on it by 06:35:36 UTC, with `0051_routing` applied, and
   its checks read clean (above): [5.1, as built](#51-as-built). It went web
   first, since it migrates `0051_routing`; then the worker and **all four**
   crons, before any channel could leave `default_group`. Two of the crons
   assign: an old
   `shipblu-sla-sweep` runs an `assign_sweep` that assigns held tickets, and an
   old `shipblu-time-automations` runs rules whose `auto_assign` assigns them
   and whose `assign_group` moves one without ending its hold. Deployed, it
   routes nothing: every channel reads `default_group`, and nothing is held or
   enqueued until an admin moves one while the classifier is in `apply`. Four
   things changed on every ticket at the deploy, all under
   [5.1, as built](#51-as-built): the out-of-hours acknowledgement's guards
   (decision 6); assignment's ticket-first `FOR NO KEY UPDATE` lock and its
   checked update (decision 7); a console group move running the `on_update`
   rules before it assigns (fixed after the review of the build); and an
   agent's reply and the engine's `assign_agent` and `assign_group` written in
   a transaction with `endHold`, as the console's assignee and group writes
   already were — one read and no lock on a ticket that never routed (fixed
   after the adversarial review, #0/#4).
9. **6 is deployed.** #434 was squashed into `dev` as `1daf6a5`, and #437
   (`9b4bc5b`) took it to `main` on 2026-10-29; all six services were live on
   it by 11:29:28 UTC, web first, with `0052`–`0055` applied, and its checks
   read clean (above). The first Stage 6 nightly is left to read. The way back
   is the plan's Stage 6 rollback: the nightly and the worker to `1470902`
   first, then the category rows deleted, then web. Its screenshot pass went
   out after it: #438 was squashed into `dev` as `b237858`, and #439
   (`063e477`) took it to `main`; all six services were live on it by
   14:27:51 UTC, and its checks read clean (above). It is code and copy only,
   so its way back is `9b4bc5b` on each service, in any order.
10. **Before Stage 5.2 turns routing on**, a person does 0.2's reorder and 0.6's
    staffing, the support lead answers the questions still open (below), and the
    classifier reaches `apply` by 4.2's sequence. Read on 2026-10-29 at 11:20
    UTC, none of 5.2's prerequisites holds yet:
    - the SLA policies are still in 0.2's "Now" order, Live Support (Customer
      Care) first and the default;
    - Customer Care, Inbound Sales Team and Merchant Care have no members;
      Support has three, one of them active and accepting, and 178 open
      unassigned tickets (129 on 2026-10-21);
    - six channels still default to Support: the mailbox, web chat, Instagram,
      the Facebook Page, WhatsApp Support and ShipBlu Admin;
    - no category has a route group;
    - the only automatic assignments lately are a number's owner's hand-backs,
      the last at 20:08 UTC on 2026-10-27; nothing from the rota or the sweep;
    - no comment channel row exists (Q11);
    - the classifier is in Shadow, until 2026-11-12 at the earliest.

### 1.3, as built

Decided first, then built in #395 exactly so, which is why this section reads
as instructions. The reasons are given so that any of them can be argued with.

- **The constraint is a new file, `db/sql/008_comment_channel_check.sql`.** A
  file of its own means the migrate log names it if it fails ("Applying
  008_…"), and its rollback touches nothing else. It holds one guarded block,
  in the shape `003_constraints.sql` uses, plus the table in the guard:

  ```sql
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'conversations_comment_channel_matches_external_id'
        AND conrelid = 'conversations'::regclass
    ) THEN
      PERFORM set_config('lock_timeout', '3s', true);
      ALTER TABLE conversations
        ADD CONSTRAINT conversations_comment_channel_matches_external_id
        CHECK (CASE channel
          WHEN 'facebook_comment' THEN coalesce(external_id, '') ~ '^facebook:comment:.'
          WHEN 'instagram_comment' THEN coalesce(external_id, '') ~ '^instagram:comment:.'
          ELSE coalesce(external_id, '') !~ '^(facebook|instagram):comment:'
        END);
    END IF;
  END $$;
  ```

  This is stricter than the expression under 1.3 below, which is kept there as
  first written. It also pins the platform, so `instagram:comment:…` cannot sit
  on `facebook_comment`, and it requires a root, as `rootCommentId` does. No
  writer produces either shape, and production holds none. The expression is
  never null, because `channel` is NOT NULL and every arm coalesces.

  It is added VALID, with the wait for its lock bounded at 3 s, and not
  `NOT VALID` with a `VALIDATE` in a later file. Review asked for the second
  form (#395), so it was measured on a 70,000-row copy of the table:
  - **Holding the lock costs about 80 ms.** The same predicate scans
    production's heap in 82 ms, all from cache (2026-10-22). `NOT VALID` cuts
    that to 2 ms.
  - **Waiting for it costs up to the timeout, and `NOT VALID` does not help.**
    Both forms ask for ACCESS EXCLUSIVE, so both queue behind any open
    transaction that has touched the table, and every later read and write of
    `conversations` queues behind them. With a reader holding the table, a plain
    `SELECT` waited the same 5 s behind either form. What bounds that is the
    `set_config` line: transaction-local, and `db/migrate.ts` sends each file as
    one implicit transaction, so it applies to this `ALTER` alone and reverts
    before the next file. Measured: 55P03 after 3 s, the session still at 10 s
    afterwards.
  - **The split has a half-applied state.** If `VALIDATE` found a bad row, the
    deploy would fail with the constraint already committed `NOT VALID`, and
    that refuses every `UPDATE` of the row, so a ticket would stop taking
    replies. VALID lands whole or leaves nothing.

- **The tests it breaks.** The test database replays `db/sql`, so a test that
  inserts a row the CHECK refuses fails at the insert. This was measured on
  2026-10-21 by adding the CHECK to a local test database migrated to
  `634a28d`: 12 tests in 8 files fail.
  - `worker/handlers/split-comment-channels.db.test.ts`: five tests, which is
    all of it.
  - `lib/tickets/ingest-meta.db.test.ts`: "puts a reply on a thread filed before
    comments had a channel, and leaves it there".
  - `lib/automations/send-reply.db.test.ts`: "is never sent on a public comment
    thread", its legacy case.
  - `lib/csat/meta-feedback.db.test.ts`: "takes no answer on a comment ticket,
    before 1.2 moves it or after".
  - `lib/priority-ai/run.db.test.ts`: "asks only about what the ticket's own
    customer wrote".
  - `lib/tickets/inbox.db.test.ts`: "marks a Meta comment ticket, and not a
    direct-message one".
  - `worker/handlers/send-csat.db.test.ts`: "records why there was no survey, on
    the ticket".
  - `lib/tickets/locale.db.test.ts`: "reads the requester's words on a comment
    thread, not a passer-by's". Its `facebook_comment` ticket has no external
    id.

  Each fixture becomes a row 1.2 writes: a comment channel with its own
  platform's comment external id. A case that exists only for a pre-1.2 row
  goes, because that row can no longer exist.

  A new `lib/tickets/comment-channel-check.db.test.ts` (`withCleanDatabase()`)
  inserts each refused shape and expects code `23514`, naming the constraint.
  The shapes are:
  - a platform channel with a comment id;
  - a comment channel with no id;
  - a comment channel with the other platform's id;
  - an empty root;
  - `email` with a comment id.

  It also inserts each accepted shape and expects it to succeed.

  Locally, a database migrated before the branch has no CHECK. Since #395
  (79fac1f) `withCleanDatabase()` replays `008` before every test, so the suite
  adds it itself; migrating `shipblu_test` again is still the way to bring the
  rest of `db/sql` up to date.

  As built: the seven fixtures were rewritten, and the one case that existed
  only for a pre-1.2 row (ingest-meta's "a reply on a thread filed before
  comments had a channel") went, with send-reply's and meta-feedback's legacy
  halves. The new test has fourteen cases: seven refused, six accepted, and an
  update that splits the pair.

  Review of #395 put the legacy cases back, in the shape that can still exist:
  the one the rollback of 1.2 leaves (below). Deleting them had left every
  reader's external-id half deletable with the suite green. Each file that held
  one now has a `describe` that calls `withoutCommentChannelCheck()`
  (`lib/testing/db.ts`). That drops the CHECK with the rollback's own guarded
  block, builds the ticket the way 1.2 files it, and moves it back with step 3's
  `UPDATE`. Afterwards it empties the tables and replays `008`. There are eight
  cases, across `send-reply`, `meta-feedback`, `send-csat`, `ingest-meta` (two),
  `inbox`, `locale` and `auto-response/index`. Seven guard a reader, and each
  was mutation-checked: swapping the reader's `isCommentTicket` for
  `isCommentChannel` (eight readers: the inbox and out-of-hours cases cover two each), or dropping
  Meta's external-id condition, fails it, and restoring passes it. The eighth
  pins that ingest lands a reply on a moved-back thread and leaves its channel.

- **`split_comment_channels` is retired in the same PR.** After the CHECK it can
  match nothing, and its test cannot build a fixture. Remove all of it:
  - `worker/handlers/split-comment-channels.ts` and its `.db.test.ts`;
  - the import and the registration in `worker/handlers/index.ts`;
  - `| 'split_comment_channels'` in `lib/queue/index.ts`;
  - its `JOB_PAYLOADS` entry in `lib/queue/payloads.ts`;
  - its line in `scripts/ci/db-jobs.txt`.

  CI checks that those agree. The job stays in git history and in 1.2's
  as-built note.

- **One runtime change, and it changes no answer.** `isCommentTicket` keeps its
  external-id half, and `pickRule` keeps `ruleChannel`.
  Review of #395 read both as dead once the CHECK holds. They are not, because
  the rollback of 1.2 undoes the move while 1.1's readers stay deployed. Its step
  2 reverts #391 and #392, which re-deploys 1.1's ingest, so new comments are
  filed on `facebook`/`instagram` again; its step 3 moves the old ones back.
  The half came in 1.1 (#387), so that revert does not restore it if 1.3 has
  removed it. An audit of every reader in that state found that, with the half
  removed, the out-of-hours picker and the survey's thanks would post publicly,
  and the survey and the console reply would message privately, possibly a
  passer-by. With the half kept, every one of them stays right. The one runtime
  change: Meta's direct messages now use the shared `liveConversationFilter`.
  Their own copy had drifted, missing the merged-away and import conditions,
  neither of which exists on a Meta ticket. The filter keeps their one extra
  condition, no external id, for the same rollback. What else changes are the
  comments that promise otherwise, or that name the retired job:
  - `lib/tickets/channel-policy.ts` (the comments near `isCommentTicket` and the
    "Stage 1.3" notes);
  - `lib/auto-response/resolve.ts` (`ruleChannel`: "Once a CHECK … returns its
    input");
  - `lib/tickets/outbound.ts` ("until a CHECK makes the two one answer");
  - `lib/tickets/live-conversation.ts`;
  - `lib/tickets/ingest-meta.ts` (the comment above `channelFor`'s call);
  - `app/(console)/admin/field-options.ts`.

  `grep -rn "split_comment_channels\|Stage 1.3\|until a CHECK"` lists them.

- **Docs in the same PR.**
  - `AGENTS.md`'s paragraph beginning "Until the CHECK constraint … lands"
    changes to say the database holds the pair, under the constraint's name,
    and why `isCommentTicket` keeps both halves.
  - The comment-exemption wording in the `HUMAN_AGENT` section changes to
    match.
  - The plan's 1.2 as-built note and this section are updated.
- **The gate.** Merge `dev` → `main` only when this read-only query, run on the
  day, returns 0, 0, 0 on production (`nqbcfnvqqyqawmffgiql`):

  ```sql
  SELECT
    (SELECT count(*) FROM conversations WHERE NOT (CASE channel
       WHEN 'facebook_comment' THEN coalesce(external_id, '') ~ '^facebook:comment:.'
       WHEN 'instagram_comment' THEN coalesce(external_id, '') ~ '^instagram:comment:.'
       ELSE coalesce(external_id, '') !~ '^(facebook|instagram):comment:' END)) AS tickets,
    (SELECT count(*) FROM csat_surveys s JOIN conversations c ON c.id = s.conversation_id
      WHERE (c.channel IN ('facebook_comment', 'instagram_comment')
             OR s.channel IN ('facebook_comment', 'instagram_comment'))
        AND coalesce(s.channel, c.channel) <> c.channel) AS surveys,
    (SELECT count(*) FROM canned_suggestions s JOIN conversations c ON c.id = s.conversation_id
      WHERE (c.channel IN ('facebook_comment', 'instagram_comment')
             OR s.channel IN ('facebook_comment', 'instagram_comment'))
        AND s.channel <> c.channel) AS suggestions;
  ```

  `tickets` is what the CHECK would refuse. The other two are the frozen copies
  `split_comment_channels` used to move with their ticket, read on the comment
  axis: a comment ticket's copy anywhere but its own comment channel, or a
  direct message's copy on a comment channel. A null survey channel follows its
  ticket, as the rollup reads it (`coalesce`, `lib/reports/rollup.ts`). This is
  the last read that can find a stranded copy: both copies are written from the
  ticket's channel as it stands, nothing updates either copy's channel, and once
  the CHECK holds nothing moves a ticket's channel either, the retired job
  having been the only thing that did. So there is no job left to keep for them.

  It returned 0, 0, 0 at 11:30 UTC on 2026-10-23 (the first count alone, 0, at
  21:54 UTC on 2026-10-21). Staging's database
  (`funavpkflkhthegahuay`) has only its first migration applied and holds no
  tickets, so its first deploy, whenever staging is resumed, adds the CHECK to
  an empty table.

- **Deploy order and precautions.**
  - **Order: web first, then the worker, then the crons.** Only web's
    preDeploy (`npm run db:migrate`) replays `db/sql`. 1.3 on its own changes
    nothing on the worker or the crons that depends on new schema: its
    retired job is gone, and nothing enqueues it. The release that shipped
    it, #397, also carried #396. #396's worker and cron code reads
    `conversations.accountable_agent_id` from migration 0044 by name, in:
    - the worker's ingest and assignment;
    - `sla_sweep` and `assign_sweep`;
    - `snapshot_backlog`;
    - `rollup_metrics`;
    - the time automations, through `assignConversation` and
      `reopenWithOwner`.

    Ingest and `reopenWithOwner` also read `channels.owner_agent_id`. Drizzle
    names every column, so new code running ahead of 0044 fails every insert
    and whole-row select of `conversations` or `channels` (rule 1), the
    senders' included. That made web first rule 7's requirement for the
    release too, and it is the order that ran.

  - **The lock.** `ADD CONSTRAINT … CHECK` takes ACCESS EXCLUSIVE on
    `conversations` and holds it while it validates every row (about 70,000;
    about 80 ms). While it waits for the lock, every read and write of the
    table waits behind it, so `008` bounds that wait at 3 s, below
    `db/migrate.ts`'s session-wide 10 s. One transaction holding the table for
    longer fails the deploy with 55P03.
  - **Just before triggering:**
    - run the gate again, and note `SELECT now()` from the same session as the
      instant the verification below reads from;
    - list what holds a lock on `conversations`, which must show nothing more
      than a few seconds old: `select a.pid, l.mode, a.state, now() -
a.xact_start as age, left(a.query, 80) from pg_locks l join
pg_stat_activity a using (pid) where l.relation =
'conversations'::regclass and a.pid <> pg_backend_pid();` (§5.5's query
      lists only transactions older than five minutes, which the role's
      `transaction_timeout` reaps, so it reads clear when this would not). It
      is a reading, not a reservation: Render runs the whole build between it
      and the `ALTER`, which is why the file bounds the wait itself;
    - stay clear of the nightly rollup at 00:00 UTC.
  - **If the preDeploy fails,** the previous release keeps serving and the
    constraint is absent. Read the deploy log, then the gate query. A 55P03 is
    the 3 s bound: list the locks again and redeploy once the table is clear.
- **1.3's verification**, read-only, after the deploy:
  - `SELECT convalidated, pg_get_constraintdef(oid) FROM pg_constraint WHERE
conrelid = 'conversations'::regclass AND conname =
'conversations_comment_channel_matches_external_id'` returns one row, `true`,
    matching the file.
  - No ingest has failed on it since. A refused comment fails its
    `process_webhook` job, not the web, and nothing stored names the
    constraint: `processMetaWebhook` keeps drizzle's `Failed query: insert into
"conversations" …` text, and Postgres's "violates check constraint" is on
    its `cause`, which nothing stores. So read two things, from the instant
    noted just before triggering (`<X>`, the database's own clock, which
    precedes the build and so the preDeploy that adds the CHECK):

    ```sql
    -- Every attempt since X that failed on an insert into conversations, however
    -- old its job, except one that ended it dead: that keeps the run_at it was
    -- scheduled with, so a dead job scheduled before X is the next query's to
    -- find. Expect no rows.
    SELECT j.id, j.status, j.attempts, j.created_at, j.run_at, j.completed_at,
           substring(j.last_error from 'comment ([^: ]+):') AS comment_id,
           (SELECT c.channel FROM messages m JOIN conversations c ON c.id = m.conversation_id
             WHERE m.channel_message_id = substring(j.last_error from 'comment ([^: ]+):'))
             AS filed_on
    FROM jobs j
    WHERE j.type = 'process_webhook'
      AND j.run_at >= timestamptz '<X>'
      AND j.last_error LIKE '%Failed query: insert into "conversations"%'
    ORDER BY j.run_at;

    -- Every verified Meta delivery left unprocessed, retrying or dead, received
    -- since an hour before X. Run it at X as well: what it lists then predates
    -- the deploy. A delivery retries for at most 10 + 40 + 90 + 160 s, so the
    -- hour is for a backlogged worker, and a dead delivery from earlier, which
    -- cleanup keeps for 30 days, cannot read as a refusal. Expect nothing new.
    SELECT id, received_at, left(error, 120) AS error FROM webhook_events
    WHERE channel IN ('facebook', 'instagram') AND signature_verified
      AND processed_at IS NULL
      AND received_at >= timestamptz '<X>' - interval '1 hour'
      AND received_at < now() - interval '10 minutes'
    ORDER BY received_at;
    ```

    Each detail is there for a reason found on review:
    - **`run_at`, not `created_at`.** Claiming, failing and completing a job
      never touch `created_at`, so a job created before the deploy whose later
      attempt was refused would read clear. `jobs` has no `updated_at`.
    - **A success does not hide a refusal.** `completeJob` leaves `last_error`
      alone, so a refusal followed by a successful retry is still listed. It is
      `webhook_events.error` that a Meta success clears, so that column adds
      nothing here.
    - **A hit is not proof of the CHECK.** The same text comes from a race on
      `conversations_external_idx`, which its retry wins. Production held two
      such jobs from 2026-10-15, both completed, both comments filed on
      `instagram_comment`. A CHECK refusal does not win on retry, so a completed
      hit whose `filed_on` is the comment channel is that race; a `filed_on`
      that is null means the comment is not in the database.
    - **Read it within seven days.** `cleanup` deletes completed jobs a week
      after they complete, which is where the two from 2026-10-15 went. A later
      failure with different text also overwrites `last_error`; the per-attempt
      record is the worker's Render log, `[worker] process_webhook` lines
      carrying `Failed query: insert into "conversations"`.

  - A comment that arrives after the deploy files on its comment channel.
- **Rollback.** Open a PR that replaces the ADD block in `008` with a drop
  guarded the same way, merge it and deploy web:

  ```sql
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'conversations_comment_channel_matches_external_id'
        AND conrelid = 'conversations'::regclass
    ) THEN
      PERFORM set_config('lock_timeout', '3s', true);
      ALTER TABLE conversations
        DROP CONSTRAINT conversations_comment_channel_matches_external_id;
    END IF;
  END $$;
  ```

  Its preDeploy drops the constraint, so nobody types DDL against production,
  and every later replay finds nothing to drop and takes no lock. The drop
  asks for ACCESS EXCLUSIVE as the ADD did, so its wait is bounded the same way,
  at 3 s: a rollback is the deploy most likely to run while something holds the
  table. `withoutCommentChannelCheck()` in `lib/testing/db.ts` runs this block
  before its tests, so the rollback's SQL is exercised on every CI run. Not a bare
  `DROP CONSTRAINT IF EXISTS`: `ALTER TABLE` takes ACCESS EXCLUSIVE before it
  checks `IF EXISTS`, so every later deploy would lock `conversations` to do
  nothing — the failure `001_extensions_and_triggers.sql`'s trigger loop
  records from 2026-08-19. Rolling back 1.3 never needs 1.2 rolled back,
  because no code path depends on the CHECK.

### 2.A, as built

Built as [Stage 2](#stage-2--the-subcategory-rename) describes it, with no
migration: `drizzle-kit generate` reports nothing to do, because every schema
identifier was renamed with its SQL string pinned to the old name. What the
stage section left open was decided as follows.

- **What moved.** `lib/subcategorise/`, `lib/subcategorise-ai/`,
  `db/schema/subcategories.ts` and `subcategorise-ai.ts`,
  `lib/reports/subcategory-queries.ts` and `subcategory-rollup.ts`,
  `worker/handlers/backfill-subcategorise-ai.ts`,
  `app/(console)/admin/subcategories/`, `app/(console)/reports/subcategories/`,
  `app/(console)/subcategory-actions.ts` and the ticket page's
  `subcategories-field.tsx`. Every exported name follows, with no
  compatibility alias left behind, and so do the fields that carry the taxonomy
  across modules: a rule's `subcategory`, an area's `subcategories`, the ticket
  page's `subcategories` and the form field `subcategoryId`. A raw SQL row keeps
  `category_key` and is mapped at the boundary.
- **What kept the old word, on purpose.** The SQL names, until 2.B. The
  status category, the knowledge base's categories and Meta's template
  categories, which are other things. The taxonomy and rule keys and
  `DETECTOR_VERSION`, since no rule changed. The handbook article key
  `categorising`. And what TypeSafe is sent: `SUBCATEGORY_QUESTION` is still
  the string `'category'` and the instructions are byte for byte the old ones,
  pinned by a test, so a shadow run after 2.A is compared with one before it on
  the same question. The taxonomy's `note` texts did change, and each is shown
  to TypeSafe as its option's description, but only in a database seeded after
  2.A: the seed never rewrites a stored description, so production's options
  read as they did.
- **Events.** The rules detector writes `subcategorised` as
  `subcategory-detector`, and the four console actions write
  `subcategory_added|confirmed|rejected|removed` with `subcategoryKey`.
  `describeEvent` reads the old and new names and both keys for good, since
  stored rows keep their words, and `describeActorLabel` prints the old actor
  as the new one, so a ticket whose history spans the deploy shows one
  mechanism, not two. **Stage 3 must not reuse `categorised` or the four
  `category_*` types**, or a ticket's subcategory history would read as the new
  field's.
- **Redirects.** Four exact sources, each a 307. Not `/admin/categories/:path*`:
  redirects run before the filesystem, so a wildcard would hide Stage 3's whole
  tree, not only its index. An exact source hides one page the same way, and
  Stage 3's tree may grow a `review` or a `shadow` of its own, so the PR that
  adds its page deletes all three `/admin/categories` entries.
  `/reports/categories` goes in whichever PR first puts a report there.
- **Permission keys.** Read 2026-10-23 14:22 UTC: no agent holds any override,
  of these keys or any other. `can()` ignores a key it does not know, so an
  override under an old name would lapse silently rather than fail. Stage 3
  gives `admin.categories` back to the new Categories page, and before it does
  it reads that no agent's `permissions` holds the key. A `db/sql` statement
  moving overrides to the new keys was proposed in review and declined: no
  code writes the column, so only hand-typed SQL could make one, and a
  statement replayed on every deploy would, once Stage 3 reclaims
  `admin.categories`, turn an override of the new page into one of the
  subcategories page.
- **Env vars.** `SUBCATEGORISE_DISABLED_RULES`, `SUBCATEGORISE_AUTO_MIN` and
  `SUBCATEGORISE_RECORD_MIN`, with no fallback to the old names: a fallback
  would be a second place for the same setting. A value still set under an old
  name is read by nothing, but said once per process
  (`[subcategorise] CATEGORISE_DISABLED_RULES is set, and nothing reads it`),
  so a rule switched off under the old name does not come back on in silence.
  The Render MCP tools do not return variable values, so the deploy-day read is
  in the dashboard.
- **Job and log tags.** `backfill_subcategorise_ai` (no row of either name has
  ever existed, read 14:22 UTC) and the log tags `[subcategorise]` and
  `[backfill_subcategorise_ai]`. A log search for the old tags finds nothing
  newer than the deploy.
- **Handbook.** Seven articles change: `replying`, `ticket-fields`,
  `categorising`, `reports`, `people`, `automation-and-forms` and
  `owner-role`. So do the `tickets` and `administration` folder descriptions,
  which the seed syncs on every run. The chips quote the code's labels
  exactly: `Subcategories`, `Add a subcategory…` and `Subcategory review`.

**Deploying 2.A.** It has no migration. Nor does the release it rides in, since
#397 shipped #396's migrations and 1.3's `db/sql/008` without it, unless
something carrying one lands on `dev` first (rule 7: read
`git log origin/main..origin/dev` on the day). Web goes first all the same: an
old web prints a new worker's `subcategorised` event as its bare type, while a
new web reads an old worker's events in full.

1. **Before.** Read, in the Render dashboard, the three env groups and the
   variables set on web and the worker for any `CATEGORISE_*`; copy a value to
   its new name before deploying. Re-read the overrides and the job, expecting
   0 and 0:

   ```sql
   select
     (select count(*) from agents
       where permissions ?| array['ticket.categorise', 'admin.categories']) as overrides,
     (select count(*) from jobs where type = 'backfill_categorise_ai') as old_jobs;
   ```

2. **Deploy** web, then the worker, then the four crons.
3. **Handbook.** Production held no console handbook at 2026-10-23 15:01 UTC:
   no `handbook-` folder or article, and no `seed_console_handbook` job, ever.
   If that still holds, 2.A has nothing to do here, because the first seed,
   whenever somebody runs it, writes 2.A's words. If it has been seeded since,
   run `npm run job -- seed_console_handbook dryRun=true` once web is live. It
   should report `folders 0 created, 2 updated` and
   `7 article(s) differ from this repository`; the job counts them without
   naming them. A different count is a console edit that `overwrite=true`
   would replace, and is read first. Then `overwrite=true`, which cuts one
   `kb_article_versions` row for each article it replaces, so the rows written
   then name the seven. Rehearsed locally: `origin/dev`'s seed into an empty
   database, then this branch's dry run, reported exactly that; the overwrite
   replaced `handbook-automation-and-forms`, `-categorising`, `-owner-role`,
   `-people`, `-replying`, `-reports` and `-ticket-fields`; and a run after it
   found all 15 current.
4. **Verify.** `/admin/categories` lands on `/admin/subcategories`, and the
   ticket sidebar says Subcategories. Once all six services run the release, no
   `categorised` or `category_*` row is newer than the moment the old web and
   worker instances stopped (Render's shutdown grace after the last of them went
   live), and every detector row since is `subcategorised`. It appears only
   where a rule fired: never on `whatsapp_bot`, which the detector leaves out as
   read-only, and perhaps not at all on a quiet channel such as email or
   webchat:

   ```sql
   select c.channel, e.type, count(*) as n, max(e.created_at) as newest
   from conversation_events e
   join conversations c on c.id = e.conversation_id
   where e.type in ('categorised', 'subcategorised')
      or e.type like 'category\_%' or e.type like 'subcategory\_%'
   group by 1, 2
   order by 1, 2;
   ```

   Read 2026-10-23 14:22 UTC, before any of it: 783 `categorised` (facebook
   380, whatsapp 241, instagram 117, facebook_comment 36, instagram_comment 5,
   email 2, webchat 2), one `category_confirmed`, and no row under a new name.

**Rolling back 2.A** is deploying the previous commit on all six services. The
review queue and the reports read `conversation_categories`, which 2.A never
touched; what an old web cannot read is the events written in between, which
its timeline prints as bare types. A variable set under a new name is then
read by nothing, and the handbook keeps its new words until the seed is run
from the older commit with `overwrite=true`.

### 2.B, as built

Built as [Stage 2](#stage-2--the-subcategory-rename) describes 2.B, stacked on
2.A (#400) at the user's request. What the stage section left open, or got
wrong, was decided as follows. Every catalog figure was read from production
on 2026-10-23 after 18:00 UTC.

- **What moved.** The four tables, the two enum types (Postgres renames their
  array types with them), and **three** columns, not two: `category_metrics_daily`
  also has a `category_key`, and leaving it would put a `category_key` column
  in `subcategory_metrics_daily` once Stage 3 gives "category" its new meaning.
  `conversation_categories_category_idx` became
  `conversation_subcategories_subcategory_idx`. No foreign key from any other
  table points into the four, and no function, view, trigger body, policy or
  publication names them, so a rename reaches everything that depends on them.
  Their rows: 55, 823, 396 and 647.
- **Migration `0046_subcategory_names`** is drizzle-kit's, committed as it
  wrote it. It was generated under a pseudo-terminal, since this environment
  has none, with every one of the nine prompts (two types, four tables, three
  columns) answered from a list naming each rename in advance; any other prompt
  would have killed the run before it wrote anything. A second `generate`
  reports nothing to migrate. It renames the types, tables and columns, drops
  and re-adds the seven foreign keys and the composite primary key under new
  names, and drops and recreates the thirteen indexes.
- **Two foreign-key names are longer than the 63 bytes Postgres keeps**, so
  they are stored cut short:
  `conversation_subcategories_subcategory_id_ticket_subcategories_` and
  `conversation_subcategories_detected_in_message_id_messages_id_f`. Production
  already holds eight like that. A command naming the long form is truncated
  the same way, so a later migration that drops one still finds it.
- **`db/sql/002_subcategories.sql`** renames the six CHECKs and the three
  `_pkey` names in a loop, each guarded on the constraint's name **and** its
  table through `to_regclass`, and then adds any CHECK still missing under its
  new name. For 2.B alone, a fresh database takes the same path as production:
  every migration runs before `db/sql`, so `0021` has created the tables under
  the old names and `0046` has renamed them by then.
- **That order leaves a trap for Stages 3 and 4.** On a fresh database (CI,
  `shipblu_test`, a staging that takes 2.B and Stage 3 in one deploy),
  `ticket_categories_pkey`, `category_metrics_daily_pkey` and
  `ai_category_runs_pkey` are still taken while every later migration runs,
  because only `db/sql` renames them. A later table reusing one of those names
  with an unnamed primary key is then created as `<table>_pkey1` there, but as
  `<table>_pkey` in production. Moving the three renames into a migration of
  their own would close it. Decision 2's objection to `--custom`, that it
  keeps the previous snapshot, does not reach this one: placed after 0046 it
  copies 0046's snapshot, which already describes the schema, and CI's drift
  step passes (tried in a scratch copy on 2026-10-23; the three renames took
  about 1 ms on the three small tables). What it costs is a hand-written
  migration, against the generated-only convention, and inside 2.B a runbook
  that would have to remove two rows. So it is recorded here rather than done.
  The cheapest place is the head of Stage 3's PR, guarded, where the runbook is
  deleted anyway; Stage 3's and Stage 4's own sections say what they do about
  it.
- **Locks.** Dropping the old foreign keys removes their triggers on
  `conversations`, `messages` and `agents`, and Postgres takes ACCESS EXCLUSIVE
  on each referenced table to do that. Re-adding them asks only SHARE ROW
  EXCLUSIVE, but the stronger lock is held until 0046 commits. So reads of the
  three tables block as well as writes, and every console request reads
  `agents`. While the migration waits for one of these locks, every new query
  on that table queues behind it, and a transaction that has only read the
  table is enough to make it wait. Validation reads only the 823 and 647 rows
  that reference them. Locally, the whole migrate (`0046` and every `db/sql`
  file) took 0.9 s on Postgres 17.11.
- **A rename-only 0046 was proposed in review and declined by the user on
  2026-10-23.** Renaming the foreign keys, indexes and primary key instead of
  dropping and re-adding them would lock only the four small tables, never
  `conversations`, `messages` or `agents`: measured on near-empty tables,
  8 ms against 24 ms for the generated statements, ending in the same
  catalog. But it gains little inside a window where the old release fails
  against the renamed tables either way: what it moves is where a wait of up
  to `lock_timeout` falls, and failing to get a lock is the clean failure. It
  does not remove the failure under "How it fails" either, which comes from
  `db/sql` running after either form commits. And it cannot pass CI as
  generated: `--custom` in place of 0046 keeps 0045's snapshot, so the drift
  step stops on its TTY prompt, and drizzle-kit has no rename for an index, a
  foreign key or a primary key. The only way through is replacing generated
  SQL by hand, which the drift step cannot see and decision 2 rules out.
- **How it fails.** `db/migrate.ts` sets `lock_timeout` to 10 s. A lock 0046
  cannot get fails the preDeploy cleanly: Drizzle's transaction rolls back,
  nothing is applied, and the old release keeps serving. But `db/sql` runs only
  after 0046 has committed, and 001's `CREATE INDEX IF NOT EXISTS` takes SHARE
  on eight tables (`conversations`, `messages`, `contacts`, `companies`,
  `kb_articles`, `shipments`, `shipping_accounts`, `side_conversation_messages`)
  before it checks that the index exists. A write transaction open on one of
  those for more than 10 s fails the preDeploy **after** the rename. The log
  then shows `Applying 001_…` or `Applying 002_…` after the migrations ran, and
  the old release is serving against renamed tables. There are two ways out.
  Clear the lock and deploy the same commit again: Drizzle skips 0046, and 002
  is written for exactly "tables renamed, constraints still old". Or roll back
  by the runbook, which renames back only the CHECKs and `_pkey` names that 002
  renamed, so it starts from this state as well as from a finished deploy; a
  test builds the state and runs it. From this state the runbook is the whole
  rollback: Render never promoted the failed deploy, so web is still on the
  previous commit, and the worker and crons were never deployed ("Rolling back
  2.B" says which steps that leaves). Keep the worker and crons suspended until
  one of them succeeds.
- **The raw SQL follows**, in `lib/reports/subcategory-queries.ts`,
  `lib/reports/subcategory-rollup.ts`, `lib/subcategorise/queries.ts`,
  `lib/subcategorise/seed.ts` and `lib/subcategorise-ai/report.ts`. Each
  function in them that names a renamed table now has a database test that
  executes it on fixture rows, so a missed name fails CI. `rootCauseOptions`,
  which reads only `ticket_root_causes`, has none. The tier passes under both
  `C.UTF-8` and `en_US.UTF-8`, the collation CI and production sort with.
- **The rollback is `db/runbooks/2b-subcategory-rollback.sql`**: one `DO`
  block, so a name that is not there leaves nothing half renamed. Its test runs
  it and then `0046` and `002` again inside a transaction it rolls back. It
  asserts that the way back produces production's catalog exactly, and that
  the way forward restores every new name. That way, the runbook a person runs
  by hand is exercised on every CI run. Drizzle applies a migration only when
  it is newer than the newest row, so deleting 0046's row brings it back only
  while nothing later has run. The runbook therefore refuses once a later
  migration has been applied, and a second test holds it to that. A third runs
  it from the half-applied state under "How it fails". The test also reads the
  journal: the runbook's literal `when` for 0046 must match it, and once any
  migration follows 0046 a case fails with a sentence saying what to do (delete
  the runbook and its test in that PR, and write the way back from then), while
  the cases that run the runbook are skipped rather than failing on its
  exception.

**Rehearsed locally, not on a Supabase branch.** The user chose this on
2026-10-23, for two reasons. A Supabase branch replays only the migrations
Supabase itself recorded, which is 2 of production's 46, so it would start
nearly empty. And it is billed while it exists. The rehearsal ran on a local
Postgres 17.11:

1. 2.A's code migrated an empty database. Its 39 names for the four tables
   (the constraints, the indexes, the three renamed columns and the two types,
   as listed in `PRODUCTION_BEFORE` in the runbook's test) are identical to
   production's, and so is its one trigger.
2. Rows were written in every table through 2.A's schema.
3. This branch's migrate took 0.9 s. Every name was new and none old, every
   row survived, and every constraint was validated. `rollup_metrics` and
   `backfill_subcategorise_ai dryRun=true` ran.
4. The runbook, through `psql -v ON_ERROR_STOP=1 -f`, left a catalog identical
   to production's, with 0046's migration row gone and the rows intact.
5. 2.A's migrate replayed the old `002_categories.sql` and changed nothing.
   2.A's rollup and backfill ran.
6. This branch's migrate again took 0.87 s, ending identical to step 3. One
   more replay changed nothing.

2.A's code run against the renamed database fails at once:
`relation "conversation_categories" does not exist`. That is the window the
maintenance sequence below closes.

**Deploying 2.B.** The stage section's sequence holds, with these specifics:

1. **Order of merges.** #400 merged into `dev` first, as `a558c5b`, and #403
   merged only after 2.A's release was on all six services, as `1d21cdc`. It
   then reached `main` in #413 and #415 a day before its deploy. While `main`
   holds a migration nothing has run, nothing deploys from it and no
   environment variable changes outside the window: Render redeploys every
   service at once on an environment change, which would run the migration
   with nothing suspended (2.B's deploy, under Status and handoff).
2. **Before the deploy.** List what holds a lock on the tables the deploy
   locks: the seven 0046 does and the six more 001 does. Do not use the query
   in `docs/PROJECT-STATE.md` §5.5: it lists only transactions older than five
   minutes, which `transaction_timeout` reaps, so it reads clear when this
   would not.

   ```sql
   select a.pid, l.relation::regclass as relation, l.mode, a.state,
          now() - a.xact_start as age, left(a.query, 80) as query
   from pg_locks l
   join pg_stat_activity a using (pid)
   where l.relation in (
       'conversations'::regclass, 'messages'::regclass, 'agents'::regclass,
       'ticket_categories'::regclass, 'conversation_categories'::regclass,
       'category_metrics_daily'::regclass, 'ai_category_runs'::regclass,
       'contacts'::regclass, 'companies'::regclass, 'kb_articles'::regclass,
       'shipments'::regclass, 'shipping_accounts'::regclass,
       'side_conversation_messages'::regclass)
     and a.pid <> pg_backend_pid()
   order by age desc;
   ```

   Nothing on it should be more than a few seconds old. It is a reading, not a
   reservation. Note the time web's preDeploy starts.

3. **During it**, the stage section's steps 2–6 apply: suspend the worker and
   crons, deploy web, load the pages, then deploy the worker and crons and
   resume them. If the preDeploy fails, read "How it fails" above before doing
   anything else.
4. **Step 7's list.** These are the inbound messages ingested on web between
   the migration and cutover. Web is every path that leaves
   `channel_message_id` null: the widget, the portal (including a portal reply
   on a ticket of any channel) and forms. The worker's email, WhatsApp and
   Meta ingest always sets it, and the worker is suspended for the window.

   ```sql
   select c.number, c.channel, m.id as message_id, m.created_at
   from messages m
   join conversations c on c.id = m.conversation_id
   where m.direction = 'inbound' and m.kind = 'reply'
     and (c.channel in ('webchat', 'portal') or c.form_id is not null
          or m.channel_message_id is null)
     and m.created_at between '<preDeploy start>' and '<web live>'
   order by m.created_at;
   ```

   An old web instance's subcategoriser failed on each of them and the failure
   was caught. There is no job that re-runs it, so for each row an agent opens
   the ticket and adds a subcategory by hand if the sidebar shows none.

5. **Verify.** No relation or type still has an old name:

   ```sql
   select relname from pg_class
   where relname ~ '^(ticket_categories|conversation_categories|category_metrics_daily|ai_category_runs)'
   union all
   select typname from pg_type
   where typname ~ '^_?category_(audience|review_state)$';
   ```

   It should return no rows. `subcategorised` events also continue on new
   messages.

**Rolling back 2.B** is the stage section's runbook, with the file named and
the services it leaves out put back:

1. Suspend the worker and the four crons. If the deploy's step 3 already
   resumed them on 2.B, suspend them again.
2. On the session connection, run:

   ```sh
   psql "$DATABASE_URL_SESSION" -v ON_ERROR_STOP=1 \
     -f db/runbooks/2b-subcategory-rollback.sql
   ```

   It refuses once any migration newer than 0046 has been applied. Note when it
   committed.

3. Deploy the previous web commit by hand, and note when it goes live. Its
   preDeploy replays the old `002_categories.sql`, which finds its own names and
   does nothing. The order cannot be swapped: run before the runbook, the old
   file reaches `ALTER TABLE ticket_categories` and fails with 42P01. So between
   the two times, web serves 2.B's code against the old names for the previous
   commit's whole build, preDeploy and start, minutes rather than seconds.
   Meanwhile every ticket page fails, because `subcategoriesForConversation`
   is in its `allLimited` batch, and every inbound web message loses its
   subcategorisation.
4. If the worker and crons ran 2.B, deploy the previous commit to the worker,
   `shipblu-sla-sweep`, `shipblu-time-automations`,
   `shipblu-whatsapp-template-sync` and `shipblu-nightly`. They have no
   preDeploy and build their own copy. Then resume them all.
5. List the messages step 3's window cost with the query in step 4 of
   "Deploying 2.B", bounded by `'<runbook committed>'` and
   `'<previous web live>'`, and subcategorise each one by hand as that step
   says.
6. Do not deploy `main` to any service until the roll-forward is intended.
   With 0046's row gone, web's preDeploy applies it again, and the worker and
   crons would run 2.B's code against the old names.

**From a preDeploy that failed between 0046 and `db/sql`** ("How it fails"),
only steps 1, 2, 5 and 6 apply. Web never left the previous commit, because
Render does not promote a failed deploy, and the worker and crons were never
deployed, so steps 3 and 4 have nothing to do: the previous release works again
once the runbook commits. Step 5's window then runs from
`'<preDeploy started>'`, before 0046 committed, to `'<runbook committed>'`.

It stops being a way back once any migration after 0046 has been applied,
Stage 3's new `ticket_categories` among them. The PR that adds that migration
deletes the file and its test; the test fails and says so until it does.

**Since Stage 3.1 it is gone from the tree**, deleted in the PR that adds
`0047` and `0048` ([3.1, as built](#31-as-built)). Until that release's web
preDeploy has run in production, it still works from history, unchanged:
`git show 1d21cdc:db/runbooks/2b-subcategory-rollback.sql`. Once `0047` and
`0048` are applied, 2.B has no way back by renaming: the new
`ticket_categories` holds the name the old table would return to, and Drizzle
would not apply `0046` again behind two newer rows. A problem found in 2.B
after that is fixed forward, in a migration of its own. That is now: 3.1's web
preDeploy applied both at 19:43:50 UTC on 2026-10-25.

### Working on this repo without the outgoing session's context

- **`dev` is the integration branch, and GitHub used to delete it.** The
  repository's "Automatically delete head branches" setting removed `dev`
  whenever a `dev` → `main` PR merged: at #389, and again at #393. Both times
  it was recreated from `main` with the user's agreement. It survived #397:
  `dev` still pointed at `e7376bf` at 18:30 UTC, two minutes after that merge,
  and #399 merged into it at 18:34. The repository's `delete_branch_on_merge`
  read `false` at 21:33 UTC, which explains it. When it changed is not
  recorded. Before branching, still run `git ls-remote origin dev`. If it
  prints nothing, ask the user, since creating `dev` is a push to `dev`, which
  `AGENTS.md` forbids an agent to do unasked. Then branch from `origin/dev`,
  open the PR into `dev`, and leave the `dev` → `main` merge to the user.
  Protecting `dev` would make it hold for good, and that is the user's
  call.
- **A `dev` → `main` merge ships every session's work.** `634a28d` carried #390
  beside 1.2, and `447d8be` carried #396 beside 1.3. Before choosing a stage's
  deploy order, read `git log origin/main..origin/dev` and every migration in
  it (deploy rule 7).
- **Deploys are by hand.** `autoDeploy` is off on every production service.
  On 2026-10-23 it was `checksPass` on all six from about 13:53 to 18:25 UTC,
  by Render's `auto_deploy_enabled` and `auto_deploy_disabled` events, and off
  again before #397 merged. Render's workspace is
  `tea-da1f2lgjo6nc738hobmg`:

  | Service                           | Id                         | Runs                                           |
  | --------------------------------- | -------------------------- | ---------------------------------------------- |
  | web `shipblu-support`             | `srv-da1jgtg1ne8s73ciqulg` | the console; its preDeploy migrates            |
  | worker `shipblu-support-worker`   | `srv-da1jgtg1ne8s73ciqujg` | the queue                                      |
  | `shipblu-sla-sweep`               | `crn-da1jgtg1ne8s73ciqup0` | `sla_sweep && presence_sweep && assign_sweep`  |
  | `shipblu-time-automations`        | `crn-da1jgtg1ne8s73ciquog` | `run_time_automations`                         |
  | `shipblu-whatsapp-template-sync`  | `crn-da1jgtg1ne8s73ciquk0` | the hourly template sync and backlog snapshot  |
  | `shipblu-nightly`                 | `crn-da1jgtg1ne8s73ciqumg` | `cleanup && rollup_metrics`                    |
  | staging `shipblu-support-staging` | `srv-da1jgtg1ne8s73ciqul0` | suspended; `docs/PROJECT-STATE.md` §2 says why |

  `list_deploys` on each shows the commit it runs.

- **A hand-run job reaches production in one of two ways.** Both are production
  writes when the job writes.
  - `npm run job -- <type> key=value` from a shell that carries production's
    environment, such as the worker's Render shell. It runs inline, prints its
    lines there, and leaves no `jobs` row. This is how 1.2's backfill and
    rollup were run.
  - A row the running worker claims within seconds, for example
    `insert into jobs (type, payload, max_attempts) values ('<type>', '{…}', 1)`.
    Its lines land in the worker's Render log, under `[<type>]`.
    `max_attempts` of 1 keeps a failed rebuild from being retried four more
    times.

  Never run a job locally with production's credentials.

- **Production is read with `execute_sql` against Supabase
  `nqbcfnvqqyqawmffgiql`**, `SELECT`s only, unless the user has said yes to a
  specific write. Staging is `funavpkflkhthegahuay`.
- **The database tier locally.** Start Postgres with
  `pg_ctlcluster 16 main start` if it is down. The 3.1 session used
  Postgres 17, CI's version, on port 5433 instead; a fresh container may have
  either or neither. Keep the password out of the repo. Then migrate (again,
  whenever `db/sql` or a migration changed) and run:

  ```bash
  T=postgresql://postgres:postgres@localhost:5432/shipblu_test
  DATABASE_URL=$T DATABASE_URL_SESSION=$T npm run db:migrate
  DATABASE_URL=$T DATABASE_URL_SESSION=$T TEST_DATABASE_URL=$T \
    APP_SECRET=local-placeholder-secret-at-least-32-characters-long \
    npx vitest run -c vitest.db.config.mts [file]
  ```

- **What every stage so far did before merging.**
  - A read-only production inventory before anything wrote.
  - At least two rounds of adversarial review, each finding checked against
    the code before it was fixed.
  - A mutation check on every new test: undo the fix and watch the test fail.
  - The full suite: `typecheck`, `lint`, `lint:strict`, `format:check`, `knip`,
    `repo-rules`, the unit tests, `build`, and `test:db`.
  - Each PR body filled in the template, and its rollback was written before
    the PR merged.

### Still open, and recorded elsewhere

- **The support lead's three.** The first two are under
  [Still open](#still-open), and are needed before Stage 5.
  - Where courier jobs route.
  - Whether channel defaults move off Support.
  - Whether an automation may ever answer a public comment. Today
    `sendCannedReply` refuses that. It is recorded under
    [Risks](#risks-not-closed-by-the-design), and blocks nothing.
- **Comments rows.** None exists, and creating one is optional. A
  "Facebook comments" or "Instagram comments" row gives new comment tickets a
  default group of their own; the moved tickets keep the platform row they were
  filed through. Which group is the support lead's call.
- _Closed, outside this plan, on 2026-10-29._ **A gap older than this plan.**
  An automation's `send_reply` on a `whatsapp_bot` ticket was queued as an
  email: the engine asked only `automatedReplyBlocked`, which knew nothing of
  the bot, and `carrierFor` answers `send_email` for it. The guard now refuses
  the bot's tickets, and `writeAutomatedReply`, the door every automated sender
  writes through, throws on one before anything is written (#440, live in
  `69a22b6` by 17:47:16 UTC on 2026-10-29). It was found during 1.1; nothing
  reached it in production, where no rule sends a reply.
- **Two more, found in #395's review and left out of its seam.**
  - _Closed, outside this plan, on 2026-10-23._ An agent's private reply on a
    comment thread was sent to the newest inbound comment's author, who can be
    a passer-by. The console now names one of the requester's own comments as
    `meta.commentId`, re-read in `sendReply` (`lib/tickets/reply-comment.ts`);
    a row naming none takes the requester's newest, and a private reply with
    none of theirs is refused on the row. `lastInboundCommentId` now only
    answers `inferSendKind`.
  - `findByExternalId` skips a soft-deleted ticket that the unique index still
    holds, so the next comment under it would fail 23505. Nothing soft-deletes
    a ticket yet; the lookup and the `ticket.purge` note say what the change
    that gives `ticket.delete` an action has to decide.

## What production says (read-only, 2026-10-19/20)

Measured against `nqbcfnvqqyqawmffgiql` with SELECTs only; the numbers are small
and should be read as a guide:

- **Volume.** 532 human tickets since 2026-08-18, now about 110–120 new live
  tickets a week. Comment tickets: 43 Facebook and 9 Instagram, 13.8% of Meta
  tickets. They come from 10 and 4 people respectively, and almost every one
  holds a single inbound message.
- **The subcategory detector rarely knows whose work a ticket is.** Of 484 live
  tickets, 305 have no real subcategory. Among primary subcategories, 148 of
  226 are `service.*` ("asking for a human", "acknowledgement"), which says
  nothing about sales versus support. Jev's one shadow run over September did
  better: on 126 Facebook DMs it found 39 sales, 28 customer, 2 merchant, 11
  other and 46 unclear. Among Facebook DMs that can be classified at all,
  sales is roughly 40–50% and merchant support under 10%.
- **No record says who is a merchant.** `contact_shipping_accounts`,
  `shipping_accounts` and `is_shipper` are empty, and `requester_kind` is null
  on every ticket. Text is the only signal, plus one configuration fact: the
  "Nayera Mohamed" coexistence number defaults to Merchant Care.
- **Jev is fast and reliable on the priority path.** 1,423 runs with 0 errors.
  Provider latency is p50 238 ms; from message to answer it is p50 2.2 s.
  Priority has been in `apply` since 2026-10-13, which
  `docs/PROJECT-STATE.md` §5.2 called "ships off" until 4.1 corrected it.
- **Assignment today happens almost entirely in the sweep, and nobody is free
  to be assigned.** Only 9 of 532 tickets were assigned on arrival. The other
  253 assignments came from `assign_sweep`, at a median of 40 hours. Nothing has
  been assigned since 2026-10-07. The sweep is not broken: it runs every day and
  writes its skips (199 `outside_hours` and 115 `none_available` on 2026-10-19
  alone). It finds nobody, because of Support's three members:
  - one is switched off by a supervisor and was last seen on 2026-10-10;
  - one is switched off by themselves;
  - one is "accepting" but has never signed in.

  See Stage 0.7.

- **Only one group has members.** Support has 3 (admins). Merchant Care,
  Customer Care and Inbound Sales Team (created 2026-10-19) have 0, though all
  four are `round_robin`. Nine of twelve active agents are in no group.
- **Agents cannot see unassigned work.** An agent-role user sees only tickets
  assigned to them, because seven separate places enforce "assigned to me
  unless `ticket.view.all`" (Stage 0.5 lists them). `ticket.view.group` is
  already in the `AGENT` role's defaults (`lib/auth/permissions.ts:227-229`),
  but nothing reads it.
- **The SLA policies cannot select by group.** Their group conditions compare
  `group.id` to group _names_ ("Merchant Care"), but the fact is a uuid, and
  the condition builder offers it as free text
  (`app/(console)/admin/field-options.ts:64`). The same builder writes
  automation and skill conditions, so those may hold names too. Policy 1 is the
  default and sits at position 1, matching every chat channel, so policy 4
  ("Live Support (Merchant Care)") is unreachable whatever the names say.
- **Messenger is read-only from here until the Freshworks swap.** Freshchat
  holds thread control on the Page: 240 of 248 first DMs arrived in `standby`,
  and 6 Facebook DM tickets were ever answered from this system
  (`docs/PROJECT-STATE.md` §5.1). Instagram through Instagram Login, and
  comments through the comment edge, can be answered here today. The live
  coexistence number is answered on the phone: all 1,029 of its outbound
  replies were Business-app echoes.

## Decisions

Each decision says what it closes. Where a decision is the support lead's to
make, it was listed again as a question for the support lead with the default
this plan assumed, and
[Decisions taken with the support lead](#decisions-taken-with-the-support-lead-2026-10-20)
records the answer.

### 1. Comment channels are new `channel` enum values, scoped to the work surface

`facebook_comment` and `instagram_comment` join `channelEnum`. They are written
to `conversations.channel` and `channels.type`. The config and reporting tables
that copy a ticket's channel inherit them: `auto_responses`, `csat_rules`,
`csat_surveys`, `metrics_daily`, the subcategory and root-cause rollups, and
`canned_suggestions`. They are **not** written to `contact_identities`,
`webhook_events`, `messages.meta.platform`, job payloads or the external id.
Those name the platform, and that must not change:

- **Contacts.** `contact_identities` is unique on (channel, identifier). 7 of
  10 Facebook commenters share a contact with their DM history, so a comment
  value there would split real people in two.
- **Webhooks.** One webhook delivery carries both DMs and comments
  (`lib/meta/parse.ts:63-85`), so the webhook's channel cannot be either one.
- **External id.** `${platform}:comment:${root}` is the dedupe and threading
  key (`findByExternalId`, `rootCommentId`).

This follows the repo's own precedent. `whatsapp_bot` got "its own value rather
than `whatsapp` with a flag, because the discriminator is what every read,
filter and report already keys on" (`db/schema/enums.ts:14-20`). Two other
shapes were rejected:

- **A second channel row with a config flag.** Nothing reads
  `conversations.channel_id` for Meta. Filters, views, rules, SLA, reports and
  auto-responses all key on `conversations.channel`, so comments would be
  "separate" nowhere anyone looks. It also runs into two traps:
  - `channelFor` takes `limit(1)` with no order.
  - `saveChannel` rebuilds a Facebook or Instagram row's config as `{}` on
    every save (`app/(console)/admin/channels/actions.ts:347-351`).
- **A separate `surface` column.** This is the flag design the bot channel
  already rejected, with a new fact, filter, rollup dimension and scope
  column to match.

The cost is breadth, and the compiler catches little of it, because almost
every channel list in the code is `string`-typed and every switch has a
`default` arm. Two of those defaults fail silently and badly:

- `carrierFor` sends any channel it does not know to `send_email`
  (`lib/tickets/outbound.ts:269-273`), and `sendsByEmail` follows it.
- `reply-actions` copies `meta.platform` from the channel
  (`app/(console)/reply-actions.ts:118,172-182`), and `send_meta` throws on
  anything that is not `facebook` or `instagram`
  (`worker/handlers/send-meta.ts:117-121`).

Three things contain the breadth:

- **One helper module.** `isMetaChannel`, `metaPlatformOf` and
  `isCommentChannel` live in `lib/tickets/channel-policy.ts`, and every site
  that compares a channel with `'facebook'` or `'instagram'` calls them
  instead. That includes the ones written as `case` labels, such as
  `channelSwitch` in `lib/csat/decision.ts:120-133`.
- **`carrierFor` takes `ConversationChannel`, not `string`, as an exhaustive
  switch with no `default`.** `lint:strict` then refuses the next enum value
  that nobody routes. Re-typing it reaches its string-typed feeders:
  `AutomatedReply.channel`, `enqueueAutomatedDelivery`, `storeAgentReply`,
  `sendsByEmail` and `lacksEmailRecipient`. A caller holding a bare string
  narrows it through a guard built from `CONVERSATION_CHANNELS`, never a
  cast.
- **Readers ship before writers, on every service.** That includes the four
  crons, which build their own copy of the code (see
  [Deploy rules](#deploy-rules-every-stage-obeys)).

**Stored configuration is code too.** Automation rules, SLA policies and skills
all match the `channel` fact against `conversations.channel`. Any stored
condition that says `channel is facebook` stops matching comment tickets the
moment they move. So Stage 1.2 begins by reading every such condition and
deciding it row by row. A code review cannot see these rows.

### 2. The rename covers the topic taxonomy only, all the way to the database, in two steps

"Category" means four things in this repo, and only one of them is being
renamed:

| Meaning                                                     | Where                                                                                                                                   | Renamed?                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| The topic taxonomy (area → 55 keys such as `delivery.late`) | `lib/categorise/`, `ticket_categories`, `conversation_categories`, `category_metrics_daily`, `ai_category_runs`, admin and report pages | **Yes → subcategory**               |
| Status category (open / pending / resolved / closed)        | `ticket_statuses.category`, the `status.category` fact, `set_status.category`, `status_changed` event data                              | No; stored automation rules name it |
| Knowledge-base categories                                   | `kb_categories`, `/help/[locale]/c/[category]`, the Freshdesk import                                                                    | No                                  |
| Meta's template and pricing categories                      | `whatsapp_templates.category`, `lib/whatsapp/*`                                                                                         | No; Meta's field names              |

"Everywhere" is taken to mean: what people see, the code's names, and the
database's names. Stored history keeps its words, because rewriting an
append-only audit table to match a rename would put a lie in it. That history
is:

- 722 `categorised` events, 1 `category_*` event and the `category-detector`
  actor label. These are kept and displayed as "subcategory".
- The two strings Jev is sent, `CATEGORY_QUESTION = 'category'` and its
  English instructions (`lib/categorise-ai/request.ts:24,71-80`). Changing
  them changes the experiment, so they are kept as they are.

It ships in two steps because the database half has a real deploy-window
cost and the code half has none:

- **Step A — code and UI.** Everything is renamed, but the SQL names stay
  pinned through Drizzle's explicit strings, for example
  `pgTable('conversation_categories', …)`. This is verified to generate no
  migration. Old and new code agree on the database, so web, worker and crons
  can deploy in any order.
- **Step B — the database.** Tables, columns, index names, constraint names,
  the two enum types and `db/sql/002` are renamed, under a short maintenance
  sequence.

Step B has to happen, and before Stage 3: the new field wants the name
`ticket_categories`, and the name cannot mean two things. The deploy window is
real, because only the web service runs migrations (`render.yaml:286-288`).
Until traffic shifts to the new release, old web instances (up to three) keep
serving against renamed tables. That fails their ticket pages through
`allLimited` (`lib/tickets/conversation.ts:254-322`). It also silently skips
subcategorising any message they ingest themselves: web chat, portal and form
messages are ingested on the web service, and the error is caught with no
backfill. Suspending the worker and crons closes every other path, because
webhook processing is the worker's job and receiving webhooks only appends to
`webhook_events`. The remaining gap is the preDeploy-to-cutover span on web
chat, portal and forms. Production has five web chat tickets ever, so the gap
is measured afterwards and closed by hand if it is not empty (2.B).

**The migration is generated, not hand-edited.** `drizzle-kit generate` is run
at a TTY with the rename prompts answered, and the result is committed as
generated. That gives:

- `ALTER TABLE … RENAME TO` and `RENAME COLUMN`;
- a drop and re-add of the foreign keys and the composite primary key, whose
  names derive from the table;
- a drop and create of each explicit index string renamed in `db/schema`.

The tables hold a few hundred rows each and the worker is suspended, so those
locks last milliseconds. Rewriting the drops as renames would save nothing and
break the "never hand-edit a migration" rule. CI could not then check the
result, because the drift step only regenerates and the `generated-files` rule
refuses only modified files that already exist. Two pieces are invisible to
Drizzle and go in `db/sql`, as idempotent statements guarded on the owning
relation:

- the implicit `<table>_pkey` index names, which `ALTER TABLE RENAME` leaves
  behind;
- the six CHECK constraints.

Two traps in the tooling are fixed before Step B rather than discovered during
it:

- **`drizzle-kit generate` passes CI without writing a migration.** It asks
  interactively about every renamed table and column, and without a terminal
  it prints "Interactive prompts require a TTY", writes nothing, and **exits
  0**. CI's drift step (`.github/workflows/ci.yml:135-144`) would therefore
  pass a schema rename with no migration. Stage 0.1 makes that step fail on
  the message.
- **The `--custom` flag is not used for the rename.** It saves the _old_
  snapshot, so every later generate would prompt again. A `--custom` migration
  that changes nothing the snapshot records, such as the implicit `_pkey`
  names, does not have that problem; [2.B, as built](#2b-as-built) says where
  that matters.

### 3. The new category is a registry row and a foreign key, like root causes

The design is a `ticket_categories` table shaped like `ticket_root_causes`:

- `key`: immutable. The starter set is `sales`, `customer_support`,
  `merchant_support` and `courier_jobs` (Q3: couriers and outsourcing
  companies looking to work with or for ShipBlu). A CHECK
  named `ticket_categories_key_format` holds it to lowercase letters and
  underscores, and refuses `unknown`, which is reserved for Jev's escape hatch
  (decision 4). Hyphens appear only in labels. The CHECK's name is
  deliberately not the old `ticket_categories_key_shape`, which belongs to the
  renamed table's history.
- `label_en` and `label_ar`, both required.
- `description`, which is the sentence Jev is shown for the option.
- `position`, `is_active` (retired, never deleted) and `is_system`.
- `route_group_id`, the group a ticket with this category goes to on a channel
  that routes by category. It is nullable, and null means "stay in the
  default group".

`conversations.category_id` is a single-valued foreign key with `on delete
restrict`, beside `root_cause_id`. The rule fact is `category.id`, read straight
off the conversation row as `group.id` is. A fact holding the key would need
every loader (automations, SLA, assignment) to join the registry, and a loader
that forgot would see null silently, as `formSlug` already can. The condition
builder offers it as a choice of registry rows and stores the uuid.

Three alternatives were rejected:

- **An enum like `priority`.** "More may be added" then means a migration and a
  deploy per value. It also has nowhere to keep two labels, a description for
  Jev, or a target group.
- **A custom ticket field.** There is no foreign key and no protection:
  `admin.fields` can delete the field or strip an option
  (`app/(console)/admin/fields/actions.ts:50,143-178`), and every stored value
  and route then stops matching in silence. `lib/forms/elements.ts:22-39`
  already says column-backed questions should not become ticket fields.
- **Deriving the category from subcategories.** On Facebook, 83 of 133 primary
  subcategories are `service.*`, which is line-neutral. Subcategories are also
  many per ticket, while the category is one.

`conversations.type` is null on every row and could hold the key. But it is
free text described as a "Freshdesk ticket type", so it is not reused for this.

**Every writer stamps its event the way priority's writers do.** That covers
the console, the `set_category` action, Jev and the backfill. Each writes the
column and a `category_changed` event in one transaction, with the event
stamped by `clock_timestamp()` after the update holds the row lock.
`PRIORITY_STAMP` is generalised for this (`lib/tickets/priority-stamp.ts`).
With the default `now()`, a change that waited on another writer's lock sorts
before it, and the ownership rule in decision 4 would read the wrong order.

**It is a routing label, not a claim about the requester.**
`db/schema/enums.ts:257-260` rules out detecting a _prospect_ from vocabulary.
`requester_kind` is a statement about who someone is, and words are not
evidence of that. The new category says which team's work a ticket is, which
words _are_ evidence of. So it never writes `requester_kind`, and the docs say
so beside both.

The category and the subcategories are independent judgements in this plan:

- The category is one per ticket, it routes, and Jev sets it.
- Subcategories are several per ticket, they describe the topic, and the rules
  detector sets them.

Whether a subcategory should also carry a "usually this category" link for the
picker was a question, not a dependency. The support lead answered it
([decision 4](#decisions-taken-with-the-support-lead-2026-10-20)): category and
subcategories are independent.

**Before the first response, the SLA policy follows the ticket's category and
group.** `applySlaOnCreate` selects the policy before any category exists. So
one function, `reselectPolicyBeforeFirstResponse`, selects it again whenever
the category or the group changes before `first_responded_at` is set. Who made
the change does not matter: Jev, a rule, a form, a person or the router. The
one exception is `backfill_category_ai`, which labels an old backlog and never
retargets it. The function can create clocks where the ticket had none, so it
is built from the pause-crediting helpers (`completedPauses`, `excusedSince`),
not on `recomputeOwedClocks`, which returns early without due dates
(`lib/sla/index.ts:617-643`).

`onGroupChanged` deliberately never re-selects the policy
(`lib/sla/index.ts:551-575`), because "which targets a ticket is held to is what
an agent was told when it arrived". That stays true after the first response.
Before it, nobody has been told anything, so this is the same principle applied
to the moment it was written for. The change reaches group moves before a first
response too, which today only re-time: a rule or an agent moving a fresh
ticket to Merchant Care should get Merchant Care's targets as surely as the
router doing it. The doc comments on both functions say exactly where each
applies. Without this, a category-keyed policy would match only on routed
tickets, which is the same unreachable-policy failure Stage 0.2 exists to fix.

### 4. Jev's category classifier is its own module, beside priority

`lib/category-ai/` mirrors `lib/priority-ai/`: request, pure `decide.ts`, run,
enqueue and settings, with its own `classify_category` job and its own runs
table. It is not a second question on the priority call. The wire format would
allow one (`lib/typesafe/client.ts:95-99`), but two things argue against it:

- **Priority is live in apply mode.** Nothing measures whether adding a
  question shifts its answers.
- **The two classifiers stop at different points.** Priority runs on every
  message, while category needs only the first few. Sharing the call would
  couple their switches, selection, failure and dedupe.

A second call costs about 700 input tokens per message classified. The real
number of calls per ticket comes from the shadow rows, not from a guess.

What is shared is extracted rather than copied. That means the message
selection (`skipReason`/`isMachineMail` in `lib/priority-ai/run.ts:346-379`,
moved to `lib/tickets/classifiable.ts`) and the context (`stateFor` and
`earlierMessages`). Both classifiers then ask about the same messages, with the
same context, for the same reasons.

The classifier's rules, and what each one closes:

- **A person, a form or a rule always wins.** These count as owned:
  - any `category_changed` event not written by `jev:category`;
  - an `opened_by_agent` event;
  - a form default recorded as `form:<slug>` at creation;
  - a column that does not hold what the classifier last wrote.

  This is the same ownership test as `lib/priority-ai/run.ts:389-442`, and it
  is decided under the ticket's row lock.

- **`unknown` is offered in code and named in the instructions, and it never
  settles anything.** It covers greetings, thanks, a lone image, and anything
  unrelated to ShipBlu. A greeting is the most confident answer a classifier
  gives, so the escape hatch must never apply or stop the ticket being asked
  again (`lib/priority-ai/decide.ts:24-33` records the same lesson). The key is
  reserved three times over:
  - by the registry's CHECK;
  - by the admin action;
  - by the request builder, which refuses a registry row named `unknown`.

  Category keys come straight from the registry, so a collision would
  otherwise merge the two silently. Canned suggestions avoid the same problem
  with positional keys.

- **The first confident answer settles the category, and later messages leave
  it alone.** The category drives routing, and a ticket that changes teams
  mid-conversation is worse than one an agent relabels by hand.
  - **What "first" means.** The earliest settling answer by the message's
    `created_at`, decided under the row lock. Jobs run concurrently and retry
    out of order (`lib/priority-ai/run.ts:198-202`).
  - **After settling.** A job that finds the ticket already settled records
    outcome `after_settle` and writes nothing. Messages enqueued after the
    settle are checked before the provider call and not asked at all.
  - **In shadow.** A ticket settles at its first non-`unknown` `would_apply`
    run, exactly as priority's shadow weighs answers against its own last
    `would_apply` (`lib/priority-ai/run.ts:180-188`). Otherwise the shadow
    would measure a classifier that never settles, which is not the one
    `apply` turns on.
- **Only the requester's own words are classified.** A passer-by's "price?" on
  a comment thread must not turn a complaint into a sales ticket. This uses the
  requester-only rule priority already applies.
- **A cap per ticket.** No more than five classified messages, and only while
  `first_responded_at` is null. That column moves for agents and for
  Business-app echoes but never for an automated message
  (`lib/tickets/outbound.ts:20-25`). So an out-of-hours acknowledgement does not
  end classification before the informative second message, and a ticket that
  has not settled by the first human reply is a person's call.
- **One threshold on the winner's share,** default 0.6, as for priority. It
  starts as a guess, and the shadow period is what calibrates it.
- **Every answer is a row, and its outcome is one of a closed list:**
  - `applied`
  - `would_apply` (shadow)
  - `unknown`
  - `below_threshold`
  - `owned`
  - `after_settle`
  - `capped`
  - `failed`

  The row also records the run label, mode, prediction, the full distribution,
  latency, tokens and a `request_fingerprint`:
  - **Run label.** Live runs carry the label `live`. Each archive backfill
    carries its own label, and the unique index is on (`run_label`,
    `message_id`), as `backfill_subcategorise_ai`'s table is
    (`db/schema/subcategorise-ai.ts:54-64,123`). So the same message can be
    measured again under a new question. Settling and the ownership test read
    only `live` rows.
  - **Fingerprint:** a hash of the serialised `questions` object exactly as
    sent (keys, criterion strings, the `unknown` criterion, instructions),
    plus a `STATE_VERSION` constant bumped whenever `state` changes shape. An
    admin editing a label or description changes the question, and a report
    must not average two questions.
  - **Baseline:** each row also records a free baseline, computed in the same
    call and **not sent to Jev in v1**. Disagreements can then be read as
    being about the text. It holds:
    - `detectCategories` output put through a reviewed area-to-category map
      in `lib/category-ai/baseline.ts`. `commercial.*` and `account.signup` go
      to sales, other merchant-audience areas to merchant support, and
      recipient areas to customer support. `service.*`, `meta.*` and `other.*`
      map to null. Computing it in the same call is the rule `AGENTS.md`
      already sets for the shadow categoriser, since agents curate the stored
      rows.
    - The channel row, any linked shipment, and `requester_kind`.

The mode is an admin switch (`off`, `shadow`, `apply`), stored in a one-row
settings table, not an environment variable. That is the canned-suggestion
precedent: production already holds `TYPESAFE_API_KEY`, so key-as-flag would
switch it on for every environment that has the key. Staging stays off because
its database says so. The key remains a precondition, shown on the page. The
enqueue path reads the switch through a 30-second memo, as `suggestionsLive()`
does. A memo that fails to read answers `off` and logs: the classifier misses a
message rather than breaking ingest.

Every existing Jev request keeps its exact input across the comment split.
`metaPlatformOf` maps a comment channel back to its platform in **both**
`stateFor` functions, `lib/subcategorise-ai/request.ts` and
`lib/canned-suggest/request.ts`. The priority request in particular stays
byte-identical, and a test asserts it. The new classifier is told
`is_public_comment` explicitly.

### 5. Routing is a channel setting plus a hold, decided once by `lib/routing/`

`channels.routing_mode` is an enum column, not a config key, because
`saveChannel` rebuilds config by type:

| Mode              | What happens to a new ticket                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `default_group`   | Today's behaviour, and the default for every row.                                                                           |
| `category_shadow` | The ticket stays in the default group. The router records where it _would_ have gone.                                       |
| `category`        | Assignment and the out-of-hours reply are held until the router settles the ticket, and the ticket then moves at most once. |

`category_shadow` is per channel because the channels are at different points.
Messenger is read-only until the Freshworks swap, so routing it live moves
copies of tickets that somebody in Freshchat is answering. Instagram and the
comment channels are answerable today.

**Coexistence numbers never route.** Their replies are typed on the phone, so
routing a ticket changes nothing about who answers it. Code reads a channel's
mode only through `routingModeOf(channel)`, which answers `default_group` for
any row whose config parses as coexistence, whatever the column says. It is
also enforced at both writers:

- `saveChannel` refuses a category mode on such a row;
- `complete_coexistence_onboarding` resets the column when it adopts an
  existing row (`lib/whatsapp/onboarding-complete.ts:662-689`).

Those two keep the column from contradicting the answer.

**Which tickets route.** Only a ticket created by an inbound ingest path (email,
WhatsApp, Meta DM or comment, or the widget) on a channel in `category` mode,
**while the classifier is in `apply`**. With the classifier off or in shadow
there is nothing to wait for. Such a ticket is not held, and the channel page
warns that the mode is idle. Tickets created through `createTicket` never route:
forms, the portal and agent-opened tickets each bring their own group. Nor do
continuations, reopens, imported history or echo-first conversations.

**State lives in two places.**

- **Two columns on `conversations`,** `routing_window_ends_at` and
  `routing_decided_at`. These are what the hold is computed from. They sit on
  the row because `assignConversation` already selects the whole row, so the
  check costs nothing even across 500 tickets a sweep. Both are added to the
  realtime trigger's `queue_relevant` list, so the inbox's "Routing…" badge
  appears and clears without waiting for an unrelated change.
- **A `routing_decisions` table,** one row per ticket that entered routing,
  live or shadow:
  - `stage`: `pending`, then `holding`, then `decided`;
  - `outcome`, from the list below;
  - the from and to group, the category, Jev's probability, and who decided;
  - the window's end, the phase-one time and the decision time.

  For a shadow row, the outcome, to-group and decision time are the would-be
  values. The report reads this table. The timeline gets one `routed` event per
  live decision, naming the category, the group, the probability and the
  outcome, including a decision that moved nothing. Today `group_changed` says
  only "moved the ticket to another group", and nothing else reads that event.

**The hold starts when the ticket is inserted.** The ingest path's transaction
that inserts the conversation, through one helper (`startRouting(tx, …)`),
writes three things:

- `routing_window_ends_at = now() + window`;
- a `pending` decision row;
- the `settle_routing` job for that instant, enqueued `on: tx`.

All three commit with the ticket or not at all.

Starting it there, rather than after the creation pass, is what stops the
things that can assign a ticket in its first second from assigning it in the
default group before routing has had its say:

- the priority classifier's `on_update` pass and autoAssign, which is enqueued
  at the same instant and can beat the creation pass
  (`lib/priority-ai/run.ts:286-299`);
- an `on_create` rule's group-less `auto_assign`;
- a sweep;
- a second message ingested concurrently.

The window is anchored on processing time, not `created_at`, so an email
processed late after a worker pause still gets its full window. A shadow
channel gets the same row (marked shadow) and the same job, and no window.

**The hold.** A ticket is held exactly while all of these are true:

- `routing_window_ends_at` is set;
- `routing_decided_at` is null;
- `assignee_agent_id` is null;
- now is before `routing_window_ends_at` + 10 minutes.

`assignConversation` skips a held ticket with a new reason, `awaiting_route`,
and so does `maybeSendAutoResponse`. Neither writes to the timeline: a timeline
entry per skip already produced 1,432 rows for 137 tickets.

The 10-minute grace is a safety valve for a stuck job, not a second window. In
normal running only `settle_routing`, or a stamp, ends a hold. The hold
therefore never lapses at the instant `settle_routing` becomes due, which would
let a sweep assign a ticket in its default group just as the router moves it.

As hardening, `assignConversation` also re-reads `group_id` under its group
lock and gives up if the ticket moved meanwhile. That closes the same race for
rules, which exists today.

The alternative was to let the default group assign and then unassign on
classification. It was rejected because it breaks "never overwrites an
assignee" (`lib/assignment/index.ts:29-33`), and the ticket would appear in one
agent's queue and then vanish.

**The creation pass calls `beginRouting` after the `on_create` rules.** Under the
row lock it does one of three things:

- **A rule already decided.** If an action stamped the ticket (see `endHold`
  below), there is nothing more to do.
- **A category is already settled.** It may have been set by a rule's
  `set_category`, or by Jev answering before the creation pass got here. The
  ticket goes to `apply.ts` now, which runs the whole sequence below, and the
  creation pass ends.
- **Otherwise the row moves to `holding`.** The creation pass carries on: SLA
  on the default group, autoAssign (held), out-of-hours reply (held).

`beginRouting` is best-effort, like every other lifecycle step. If it throws,
the hold stays and `settle_routing` decides at the window's end, treating
`pending` as `holding`.

**What the classifier does after an applied answer** depends only on the
ticket's routing row:

| State                                                        | What the classifier does                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pending` (the creation pass has not reached `beginRouting`) | Writes the category and nothing else. `beginRouting` routes on it, so a rule always gets the first word. |
| `holding`                                                    | Calls `apply.ts` **instead of** `afterTicketUpdate`, which would be a second `on_update` pass.           |
| An undecided shadow row                                      | Calls `apply.ts` in shadow mode to record the would-be decision, then `afterTicketUpdate` as usual.      |
| Anything else (never entered routing, or already decided)    | `afterRoutingChanged` (4.0), then `afterTicketUpdate`, as priority does.                                 |

**A decision is made in two phases, and the hold lasts until the rules have
run.**

1. Under the row lock, `decide.ts` returns an outcome and `apply.ts` writes it:
   the group move if there is one, the decision row's outcome, and the `routed`
   event. `routing_decided_at` stays null, so the ticket is still held.
2. The `on_update` pass runs. It runs after every live decision that settled
   a category or moved the group, not only after a move, because the
   classifier no longer runs its own pass. So "sales on the merchant number →
   Merchant Care", and any rule keyed on `category.id`, run before anybody is
   assigned. Nothing else can assign in between, because the ticket is still
   held.
3. Under the lock, `routing_decided_at` is set and the row moves to `decided`.
   Once that commits, `afterRoutingChanged` (4.0) runs with whether this
   decision filed the category and whether step 1 moved the group. So a move
   the policy survives is still re-timed on the route group's hours.
4. `assignConversation` runs, then the held out-of-hours reply.

This is the creation pass's own order (`lib/tickets/lifecycle.ts:26-43,93-99`).
The other way round leaves a Sales agent holding a Merchant Care ticket.
`assign_group` never touches the assignee, and `auto_assign` returns
`already_assigned` before it moves anything. It would also tell the customer
Sales' hours.

If the process dies between phases 1 and 3, the hold lasts until
`settle_routing`. That job completes a decision whose phase 1 is more than a
minute old. A younger one belongs to a caller still in flight, and the job
leaves it alone. As built, a phase 3 that fails is completed the same way, phase
2 runs once for every write it is owed for however many callers finish the
decision — any of a person's edits of the ticket, Hand to, Jev's answer or the
priority classifier's landing after phase 1 re-arms it (`deferToRouter`) rather
than running a pass of its own, unless nobody may work the ticket, and phase 3
runs it again before the hold ends; a customer's message still runs its own —
and a ticket nobody may work by then is owed nothing
([5.1, as built](#51-as-built)).

**`decide.ts`'s outcomes**, tested in this order under the lock:

| Outcome                 | When                                                                                                                                    | What happens                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `taken`                 | The ticket already has an assignee, from something that assigns without stamping, such as the sweep after the grace, or a stuck worker. | Never moves. Recorded so the report shows it.                               |
| `not_open`              | Resolved, closed, spam or deleted.                                                                                                      | Nothing is moved, re-selected, assigned or sent.                            |
| `released`              | The channel's mode, re-read now through `routingModeOf`, is no longer `category`.                                                       | Nothing moves. Assignment and the held reply go ahead in the current group. |
| `category`              | A settled category (by Jev, a person or a rule) whose route group differs from the current group.                                       | The ticket moves.                                                           |
| `no_route_for_category` | A settled category with no route group, or whose route group is the current one.                                                        | It stays.                                                                   |
| `fallback`              | No category settled by the window's end.                                                                                                | It stays.                                                                   |

`endHold` writes two more outcomes, `manual` and `rule`. `unknown` is never a
settled category.

**What ends a hold early: `endHold(tx, id, outcome)`.**

- **Which tickets it touches.** Only a ticket with an undecided routing row. On
  any other ticket it does nothing, so the console paths can call it
  unconditionally. On a live row it writes `routing_decided_at` with
  `coalesce`, and the outcome only if none is set yet. On a shadow row it
  records the would-be outcome.
- **When it runs.** In the same transaction as the write that ends the hold,
  before anything that assigns.

Its callers:

- **`manual` (a person).** The console's group change, assignee change and
  agent reply. A Business-app echo cannot reach a held ticket, since
  coexistence channels never route.
- **`rule` (the automation engine).** Only when an action actually changes
  something, compared against the locked row rather than the pass's stale
  snapshot:
  - `assign_group` to a different group;
  - `auto_assign` naming a group different from the current one;
  - `assign_agent` with an agent.

  A level-triggered rule naming the group the ticket is already in must not
  end every hold on its channel. Production has one priority pass and one
  further `on_update` pass per customer message inside the window. An
  `auto_assign` with no group means "assign within the current group", and it is
  held like any other assignment — with its strategy kept for whatever ends the
  hold ([5.1, as built](#51-as-built)), or a round-robin rule over a manual
  group would assign nobody.

**A category set during the hold routes; a category set after it does not.**

- **A person's category edit during the hold** does not stamp. It settles the
  category, and the console's category case calls `apply.ts` instead of
  `afterTicketUpdate`, so the ticket routes now, as it would on Jev's answer.
  While the system is still deciding where a ticket goes, a person saying what
  it is about is the best signal there is.
- **A rule's `set_category` during the hold** settles the category without
  stamping. `settle_routing` routes on it at the latest at the window's end.
  It cannot route immediately, because that would need the engine to call the
  router mid-pass, and actions never re-enter the engine.
- **After the hold, a category edit relabels only.** The sidebar then offers
  **"Hand to <group>"**, gated by `ticket.assign`. It is one action that moves
  the group, clears the assignee and assigns in the new group. Without the
  clearing, the move would keep the old assignee, since `assign_group` and the
  console's group case both leave it, which is the cross-team holder this
  design exists to avoid.

**`settle_routing` is the end of the window by definition.** It never waits.

- **Priority.** Its queue priority is 40: behind `classify_category`'s 30 and
  ahead of the default 100. That orders only the claim. The worker runs what it
  claims at once, so an answer that has landed by the window's end is seen, and
  one still waiting on TypeSafe is a late answer (below).
- **Once ever.** Its dedupe key `settle_routing:<id>` is spent for good, which
  is correct because routing happens once per ticket.
- **Late answers.** A late classifier answer, after the settle, finds the
  ticket decided and keeps it where it is. That matters because Jev's retries
  back off 10, 40, 90 and 160 s.
- **Purge.** It is conversation-scoped, so it joins `send_csat` in
  `lib/admin/purge-jobs.ts`, and its handler ends via `subjectGone` on a purged
  ticket.
- **Recovery.** If the job ever dies, `npm run job -- settle_routing
conversationId=…` runs it by hand. It records the outcome, assigns and sends
  the held reply.

**The held reply is owed by state, not by one caller.** Whatever ends a hold —
`endHold`'s callers, `apply.ts`, `settle_routing` whatever its outcome but
`not_open`, which sends nothing (the table above) — calls
`maybeSendAutoResponse` after its commit. The claim on `auto_responded_at` keeps
it to one send. It gains two guards, because its documented precondition, that
every caller has just reopened the ticket
(`lib/auto-response/index.ts:255-260`), no longer holds once a job calls it:

- **Status.** The ticket must be open or pending.
- **A person has already answered.** It skips when
  `last_agent_message_at ≥ last_customer_message_at`. Otherwise an agent's
  23:00 reply to a held ticket would be followed by "we are closed".

**The window defaults to 5 minutes, adjustable from 1 to 30,** and is copied
onto the ticket at insert. Changing the setting never moves a window already
running. Of 257 short chat openers, 191 had a follow-up within 2 minutes and
195 within 10. The shadow period records time to decision per ticket, which is
what tunes it. For context, today's median time to _assignment_ is 40 hours.

**Shadow is defined, not assumed.** In `category_shadow`:

- Nothing is held, so assignment on arrival and the sweep go ahead.
- The would-be decision is recorded when the classifier settles, through
  `apply.ts` in shadow mode, or at `settle_routing`, whichever is first.
- It ignores machine assignments (`auto_assign`, `assign_sweep`), which a live
  hold would have prevented, and counts manual and rule moves through
  `endHold`'s shadow branch.
- It never writes `routing_decided_at`, so moving a channel to `category`
  later starts clean.

Without this, a shadow week on a staffed group would record nearly every
ticket as kept, and report a routing rate the live mode would not have.

The settled design in the README's "Ticket assignment" ("The routing rules are
the automation rules") is amended in the same PR, with the reasons at the top
of this file. The
routing table is a lookup like `default_group_id` and holds no conditions, so
it is not a second engine. Rules still decide every exception, and they run
before assignment.

## Deploy rules every stage obeys

No production service deploys itself. Only web runs migrations, as its
preDeploy (`render.yaml:286-288`). The worker and the four crons each build and
run their own copy of the code: `shipblu-sla-sweep`, which runs `assign_sweep`;
`shipblu-time-automations`; `shipblu-whatsapp-template-sync`; and
`shipblu-nightly`. Their ids are in [Status and
handoff](#working-on-this-repo-without-the-outgoing-sessions-context). Seven
rules follow:

1. **A stage that adds schema deploys web first**, so its preDeploy migrates,
   then the worker, then all four crons. A worker carrying new columns before
   the migration fails every `insert(conversations)`, because Drizzle names
   every column and sends `default` for unset ones. It also fails every
   whole-row select, which covers ingest, assignment, SLA, automations and all
   three senders. Its jobs would reach `dead` after about five minutes of
   backoff.
2. **Readers before writers means every service.** A cron left on old code is
   old code: an old `shipblu-time-automations` sends a rule's reply on a
   comment ticket through the old `carrierFor` to email. An old
   `shipblu-sla-sweep` assigns held tickets with no hold.
3. **A new job type is enqueued only after an admin flips a switch.** The
   classifier defaults to `off` and every channel to `default_group`. So
   deploying web first never queues a job the worker does not know.
4. **A stage is "deployed" when web, worker and all four crons run it.** Each
   stage's last check confirms the deployed commit on all six services.
5. **No migration, now or later, may use a value added to an existing enum by
   `ALTER TYPE … ADD VALUE`.** Today that means `facebook_comment` and
   `instagram_comment`. Drizzle applies every pending migration in one
   transaction, which on a fresh database (CI, `shipblu_test`) is all of them,
   so the value would be used in the transaction that adds it (55P04).
   Anything naming one — a default, a partial index, a CHECK — goes in
   `db/sql`, which runs after the commit. The rule does not cover a new enum
   _type_. `routing_mode` and the routing outcome are created with
   `CREATE TYPE`, whose values may be used and defaulted in the migration that
   creates them. The classifier mode was built as text with a CHECK instead
   ([4.1, as built](#41-as-built)).
6. **Every PR follows `AGENTS.md`:**
   - It runs `typecheck`, `lint`, `lint:strict`, `format:check`, `test`, `knip`,
     `build` and `repo-rules` (with new files staged) before pushing, and
     `test:db` against a freshly migrated `shipblu_test` whenever it touches
     `db/sql`, a migration or a `*.db.test.ts`.
   - Every new raw SQL fragment gets a `*.db.test.ts`.
   - Every new job type gets an entry in `JOB_PAYLOADS` with a `z.strictObject`
     payload, a handler, a registration, and a line in `scripts/ci/db-jobs.txt`.
   - Every new env var appears in `lib/env.ts` and `render.yaml` in the same
     commit.
   - Every new permission key gets a comment saying why it is separate.
   - Every new console page brings its own scroll container and reads through
     `lib/`.
   - Every new form uses `useActionForm`.
   - The docs a change makes stale are updated in that PR.
7. **A release carries whatever is on `dev`, not only the stage.** Before a
   stage's deploy order is chosen, read `git log origin/main..origin/dev` and
   every migration in it. The order has to satisfy each of them: web first
   whenever any of them migrates a table that new worker or cron code reads.
   1.2 deployed the worker first by its own reasoning, and the release also
   carried #390's migration `0043`. That left about three minutes in which a
   worker naming `whatsapp_onboardings.origin` ran before the column existed.
   Nothing used it in that window.

## The work, in the order it ships

```
Stage 0  foundations ─┬─> Stage 1  comment channels ─────────────────────┐
                      └─> Stage 2  rename (A then B) ─> Stage 3 category ─┴─> Stage 4 Jev ─> Stage 5 routing ─> Stage 6 reporting
```

Stages 1 and 2 touch different seams and may proceed side by side, but their
migrations land one at a time.

### Stage 0 — foundations (each worth having on its own)

- **0.1 — CI fails a rename with no migration.** `ci.yml`'s drift step fails
  when generate prints "Interactive prompts require a TTY". It ships before
  anybody touches a table name.
- **0.2 — Groups are chosen, not typed.** The condition builder offers
  `group.id` as a choice of groups and stores the uuid
  (`app/(console)/admin/field-options.ts:64`). The work runs in this order:
  - **Read first.** With read-only SELECTs, quote every `group.id` condition in
    `automation_rules`, `sla_policies` and `skills`, not only the SLA policies,
    since the three share the builder. Read 2026-10-20, for `group.id` and
    `assignee.id` both: no automation rule or skill holds either; the four SLA
    policies below hold one `group.id` condition each, every one `eq` against a
    group _name_.
  - **Show what does not match.** Once the field is a choice, the builder shows
    a stored value with no matching group as "Unknown: <value>" so an admin can
    remove it. A stale name otherwise renders as a blank select. In a list it
    becomes an invisible member that is written back on every save
    (`app/(console)/admin/condition-builder.tsx:170-203`).
  - **Fix the stored conditions through the console**, once the builder change
    is deployed. That is a production write, so it follows the `AGENTS.md`
    sequence: read the rows, say the change, have the way back. The support lead
    approved this restructure on 2026-10-20 (Q15). Read on that date, the four
    policies are:

    | Now | Policy                          | Default | Conditions                                                                           | Tickets |
    | --- | ------------------------------- | ------- | ------------------------------------------------------------------------------------ | ------- |
    | 1   | Live Support (Customer Care)    | yes     | any: channel in (facebook, instagram, webchat, whatsapp), group.id = "Customer Care" | 397     |
    | 2   | Offline Support (Customer Care) | no      | all: channel = email, group.id = "Customer Care"                                     | 1       |
    | 3   | Offline Support (Merchant Care) | no      | all: channel = email, group.id = "Merchant Care"                                     | 0       |
    | 4   | Live Support (Merchant Care)    | no      | all: channel in (whatsapp, webchat, facebook, instagram), group.id = "Merchant Care" | 0       |

    They become, with the group uuids read from `groups` on the day (Customer
    Care `0861a48b…`, Merchant Care `b080b5d9…`):

    | New | Policy                          | Default | Conditions                                                                         |
    | --- | ------------------------------- | ------- | ---------------------------------------------------------------------------------- |
    | 1   | Live Support (Merchant Care)    | no      | all: channel in (whatsapp, webchat, facebook, instagram), group.id = Merchant Care |
    | 2   | Offline Support (Merchant Care) | no      | all: channel = email, group.id = Merchant Care                                     |
    | 3   | Offline Support (Customer Care) | no      | all: channel = email, group.id = Customer Care                                     |
    | 4   | Live Support (Customer Care)    | **yes** | any: channel in (facebook, instagram, webchat, whatsapp), group.id = Customer Care |

    The specific policies come first and the catch-all default last.
    `selectPolicy` takes the first match by position and falls back to the
    default (`lib/sla/policy.ts:47-58`), so every ticket that matches nothing
    else still gets Live Support, as all 397 do today. That includes the comment
    channels, which Q11 leaves out of every condition. The way back is the old
    table, typed back in.

    Sales gets its own policies once the `category.id` fact exists (Stage 3).
    They go above the default, with targets the support lead chooses: "Live
    Sales" for category = sales on the chat channels, and "Offline Sales" on
    email. A policy can combine category, channel and group in one condition, so
    "category is sales **or** group is Inbound Sales Team" is a single policy.
- **0.3 — A group cannot be deleted out from under routing.** `deleteGroup`
  refuses while a channel or a form names the group as its default. Today
  both are `on delete set null`, and new tickets would silently land in no
  group and never be assigned. Stage 3 adds "or a category routes to it".
- **0.4 — Channel lookup is deterministic.** Every lookup that picks one row
  of a type orders by `created_at, id`, as `webchatChannel` already does
  (`lib/widget/session.ts:113-127`). That covers:
  - `channelFor` (`lib/tickets/ingest-meta.ts:575-583`);
  - `defaultEmailChannel` (`lib/tickets/ingest.ts:332-339`);
  - `portalChannel` (`lib/portal/tickets.ts:393-400`);
  - `resolveWhatsAppChannel`'s fallback for an unknown number
    (`lib/tickets/ingest-whatsapp.ts:766`).

  From Stage 5 a ticket's channel row decides its routing mode, so an
  unordered choice would make routing depend on the order the rows happen to
  come back in.

- **0.5 — An agent can see their group's queue.** `ticket.view.group` is
  already in the `AGENT` role (`lib/auth/permissions.ts:227-229`); nothing
  reads it.
  - **One predicate.** The rule "assigned to me, or in a group I belong to,
    when I hold `ticket.view.group`" goes in one place: `conversationVisibility`
    extended with a group-membership arm, plus a row-level twin for single-row
    checks.
  - **Every copy switches to it.** Seven places enforce "assigned to me unless
    `ticket.view.all`" today:
    - the inbox list (`lib/tickets/inbox.ts:169-171`);
    - the inbox counts (`:410-417`), whose cache is keyed on `viewAll` alone
      and must also key on group membership, and which gain a "My groups"
      count;
    - the ticket page (`lib/tickets/conversation.ts:195-197`);
    - `loadConversation`, the guard every ticket action uses
      (`lib/tickets/console-guards.ts:60`);
    - the attachment route (`app/api/attachments/[id]/route.ts:74`);
    - `scopeForAgent` and the shipment read model
      (`lib/tickets/visibility.ts:42`, `lib/shipments/queries.ts:158-159`);
    - `conversationVisibility` itself.

    Changing only the last one would leave a routed ticket out of the inbox
    and unopenable, which is the gap this item exists to close.

  - **The inbox.** It gains a "My groups" view and a group filter. A ticket
    held for routing (Stage 5) carries a "Routing…" badge with the time the
    hold ends, so an agent who takes it knows they are ending the route.
  - **Tests.** A `*.db.test.ts` shows a group member admitted, and a non-member
    refused, by the inbox list, the counts, the ticket page, and an
    assign-to-self action.
  - **It switches on for every agent at once.** Deploying this enables group
    visibility for every agent-role user the moment it lands, because the
    grant already exists. Q8 settled it: the key stays in `AGENT`.
- **0.6 — Staffing and group settings (operations, not code).**
  - Put agents into Inbound Sales Team, Merchant Care and Customer Care. Support
    is then unused (Q5).
  - **Before Support is emptied, every channel that defaults to it moves to
    Customer Care**, in the console. Today that is six channels: email, web
    chat, Facebook, Instagram, WhatsApp Support and ShipBlu Admin. A channel's
    default group is where every ticket lands that no category routes:
    - `fallback` and `unknown`;
    - courier jobs, which have no route group (Q3);
    - every channel left in `default_group` mode.

    In an empty group those tickets wait for nobody. Support's open backlog,
    127 unassigned tickets on 2026-10-19, is moved or closed in the same step.
    That is a person's decision, not a side effect.

  - For each future route group, read and confirm:
    - `assignment_strategy`, which must not be `manual`. Manual is the
      column's default (`db/schema/agents.ts:159`), `assign_sweep` skips such
      groups, and the skip is not recorded.
    - `assign_within_hours_only` and the group's hours.
    - That at least one member is active and accepting tickets.

  Without this, every routed ticket waits unassigned, and each of those groups
  escalates after 60 minutes to a named agent.

- **0.7 — Find out why `assign_sweep` stopped (read-only). Done 2026-10-20.**
  It has assigned nothing since 2026-10-07, yet it is routing's backstop and its
  rollback path. **The cause is staffing, not code.**
  - **The cron chain runs through to the end.** It chains
    `sla_sweep && presence_sweep && assign_sweep` (`render.yaml:411`), and a
    throwing earlier step would stop it, as §6.66 records once. That is not
    happening here: `assign_sweep` writes `assignment_skipped` events every day
    (`outside_hours`, `none_available`, and `no_group_members` for Merchant Care
    since 2026-10-11).
  - **Nobody it may pick is free.** Of Support's three members, one is switched
    off by a supervisor (last seen 2026-10-10), one switched themselves off, and
    the one marked accepting has never signed in.

  0.6 is therefore the fix, and "the sweep assigned something in the last day"
  stays a 5.2 prerequisite, as the proof that it was.

- **As built (2026-10-20).** Where Stage 0 differs from the items above, and
  why. Stage 1 onwards builds on this, not on the wording above it.
  - **0.1** also fails when drizzle-kit's output names neither outcome ("No
    schema changes" or "Your SQL migration file"), so a silent exit other than
    the TTY one cannot pass the diff either.
  - **0.2** made `assignee.id` a choice of active agents too, for the same
    reason as groups: the fact is a uuid and nobody types one. The builder shows
    a stored operator the field no longer offers (`contains` on a group, from
    the free-text days) selected and marked "not offered here". A stored
    scalar on a choice field loads whole, commas and all, rather than as its
    first comma-separated piece, and a choice with a comma in it becomes a set
    of one under "is any of" rather than being split. Production holds no such
    condition (the read above); these are safeguards, not repairs.
  - **0.3** refuses for more than channels and forms. Live tickets, as before
    but no longer counting deleted or merged ones, which nobody can move;
    automation rules, SLA policies and skills that name the group; a canned
    response naming the group (its `group_id`, whatever its visibility) that a
    rule sends, which the cascade would otherwise delete from under the rule;
    and a WhatsApp connection the Channels page shows with a way to finish it,
    with the group as the default for the channel it would create: running
    now, stalled, or failed and still offered Retry (by the page's own rules,
    including hiding the wrong number picked once the right one connected). A
    stalled or failed attempt stops counting when its number is connected
    again with another group, and a failed one also a week after it failed,
    when the page stops offering Retry; a stalled one stays on the page, with
    Retry, until somebody acts on it. The check and the delete run
    in one transaction behind a lock on the group's row
    (`deleteGroupIfUnused`). Auto-responses and CSAT rules scoped to the group
    still cascade, by design: each narrows a broader row that answers instead.
    So do the group's rows in `metrics_daily` (a null group there means every
    group), and the delete's confirmation says its report history goes with
    it. Stage 3 adds category routes to `groupUses`.
  - **0.4**: when no active channel row names a WhatsApp number, the fallback
    picks the oldest active support row that is not a coexistence phone, and a
    coexistence row only when no other active WhatsApp row exists. So an
    unknown number lands in a business's phone inbox only when that phone is
    the sole WhatsApp channel.
  - **0.5**: which tickets an agent may see is decided in one function,
    `assignmentScope`, and the list, the counts, the ticket page, the action
    guard, the attachment route, the shipment pages and the inbox's group
    views all take their answer from it. The counts' request cache is keyed on
    that answer (unrestricted, and whether it takes in groups), not on
    membership: the query reads membership itself, and one request asks once. The group filter
    is a view per group, offered once there is more than one to tell apart (an
    agent in one group has it as "My groups"), and `?group=<id>` in the URL,
    which narrows and never widens. Unassigned and All open appear for an
    agent who sees every ticket or is in at least one group, and My groups for
    a member of one: the permission is in the whole agent role, and for an
    agent in no group those lists are empty or Mine again. A group view's
    narrowing is said on the list, with "Stop filtering by group", as the rated
    view's is. Moving a ticket out of your own sight (another group, another
    assignee) lands you on the inbox instead of a 404; somebody else moving it
    while you have it open lands you on the ticket route's own not-found, which
    says that is the likely reason and links back. The database test drives
    `loadConversation`, the guard every ticket action passes, and the
    attachment route rather than an action; Stage 5's "Routing…" badge goes on
    the list row.

### Stage 1 — comment channels

**1.1 — Readers (no behaviour change).** Web first (it migrates), then the
worker and all four crons. 1.2 does not start until all six run 1.1.

- The enum values go in through a one-line `ALTER TYPE … ADD VALUE` migration,
  following the precedent of `db/migrations/0004_tired_namora.sql`. Deploy
  rule 5 applies from then on.
- `channel-policy.ts` gains the helpers in decision 1. `CONVERSATION_CHANNELS`
  (which the compiler checks both ways) and `FILTERABLE_CHANNELS` list the two
  new values, and so does the hand-written union in
  `lib/tickets/inbox-filters.ts:16`. Realtime topics follow from
  `CONVERSATION_CHANNELS`.
- `carrierFor` takes `ConversationChannel` as an exhaustive switch, and its
  feeders are re-typed (decision 1). Comment channels go to `send_meta`.
  `sendsByEmail` and `lacksEmailRecipient` follow.
- Every site that compares a channel with `facebook` or `instagram` calls the
  helper. Among them:
  - reply-actions writes `meta.platform: metaPlatformOf(channel)`;
  - send-meta maps the channel to its platform;
  - `conversation.ts` keeps comment channels out of Meta thread state;
  - the composer, the header, `inbox-badges`, `meta-actions` and
    `canned-suggest`;
  - both `stateFor` functions sent to Jev, mapped back to the platform;
  - CSAT's `channelSwitch`, where comment channels map to their platform's
    switch. `scheduleSurvey` then still queues the job and `decideSurvey` still
    records `comment_thread`, rather than answering `channel_unsupported`
    before anything is queued.
- Labels and badges:
  - `ChannelBadge` gives "Facebook comment" and "Instagram comment" a mark of
    their own: the platform's glyph with a small globe overlay. Several places
    draw the mark without its label (the inbox row, the header, the
    conversation-row avatar), and there the four Meta channels must be told
    apart by shape, not hue.
  - `channelLabel` in `lib/format.ts`.
  - The condition builder's channel choices.
- **Auto-responses.** A rule scoped to "every channel" no longer matches a
  comment channel; only a rule naming that channel does. Today a company-wide
  out-of-hours reply would go out as a **public** comment reply
  (`send-meta.ts:431-436` infers `comment_reply`). The only row is inactive,
  so this changes nothing live and closes the trap before it opens.
  - Both channel lists change: `AUTO_RESPONSE_CHANNELS` in the action and the
    form's own copy in `app/(console)/admin/auto-responses/forms.tsx:23-40`.
  - The null scope's label becomes "Every channel except public comments",
    with an `InfoTip` saying why.
- **The external id stays a safeguard.** The send path, the 24-hour guard and
  the CSAT skip keep their `rootCommentId(externalId)` test beside the new
  channel test.
- **As built (2026-10-20).** Where 1.1 differs from the items above, and why.
  - **Four comparisons stay strict**, and say so. Three are Messenger's
    feedback card: the `feedback_template` case of `automatedReplyBlocked`,
    `decideSurvey` choosing it and `send_meta` sending it. The card exists only
    in a Messenger thread, so widening them through `metaPlatformOf` would let
    a comment channel through the one door that must stay shut to it. The
    fourth is `recordMetaFeedback` matching a tap's platform against its
    survey's ticket, which also refuses a comment by its external id, so a tap
    can never thank a commenter in public (no survey on a comment ticket
    exists, 2026-10-20; the check is the second line).
  - **`refreshRequesterProfile` and `claimThreadControl` refuse a comment
    ticket** (by channel or external id), rather than mapping it to its
    platform. The console offers neither on a comment — the header hides the
    profile refresh, and the composer shows thread control only under a
    standby refusal, which a comment ticket never has — so a request reaching
    them is a stale tab or a forged form, and both say the comment is answered
    on the post.
  - **The auto-response picker reads a comment ticket still filed on
    `facebook`/`instagram` as the comment channel it is moving to**: `pickRule`
    takes the stored channel and external id and maps them itself
    (`ruleChannel`), so every caller must supply the external id and none can
    skip the mapping by forgetting it. Matched on the bare column, a rule
    naming the platform would post its wording under a comment. The form names
    the platform's scope "Facebook messages" / "Instagram messages" for the same
    reason. Production holds one rule, null-scoped and inactive (2026-10-20).
  - **No picker offers the comment values yet** — not the out-of-hours form or
    its action's allowlist, not the condition builder, not the inbox filter or
    the Channels views. Moved to 1.2 on review of #387: offered in 1.1, the
    views and the filter were empty while every comment ticket sat under
    Facebook or Instagram badged "Public comment"; a condition naming one
    matched nothing, because the rules engine's `channel` fact is the stored
    column; and an out-of-hours rule naming one was the first row to carry the
    value, which the editor before this stage, after a rollback, would list as
    company-wide and save back as every channel. So nothing 1.1 deploys writes
    the values, and rolling it back is clean. The 1.1 editor in turn keeps a
    stored channel it does not offer as a visible option, which the action
    refuses, so a rollback from 1.2 cannot widen a comments rule either. Until
    1.2 a comment is not acknowledged out of hours, which is the safe direction. The realtime topics
    still listen for them, so a web on 1.1 already hears a ticket the 1.2
    worker writes.
  - **One test for a comment ticket**, `isCommentTicket(channel, externalId)`
    in `channel-policy.ts`, built on `rootCommentId`. Every reader that needs it
    calls it; the inbox decides `isComment` once and the badges read that. It
    replaces a dozen copies in two spellings — the anchored `rootCommentId` and
    a bare `includes(':comment:')` — so 1.3 changes one function, not each copy.
  - **The admin channels page's address column** asks `isMetaChannel`, so a
    comment row 1.2 creates reads as its platform's rather than "no address".
  - **The names live once**, in `lib/tickets/channel-labels.ts`, keyed by
    `ConversationChannel`: the badge and `channelLabel` read the same record, so
    a new channel does not compile until it has a name. `channelLabel` used to
    know three channels and print the enum value for the rest.
  - **`send_meta` maps its source rather than casting it**: `meta.platform`,
    else the ticket's channel, through `metaPlatformOf`, so a comment value that
    reached `meta.platform` goes out on its platform instead of dead-lettering
    the reply.
  - **The admin channels page reads the comment types and declines them** as it
    declines `portal` and `api`, until 1.2 teaches the form to create them.
  - **The marks are the platform glyph with a globe on a disc**, cut out of the
    glyph so it reads at 12px, drawn from new
    `--color-channel-*-comment-bg/fg` tokens that alias the platform's for now.

**1.2 — Stored configuration, then writers.** The worker carries the writer;
deploy it with web and the crons.

- **Before anything writes the new values: the inventory.** With read-only
  SELECTs, quote every `automation_rules`, `sla_policies` and `skills`
  condition, and every `auto_responses` scope, whose text names `facebook` or
  `instagram`.
  - **Nothing gains the comment values.** The support lead decided this row by
    row on 2026-10-20 (Q11), so comment tickets stop matching every condition
    that names their platform.
  - **The SLA stays as it is.** Comment tickets fall through to the default
    policy, Live Support (Customer Care), which is what they get today. That
    holds before and after 0.2's restructure.
  - **The inventory is still taken.** Quoting it is what proves that nothing
    else, such as an automation rule added since, depends on the old match.
  - `csat_rules` is a channel column and comment tickets are never surveyed, so
    it needs no change.
- Ingest writes `channel: '<platform>_comment'` for a comment ticket
  (`lib/tickets/ingest-meta.ts:216`).
- `channelFor` looks for the comment row and falls back to the platform's row
  if none exists. Until an admin creates a comment channel, its tickets keep
  today's default group.
- `resolveContact` stays on the platform.
- **The pickers gain the comment values, with the writer.** The inbox filter
  and Channels views (`FILTERABLE_CHANNELS`), the condition builder
  (`CONDITION_CHANNELS` in `app/(console)/admin/field-options.ts`) and the
  out-of-hours form and its action's allowlist (`AUTO_RESPONSE_CHANNELS`). The
  out-of-hours page, `NO_CHANNEL_WHY` and the Active toggle's hint then say a
  comment is acknowledged only by a rule naming its comment channel.
- **Order: the worker first, then web, then the crons.** The worker brings the
  writer; the web brings the pickers. Web first, a 1.2 web accepts a "Facebook
  comments" out-of-hours rule that a 1.1 worker, where comments are ingested and
  acknowledged, applies without the requester check — a reply addressed to the
  customer posted under a passer-by's comment. Worker first, a 1.1 web shows a
  new comment ticket only under All channels for the minutes until it lands —
  it has left Facebook and Instagram and the 1.1 filter has no comment choice —
  which is the lesser gap. (First written web first, for the opposite
  judgement; reversed on review, since one gap is cosmetic and the other
  public.)
- The admin channels page can create "Facebook comments" and "Instagram
  comments" rows. They need no credentials, since they ride the Page and
  Instagram tokens, and their config is `{}`. The page's four type allowlists
  and its config branch learn the new types. The form's and the action's
  `type === 'facebook' || type === 'instagram'` tests (`forms.tsx`, the
  address field, and `actions.ts`, the stored config) become `isMetaChannel`,
  or a comment row falls through to the email address field and is stored as
  `{ address }` rather than `{}`. The address field's
  `type === 'facebook' ? 'FACEBOOK_PAGE_ID' : 'INSTAGRAM_ACCOUNT_ID'` becomes
  `metaPlatformOf(type) === 'facebook'`, or a Facebook comment row names
  Instagram's variable. The page's own address column already asks
  `isMetaChannel` (1.1).
- **Backfill job `split_comment_channels`** (strict payload, `dryRun`).
  - **What it moves.** Existing comment tickets (52 today) move to the new
    values, and `channel_id` is set to the comment row where one exists; 13 of
    the 52 have a null `channel_id` because they predate the channel rows. It
    also moves the frozen channel copies for those tickets,
    `csat_surveys.channel` and `canned_suggestions.channel`. Otherwise their
    CSAT skips would stay in the platform slices of rebuilt reports, which the
    rollup's reconcile check cannot see.
  - **How it is built.** It is idempotent, reports counts, and has a
    `*.db.test.ts`.
  - **When it runs.** It runs once all six services run 1.2: dry run, then
    real.
  - **Side effect.** Each moved row fires `notify_change` on both queue topics.
    That is harmless at this size.
- Then run `rollup_metrics from=2026-08-29`, so historic reports show the
  split. Its reconcile check (channel slices sum to totals) is one
  verification. The CSAT columns per channel are the other.
- **As built (2026-10-21).** Where 1.2 differs from the items above, what the
  inventory found, and the runbook.
  - **The inventory** (read-only, 2026-10-21, after 1.1 deployed). No
    `automation_rules` condition and no `skills` condition names `facebook` or
    `instagram`. The one `auto_responses` row is null-scoped and inactive. Two
    `sla_policies` name them:
    - **Live Support (Customer Care)**, position 1 and `is_default`: `any` of
      `channel in [facebook, instagram, webchat, whatsapp]` or
      `group.id eq "Customer Care"`.
    - **Live Support (Merchant Care)**, position 4: `all` of the same channel
      list and `group.id eq "Merchant Care"`.

    All 52 comment tickets are in the Support group and carry Live Support
    (Customer Care). A policy is selected when a ticket is created (and again
    on a group move before the first response), so a moved ticket keeps the one
    it has. A new comment ticket in the Support group matches none of the four:
    the two Offline policies are email-only, the two Live ones list only the
    platforms in their channel arm, and Live Support (Customer Care)'s group
    arm compares a group id with the name "Customer Care", which matches no
    ticket until that condition is re-saved through 0.2's picker. It takes the
    default, the same Live Support (Customer Care), so for the tickets there are
    the SLA does not change, as Q11 expected. A comments row defaulting to
    Merchant Care would change it: its tickets would take the default too, where
    a Facebook ticket in Merchant Care takes Live Support (Merchant Care) — Q11's
    choice, stated so nobody is surprised by it. No condition gains the comment
    values.

  - **`channelFor` takes the channel**, and for a comment channel reads both
    types in one query, preferring the oldest active comments row and falling
    back to the platform's row. A direct message still reads its platform's
    row only. A comment on a thread filed before 1.2 is found by its external
    id, as every comment is, and keeps its platform's channel until the
    backfill moves it (`ingest-meta.db.test.ts` pinned both until 1.3, whose
    CHECK cannot hold such a thread, deleted the second half).
  - **The admin page's allowlists are named** (`SAVEABLE_TYPES` in the action,
    `EDITABLE` in the form, each naming the other). A comments row says it
    covers the public comments on the account its variable configures, and
    that without one they start in the platform row's group.
  - **`split_comment_channels`** (`worker/handlers/split-comment-channels.ts`)
    moves the tickets and both copies in one transaction:
    - **Tickets.** It moves every ticket on `facebook`/`instagram` whose
      external id is a comment, deleted ones included, because 1.3's CHECK reads
      every row. Its `channel_id` goes to the oldest active comments row of its
      type, else stays as it was, and its group is not touched.
    - **Copies.** It moves the copies still on the platform beside a ticket
      already on its comment channel. They are matched by the ticket's channel
      as it stands, so a copy written late is caught by the next run.

    A second run finds nothing. It was in `scripts/ci/db-jobs.txt` as
    `dryRun=true` until 1.3 retired it. Its dry-run selection, read-only against production on
    2026-10-21: 43 Facebook and 9 Instagram tickets, none onto a comments row
    (there is none), none deleted; 0 `csat_surveys` and 1 `canned_suggestions`
    copy.

  - **Runbook.** Done on 2026-10-21. Every step's result is in [Status and
    handoff](#status-and-handoff).
    1. Deploy the worker, then web, then the crons.
    2. Confirm every service runs 1.2, since a worker still on 1.1 files new
       comments on the platform channel.
    3. `npm run job -- split_comment_channels dryRun=true` should report the
       figures above, give or take what arrived since.
    4. Run it without `dryRun`, then dry-run again, which must report nothing
       to move and no ticket left that 1.3's CHECK would refuse.
    5. `npm run job -- rollup_metrics from=2026-08-29`, then the two
       verifications above.
  - **Rollback** is the list after 1.3 below. Redeploying 1.1 (its step 2)
    leaves tickets 1.2 wrote legible, since 1.1 reads the comment values, and
    its out-of-hours editor keeps a comments rule's scope visible rather than
    saving it as every channel — but 1.1 still acts on such a rule without the
    requester check, and its automation engine has no comment refusal, so the
    step deactivates both kinds of rule first. Reversing the backfill (its step 3) is one
    `UPDATE` each for `conversations`, `csat_surveys` and `canned_suggestions`
    (`replace(channel::text, '_comment', '')::channel` where the channel is a
    comment one), with `channel_id` set back to the platform row where it names
    a comments row.
  - **Out-of-hours on a comment thread answers the requester only**
    (`answersRequester` in `lib/auto-response/resolve.ts`). Anybody may reply
    under a customer's comment, and the reply is filed on the customer's ticket;
    the acknowledgement names the requester and is posted on the thread, so a
    passer-by's comment neither earns it nor spends the closed stretch. Found
    on review: 1.2 is what lets an admin write a comments rule. The reply is
    marked `isPublic`, so the timeline badges it "Posted publicly" as it does an
    agent's comment reply. It judges the comment that set it off, which the
    lifecycle now passes by id (`afterInboundMessage`'s `message`), not the
    newest inbound row: a Meta batch retried whole stores the item that failed
    after siblings newer than it, so the newest row can be a passer-by's reply
    while the requester's comment goes unanswered (found on review). Every
    inbound path passes it, so the out-of-office check reads the same row.
  - **The dry run also names what it cannot move.** A ticket whose channel and
    external id disagree anywhere but on its own platform's channel — a
    comment's external id on `email` or on the other platform's channel, or a
    comment channel without one — fails 1.3's CHECK or would land on the wrong
    comment channel, and this job cannot tell which channel it belongs on. Nothing files
    either (production, 2026-10-21: every one of the 52 refused rows is a
    platform-channel comment the job moves), so the job names them by number on
    every run and leaves them for a person. Found on review: a gate that counted
    only what it moves would read clear with such a row still there.
  - **Review, second round (2026-10-21).** Nothing found had reached
    production, which then held 53 inbound comments, none without a `from` or an
    author and none on a thread with a second commenter; three automation rules,
    none sending a reply; and no ticket with an inbound reply by anybody but its
    requester. Fixed:
    - an automation's `send_reply` is refused on a comment ticket (the risk
      below, now closed);
    - `requesterLocale` reads the requester's own words on a comment thread
      (and not an authorless row there, which is a purged passer-by's), so a
      passer-by's English does not choose the language an Arabic requester is
      answered in when her newest comment was a photo; elsewhere every customer
      row still counts, so a CC'd colleague's words answer for an email whose
      requester wrote none;
    - the acknowledgement leaves `{{customer_name}}` blank on a comment, since
      the contact's name may have come from her email;
    - one `commentIdOf` reads a stored comment's id for the acknowledgement and
      `send_meta`'s fallback alike;
    - `channelFor` runs only for a thread that opens a ticket;
    - the admin pages' type lists are one module each (`channel-types.ts`,
      `auto-responses/channels.ts`);
    - the backfill moves a comment only onto its own platform's comment
      channel, and names the rest;
    - the deploy order is the worker first (above).

    Kept as they are, with the reason on each thread: a commenter Meta sends
    without `from` is a new contact per comment, so only the first is answered
    — silence is the safe side of not knowing who wrote it; the priority
    classifier counts an authorless row as the requester's and the
    acknowledgement does not, because a trigger always has an author and the
    two errors cost differently; and a moved ticket keeps the `channel_id` it
    was moved with, as an ingested one keeps the row it was filed through.

  - **A comments row's default group is its own, "None" included.** Without a
    comments row, comments start in the platform row's group; with one, they
    start in its group, and a row left on "None" starts them in none. The form
    says so.

**1.3 — Lock the invariant.** A CHECK in `db/sql`, idempotent and guarded by
constraint name and table:

```sql
(coalesce(external_id, '') ~ '^(facebook|instagram):comment:')
  = (channel in ('facebook_comment', 'instagram_comment'))
```

The `coalesce` matters, because a regex on null is null and a CHECK passes on
null. 1.3 deploys only after the gate under [1.3, as built](#13-as-built)
returns 0, 0, 0, with all six services on 1.2. Adding the CHECK validates every
row, and one stray row would fail web's preDeploy. After that the pair can
never disagree again, and the three ways the code detects a comment today
become one answer.

**Must not change:**

- the comment-edge reply and `commentReplyTarget`;
- `send_meta` handling `comment_reply` and `private_reply` before it reads
  thread state, the window or `messagingTag`;
- the 24-hour guard's comment exemption;
- the CSAT `comment_thread` skip;
- the external id format;
- webhook routing;
- contact identities;
- the priority request's bytes.

**Docs:** README.md (channels), and `AGENTS.md` (the comment exemption wording,
the `HUMAN_AGENT` section, and the paragraph that begins "Until the CHECK
constraint … lands"). Two items once listed here were done in 1.1: the comment
in `lib/tickets/live-conversation.ts`, and `docs/PROJECT-STATE.md`'s claim that
no Instagram comment had ever arrived. What else 1.3 changes is decided in
[1.3, as built](#13-as-built).

**Rollback, in this order.** 1.1 itself is never reverted. Its migration
cannot be deleted (`scripts/ci/rules/generated-files.mjs:52-63`), and its
readers are harmless.

1. **If 1.3 has shipped:** a PR replaces the ADD block in
   `db/sql/008_comment_channel_check.sql` with the guarded drop under
   [1.3, as built](#13-as-built), and web is deployed. Its preDeploy drops the
   constraint, so nobody types DDL against production, and every later replay
   finds nothing to drop and takes no lock.
2. **Revert 1.2's writers**, in a PR that reverts #391 and #392, and deploy web,
   worker and crons with 1.1's readers still in place, so nothing writes comment
   values any more. Where the revert meets 1.3's retirement of
   `split_comment_channels`, keep the job deleted: step 3 is an `UPDATE`, not
   the job. Where it meets the rollback-state cases #395 added, the ones that
   hold code #391/#392 wrote go with that code: send-reply's and locale's, and
   `lib/auto-response/index.db.test.ts`, which #391 created. Ingest-meta's two
   build their thread through 1.2's ingest, so under 1.1's it is filed on the
   platform already and `moveCommentsBack()` moves nothing: drop that one
   expectation from each and keep the rest, which is exactly what 1.1's ingest
   must still get right. Send-csat's, meta-feedback's and the inbox's hold 1.1's
   readers and stay as they are. Never deploy an old commit such as `1f89219` instead: `main` also
   carries other work since then, #390 among it. First
   deactivate every `auto_responses` row naming a comment channel: 1.1 still
   matches one, without `answersRequester`, so a passer-by's comment would earn
   a public acknowledgement addressed to the requester. Then the same for
   automation rules, since 1.1's `sendCannedReply` has no comment refusal: list
   the active rules with a `send_reply` action as a `SELECT` first
   (`actions::text like '%send_reply%' and is_active`), and deactivate each
   one a comment ticket could satisfy — a comment channel named, no channel
   condition, a channel condition that excludes rather than names, or one that
   names `facebook` or `instagram`, which every comment ticket carries again
   once this step re-deploys 1.1's ingest and step 3 moves the old ones back —
   unless the support lead approves it by name. The last case was missed until
   #395's review: the engine's `channel` fact is the stored column, and the
   refusal in `sendCannedReply` that would otherwise stop it is #391's, so this
   step removes it.
3. **Reverse the backfill** with an `UPDATE`, run as a `SELECT` first, that
   sets each comment channel back to its platform in `conversations`,
   `csat_surveys` and `canned_suggestions`, and points `channel_id` back at the
   platform row where it names a comments row. That is a remap, not a restore:
   the job keeps no record of a null `channel_id` it filled.
4. **Rebuild the reports** with `rollup_metrics from=2026-08-29`.

### Stage 2 — the subcategory rename

**2.A — Code and UI (no migration).** Any deploy order, but all six services.

- **Wording.** "Subcategory", in the sidebar block, admin pages, reports,
  review queue, shadow page, nav, error text and event-label sentences. The
  Arabic is التصنيف الفرعي (Q2).
- **Routes** move to `/admin/subcategories`, `/admin/subcategories/review`,
  `/admin/subcategories/shadow` and `/reports/subcategories`.
  - **Redirects.** `next.config.ts` serves **temporary** redirects from the
    old paths (`permanent: false`, a 307). Stage 3 removes the
    `/admin/categories` redirect in the PR that puts the new Categories page
    there. A permanent 308 would be cached by every browser that followed it,
    and would keep sending admins to subcategories after Stage 3.
  - **Every hard-coded path moves**, not only the three
    `/admin/categories/review` revalidations outside the folder
    (`lib/tickets/console-guards.ts:96`, `app/(console)/ticket-actions.ts:324`,
    `app/(console)/contacts/actions.ts:332`). That includes:
    - the four `revalidatePath('/admin/categories')` calls in
      `admin/categories/actions.ts`;
    - the in-page links to `/review` and `/shadow`;
    - `app/(console)/admin/nav.tsx:46`;
    - `app/(console)/reports/page.tsx`'s link.

    A stale one passes CI. After Stage 3 it would name the new page.
- **Code.**
  - `lib/categorise/` → `lib/subcategorise/` and `lib/categorise-ai/` →
    `lib/subcategorise-ai/`, with every exported name renamed to match.
  - `category-actions.ts` → `subcategory-actions.ts`.
  - The schema identifiers, with the SQL strings pinned to the old names.
  - The cross-imports from `lib/priority-ai/`.
- **Permission keys.** `ticket.categorise` becomes `ticket.subcategorise` and
  `admin.categories` becomes `admin.subcategories`. No production agent holds
  an override of either. That is checked again on the day, because an override
  of a renamed key would silently lapse.
- **Job type.** `backfill_categorise_ai` becomes `backfill_subcategorise_ai`,
  with its `db-jobs.txt` line. It has 0 stored rows and no cron.
- **Env vars.** `CATEGORISE_*` becomes `SUBCATEGORISE_*`. `render.yaml` says
  they are "set nowhere". Read the Render dashboard on both services first,
  because a value set there under the old name would silently fall back to the
  default.
- **Events.** New writes use `subcategorised` and
  `subcategory_added|confirmed|rejected|removed`, with `subcategoryKey` in the
  event data and actor `subcategory-detector`. `event-labels.ts` reads both the
  old and new strings.
- **Handbook.** Its Arabic moves to the agreed subcategory word, and its keys
  stay the same. That covers four articles, plus three descriptions:
  - the `categorising` article;
  - the ticket fields list (`lib/kb/handbook.ts:203`);
  - the supervision folder's `reports` article (`:315-326`), which says
    التصنيف for the subcategory report;
  - the administration article (`:424-426`);
  - the folder and article descriptions at `:136`, `:365` and `:416`.

  Then `seed_console_handbook overwrite=true` runs. The role lists at `:380`
  and `:454` are re-read once both admin pages exist.

- **Docs.**
  - `AGENTS.md` §"Ticket categorisation".
  - `AGENTS.md` §"The one AI provider", which names `lib/categorise-ai/`,
    `ai_category_runs`, `ticket_categories` and `conversation_categories` for
    the shadow categoriser. After Stage 3 reuses two of those names, stale text
    there would point readers at the wrong table.
  - `docs/PROJECT-STATE.md`.
  - `plans/ticket-categorisation.md` and
    `plans/categorisation-through-typesafe.md` get a one-line historical note
    rather than a rewrite.

**2.B — The database (maintenance sequence).**

- **Schema.** The four table names, two column names (three, as built), two
  enum type names, and every explicit index string on those tables are renamed
  in `db/schema`:
  - `ticket_categories` → `ticket_subcategories`
  - `conversation_categories` → `conversation_subcategories`, with its columns
    `category_id` → `subcategory_id` and `category_key` → `subcategory_key`
  - `category_metrics_daily` → `subcategory_metrics_daily`
  - `ai_category_runs` → `ai_subcategory_runs`
  - the enum types `category_audience` and `category_review_state`

  The index strings are explicit, not derived, so a table rename alone leaves
  them behind.

- **The migration** is generated at a TTY with the rename prompts answered, and
  committed exactly as generated (decision 2).
- **`db/sql/002_categories.sql` becomes `002_subcategories.sql`.** It keeps its
  place in the replay order. Every guard matches on the constraint's name
  **and** its table (`conrelid = 'ticket_subcategories'::regclass`), so it
  handles both databases:
  - on production it renames the six CHECK constraints when the old name
    exists on that table and the new one does not;
  - on a fresh database it creates them under the new names;
  - it renames the three implicit `_pkey` constraints, and their indexes with
    them, guarded on `conrelid` as built.

  A guard on the name alone would one day find Stage 3's constraint on the new
  `ticket_categories` and fail every replay.

- **Raw SQL with no database test is tested before merge.** These were never
  executed in CI: `subcategoryTotals`, `areaTotals`, `channelTotals`,
  `causeCoverage`, `ruleScores`, `subcategoryUsage` and `runLabels`. They get a
  `*.db.test.ts`, or one `execute_sql` each against a Supabase branch.
- **Verification before merge:**
  - CI's `database` job, which migrates an empty Postgres and replays
    `db/sql` twice;
  - a second `drizzle-kit generate` reports nothing to migrate;
  - the migration and `db/sql` applied to a Supabase branch of production;
  - no `pg_class` relation still named `ticket_categories%`,
    `conversation_categories%`, `category_metrics_daily%` or
    `ai_category_runs%`.
- **Deploy sequence:**
  1. Pick the time. Avoid 00:00 UTC, when `shipblu-nightly` runs the rollup,
     and choose a time when web chat, portal and form traffic is about zero.
  2. Suspend the worker and the crons.
  3. Deploy web, which runs the migration before traffic moves. Note the
     migration's start time and the moment the new release went live.
  4. Load a ticket page, a web chat ticket, `/admin/subcategories` and its
     shadow page.
  5. Deploy the worker and crons, then resume them.
  6. Watch for `subcategorised` events on new messages.
  7. List inbound messages on web chat and portal tickets created between the
     two times in step 3 with no `subcategorised` event. If there are any,
     re-run the detector over them, or accept the loss explicitly.

  Expected window: a few minutes of queued (not lost) webhook processing.

- **Rollback.** A tested runbook, not a reverse migration in the repo. Drizzle
  applies only migrations newer than the newest row in
  `drizzle.__drizzle_migrations`, and the forward file cannot be deleted from
  `main`.
  1. Keep the worker and crons suspended.
  2. On the session connection, run the reverse SQL by hand: tables, columns,
     FK, PK and index names, both enum types, the six CHECK names and the three
     `_pkey` names.
  3. In the same transaction, delete the forward migration's row from
     `drizzle.__drizzle_migrations`, so a later deploy from `main` re-applies
     it.
  4. Deploy the previous web commit by hand. Its preDeploy replays the old
     `002_categories.sql`, which now finds its old names again.
  5. Do not deploy `main` until the roll-forward is intended.

  This exact sequence, including the later roll-forward, is rehearsed before
  2.B merges. As built, it was rehearsed locally against production's names,
  as the user chose on 2026-10-23, and [2.B, as built](#2b-as-built) has the
  runbook and the steps that superseded this list.

**Gate:** Stage 3 does not start until 2.B is deployed to all six services and
verified. After that, nothing running can read `ticket_categories` expecting the
old meaning, and the name is free.

### Stage 3 — the category field

**3.1 — Schema, admin and the ticket.** Web first (it migrates), then the
worker and all four crons. An old time-automations cron would drop a
`set_category` action without a word, because `parseActions` filters what it
cannot parse.

- **Schema.**
  - The `ticket_categories` registry, as described in decision 3.
  - `conversations.category_id` (FK `restrict`) and an index for the inbox
    filter.
  - In `db/sql`: the `ticket_categories_key_format` CHECK, and
    `OLD.category_id IS DISTINCT FROM NEW.category_id` added to the
    `queue_relevant` list in `001_extensions_and_triggers.sql:370-385`. Without
    the second, open inboxes do not redraw when only the category changes.
  - **The primary key's name.** On a fresh database `ticket_categories_pkey` is
    still taken when this migration runs, because only `db/sql/002` renames the
    old one ([2.B, as built](#2b-as-built)), so an unnamed key is created as
    `ticket_categories_pkey1` there and as `ticket_categories_pkey` in
    production. Nothing may name it until a migration of its own renames the
    old three ahead of this one; deciding that is this stage's. The cheapest
    is a guarded `--custom` migration at the head of this stage's PR, renaming
    each old `_pkey` only where it still exists: about 1 ms, and it passes the
    drift step because it changes nothing the snapshot records. The fallback is
    an explicit primary-key name here and in Stage 4.
- **Seeding.** `lib/categories/registry.ts` holds the starter set: four rows
  with English and Arabic labels and descriptions written for Jev. Being in
  code means the wording goes through review.
  - **Route groups (Q5).** The seed leaves them empty, and an admin sets them
    on the Categories page when Stage 5 turns on:
    - `sales` → Inbound Sales Team;
    - `merchant_support` → Merchant Care;
    - `customer_support` → Customer Care.
  - **`courier_jobs` has no route group.** It lands in its channel's default
    group, which 0.6 moves to Customer Care.
  - **The `courier_jobs` description.** It must exclude greetings and generic
    "I want to work" openers that name no courier or delivery work. Otherwise
    a greeting answered "courier jobs" would settle the ticket before its
    informative message arrives. `seed_ticket_categories` puts
    the set in idempotently, finding rows by key, and production runs it by
    hand, because deploys only run `db:migrate`
    (`docs/PROJECT-STATE.md` §6.30). `db/baseline.ts` seeds the same set for
    tests and development.
- **Admin.** A "Categories" page at `/admin/categories`. This PR removes the
  three 2.A redirects under that path, `/admin/categories/review` and
  `/admin/categories/shadow` included, so a child page of its own named either
  way is not hidden behind one.
  - **Edit** labels, description, position, active flag and the route group.
    The route-group picker shows each group's strategy, members accepting now
    and hours gate, and warns on a `manual` group.
  - **Add** a category. The key `unknown` is refused.
  - **Retire** a category, never delete one. Retiring uses `ConfirmSubmit`.
  - **Permission.** It is gated by `admin.categories`, which is free after
    Stage 2.
  - `deleteGroup` also refuses while a category routes to the group.
- **The ticket.**
  - A Category select beside Group and Priority in the sidebar.
  - A badge in the header, because the sidebar renders only from `lg` up.
  - `ConversationDetail` carries the field.
  - A new `updateTicket` case writes the column and a `category_changed` event
    in one transaction, with the stamp of decision 3. It then calls
    `reselectPolicyBeforeFirstResponse` and runs `afterTicketUpdate`. From
    Stage 5, on a held ticket, it calls `apply.ts` instead (decision 5).
  - It is gated by a new permission, `ticket.set_category`, which agents get
    by default.
  - The new event string `category_changed` cannot collide with the old
    `category_*` history. `event-labels.ts` gets a case for it naming the
    category, and for `jev:category` Jev's probability, as `priority_changed`
    does.
- **Rules.** The `category.id` fact appears in the condition builder as a
  choice of registry rows. There is also a `set_category` automation action, so
  a rule such as "anything on the merchant number is merchant support" can set
  the category and be respected as owned. The action calls
  `reselectPolicyBeforeFirstResponse` after the pass, as the console does.
- **SLA.** `reselectPolicyBeforeFirstResponse` lands here (decision 3). It is
  wired to every category writer except the backfill. It is also wired to the
  group moves that happen before a first response: the console's group case,
  `assign_group`, and a grouped `auto_assign` that moves.
- **Inbox.** A category filter axis, views, and a row badge.
- **Docs.**
  - `AGENTS.md` gains a section next to the subcategory one: the routing-label
    framing, the ownership rules, the event stamp, the SLA re-selection rule,
    and the reuse of the `ticket_categories` name after the gate.
  - A handbook article on the Category field.

#### 3.1, as built

Squashed into `dev` as `ff3bbfd` (#419). What it holds beyond the list above,
and where it departs from it:

- **Migrations.** `0047_free_old_pkey_names` is the hand-written one this stage
  was to decide on (`drizzle-kit generate --custom`): a loop renaming the three
  `_pkey` constraints 2.B left to `db/sql/002`, each guarded on its name and its
  table. Its snapshot is 0046's, so the drift step regenerates nothing. On a
  fresh database the new key is then `ticket_categories_pkey`, as in
  production, where `0047` does nothing (read 2026-10-25: all three already
  carry their new names, 47 migrations applied). `db/sql/002` stops renaming
  them. `0048_ticket_categories` is generated: the registry,
  `conversations.category_id` (`restrict`) and `conversations_category_idx` on
  `(category_id, last_message_at)`. The route group's foreign key is
  `set null`, like a channel's default group, and `deleteGroupIfUnused`
  refuses while any category names the group, retired ones included.
- **`db/sql`.** `003` adds `ticket_categories_key_format` and
  `ticket_categories_labels_not_blank` (a blank label is a blank badge), each
  guarded on its name and its table; `001`'s `queue_relevant` gains
  `category_id`.
- **The 2.B runbook and its test are deleted**, as the test required;
  [Rolling back 2.B](#2b-as-built) says what replaces them.
- **One writer.** `setConversationCategory` (`lib/categories/write.ts`) is
  what the console and `set_category` call: the ticket's row locked, an
  unchanged value writing nothing, a retired category refused, the key and
  label stored on the event. `PRIORITY_STAMP` is generalised to
  `CHANGE_STAMP` (`lib/tickets/change-stamp.ts`), the same `clock_timestamp()`.
- **SLA.** `reselectPolicyBeforeFirstResponse(id, cause)` as decision 3 says,
  doing nothing once a first response exists, when the same policy wins, when
  none does, on a read-only channel or an imported history, on a deleted, spam
  or merged ticket, and on a resolved or closed one, each asked first of the
  row read without a lock so an answered ticket costs one read. The last is a
  departure: a policy changed under a
  resolved ticket's clocks came back out of a reopen with the new policy's name
  on the old one's resolution deadline, or on none, because a reopen shifts the
  clocks a ticket has rather than choosing them. So a category set while a
  ticket is resolved moves its policy only when the category or the group next
  changes after it reopens. The automation engine owes it once per pass
  (`Pass.policyOwed`, named `category` over `group` when both moved) and skips
  it on `on_create`, because `applySlaOnCreate` runs after that pass and reads
  the category. A group is owed it only when it really moved: `assign_group`
  and the console's group case write through `moveToGroupIfElsewhere`
  (`lib/tickets/move-group.ts`), and `auto_assign` reads `movedGroup` off
  `assignConversation`, because a rule naming the group a ticket is already in
  matches on every pass, and a second look owed for nothing took up a raised
  priority as though the group had moved. Neither writes a `group_changed`
  event for a move that did not happen, which `assign_group` used to on every
  pass. Both callers run it before `onGroupChanged` — the console in its
  action, the engine once the pass is over (`Pass.groupMoved`) — so a move that
  changes the policy writes one `sla_recalculated`; re-timed first, the old
  policy's clocks moved to the new hours and then moved again. Its event is
  `sla_recalculated` with `reason: 'policy'`, the cause and both policies'
  names, and reads "moved the ticket from the Standard to the Sales SLA policy
  after its category changed": by what set the choice off, since the policy is
  chosen from everything the ticket is and the one that wins need not be keyed
  on the category at all.
- **Escalation per policy.** `sla_escalated` names its `policyId`, and the
  sweep counts an escalation only under the policy the ticket holds now, so a
  ticket escalated under the default and then filed under Sales still reaches
  the Sales contacts when it misses Sales' target too. An event from before
  names no policy and settles its kind under any, so no ticket is escalated
  twice by the deploy.
- **Permissions.** `ticket.set_category` on every agent, `admin.categories` on
  admins. No agent held an override of either key (read 2026-10-25 06:3x UTC).
- **Seed.** The starter descriptions say where each category's edges are, for
  Jev, and `courier_jobs`' excludes a greeting or a bare "I want a job". The
  seed reconciles by key, never overwrites, and marks as seeded only what it
  inserts, reporting a starter key an admin's own category holds; CI's `database` job runs it
  through `scripts/ci/db-jobs.txt`.
- **The ticket.** A Category select beside Group and Priority, read-only text
  for an agent without the permission; a retired category the ticket holds is
  shown as "(retired)" rather than as "None", and so it is in the header badge
  ("Category: Sales (retired)"), the read-only text and the inbox row
  (`categoryLabel` in `lib/categories/choices.ts`). The timeline reads "set the category to Sales", with Jev's
  probability from Stage 4, or "cleared the category".
- **Rules.** `category.id` in the condition builder on the automations, SLA
  and skills pages, a retired category named as such; "Set category" in the
  action builder. A stored `set_category` with no id is refused at parse, as a
  rule saved half-written.
- **Admin.** `/admin/categories` adds, edits, retires (`DangerAction`'s two
  clicks) and restores; nothing deletes. The rules are `lib/categories/admin.ts`:
  the key checked as given and never written on an edit, `unknown` refused, a
  duplicate refused naming its holder, both labels required. The route group is
  re-read under a key-share lock, so a group delete at the same moment answers
  the save with a sentence. The picker shows each group's strategy, "N of M
  members accepting now", counted by assignment's own `filterCandidates`, and
  its hours rule, and warns on a manual group or one with nobody in it. The three
  `/admin/categories` redirects are gone; `/reports/categories` stays.
- **Inbox.** `?category=<uuid>`, parsed like the group and applied inside
  visibility, part of every view's filters and of the scroll signature, with no
  preset view per category until Stage 5 routes by it. A Category select under
  Status and Channel, and each row's label as a neutral badge, last in both
  layouts. `listCategories` is memoised per request, so the ticket page and the
  inbox shell share one read, and every page handing the registry to a client
  component cuts it to id, label and state first (`toCategoryChoices`): a
  wider row passes a narrower prop type and is serialised whole. `/api/inbox`
  reads a repeated parameter as the page does, first value first
  (`queryParams`), where it kept the last and a link naming two categories
  scrolled into the second one's tickets — true of every axis before 3.1.
- **Handbook.** A `category` article in the agents' folder; a Category filter
  in `inbox`'s list of them; a line in `ticket-fields`; a Categories section in
  the admins' `automation-and-forms`, saying rules and policies hold the
  category itself, so a rename breaks neither; the role lists in `people` and
  `owner-role`; and the two folders' descriptions.

**Decided on review.** #419 had three review rounds. Every finding was fixed
or decided, and four were put to the user and decided on 2026-10-25:

- **A `set_category` naming a bad id is not refused when the rule is saved.**
  A non-uuid, an unknown category or a retired one is answered at run time: the
  engine logs an error or warning naming the rule on each match. Checking the
  uuid in `parseAction` would make it quieter, because `parseActions` drops an
  unparsable action without a word. No console path produces a bad id, every
  other id-bearing action is held to the same not-blank check, and refusing a
  retired category at save would stop an admin saving any change to an older
  rule until they replaced that action.
- **A breach flag stays set when the re-selection moves a breached ticket to a
  policy whose target has also passed.** One missed response is one breach,
  recorded once by the sweep against the deadline in force when it was found,
  as `recomputeOwedClocks` already does when a priority raise brings a breached
  deadline earlier. Clearing the flag would record the same miss twice. What
  follows the new policy is the escalation, keyed per policy above.
  `breachesCleared` is the one copy of the rule.
- **With no active default policy, correcting a category to one no policy
  matches keeps the policy the wrong category chose**, with nothing on the
  timeline. Left as it is: production has an active default, Live Support
  (Customer Care), and `/admin/sla` warns when there is none. If that changes,
  the cheap answer is an `sla_recalculated` event in the `!policy` branch when
  the current policy's own conditions no longer match.
- **Every writer of the category or the group calls the follow-up by hand.**
  The console, the engine's `finally` and, from Stage 4, Jev must each remember
  `reselectPolicyBeforeFirstResponse` and then `onGroupChanged`, and a writer
  that forgets leaves a category-keyed policy unreachable with no test failing.
  It becomes one function, `afterRoutingChanged`, as
  [Stage 4's first change](#stage-4--jev-sets-the-category), before Jev is a
  writer.

**Deploying 3.1.** Web first, because it migrates; then the worker and the four
crons, because an old time-automations cron drops a `set_category` action
without a word. It waits for 2.B's two remaining reads. It did not, in the
end: the user released it with the page loads unread
([3.1's deploy](#status-and-handoff)).

1. **Before.** Read `git log origin/main..origin/dev` (rule 7) for what else
   rides. Expect 47 rows in `drizzle.__drizzle_migrations`, the newest
   `1792781241219`, and no `ticket_categories` relation. Run the lock check of
   `docs/PROJECT-STATE.md` §5.5.
2. **Deploy web.** Its preDeploy applies `0047` (nothing to do in production)
   and `0048` in one transaction, then `db/sql`. `0048` takes ACCESS EXCLUSIVE
   on `conversations` when it adds the column, and the foreign key's validation
   of every row (72,119 rows, 20 MB, read 2026-10-25) and the index build come
   after it in the same transaction, so that lock is held until it commits:
   reads of tickets block as well as writes, for the whole migration — seconds,
   because the new column is all null — and for up to `lock_timeout` (10 s,
   `db/migrate.ts`) more if the lock queues behind an open transaction, which is
   what step 1's lock check is for.
3. **Deploy the worker and the four crons** on the same commit.
4. **Seed.** `npm run job -- seed_ticket_categories` on the worker's shell, or
   `insert into jobs (type, payload) values ('seed_ticket_categories', '{}')`.
   It logs `[seed_ticket_categories] done created=sales,customer_support,merchant_support,courier_jobs present=0`;
   run again, `created=none present=4`. If an admin added a category under a
   starter key first — web is live before the seed runs, and the empty admin
   page offers to add one — the run also logs `starter key held by an admin's
category, left as it is: <key>`, and that key keeps the admin's wording.
5. **Handbook.** Production held no console handbook at 2026-10-25 08:44 UTC:
   no `handbook:` folder or article. If that still holds there is nothing to
   do, because the first seed, whenever somebody runs it, writes 3.1's words.
   If it has been seeded since, run
   `npm run job -- seed_console_handbook dryRun=true` once web is live,
   expecting `folders 0 created, 2 updated`, one article created and
   `5 article(s) differ from this repository` (`inbox`, `ticket-fields`,
   `people`, `automation-and-forms`, `owner-role`). A different count is a
   console edit `overwrite=true` would replace, and is read first. Then
   `overwrite=true`, which cuts one `kb_article_versions` row per article it
   replaces. Rehearsed locally on 2026-10-25: `origin/dev`'s seed into an empty
   database, then this branch's dry run, reported exactly that; the overwrite
   replaced the five named, and a run after it found all 16 current.
6. **Verify** (read-only):

   ```sql
   select
     (select count(*) from drizzle.__drizzle_migrations) as migrations, -- 49
     (select string_agg(conname, ', ' order by conname) from pg_constraint
       where conrelid = 'public.ticket_categories'::regclass) as constraints,
     (select string_agg(key, ', ' order by position) from ticket_categories) as categories,
     (select prosrc like '%category_id%' from pg_proc
       where proname = 'notify_conversation_change') as queues_redraw;
   ```

   Expect 49; `ticket_categories_key_format`, `ticket_categories_labels_not_blank`,
   `ticket_categories_pkey` and the route group's foreign key; the four keys in
   order; `true`. Then, signed in: `/admin/categories` lists the four, a ticket
   page shows the select, and setting a category writes one `category_changed`
   event naming the agent.

**Rolling back 3.1.** The schema is additive, so it is code only: deploy the
previous commit to web, then the worker and the crons. Its preDeploy applies
nothing — every migration in its journal is older than the newest row — and its
`db/sql` replays cleanly: `001` puts the trigger back without `category_id`,
`002`'s `_pkey` rows look for the old names on the subcategory tables only and
find none, and `003` neither knows nor drops the new CHECKs. The old code never
reads `category_id`. Tickets keep their categories and events, which the old
timeline prints as "category changed"; a rule holding a `set_category` action
has it skipped and the rest performed (`parseActions`). Removing the table or
the column would be a forward migration of its own. Four things the old code
does differently with 3.1's data, and the first needs a step before the
deploy:

- **A stored condition on `category.id` changes meaning.** The old code has no
  such fact, and its evaluator reads an unknown field as absent: `is`/`is any
of` then match no ticket, so a category-keyed SLA policy stops applying and
  its tickets fall to the next policy or the default, while `is not`, `is none
of` and `is empty` match every ticket, and the time sweep acts on the whole
  backlog within one run. So read the rows that name it first, and deactivate
  or rewrite each, to restore after rolling forward (none, if nobody has
  written one):

  ```sql
  select 'automation' as kind, name, is_active from automation_rules
    where conditions::text like '%"category.id"%'
  union all
  select 'sla', name, is_active from sla_policies where conditions::text like '%"category.id"%'
  union all
  select 'skill', name, is_active from skills where conditions::text like '%"category.id"%';
  ```

- **A group delete stops asking about route groups.** The old
  `deleteGroupIfUnused` does not count categories, so a group deleted while
  rolled back sets its categories' `route_group_id` to null, and rolling
  forward does not bring it back. Read `select key, route_group_id from
ticket_categories` before and after.
- **A `seed_ticket_categories` queued under the old worker goes `dead`**: it
  has no handler, so each attempt fails, and the fifth is about five minutes
  after the first. After rolling forward, run the seed again and check the
  four keys with step 6's query.
- **The handbook's articles keep 3.1's words** until the seed is run from the
  older commit with `overwrite=true`; its folders do not wait for that. Any run
  of the older seed but a dry one puts the `tickets` and `administration`
  descriptions back and the tickets folder's article positions with them,
  because folders and positions are synced every run, so the orphaned
  `category` article then shares a position with `categorising`. It stays
  either way, because the seed never deletes.

**3.2 — Where a person sets it at creation.** Web, worker and crons; no schema
beyond one column.

- A form gets `default_category_id`, recorded at creation as a
  `category_changed` by `form:<slug>`. Like `priorityChosenBy`, this is read at
  the time and never from the form as it stands later.
- The console's new-ticket form gets a category chooser, which counts as
  owned. Production has no forms today, so this can follow later without
  blocking anything.

#### 3.2, how to build it

Mapped from the code on 2026-10-26, against `dev` at `992286c`, by four
readers and a critic that checked them against the code. The critic's
corrections are folded in: assignment's skill match reads the category, the
console chooser is not a copy of priority, and the action writes a contact
before it can refuse. It was built from this map on 2026-10-26: what it holds and where it departs are under [3.2, as built](#32-as-built). Every line number below was read then; re-read the file
before you edit it.

The defaults below are recommendations. They answer the questions the map
raised, so a session can build without stopping. Where a default is a product
call the user may want to make, it says so.

**The one hard constraint: the category is written inside `createTicket`'s
own transaction.** Everything else follows from it.

- `createTicket` (`lib/portal/tickets.ts:224-307`) commits, then runs two hooks
  before it returns:
  - `afterMessageStored`, which queues the priority job and, from Stage 4, the
    category job;
  - `afterInboundMessage(…, true, …)`, which runs the `on_create` rules, then
    `applySlaOnCreate`, then auto-assignment (`lib/tickets/lifecycle.ts:73-78`).
- So a category written after it returns arrives too late, four ways:
  - the `on_create` rules miss it;
  - the first policy selection misses it;
  - auto-assignment's skill match misses it. `routeAndPick` matches skills on
    `conversationFacts`, which carries `category.id`
    (`lib/assignment/index.ts:258-269`), and the Skills page offers it. A later
    re-selection would fix the SLA, never the assignment;
  - from Stage 4, Jev could act first.

  This is the lesson `NewTicket.openedBy`'s comment records. `submitForm`'s
  `unverified_submitter`, written after `createTicket`, is the shape not to
  copy.

- **`setConversationCategory` cannot be called inside that transaction.** It
  opens its own `db.transaction`, which cannot see the uncommitted row and
  answers `no_ticket`.
- **The column goes in the insert, and the event in the same transaction.**
  - Before the insert, read the registry row `for('share')`, as
    `lib/categories/write.ts:59-71` does. The foreign key's own lock does not
    block a retire, so without it a retired category could be filed.
  - Write the column only if the row exists and is active.
  - Write one `category_changed` with:
    - `createdAt: CHANGE_STAMP`;
    - `data: { from: null, to, key, label }`, with `label` from `labelEn`;
    - the actor: `actorAgentId`, or `actorLabel: 'form:<slug>'`.
  - Share one helper with `write.ts` for the registry read and the event's
    values, so the two writers cannot drift. A `tx`-taking function that
    `setConversationCategory` wraps is the cleanest, with one trap: its
    `ticket.categoryId === categoryId` check (`write.ts:55`) answers
    `unchanged` and writes no event. So either insert the row with a null
    category and let the shared writer update it in the same transaction
    (which sees its own row), or share only the registry read and the event
    values.
  - `write.ts`'s existing tests must pass unchanged
    (`reselect-policy.db.test.ts` "skips a retired category", "writes nothing
    when…", "refuses a category that is gone or retired").
- **No re-selection at creation.** `applySlaOnCreate` reads the whole row
  (`lib/sla/index.ts:96-114, 169-170`), and the `on_create` facts carry
  `category.id` (`lib/rules/facts.ts:51`). So a category-keyed policy is chosen
  at the first selection, with no `sla_recalculated`. Calling
  `reselectPolicyBeforeFirstResponse` here would either write a misleading
  event or waste a locked transaction.

**The pieces, by file.**

- **Schema.**
  - Add
    `defaultCategoryId: uuid('default_category_id').references(() => ticketCategories.id, { onDelete: 'restrict' })`
    beside `defaultGroupId` in `ticketForms` (`db/schema/config.ts:533-539`).
  - `restrict`, like `conversations.category_id`: nothing deletes a category,
    and `set null` would only ever fire on a hand-run delete, quietly clearing
    a form's default.
  - Extend the "What the form presets" comment: the default is recorded at
    creation as `form:<slug>` and never read back from the form.
  - Then `npm run db:generate`, which writes `0049`. It is a plain
    nullable-column add, so there is no rename prompt.
  - Production has no forms, so the foreign key validates zero rows.
  - Stage the new files before `repo-rules.mjs`.
- **`lib/portal/tickets.ts`, `NewTicket`.** Add
  `category?: { id: string; chosenBy: CategoryActor }`. The value and the actor
  are in one field, so the type rules out a column with no event. Priority's
  `priority` and `priorityChosenBy` are two separate fields, which allows
  exactly that. The docstring gives `openedBy`'s reason. In `createTicket`,
  write as above. A retired or missing category is dropped: null column, no
  event, and a `log.warn`, like the engine's skip at
  `lib/automations/index.ts:274-278`. The module has no `logger` yet; add one
  from `lib/log.ts`, since a bare `console` fails lint. A customer's ticket is
  never refused over an admin's retire, so `createTicket` never refuses at all.
  That also keeps `SubmitResult` as it is: its two `switch`es, in the console
  action (`:61-76`) and the help centre's (`forms/actions.ts:70-88`), have no
  default, and a new reason would need a case in each and a translated key in
  the second. No category means no event: `tickets.db.test.ts:155-159` pins
  the bare event list.
- **`lib/forms/queries.ts`.** Add `defaultCategoryId: string | null` to
  `FormRecord`. `load()` already spreads the whole row, so only the type
  changes.
- **`lib/forms/submit.ts`.** Compute the category beside priority, at
  `:267-296`.
  - The console's choice travels only on the agent variant of `Requester`, as
    a tri-state `categoryId?: string | null`:
    - `undefined`: the chooser was not offered;
    - `null`: the agent chose none;
    - a uuid: the agent chose that category.
  - The help centre's `session` and `anonymous` variants cannot carry one.
    Never read it from `input.values`, or a hand-made POST to a public form
    could file a category, which counts as owned from Stage 4.
  - Default: the agent's answer when offered, otherwise
    `form.defaultCategoryId`.
- **Admin forms.**
  - `app/(console)/admin/forms/page.tsx` adds `listCategories()` to its
    `Promise.all` and passes `toCategoryChoices(...)`.
  - `forms.tsx` gets an always-rendered
    `<Select name="defaultCategoryId">`, with "No category" plus
    `categoryOptions(categories, form?.defaultCategoryId ?? null)`, so a
    retired stored default reads "(retired)" and saving unchanged does not
    clear it.
  - `saveTicketForm` (`actions.ts:57-168`) reads it with `uuidField`, before
    the first query, so a malformed value is refused with a sentence. It
    refuses an unknown category, and a retired one unless it equals what the
    form already stores. Put that check in `lib/` (`lib/forms/` or
    `lib/categories/`) so a `*.db.test.ts` reaches it.
  - Do not copy the group default's `text(…) || null` (`:116`). A malformed
    value there raises 22P02 and the action throws with no state. Switching
    the group to `uuidField` too is a one-line fix of the same class, optional
    in this PR.
- **The console's new-ticket page.**
  - `page.tsx:25`: keep the agent `requirePermission('ticket.create')` returns.
    Only when `can(agent, 'ticket.set_category')`, read `listCategories()` and
    pass `toCategoryChoices(...)`, and the form's default category's label
    while it is active, for the hint below.
  - Put `key={slug}` on `<ConsoleTicketForm>`. Next keeps the page's client
    state across `?form=` links, since the router cache key ignores search
    params, so switching forms would carry a category the agent picked on the
    first form onto the second. Priority's seed has the same latent bug. This
    was read from Next 16.3.1's source (`layout-router.js:549`), not seen in a
    browser; check it in one.
  - `form.tsx` gets `<Select name="categoryId">`, which is never seeded with
    the form's default. It offers three kinds of value:
    - `''` first, labelled with the default ("Form default: Sales", or "No
      category" when the form has none);
    - an explicit `none`, "No category", offered only when the form has a
      default;
    - then `categoryOptions(categories, null)`.

    It imports only `@/lib/categories/choices`. Anything else reaches
    `db/client` and fails `client-bundle`.

  - The action (`actions.ts`) reads `categoryId`: `''` is untouched,
    `none` is none, anything else goes through `uuidField`. The name stays
    outside `system.*` and `custom.*`, and making it a `SYSTEM_KEYS` entry
    would trip `form-system-keys` and the visibility machinery. It refuses a
    value other than `''` from an agent without `ticket.set_category`, with
    `ticket-actions.ts:203`'s sentence. It re-reads the row: "Unknown
    category", or "That category has been retired — choose another", as
    `ticket-actions.ts:211-213`. Then it passes the result on the agent
    requester: `undefined` for untouched, `null` for none, or the id.
  - **Every refusal comes before `resolveContact` (`actions.ts:43-47`).**
    That inserts a contact and its identity for a new address before
    `submitForm` runs, so a refusal after it leaves a contact behind. Success
    redirects, so `action-revalidates` holds.
  - The form keeps `<form {...form}>` from `useActionForm`.
- **Retiring a category a form defaults to** is allowed, as for rules.
  - The forms editor shows it "(retired)".
  - Optionally, the collapsed row carries a warning `Badge` with words.
  - Creation skips it.
  - Update the comments on `setCategoryActive` and the `/admin/categories`
    description, "set by an agent or a rule", to name forms.
  - Listing forms beside Retire is left out: production has no forms.

**Decisions the map raised, with the default taken.**

- **An untouched chooser is the form's default, credited to the form.** The
  chooser posts `''` unless the agent changes it, and `submitForm` then takes
  `form.defaultCategoryId` as it reads the form at submit, recorded as
  `form:<slug>`.
  - **Why credit the form.** Stage 4.2's ground truth is only a
    `category_changed` with an agent, and an untouched default is not a
    person's judgement.
  - **Why the chooser is never seeded.** A chooser seeded with the default
    would post it back as the agent's choice. It would also post a stale one
    if an admin changed the default between render and submit.
  - **Priority is not a precedent here.** Its select is drawn only when the
    form places the `system.priority` question (`form.tsx:87-120, 198`), and
    otherwise its default is credited to the form. A chooser outside the
    element list is always posted.
  - A category the agent picks is credited to the agent.
  - "None" over a default writes no column and no event. An event with
    `to: null` would read "cleared the category" on a ticket that never had
    one. `opened_by_agent` still marks the ticket owned, as decision 4 says.
- **Decision 4 makes every console-opened ticket owned, so Jev never
  classifies one.** That is true whatever the chooser says, "None" included.
  Recorded here because it now has a visible consequence; the user may want to
  revisit it in Stage 4.
- **An `on_create` `set_category` rule overrides both the form's default and
  an agent's choice.** That is the documented "defaults, not overrides", the
  same as priority. Changing it for a person's choice is a product call, not
  made here.
- **A form's default group can differ from its category's route group.** The
  ticket stays in the form's group, because decision 5 never routes a
  `createTicket` ticket. The policy, a skill match at assignment and reports
  follow the category; the group does not. A warning on the forms page is
  optional.

**Tests.**

- **`lib/portal/tickets.db.test.ts`.** Extend "takes what a form presets"
  (`:162-189`):
  - the column is set;
  - one `category_changed` with `actorLabel 'form:<slug>'`, `actorAgentId`
    null, and `data { from: null, to, key, label }`;
  - an agent actor gives `actorAgentId`;
  - a retired category writes neither column nor event, and the ticket is
    still created;
  - the bare case keeps `[{ type: 'subcategorised' }]`.
- **New `lib/forms/submit.db.test.ts`.** None exists today. Cases:
  - help centre `session` and `anonymous` get the default as `form:<slug>`;
  - an agent's different choice is the agent's;
  - an untouched default is the form's;
  - an explicit `none` over a default writes nothing;
  - a `categoryId` posted to a help-centre submission is ignored;
  - a default added to a form after a ticket was filed leaves that ticket
    alone. Model it on `run.db.test.ts:530-556`.
- **`lib/sla/reselect-policy.db.test.ts`.** Beside "leaves an on_create rule's
  category to applySlaOnCreate" (`:388-420`):
  - a ticket created with Sales gets the Sales policy and no
    `sla_recalculated`;
  - an `on_create` `set_category` overrides it, with one event of its own.
- **`app/(console)/admin/actions.test.ts`.** Add the forms actions to its
  import list: a malformed `defaultCategoryId` is refused before any query
  (`expectNoQuery`).
- **A database test of the save check.** In `lib/`:
  - unknown refused;
  - retired-unchanged accepted;
  - newly retired refused;
  - new form with a retired id refused;
  - null clears.
- **`lib/categories/admin.db.test.ts`.** Retiring a category a form names
  leaves the form holding it. Deleting it raises 23503, which proves
  `restrict`.
- **`lib/assignment/index.db.test.ts`.** In a `matchSkills` group, a skill
  conditioned on `category.id`: a ticket created with that category is offered
  only to the skill's holders.
- **The console action's refusals** (malformed, unknown, retired, no
  `ticket.set_category`), from a `lib/` helper so a `*.db.test.ts` reaches
  them. One case asserts that a refused submission creates no `contacts` row.

**Docs in the same PR.**

- **`AGENTS.md`, "Ticket forms".** The category default is written by
  `createTicket` as `form:<slug>` in the creating transaction, and read at the
  time, never later.
- **`AGENTS.md`, "The ticket category".**
  - Name `createTicket` as the insert-time writer, which neither goes through
    `setConversationCategory` nor re-selects.
  - Say the New form's chooser is gated by `ticket.set_category`.
- **The handbook** (`lib/kb/handbook.ts`):
  - `inbox` `:165-166`, the New button;
  - `category` `:225`, a form among who sets it;
  - `category` `:228`;
  - `automation-and-forms` `:443-446` and `:450-456`.

  Each body must stay a fixed point of `normaliseArticleHtml(sanitiseArticleHtml())`
  and over 600 characters of text (`handbook.test.ts`).

- **Comments 3.2 makes untrue.** Each says every category writer re-selects,
  or that `setConversationCategory` is the only writer:
  - `reselectPolicyBeforeFirstResponse`'s docstring (`lib/sla/index.ts:623-629`).
    A category written at creation is a second exception beside `on_create`,
    read by `applySlaOnCreate`.
  - `db/schema/conversations.ts:126-129`, on `category_id`.
  - `lib/categories/write.ts:17-21`.
  - `lib/tickets/change-stamp.ts:6-9`. It assumes an update holding the row
    lock; say a creation-time event is stamped too. `createTicket`'s own
    `priority_changed` is not stamped, so either stamp it or name the
    exception.
  - `lib/categories/admin.ts:20-23, 150-156`. Name
    `ticket_forms.default_category_id` and what a form holding a retired
    default does.

**Deploying 3.2.**

1. Web first, because it migrates `0049`. This brief ACCESS EXCLUSIVE on
   `ticket_forms` is over a table of zero rows in production.
2. Then the worker and the four crons, on the same commit.
3. Nothing to seed.
4. If production holds a handbook by then, run `seed_console_handbook
dryRun=true` first, and expect only the articles this PR changed to differ.
   `overwrite=true` has no per-key filter.

**Rolling back 3.2.** Code only: the column stays, and the old code never
reads it.

#### 3.2, as built

Built on 2026-10-26 from the map above, against `dev` at `d05c131`. What it
holds beyond the map, and where it departs from it:

- **The shared halves.** `lib/categories/write.ts` exports `holdCategory`
  (the registry read, share-locked) and `categoryChangedEvent` (the event's
  values), and both `setConversationCategory` and `createTicket` call them.
  The map's second option was taken: the row is inserted with its category,
  rather than inserted bare and updated by the shared writer.
- **Category ids are canonical.** `holdCategory` lower-cases the id it is
  given and returns it, and both writers store that one. Found in review: an
  upper-case id from a hand-made POST was stored lower-case in the column,
  which is a `uuid`, and as typed in the event's `data.to`, which is jsonb, so
  the two disagreed, and from Stage 4 Jev's ownership rule reads one against
  the other. It also closes the same gap in 3.1's sidebar, which hands its
  value to `setConversationCategory` as typed. Not a uuid at all is
  `unknown_category`, with no query, so a malformed id can never make
  `createTicket` throw 22P02 instead of opening the ticket.
- **The refusals live in `lib/forms/category.ts`**:
  - `formDefaultCategoryRefusal`, for the forms editor;
  - `consoleCategoryChoice`, for the New form's action, which calls it before
    `resolveContact`.

  `NO_CATEGORY` (`'none'`) is in `lib/categories/choices.ts`, because the
  client form needs it too.

- **Two sentences differ from the map's.**
  - Without `ticket.set_category`, the action says "You cannot set a ticket's
    category": a ticket not yet opened has nothing to change.
  - The forms editor reads `defaultGroupId` with `uuidField` as well, the
    optional one-line fix the map named. A malformed group id is now "That
    group no longer exists", where it was a 22P02 out of the action.
- **The forms list marks a retired default** with a "Default category
  retired" badge, the optional one the map named.
- **`createTicket`'s `priority_changed` stays unstamped.** `change-stamp.ts`
  names it as the one exception, for the reason it is harmless: nothing else
  can have written a ticket's priority inside the transaction that creates it.
- **The log line** for a category left off is
  `[create_ticket] category left off a new ticket category=<id> reason=<retired_category|unknown_category>`.

- **The key is on the questions, not the whole form.** The map put
  `key={slug}` on `<ConsoleTicketForm>`. Review found that wipes the customer's
  email and name when the agent switches form, and those do not depend on the
  form. So the email, the name and the submit stay in `ConsoleTicketForm`, and
  `<FormQuestions key={slug}>` inside it holds the answers, the priority seed
  and the category chooser. A happy-dom test, `app/(console)/inbox/new/form.test.ts`,
  holds both halves.
- **AGENTS.md credits the priority default precisely.** It credits
  `form:<slug>` only where the form applies it: a console form that places the
  priority question seeds it, so an agent who leaves it alone is credited.
- **One reader, one set of sentences.** `checkCategory` sits beside
  `holdCategory` as the same read holding nothing, and `CATEGORY_REFUSALS`
  holds the two sentences. The sidebar, the New form and the forms editor all
  answer from them.
- **A refusal on the New form shows only under the form it refused.** The
  answer outlives a `?form=` switch, since only the questions remount.
- **The forms editor's check stays unlocked.** A retire landing between it and
  the save leaves the same rows as "save, then retire". A ticket's
  `category_changed` would date the category after the retire, which is why
  `createTicket` holds it.
- **Two races are left as they are**, the user's decision on #424's review,
  while production holds no forms:
  - an agent's pick retired between the action's check and `createTicket`
    opens the ticket with no category, which the agent sees on the ticket the
    redirect lands on. Refusing instead would roll the ticket back after
    `resolveContact` has already written a contact;
  - the chooser's "Form default" label can go stale while the page is open. An
    untouched chooser takes the default the form holds at submit, credited to
    the form. A hidden field with the rendered default, refused when it
    differs, is about twenty lines if forms come into use.

**Not verified in a browser:** that Next keeps the page's client state across
`?form=` links. The map read it from Next 16.3.1's source, and the test above
renders the component with new props as that implies, but there is still no
browser suite.

### Stage 4 — Jev sets the category

**4.0 — One follow-up for every routing writer.** Code only, no schema: web,
then the worker and the four crons, which carry the automation engine. Decided
on #419's review, before Jev becomes a writer.

- **Code.**
  - `afterRoutingChanged(id, { category, group })` in `lib/sla`. It runs
    `reselectPolicyBeforeFirstResponse` and then `onGroupChanged`, the order
    both callers use since 3.1, so a move that changes the policy is re-timed
    once.
  - Its only input is what the writers already return:
    - `setConversationCategory`'s outcome;
    - `moveToGroupIfElsewhere`'s boolean;
    - `assignConversation`'s `movedGroup`.
  - The console's group and category cases, and the engine's `finally`, each
    make one call to it. So do Jev (4.1) and the router (Stage 5).
  - The order then lives in one place.
- **Not a hook inside the writers.** The engine has to re-select once per pass,
  after every rule has run. Otherwise a rule that files a ticket and another
  that moves it choose two policies in turn. A hook in `setConversationCategory`
  or `moveToGroupIfElsewhere` would fire once per action.
- **Optionally, a repo rule.** It would refuse a `setConversationCategory` call
  whose result is dropped. The result is what tells the caller a follow-up is
  owed.
- **Tests.** The re-selection tests in `reselect-policy.db.test.ts` keep
  passing unchanged through the new entry point. One case covers a writer that
  changed both the category and the group, which still writes a single
  `sla_recalculated`.

#### 4.0, as built

Built on 2026-10-26 from `dev` at `d05c131`, independent of 3.2: `createTicket`
owes no follow-up, because the first selection reads its category.

- **`afterRoutingChanged(id, { category, group })`** in `lib/sla/index.ts`
  takes two booleans, which callers read off the writers' answers. Neither set
  is a no-op; otherwise it re-selects, named by the category when both moved,
  and then calls `onGroupChanged` when the group moved and the re-selection
  kept the policy. A re-selection that changed it has already timed the clocks
  on the new group's hours, so the second call would only reload the policies
  and take a second locked transaction to find nothing.
- **The callers.**
  - The console's group case calls it with `group: true`, once the move has
    committed.
  - The console's category case calls it with the outcome, `changed` or not.
  - The engine's `Pass` now carries `categoryChanged` and `groupMoved` where
    it carried `policyOwed`, and its `finally` makes the one call.
- **One behaviour moved, to no effect.** An `on_create` pass that moved a
  group used to call `onGroupChanged` on its own. It now calls nothing,
  because the ticket has no clocks yet: `recomputeOwedClocks` returns at once
  without a due date, and `applySlaOnCreate` runs after the pass.
- **The repo rule was built:** `routing-result`
  (`scripts/ci/rules/routing-result.mjs`), with a floor of four calls and a
  fixture test. Outside tests it refuses a call whose answer is a statement of
  its own or `void`ed, for three writers:
  - `setConversationCategory`;
  - `moveToGroupIfElsewhere`;
  - `assignConversation`, only when its options can name a group. Without a
    group it never moves the ticket.
- **Both halves are module-private.** `onGroupChanged` and
  `reselectPolicyBeforeFirstResponse` are called only by `afterRoutingChanged`,
  so Jev and the router cannot call one half; the re-selection's tests reach it
  the way every writer does. The comments that sent a category writer to
  `reselectPolicyBeforeFirstResponse` name `afterRoutingChanged` instead.
- **The engine notes a move before anything after it can fail.** `assign_group`
  notes it before writing its event. `auto_assign` hands `assignConversation`
  a `routed` carrier (`AssignOptions.routed`), which the move sets as it
  commits, and reads it in a `finally`. Read off the answer, a pick that failed
  on the database after the move took the follow-up with it, and the ticket sat
  in the new group on the old policy and hours until its routing next changed.
  A test makes the move's `group_changed` insert fail with a trigger and sees
  the clocks re-timed anyway; it fails against the engine that read the answer.
- **The rule has a module half.** A module that calls a writer also calls
  `afterRoutingChanged`, unless it exports a writer of its own and so hands the
  answer on (`lib/assignment`, `lib/categories/write.ts`). The call half alone
  passed a new caller that kept the answer and owed nothing for it. It also
  reads `o['writer']()` and a computed `['groupId']` key now, and takes a
  `routed` carrier as the answer.
- **Two review findings were answered without code.**
  - A pass that moves a ticket A→B→A, or files it X→Y→X, still re-selects.
    Comparing the pass's end with the ticket as the pass loaded it would race:
    an agent's move in between makes a real move read as none, and the skipped
    follow-up leaves the ticket on the other group's policy. Getting it right
    means each writer answering the value it replaced, for two rules that
    contradict each other in one pass; the re-selection they cost chooses from
    the ticket as it stands, before anybody has answered.
  - The rule does not look for a call dropped under `&&`, `?:` or a comma,
    because `npm run lint` already refuses each of those statements
    (`no-unused-expressions`, at `--max-warnings=0`). The header says so.
- **Tests.** The existing re-selection tests pass unchanged. Four new cases
  were each seen to fail under the mutation they pin:
  - nothing changed owes nothing, though a re-selection would choose another
    policy;
  - a category and a group changed together re-select named by the category.
    Both policies there run round the clock, so this pins the cause, not the
    order; the engine's older "re-times a rule's move" case pins the order;
  - a move the same policy survives is re-timed on the new group's hours, one
    `sla_recalculated` with `reason: 'group_hours'`. It is the only case that
    sees `afterRoutingChanged`'s call to `onGroupChanged`;
  - an engine pass that moves the group to one with a policy of its own, then
    files the category, writes one `sla_recalculated`. Chosen per action, it
    wrote two.

**4.1 — The classifier, shipped off.** Web first (it migrates the new tables),
then the worker and all four crons. With the switch at `off` nothing is
enqueued, so no job type is ever unknown.

- **Code.**
  - `lib/category-ai/` (request, decide, run, enqueue, settings, baseline).
  - `lib/tickets/classifiable.ts`, extracted from priority, with priority
    switched to it in the same PR and its tests unchanged.
  - The `classify_category {messageId}` job (strict payload).
  - A `classify_category:<messageId>` dedupe key, queue priority 30.
  - An entry in `purge-jobs`' `messageJobTypes`.
  - A `skip:` line in `scripts/ci/db-jobs.txt`, since the job needs the
    provider.
- **The backfill job, `backfill_category_ai`.** It has a strict payload with
  `dryRun`, a `run:` line in `db-jobs.txt`, and two modes:
  - **`record`.** It writes only `ai_category_runs`, under its own run label
    and fingerprint, simulating settling, over human tickets since
    2026-08-18. That lets labelled evaluation start now rather than after weeks
    of new traffic, following the `backfill_subcategorise_ai` precedent.
  - **`apply`.** It sets the column and its `category_changed` event (actor
    `jev:category`) on open tickets, and nothing else.
    - **It respects ownership.** Under the row lock, it applies the same test
      as the live classifier and skips owned tickets, reporting them as
      skipped. Supervisors will have hand-labelled some of them by then.
    - **It fires nothing.** It never calls `afterTicketUpdate`,
      `lib/routing/apply.ts` or an SLA hook, so it neither fires `on_update`
      rules nor moves the 207-ticket backlog.
    - **Its dry run shows what would follow.** It reports how many open tickets
      each `on_update` **and `time_based`** rule keyed on `category.id` would
      match. The time-based sweep re-evaluates every live ticket every 15
      minutes, so such a rule would act on the whole backlog within one run.
- **Runs table.** `ai_category_runs`, whose name is free after the gate. Its
  primary key meets the same fresh-database trap as Stage 3's
  (`ai_category_runs_pkey1`); see [2.B, as built](#2b-as-built).
  - The unique index is on (`run_label`, `message_id`), with the
    upsert-over-`failed` discipline applying within a label.
  - Settling and ownership read only the `live` label.
- **Settings and admin.** `category_ai_settings` is a one-row table holding the
  mode, the threshold (0–1) and the routing window (1–30 minutes), read through
  a 30-second memo. The "Categories" admin page gets:
  - a control for each, through one server action under `admin.categories`;
  - the key's presence;
  - per-category readiness: route group, strategy, members accepting now.
- **Wiring.** `afterMessageStored` enqueues the job in its own `try/catch`,
  beside priority's.
- **After commit.**
  - **Until Stage 5:** an applied answer calls `afterRoutingChanged` (4.0),
    then `afterTicketUpdate`, as priority's does.
  - **From Stage 5:** the four cases in decision 5's table, chosen by the
    ticket's routing row.
- **Tests.**
  - `decide.test.ts` covers every rule in decision 4 and every outcome in its
    list: the greeting, `unknown`, and shadow settling.
  - `run.db.test.ts` covers:
    - ownership;
    - settling by the earliest message, with jobs out of order;
    - `after_settle`;
    - the cap, including an out-of-hours acknowledgement followed by a second
      customer message that is still classified;
    - the requester-only skip;
    - the upsert within a run label;
    - a `record` backfill and a live run on the same message, which do not
      collide.
  - A request test asserts the priority request is byte-identical to before.
- **Docs.** `lib/typesafe/client.ts` and `lib/env.ts`, whose comments list
  every TypeSafe user and so get a fourth entry; `docs/PROJECT-STATE.md`,
  which corrects "priority ships off"; and `AGENTS.md`'s AI-provider section,
  which says what this one may touch.

#### 4.1, as built

Built on 2026-10-27 on top of 4.0 (#425 at `4a41a24`), because 4.1 is a writer
of the category and `afterRoutingChanged` is what it calls; it is rebased onto
`dev` once #425 merges. `0050_category_ai` was the newest migration while 4.1
was built, so had `dev` gained another first, 0050 would have been regenerated
rather than renumbered; applied in production on 2026-10-27, it is now as fixed
as any other.

- **What landed, by the spec's bullets.**
  - `lib/category-ai/`: `modes`, `settings`, `options`, `request`, `decide`,
    `baseline`, `run`, `enqueue`, `backfill`, and `runs` — the message
    selection, the call and the run row, shared by the live job and the
    backfill so their rows differ only in what each judged as of when.
  - `lib/tickets/classifiable.ts` holds `skipReason` and `isMachineMail`, moved
    from priority unchanged, reason strings word for word; priority's request is
    pinned byte for byte (`lib/priority-ai/request.test.ts`).
  - `classify_category {messageId}`: a strict payload taking a uuid, the dedupe
    key `classify_category:<id>`, queue priority 30, a place in `purge-jobs`'
    list and a `skip:` line in `db-jobs.txt`.
  - `ai_category_runs` and `category_ai_settings`, with guarded CHECKs in
    `db/sql/003`: one settings row, three modes, a threshold from 0 to 1, a
    window from 1 to 30 minutes, and a `failed` run carrying its error.
  - `/admin/categories`: the classifier's form (mode, threshold, routing
    window, whether the key is set), saved by `saveClassifierSettings` under
    `admin.categories`; and readiness in the table itself — strategy, "N of M
    accepting now", and a badge for a manual group or one with nobody active.
  - `afterMessageStored` enqueues in its own `try/catch`, after priority's.
- **Where it departs from the spec.**
  - **The unique index is (`message_id`, `run_label`)**, not the reverse: the
    same uniqueness, and the leading column serves the `set null` foreign key
    and every per-message lookup.
  - **The mode is text with a CHECK**, not an enum as deploy rule 5 had it.
    Priority's mode columns are text, and `ai_category_runs.mode` carries a
    fourth value, `record`, that the switch never takes. Rule 5 is amended.
  - **Only the message selection moved to `lib/tickets/`.** `stateFor` and
    `earlierMessages` already were the one shared copy, in
    `lib/subcategorise-ai/`; moving them would have moved two byte pins for
    nothing.
  - **The baseline is `detectSubcategories`** through an explicit map of all
    55 subcategories, held to the taxonomy by a test; `detectCategories` does
    not exist. Of the 23 whose audience is `any`, the 13 outside `service.*`,
    `other.*` and `meta.*` go to customer support. Two
    choices are for the support lead: `commercial.claim` to merchant support,
    since a claim is about a parcel an account sent, not a price; and
    `other.partnership_offer` to courier jobs, without which that category has
    no baseline at all. The baseline routes nothing; it is the report's
    comparison.
  - **The primary-key trap was already closed** by 0047, which frees
    `ai_category_runs_pkey`; `run.db.test.ts` asserts both tables' key names.
  - **The apply backfill asks nobody.** It files from a record label
    (`fromLabel=`) and refuses one whose fingerprint is not today's question,
    so it applies exactly what 4.2 evaluated, and its dry run calls nothing.
    4.2's step 5 is amended to record a fresh label first, from the archive's
    start, so it reaches the oldest open ticket: record mode has no status
    scope, and apply files only the open ones.
- **Decisions taken while building.**
  - An outcome known before asking — owned, after a settle, capped — is
    written without a call, so every message the job decides about has exactly
    one live row. A message on a ticket somebody has already answered never
    reaches the job: the enqueue side stops there, since most
    customer messages come after a first reply and each would only be recorded
    `capped`. Before the call, ownership is decided by the events alone
    (`ownedByEvent`): the column is read in a statement apart from them, and a
    Jev write committing in between would read as somebody else's, final and
    wrong. The look under the lock reads both halves together.
  - Settling depends on the mode: `apply` on `applied`, `shadow` on `applied`
    and `would_apply`, `record` on `would_apply`. Settled in shadow and then
    switched to apply, a ticket is asked again, since nothing was written:
    otherwise every ticket that settled in the shadow weeks would stay
    uncategorised for good.
  - An earlier message answered late takes the settle over, when the ticket is
    unowned: "earliest" means by arrival. Nothing runs one ticket's jobs one at
    a time, so it happens whenever a later message's job finishes first — a
    retry, or two messages of one burst whose calls come back out of order —
    and when the two answers differ the ticket has two `category_changed`
    events, each followed by its own re-selection and rule pass. When they
    agree, the earlier message's row records `applied`, nothing is written,
    and the one event names the later message.
  - The cap counts live rows with a prediction that are not `failed` —
    deleted messages included, through `is distinct from` — and
    `first_responded_at` is read under the lock.
  - A question that cannot be built (no active category, one keyed `unknown`,
    more than 254) is logged and skipped with no row: it is a configuration
    state, the same for every message.
  - A ticket deleted, marked spam, merged, resolved or closed — before the
    call or during it — is skipped with no row and no rule pass
    (`queueRefusal`, which apply mode asks too). Imported histories and merged
    tickets are skipped by this classifier only, so priority asks about exactly
    what it did.
  - **The switch and the threshold are read again under the lock** once Jev
    has answered: a classifier switched off during the call writes nothing and
    leaves no row, and one moved back to shadow, or to another threshold,
    decides by that. A category retired during the call fails the row in
    shadow as in apply, so the shadow never settles on an answer apply could
    not write.
  - **Record mode judges each message as of its arrival**: ownership from the
    events the live job would have read for it (`eventsKnownAt`), the settle
    and the cap from the label's own earlier rows. A message after the
    ticket's first reply gets no row, since the live job is never queued for
    one, so a record label covers the messages a live label would; and a
    column no event explains is owned from the first message, as the live job
    and apply mode read it. Those events are not simply the ones stamped by then:
    `createTicket` stamps its message before its transaction opens, so an
    agent's opening and a form's default carry later instants, and a rule runs
    once the message's ingest has committed. So an agent's opening and a
    form's default always count, a rule's write within five minutes of the
    message, and anything else within ten seconds. Judged as the ticket is now,
    every ticket a supervisor labelled later would read as owned, and 4.2's
    evaluation would lose exactly the tickets it is graded on. A failure stops
    that ticket for the run, and a re-run resumes it from the gap; a refused
    key (401 or 403) stops the whole run, since it is every ticket's refusal.
    A dry run counts the calls it would make up to the cap, so its figure is
    the most a real run would ask.
  - **Apply mode files** only open or pending live tickets with no category, no
    person's, rule's or form's event, no agent opening, and no Jev event: Jev's
    own live write is free by `categoryOwned`, and the backfill would otherwise
    put an older answer over it. Ownership is read through `ownedByEvent` and
    `writtenByJev`, the TypeScript the live job asks, not a SQL copy of it. Its
    event names the label and the message, so the live classifier reads the
    write as that message's settle. It fires nothing, and its report names
    every `on_update` and `time_based` rule whose answer filing would change,
    each way — counted only for the tickets it actually filed.
  - That one writer owes no follow-up, so it writes through a writer of its
    own, `fileBacklogCategory` in `lib/categories/write.ts`, which
    `routing-result` lets only `lib/category-ai/backfill.ts` call. Its answer
    is still kept. (Built first as a comment waiver at the call; #427's review
    pointed out that a comment any call site can carry is the exemption list
    `AGENTS.md` forbids.)
- **Found while building, fixed with a test.** A run replacing a `failed` row
  merged into it: an answer known before asking kept the failure's error, which
  the table refuses beside any other outcome, so a hand re-run threw; and kept
  the prediction a retired category had refused, which the cap would count.
  `insertRun` now replaces the row whole. The cap also counted `failed` rows
  and dropped deleted messages' rows, and the locked read did not look again at
  spam, deletion or a merge; each has its test, seen to fail without the fix.
- **Left, with the reason.**
  - A worker that dies between the commit and the follow-up leaves the
    category written and the follow-up unrun, and the redelivered job finds its
    row and stops — priority's gap too.
  - A dead job leaves no row, and is the one gap: 4.2's report counts
    `classify_category` jobs in `dead`, which are never cleaned up. Every other
    message without a live row was left by design — a skip (no words of the
    customer's, a passer-by's, machine mail, the bot channel, a ticket
    resolved or closed), the switch found off when the job ran or once Jev had
    answered (jobs still queued at a rollback among them), a
    question that could not be built, an unset key, or a message never queued
    (a ticket already answered, or the switch read as off through the enqueue
    side's memo). The one-row settings table keeps no history, so a report
    cannot ask when the switch was on, and should not try.
  - On Messenger, answered in Freshchat, nothing here sets
    `first_responded_at`, so only the five-message cap stops the classifier;
    on the coexistence number the phone's first reply does. Both are labelled
    like any channel, which is evaluation data; whether they route is Q10's.
  - `render.yaml` still lists `PRIORITY_AI` under "set nowhere today", though
    production has run it since 2026-10-13. Moving it needs a read of the
    production env group, which no tool in this session gives.
  - Ownership through a form's default is tested as a rule (`decide.test.ts`)
    and its event's shape by `lib/forms/submit.db.test.ts`, not end to end.

**4.2 — Shadow, then evaluate, then apply.** Operations, plus the report.

1. Run `backfill_category_ai mode=record` over the archive, then switch the
   live classifier to `shadow` for at least two weeks. Begun on 2026-10-29: the
   `archive-1` run, then Shadow since 06:00:32 UTC, which lasts until 2026-11-12
   at the earliest (4.2's first operation, in the status section).
2. **Ground truth is made, not assumed.** Nobody has ever reviewed a
   subcategory (1 confirmed, 0 rejected), so labels cannot be expected to
   appear on their own.
   - **Where labels come from.** A supervisor labels a sample through the
     Category select from 3.1, stratified by Jev's predicted class so the rare
     class is represented. Ground truth is **only** a `category_changed` event
     with an `actor_agent_id`. Never the column, which also holds rule and form
     writes, and on the merchant number those would inflate merchant precision.
   - **The report.** `/reports/category-ai` grades **one settling answer per
     ticket** against that label and against the rules baseline, per channel:
     - a confusion matrix;
     - coverage;
     - the share of `unknown`;
     - the share of tickets settled on their first message, which catches
       greetings settling a class.

     It counts only one run label and `request_fingerprint` at a time, chosen
     by the reader.
3. **Criteria to move to `apply`** (proposed):
   - 90% precision on `sales`, with sales recall reported beside it, on at
     least 30 labelled tickets.
   - The threshold set from the report.
   - **Merchant support routes from the start (Q5).** It is expected to stay
     below 30 labelled tickets for a long time: 2 of 126 in September. So the
     report shows its precision with the sample size beside it, and a supervisor
     reads every merchant-support route for the first two weeks of `apply`. If
     it proves wrong too often, emptying its route group stops it routing
     without stopping it labelling (see Risks).
4. Switch the classifier to `apply`.
5. **Back-classify the open backlog (Q12).** It files from a record label, so
   first run `backfill_category_ai mode=record runLabel=<new label>` with no
   `since=`: step 1's archive label predates the tickets opened since, and
   their live `would_apply` rows from the shadow weeks no longer settle under
   `apply` ([4.1, as built](#41-as-built)). Record mode has no status scope,
   so the label covers the whole archive from 2026-08-18 — the oldest open
   ticket included — and apply files only the open ones. A `since=` later
   than the oldest open ticket leaves the tickets before it out of both modes'
   counts, silently. Preconditions:
   - the classifier has been in `apply` for a week;
   - `backfill_category_ai mode=apply fromLabel=<that label> dryRun=true` has
     been read, including which rules it would wake.

   Then run it without `dryRun`.

#### 4.2's report, as built

Built on 2026-10-27, stacked on 4.1 (#427), since it reads `ai_category_runs`.
Code only: no migration, no `db/sql`, no job, no variable, so it deploys with
web alone. The operations in steps 1 and 3–5 are each a production write:
step 1 began at the user's go-ahead on 2026-10-29, and steps 3–5 wait for it in
turn.

- **What landed.**
  - `lib/category-ai/grade.ts` judges, purely, and its rules are
    `grade.test.ts`. `lib/category-ai/report.ts` reads, with
    `report.db.test.ts` against Postgres.
  - `/reports/category-ai`, behind `report.view` and linked from `/reports`,
    takes one run label, one `request_fingerprint` and one mode from a list of
    every such triple, newest first. For that run it shows:
    - right, settled, settled on the first message and unknown, per channel and
      in total;
    - precision and recall per category, Jev's and the rules' side by side;
    - the confusion matrix;
    - a threshold sweep;
    - what Jev filed and a person changed since;
    - the tickets to label.
  - The count of `classify_category` jobs in `dead` whose message is still
    there with no live row, 4.1's one gap, is a warning on the live label's
    views and when no run is chosen. A message given a row by hand since,
    answered or failed, leaves it, and so does one purged since, which a purge
    leaves the dead job of.
  - The handbook's reports article gains the screen and how to label for it,
    and the categories admin paragraph names it.
- **Where it departs from the spec, or adds to it.**
  - **The mode is part of the run.** The spec chose a label and a fingerprint.
    Under `live`, a ticket settled in shadow is asked again once `apply` is on,
    so the two modes' answers graded together would grade a shadow key against
    a ticket apply filed under another. A view that holds more than one
    threshold says so, and the sweep is exact only at or below the lowest.
  - **A label is a person's latest `category_changed` before anything else
    wrote the category**: not Jev, not a rule, not a form. A person who agrees
    with a write changes nothing and leaves no event, so every label after one
    is a disagreement. One given before a rule moved the category stays the
    label when the person sets it back, or changes it again. Graded, those labels would make
    every such answer wrong. They are counted apart, and Jev's own filings
    under "Filed by Jev": what it filed in answer to the run's messages, how
    many a person moved since, and to what. That is the figure step 3's
    merchant-support watch reads.
  - **So a ticket no label can reach is in no rate read off labels**: one
    something wrote first, and one deleted, spam, merged or carrying a
    category no event explains. Kept in the weights it would be stood for by
    tickets unlike it. In `apply` every settle is Jev's filing, so the
    labelled tickets are all ones Jev never settled, and recall read there
    was 0% by construction; spam, which Jev answers `unknown`, inflated every
    category's misses. Those rates describe the tickets a label could reach,
    the page says how many were left out, and a category none of whose
    settled tickets is labelled reads "Not measurable" rather than 0%: its
    stratum holds every hit, unread — in shadow, until somebody labels one;
    in apply, for good. So does every category while none of the tickets Jev
    never settled is labelled, which hold most of the misses: recall read
    high there, at 100% where no other stratum had a label either. Under
    `apply`, Filed by Jev is the grade.
  - **Rates that mix Jev's answers are weighted.** The labelling list draws
    the same number of tickets from each answer, so a rare answer's tickets
    are labelled at a far higher rate. Precision within one answer needs
    nothing. Recall, the overall rate, the rules' rates and the sweep's weigh
    each labelled ticket by its stratum's gradable tickets over its labels, so
    they estimate every ticket in the run a label could reach. The raw counts print beside every one of them, and
    the confusion matrix stays unweighted counts.
  - **The rules are graded on their own terms over the same labelled tickets.**
    Their answer is the first message the detector maps to a category, inside
    Jev's window, which is bounded as the sweep bounds Jev's. Five places, one
    for each message Jev answered or stopped asking about once settled
    (`after_settle`), none for a failure. A message Jev judged is always
    inside. An `owned` or `capped` row ends the window only when nothing after
    it was asked. Grading them on Jev's settling message instead would charge
    them with Jev's choice of message.
  - **Messages are judged in the live job's order**: by instant, then message
    id (`arrivedBefore`). WhatsApp stamps a burst to the second, and a row id
    would order such a pair at random.
  - **The sweep re-settles each ticket from its rows.** At or below the
    threshold the run used, the answer is exact: every message up to the settle
    was asked. Above it, a ticket whose settle falls below the bar moves on to
    messages Jev was never asked (`after_settle` with no answer), and those
    count as not known, not as unsettled. An `after_settle` row that holds an
    answer is read, and an `owned` or `capped` row out of job order is passed
    over. The cap of five is counted as the live job counts it, every answer
    the label holds in any mode and to any version of the question. A row
    whose job reached Jev — judged, failed, or answered before a settle landed
    — is never capped, since the live job counts in commit order and asked it
    inside its cap. That is what "the threshold set from the report"
    reads.
  - **The sample is chosen by Jev's answer and shown without it.** Strata are
    Jev's settling category, plus "never settled" so recall has misses. Each
    stratum's first ten go into one list in id order, a fixed random order for
    a v4 uuid, with only the ticket number and channel. A supervisor told "Jev
    said sales" before opening a ticket is being asked to agree, and the label
    would be Jev's answer read back. The page shows each stratum's labels
    against the 30 that step 3 wants. It does not show how many wait in each:
    beside one list, a stratum that alone has tickets waiting names every one.
  - **Only tickets with no category now are offered**, besides nobody having
    labelled them and nothing having written. Choosing the category a ticket
    already has writes nothing, so on a ticket a rule filed, agreeing leaves
    no label. A ticket is offered only once the live job can no longer ask
    about it — answered, resolved or closed, or asked five times under the
    live label (`jevMayStillAsk`, which the live job's own refusals make up)
    — whatever the view settled it on. Labelled earlier, its next live message
    would be owned. A ticket a shadow or record view settled can still be
    unsettled in the live run, where it would become a miss Jev never had the
    chance to avoid.
  - **A message judged after the first reply is out of Jev's window.** The
    live job asks whether a ticket settled before whether it was answered, so
    a message queued before the reply and judged after it is recorded
    `after_settle`, where without the settle it would be `capped`. The sweep
    and the rules' window read it as closed, not unasked. The live job judges
    when its job runs; a backfill as of the message's arrival.
  - **A filing is matched by the message it answered, or by its instant** once
    the message is deleted and the row loses its id. A failure that kept its
    prediction is no answer in any figure. Two deleted messages of one instant
    keep the order their rows are read in, by row id.
  - **The categories drawn are the active ones**, and any retired one the
    run's answers or labels name. A link to a run past the list's 200 is
    looked up on its own.
  - **Deploying it.** Code only, to all six services: besides the page, #429
    fixes code the worker runs — the live job's and the backfill's locked
    ticket reads, which `dbf4376` still makes through a join that loses the
    ticket when its status changes under the lock, and `classifierTicket`,
    which kept a refused read. So the classifier stays off until #429 is in
    `main` with the worker deployed: shadow, and the backfill's `apply`, wait
    for it as well as for the go-ahead. The handbook's reports article
    changed too, and production held no console handbook at 2026-10-27
    12:50 UTC (no `handbook-` folder or article, no `seed_console_handbook`
    job ever), so there is nothing to seed: the first seed, whenever somebody
    runs it, writes these words. If it has been seeded since, run
    `seed_console_handbook dryRun=true` once web is live, read the articles it
    reports, then `overwrite=true`, which has no per-key filter.
- **Found while building.**
  - **A ticket that fits no category cannot be labelled so.** Choosing None
    on a ticket with no category writes nothing (`setConversationCategory`
    answers `unchanged`). So a greeting Jev settled as sales stays unlabelled,
    and that false positive never reaches precision. Choosing a category and
    then None would record it, but each choice is a real change, which runs the
    category's rules and, before a first reply, re-chooses the SLA policy. The
    page and the handbook tell a supervisor to leave such a ticket unlabelled.
    Recording "none fits" needs a writer of its own, for example a review
    event, so it is the support lead's call (Still open).
  - **Labelling an open ticket is a real change**, with the same rules and
    SLA effects, so the page and the handbook say so. The archive's resolved
    tickets carry the fewest effects. Nothing restricts the sample to them,
    since a shadow week's open tickets are the live distribution.
  - **An adversarial review** found the tie order, the unweighted mixing of
    strata, the modes mixed under `live`, the rules' longer window after a
    settle, labels after a rule's write, open windows in the sample, the
    stratum counts naming the answer, the sweep's overcount of not known, and
    filings counted across questions. Each is fixed with a test, seen to fail
    without it.
- **Left, with the reason.**
  - A label from an agent since deleted has lost its `actor_agent_id`, so it
    reads as nobody's. The spec makes the agent id the ground truth, and agents
    are deactivated rather than deleted.
  - A ticket whose messages were asked under two questions is graded under
    each with that question's rows alone, so "settled on the first message"
    means the first asked under that question.
  - Weights treat labels given in ordinary work like the sample's: within a
    stratum they are the evidence there is.
  - Category names are today's labels, on an older question's view too.
  - No slice by `requester_kind` or `has_shipment` is drawn. Both columns
    are on every row, for a later cut.

### Stage 5 — routing by category

**5.1 — The router.** Web first (it migrates), then the worker, then all four
crons. `shipblu-sla-sweep` must run 5.1 before any channel leaves
`default_group`, or its old `assign_sweep` assigns held tickets. Nothing
enqueues `settle_routing` until an admin changes a channel's mode.

- **Schema.**
  - `channels.routing_mode`, an enum `not null default 'default_group'`.
  - `conversations.routing_window_ends_at` and `routing_decided_at`, both added
    to `queue_relevant` in `db/sql/001`.
  - The `routing_decisions` table (decision 5).

  No backfill is needed. Routing state is only ever written for tickets created
  after a channel enters a category mode, so the existing backlog is untouched
  by construction.

- **`lib/routing/`.**
  - `mode.ts` (`routingModeOf`, with the coexistence rule), `hold.ts` and
    `decide.ts` are pure.
  - `start.ts` (`startRouting`) is called by each ingest path inside its insert
    transaction: email, WhatsApp, Meta DM and comment, and the widget, which
    ingests on the web service.
  - `begin.ts` (`beginRouting`) is the creation-pass step, placed after the
    `on_create` rules. Its docstring explains why there.
  - `apply.ts` holds the row lock and runs the two-phase decision.
  - `end-hold.ts` is the stamp helper.
- **The hold.**
  - `lib/assignment/index.ts` gains `awaiting_route`, kept out of
    `WORTH_RECORDING`, plus the group re-read under the group lock.
  - `lib/auto-response/index.ts` skips while held, and gains the status and
    answered-since guards.
- **Stamps.** `endHold` is called from:
  - the console's group, assignee and reply paths (`manual`), in the same
    transaction as their write;
  - the automation engine's `assign_group`, grouped `auto_assign` and
    `assign_agent` (`rule`), only when the action changes something, compared
    against the locked row, and before it assigns.
- **The console.**
  - The category case calls `apply.ts` on a held ticket.
  - The sidebar's **"Hand to <group>"** action moves the group, clears the
    assignee and assigns in the new group in one server action, gated by
    `ticket.assign`. It is offered after a category edit on a ticket that is
    no longer held, and its result is recorded as `group_changed` plus
    `unassigned` plus `assigned`.
- **The fallback job.** `settle_routing {conversationId}`:
  - a strict payload, queue priority 40, enqueued at `routing_window_ends_at`;
  - conversation-scoped in `purge-jobs`;
  - `subjectGone` on a missing ticket;
  - a `skip:` line in `db-jobs.txt`.

  It also completes an interrupted two-phase decision.

- **The onboarding job.** `complete_coexistence_onboarding` resets
  `routing_mode` to `default_group` when it adopts an existing row.
- **Timeline.** `event-labels.ts` gives `routed` a sentence for every outcome
  in decision 5.
- **Admin.**
  - The channel editor gets a routing-mode control with an `InfoTip`. Every one
    of the three forms that post to `saveChannel` carries it, and an absent
    field means "unchanged" (the trap `forms.tsx:431-433` already guards).
  - `saveChannel` refuses a category mode on a coexistence row, and warns when
    the classifier is not in `apply`, since the mode would then hold nothing.
  - A readiness panel shows, per category, the classifier mode, the route
    group, its strategy, members accepting now and hours, and warns on
    anything that would leave routed tickets unassigned.
- **Tests.**
  - **`decide.test.ts`** covers every outcome and its precedence, and these
    cases:
    - shadow ignoring machine assignments;
    - a coexistence row whose column says `category`.
  - **`apply.db.test.ts`:**
    - **The race into the creation pass.** The hold is in place from the
      insert. The priority classifier's `afterTicketUpdate`, an `on_create`
      group-less `auto_assign`, and an early category answer each land before
      `beginRouting` and assign nobody.
    - **A rule gets the first word.** `beginRouting` routes on an early
      category, and an `on_create` `set_category` routes immediately.
    - **The two-phase order.** An `on_update` rule moves a routed ticket and
      the assignee comes from the final group, as does the out-of-hours
      reply's calendar. A `no_route_for_category` decision still runs
      category-keyed rules before assignment. A concurrent `assignConversation`
      between phases 1 and 3 assigns nobody.
    - **What ends a hold early.** A no-op `assign_group` during the hold
      leaves it in place. An `assign_agent` during the hold ends it as `rule`,
      and a later settle records nothing new. A person's category edit during
      the hold routes now.
    - **Hand to <group>.** After the hold it lands the ticket with a member of
      the target group.
    - **The held reply.** It is sent once for every way a hold ends, and not
      at all after an agent replied during the hold out of hours.
    - **SLA.** Re-selection carries pause credit.
    - **Recovery.** An interrupted decision is completed by `settle_routing`.
  - **An assignment `*.db.test.ts`:**
    - `awaiting_route` covering the sweep;
    - `settle_routing` interleaved with `assign_sweep` at the window's end;
    - the grace lapsing on a stuck job, followed by a settle that records
      `taken`.
- **Docs.**
  - The README's "The routing rules are the automation rules" is amended, with
    the reasons at the top of this file.
  - `AGENTS.md` gets a "Routing by category" section with decision 5's rules.
  - The handbook gets an article on routing, the hold, the "Routing…" badge
    and "Hand to <group>".

#### 5.1, as built

Built on 2026-10-27 and 2026-10-28 on `claude/jolly-noether-hxhez1-stage-5-1`,
off `dev` at `c6eb1ac`. `0051_routing` was the newest migration while 5.1 was
built, and was regenerated rather than renumbered when `dev` moved; applied in
production on 2026-10-29, it is now as fixed as any other.

- **What landed, by the spec's bullets.**
  - **Schema.** `0051_routing` creates the `routing_mode`, `routing_stage` and
    `routing_outcome` types — new types, so deploy rule 5 does not apply — and
    adds `channels.routing_mode` (`not null default 'default_group'`), the two
    columns on `conversations` and `routing_decisions`, unique per ticket, whose
    `held_strategy` and `held_actor_label` keep a rule's pick for the hold's end
    (fixed after the adversarial review, #1), and whose `rules_claimed_at` and
    `rules_done_at` hold phase two to one run (fixed after the PR review) — one
    for each write it is owed for, since the second adversarial review of the
    fixes, as a write in the gap clears the claim to re-arm it; since the third,
    the re-arm keeps a claim still running as its instant in `rules_done_at`,
    with no column added (below). 0051 was regenerated for the second, being
    deployed nowhere. `db/sql/001` adds both columns to `queue_relevant`.
    `db/sql/003` adds `routing_decisions_decided_complete`: a decided row
    carries its outcome and `decided_at`, the two things the routing report
    counts, so a hand-run repair or a later writer cannot leave the report
    silently short.
  - **`lib/routing/`.** `mode.ts`, `hold.ts` and `decide.ts` are pure, as is
    `mode-copy.ts`: the labels, and the one sentence each for a row that never
    routes and a mode the classifier leaves idle, which the forms, the action
    and the panel share. `start.ts` (`planRouting`, `routingWindowValues`,
    `startRouting`), `begin.ts`, `apply.ts` (`routeNow`, `settleRouting`),
    `end-hold.ts`, `after-hold.ts` (`afterHoldEnded`), `held-assignment.ts`
    (`recordHeldAssignment`, `heldFollowUp`), `state.ts` (`undecidedRouting`,
    `deferToRouter`, `clockInputsIfInFlight`, `routerDecidedOn`), `hand-to.ts`
    and `readiness.ts`.
  - **Wired.** Email, WhatsApp, Meta direct messages and comments, and the
    widget; the creation pass; assignment (`awaiting_route` and `moved`, neither
    recorded, `endsHoldAs`, and a rule's strategy kept for the hold's end); the
    out-of-hours reply; the engine's three stamps, and `afterHoldEnded` after a
    pass whose rule ended a hold; the sweep's escalation; the classifier's four
    cases; the agent reply; the console's assignee, group and category cases;
    `deferToRouter` in every console edit, Hand to, Jev's answer and the
    priority classifier; the onboarding job's reset; and
    `backfill_category_ai`'s `apply`, which leaves a ticket the router is still
    holding (`held for routing`), since `settle_routing` would route on the
    filing.
  - **`settle_routing {conversationId}`.** A strict payload, priority 40, the
    key `settle_routing:<id>`, a handler that ends on `subjectGone`, a place
    beside `send_csat` in `purge-jobs` and a `skip:` line in `db-jobs.txt`.
  - **Console.** The inbox row and the ticket header carry "Routing until
    15:05" while the window is ahead and "Routing…" after; the sidebar says
    under Assignee, Group and Category what changing each does to a held
    ticket; `routed` has a sentence for each of the eight outcomes; and "Hand
    to <group>" sits under the Category field.
  - **Admin.** Every form that posts to `saveChannel` carries a Routing select
    with an `InfoTip`, disabled with the reason on a coexistence number and the
    bot. `saveChannel` reads an absent field as unchanged (`formData.get`,
    which tells absent from empty), refuses a category mode on those rows, and
    saves one while the classifier is not in `apply` with a notice that it
    holds nothing. The readiness panel is on `/admin/channels`.
  - **Handbook.** A `routing` article in the tickets folder — the badge, the
    sidebar's hints, what ends a hold, the timeline line, "Hand to <group>" —
    and the Group field, channel and category passages amended.
  - **Tests.** Pure: `decide.test.ts` (every outcome, the precedence between
    each pair, shadow ignoring machine assignments), `mode.test.ts` (the lists
    held to the enums, a coexistence row whose column says `category`, the
    bot), `hold.test.ts` (the grace to the millisecond) and `hand-to.test.ts`,
    with new badge and `routed` sentence cases.
    Against Postgres, each case in the spec's list and more:
    - `begin.db.test.ts`: the insert, `planRouting`, the race into the
      creation pass, a rule's first word, the creation pass and the SLA, and
      shadow at creation;
    - `apply.db.test.ts`: `routeNow`, the two-phase order, what ends a hold
      early, the held reply once for every way a hold ends and never after an
      agent answered, a rule's kept pick against a move after phase one by
      anybody, and a rule finding the ticket where another writer's move had
      put it;
    - `settle.db.test.ts`: the window's end, an interrupted decision, its own
      failed phase three retried, a ticket no longer workable by the resume,
      the route's policy with its pause credit, and shadow;
    - `locks.db.test.ts`: an agent's reply and the engine's `assign_group`
      raced against a customer's message on a never-routed and a held ticket,
      and a message inserted while each routing lock is held;
    - `ingest-routing.db.test.ts`: every ingest path, what starts nothing, and
      a duplicate delivery processed at once;
    - `routing-hold.db.test.ts` (the engine, a rule's held strategy among it),
      `hand-to.db.test.ts`, `readiness.db.test.ts` and
      `db/sql/routing-decision-check.db.test.ts`;
    - `app/(console)/ticket-actions-gap.db.test.ts`: the console's priority,
      tags, custom-field and status edits landing between the router's phase
      one and phase three, every console edit landing there on a ticket nobody
      may work, the clocks a deferred edit moves before the router's pass
      reads them, and an edit whose clocks' policies and hours cannot be read,
      deferred or not;
    - new cases in the assignment, sweep, out-of-hours, agent reply,
      classifier, backfill, `saveChannel` and onboarding tests, among them
      `awaiting_route` covering the sweep, the settle and the sweep at the
      window's end, and the grace lapsing on a stuck job before a settle that
      records `taken`.
- **Decisions taken while building.**
  1. **`beginRouting` runs after `applySlaOnCreate`**, not straight after the
     `on_create` rules as decision 5 had it. That order left a ticket an
     `on_create` rule had filed with no SLA policy at all when the route moved
     nothing (`no_route_for_category`), and gave a moved one its first policy
     through an `sla_recalculated` describing a change nothing made. "After
     the rules" still holds, so a rule keeps the first word.
  2. **Routing starts only while the classifier is in `apply`, live and shadow
     alike** (`routingStartFor`). Off or in shadow it files nothing: a live
     hold would wait out every window for nothing, and a shadow record would
     read `fallback` for every ticket, measuring the classifier's absence
     rather than the route.
  3. **Some tickets never start**: one assigned in its insert, which is an
     owned plain WhatsApp number's, whose owner is outside the rota; spam,
     meaning an email bounce or out-of-office; a WhatsApp number no row names,
     which has no mode for the router to re-read; and the bot and coexistence
     rows (`routingModeOf`). The first two would only ever be recorded `taken`
     or `not_open`. A deactivated owner counts as nobody, so that number's
     tickets route like a team number's.
  4. **The held reply answers the message that opened the ticket**
     (`routing_decisions.message_id`), the one the creation pass would have
     answered, and not the newest inbound row.
  5. **The rules run whenever the ticket carries a category**, whatever the
     outcome but `not_open` — not only after a decision that "settled a
     category or moved the group". A ticket `released` or found `taken` after
     Jev filed it still owes the `on_update` pass Jev gave up for the router.
     A ticket with no category has nothing for the rules to react to, and its
     hold ends in phase one.
  6. **The answered guard is scoped to the closed stretch**: the agent's last
     reply at or after the customer's last message, _or_ an agent's reply out
     of hours with nothing opened since. With the first half alone, an agent's
     23:02 reply that ended a hold claims nothing, and the customer's 23:05
     message is told "we are closed". It applies to every ticket.
  7. **`assignConversation` locks the ticket, then the group** — the order the
     router, `endHold`, the console and Hand to take — and re-reads the
     assignee, the group and the hold under it, and since the PR review
     whether the ticket is still work. A re-read under the group's lock alone
     could not see a move out of the group. It also checks its
     guarded update's result: before, a write that matched nothing still moved
     the cursor and wrote `assigned` (`docs/PROJECT-STATE.md` §6.105). Every
     one of those ticket locks is `FOR NO KEY UPDATE`, never `FOR UPDATE`
     (fixed after the adversarial review, #0/#4).
  8. **A grouped `auto_assign` ends the hold inside `assignConversation`'s move
     transaction** (`endsHoldAs`), so the move and the stamp commit together:
     stamped first, the sweep could assign in the group being left; stamped
     after, a crash between would leave the ticket in the rule's group still
     held, for the router to move away from the rule. `group_changed` was
     left outside that transaction, as 4.0 placed it, so a failed event insert
     could not take the follow-up with it; since the PR review it is written
     inside, ahead of the stamp, in a savepoint that is rolled back to and
     logged when the insert is refused, so the move, the hold's end and the
     assignment they owe all stand
     (`lib/automations/routing-events.db.test.ts`), and the timeline reads the
     move before the `routed` line. The clocks follow a move that committed
     even when the pick after it throws (`lib/sla/reselect-policy.db.test.ts`).
  9. **The sweep's escalation skips held tickets.** Unassigned by design, in a
     group it may be leaving, a held ticket would make that group's lead a
     watcher on another team's work.
  10. **A `routed` event for every live decision, and one when `endHold`
      writes `manual` or `rule`**, so a hold a person or a rule ended says so
      on the page too.
  11. **Shadow records when a category settles** — `beginRouting`, the
      classifier while the row is `holding`, a person — or at `settle_routing`.
      A `pending` shadow row waits for `beginRouting`, so a rule gets the first
      word in shadow too.
  12. **A person's category edit routes a held ticket only when it sets a
      category.** Clearing one settles nothing, and the window runs on. Since
      the PR review it routes only a `holding` ticket: on a `pending` one
      `beginRouting` routes on it after the `on_create` rules.
  13. **`settle_routing` meeting a phase one younger than a minute enqueues
      itself again without a key**, at phase one plus 61 s. The first key is
      spent for good, and this is the same work legitimately asked for again.
      Since the PR review it does the same, at the claim plus
      `RULES_RUNNING_MS` and 1 s, on a claim on phase two too young to be
      abandoned, and at now plus the same on losing its own claim.
  14. **`not_open` includes merged.**
  15. **A write in the gap between phase one and phase three hands its
      `on_update` pass to the router** (`deferToRouter`): every console ticket
      edit — the category, the group, the assignee, the priority, the tags, a
      custom field, and a status that leaves the ticket open or pending — Hand
      to, Jev's category answer and the priority classifier's applied answer.
      Run beside the router's, a writer's pass was unordered with the hold's
      end, and a rule in it moved the ticket away from somebody the router had
      just assigned. Two kinds of write keep their own pass. One that leaves the
      ticket where nobody may work it, a resolve or a close among them: the
      router gives its pass up on such a ticket, so that write's rules would
      never run, and nothing races its pass, since the router assigns nobody
      that ticket. And a customer's message, on any of the five paths that
      continue a ticket: it is no decision about where the ticket goes, its pass
      races the rota as it does on every ticket once anybody holds one, and
      deferring it would reach into the transaction each path stores its message
      in. A rule never defers: re-arming the pass it runs in would run that pass
      again, to the cap.
  16. **The re-arm keeps a claim still running as its instant in
      `rules_done_at`**, with no column added: a done mark with no claim is a
      state nothing else writes, so the pair says it already, and only
      `apply.ts` and `state.ts` read the pair. Clearing a claim does not stop
      its claimant, and a resume reading the cleared claim as none ran a second
      pass beside a slow one, which ended the hold and assigned before the first
      pass's last rules moved the ticket on. A done claim's mark is cleared with
      it — its claimant has only phase three left, which ends nothing once the
      claim is gone — where a plain `coalesce` would keep that instant too and
      leave the window's job waiting ten minutes for nobody.
  17. **Every move of a held ticket's group drops a rule's kept pick, whoever
      makes it** — phase one its own, and `endHold`'s `movedGroup` a person's,
      Hand to's or a rule's, in the router's pass or another, which ends
      nothing after phase one but still drops the pick. A pick is about the
      group its rule matched the ticket in, and the override does not carry to
      the one the ticket is moved to. Dropped by a person's move alone, a rule's
      move landing after the pick was kept had it made in the new group under
      the old group's rule, and the same move landing before assigned nobody
      (`recordHeldAssignment` answers `moved`). One mechanism in `endHold`,
      which every writer of a ticket's group calls, rather than a second in
      `deferToRouter`, which a rule never asks. Only until the router ends the
      hold: a move after that meets a decided row and drops nothing (Left).
- **Where else it departs from decision 5's text.**
  - **A shadow row is `released` only by `default_group`.** A channel moved
    on from `category_shadow` to `category` still wants the shadow ticket's
    would-be answer.
  - **`endHold(tx, id, outcome, actor, now)` answers whether it ended a live
    hold**, which is what owes `afterHoldEnded`. Once phase one has written
    the router's decision a rule ends nothing — its move is part of the pass
    the router waits for, and ending the hold there would let the next rule's
    group-less `auto_assign` hand the ticket out before a later rule moved it
    — and neither does a person: the decision is the router's to finish
    (after the PR review, below).
  - **The classifier's `holding` case checks who decided when the router
    answers anything but `decided`** (`routerDecidedOn`, shared with the
    console's edit): after a person, a rule or a `not_open` the relabel is still
    owed; after the router, or with the row still undecided, the router's pass
    reads the write, and a relabel would fire every category rule twice. A
    write that finds a decision in flight, its phase one written, asks nothing:
    it re-arms the router's pass in its own transaction (`deferToRouter`), since
    the second adversarial review of the fixes.
  - **`saveChannel` decides a WhatsApp row's mode inside its UPDATE**, a
    `case` on the coexistence object, and `complete_coexistence_onboarding`
    resets the column in the statement that takes the row's lock. Either alone
    loses to the other's order: a form opened before an adoption would put
    back the mode the job had just cleared.
  - **The readiness panel is on `/admin/channels`**, beside the control it
    informs, not on `/admin/categories`, which keeps its route-group badges.
    Besides the spec's facts it names the channel rows whose mode does nothing
    — a second row of a type tickets are not filed under, an inactive one, an
    owned number — and the active rules that would end a hold on the channel,
    read through the engine's own condition evaluator. Production's two
    `on_create` web chat rules (read 10:06 UTC on 2026-10-28: `assign_group`
    to Merchant Care for a requester with an email and to Customer Care for
    one without, both `channel eq webchat`) move every new web chat ticket
    out of Support, so on that row every hold ends as `rule` and the router
    decides nothing. That is by design: rules decide.
- **"Hand to <group>" and the badge.**
  - **Offered by state, not by "a category edit just happened"**: to an agent
    holding `ticket.assign`, on open or pending work, not held, whose
    category's route group is somewhere else — an agent who went to ask
    somebody is still owed the button. Not on a number whose active owner
    answers for the ticket, since the rota would hand the cleared ticket
    straight back to them (the Group field still moves it; a deactivated
    owner counts as nobody), nor on a coexistence number. A retired category
    still routes, as `decide` routes on one.
  - **The page and the write ask one pure function.** `handToTarget` decides
    on what the page already loaded, and `handToRouteGroup` asks it again of
    the row it has locked. The form's `groupId` is only a staleness check:
    a category changed since the page loaded is refused as `changed`, never
    followed to a group the agent never saw named.
  - **One transaction, the ticket's row first**: the move, `group_changed`
    `{to, from}`, the assignee cleared with `unassigned` `{to: null, from}`
    when somebody held it, both stamped `CHANGE_STAMP`, and `endHold` as
    `manual`, which only matters on a ticket whose grace ran out. After it:
    `afterRoutingChanged`, then the `on_update` pass — every console edit owes
    one, and run before assignment a rule moving the ticket on does not leave
    the new group's agent holding it — then `assignConversation`, which writes
    `assigned`, then `afterHoldEnded` if a live hold ended. The spec's three
    events are there whenever each applies — `unassigned` only when somebody
    held the ticket, `assigned` only when somebody in the group could take it
    — and the pass between is this build's. On a decision in flight the
    transaction also re-arms the router's pass (`deferToRouter`), dropping a
    rule's pick kept for the group it moved the ticket out of, and none of what
    follows it runs: the router's pass, end of the hold and assignment do it
    instead, and the answer is `awaiting_route` (below).
  - **Nobody to assign is still a success**, with a sentence saying the ticket
    waits in the group's queue — only when the rota answered that nobody there
    could take it (`waitsIn`), and naming the group an `on_update` rule moved
    it on to. A ticket a rule resolved, or somebody moved meanwhile, gets no
    sentence, and the redrawn page shows where it went. Two clicks only when
    the hand-over would unassign a colleague, and the button posts the
    assignee the page was drawn with, which the action compares under the
    lock (`reassigned`), so a stale page cannot unassign somebody in one
    click. Refusals re-read the page, since most mean it is stale.
  - **The badge is the `automated` tone, never coral**, reads "Routing until
    HH:MM" in Cairo time while the window is ahead and "Routing…" after, and
    is drawn from the columns alone until the browser has a clock, so the
    server and the first client render agree. `InboxRow` gains
    `routingUntil`, so no reader can pair a window with a decision it did not
    read, and `isSpam`. Badge and hints are drawn only on work — open or
    pending, not spam, not merged — because no status, spam or merge writer
    ends a hold, and a resolved ticket's window stays on its row until
    `settle_routing` records `not_open`.
- **Found while building.**
  - **Fixed: auto-assignment recorded an assignment it had not made**
    (decision 7, `docs/PROJECT-STATE.md` §6.105). In production until
    `1470902` on 2026-10-29.
  - **Fixed before it shipped: "Unassigned" ended a hold.** The console's
    assignee case called `endHold` for an empty choice too. On a held ticket
    that is a no-op write that ended the hold, and `afterHoldEnded` then
    assigned the ticket in its default group — the outcome the hold exists to
    prevent. It now ends one only by naming somebody, as `assign_agent` does.
- **Fixed after the review of the build.**
  - **The console's group and assignee cases now run the `on_update` pass
    before anything is assigned or the held reply goes.** A group move used to
    call `assignConversation` and then `afterTicketUpdate`, so a rule that
    moved the ticket on left the first group's agent holding it — older than
    Stage 5, and the order the two-phase argument warns against. The explicit
    assignment is gone (the pass's own `autoAssign` assigns after the rules),
    and a hold either case ended is followed by `afterHoldEnded` only after
    the pass, so the reply is told the hours of the group the rules left. This
    changes every console group move, held or not.
  - **`endHold`'s `routed` event is stamped `CHANGE_STAMP`**, so it sorts after
    the write that ended the hold in the same transaction.
  - **An agent's reply does not count as a shadow decision**
    (`decidesShadow: false`). On a shadow channel the rota assigns on arrival,
    which a live hold would have prevented, so that agent answering is no
    `manual` decision the live mode would have seen. A move or an assignment
    by a person still counts.
- **Fixed after the adversarial review** (2026-10-28; numbered as the review
  numbered its findings, and each behaviour fix with a test that fails without
  it).
  - **#0/#4, high: `endHold`'s lock deadlocked against every customer
    message**, on any ticket, routed or not. It ran `FOR UPDATE` after its
    caller's write, which upgrades past the KEY SHARE a message inserted for
    the ticket holds, and every ingest path updates the ticket after inserting
    its message: an agent's reply stored and never sent, or a customer's
    message lost (`docs/PROJECT-STATE.md` §6.106). `endHold` now reads the
    routing row first and takes no lock on a ticket that never routed, and
    every ticket lock the router, `beginRouting`, Hand to and
    `assignConversation` take is `FOR NO KEY UPDATE`.
    `lib/routing/locks.db.test.ts` races each against a real insert.
  - **#1: an `auto_assign` rule's strategy was dropped on a held ticket**, so a
    round-robin rule over a manual group left it unassigned.
    `assignConversation` answering `awaiting_route` keeps the strategy and the
    rule's label on `routing_decisions` (`held_strategy`, `held_actor_label`;
    `lib/routing/held-assignment.ts`), and `afterHoldEnded(id, now?)` — which
    reads the opening message off the row too, and no longer takes it as an
    argument — assigns with them, and `endHold` drops them. Phase one dropped
    them whenever its own rules followed, which lost an `on_create` rule's
    strategy on every ticket whose category settled, since phase two runs
    `on_update` rules only; since the PR review it drops them only when its
    decision moves the ticket. Since the third adversarial review of the fixes
    a person's move on a decision in flight drops them too — since the fifth,
    anybody's — and a pick is kept only while the ticket is in the group its
    rule matched it in (below).
  - **#2/#11/#20: `settle_routing` swallowed its own failed phase three**, and
    the row stayed `holding` for good: no SLA follow-up and no held reply, and
    nobody assigned until the grace let the sweep in. `finish()` answers whether
    it ended the hold, and `settleRouting` throws when it did not, so the queue
    retries: a retry inside the minute requeues itself without a key, and one
    after the minute completes the decision — since the PR review without
    running the rules again. After `routeNow` the failure is still only
    logged, since the window's job is always still to come.
  - **#3: completing an interrupted decision ran the rules on a ticket nobody
    may work**, from the stored row — a category-keyed `send_reply` could reach
    the customer of a deleted ticket. The resume path reads status, deleted,
    spam and merged under the lock (`isWorkable`, which `decide()`'s
    `not_open` now uses too); such a ticket's hold ends with phase one's
    outcome, and nothing runs, assigns or sends.
  - **#5/#12: the every-ticket changes were under-counted**, and
    `docs/PROJECT-STATE.md` said the deploy changed nothing live. Both now list
    four (item 8 above).
  - **#6: a category edit meeting another caller's decision in flight skipped
    its own update pass**, whose rules the router had run on the category the
    edit replaced. It now skips the pass only when `routeNow` answers `decided`
    or `failed` — and, since the PR review, when the router it met had decided
    on the very category the edit wrote. Since the second adversarial review of
    the fixes it runs none on a decision in flight, whose pass it re-arms
    (`deferToRouter`), and `failed` asks `routerDecidedOn` too; since the
    fourth, it runs its own there on a ticket nobody may work, whose pass the
    router gives up.
  - **#7: Hand to's two-click guard trusted the page.** The button posts the
    assignee it was drawn with, and the action refuses `reassigned` when the
    locked row says somebody else.
  - **#8: the badge and the sidebar's hints stayed on a held ticket resolved,
    closed, spam or merged.** `routingHold` draws nothing unless the ticket is
    work.
  - **#9: Hand to said the ticket waits in the route group's queue when it did
    not.** Only for the rota's waiting answers, naming the group a rule moved
    it on to (`waitsIn`).
  - **#10, #14, #15, #18 and #21: docs that said more than the code does.** The
    handbook's three timeline lines for Hand to; the README's "the one reason
    never written", where `moved` is not written either; the rollback's
    trigger columns, which the old web's `db/sql` replay takes back; "whatever
    it decides", which is false for `not_open` (`routeNow`'s docstring too);
    and priority 40 "applied first", where it orders only the claim.
  - **#13, #16 and #17: comments.** Hand to's docstring called its order the
    router's; `routing-result.mjs` cited the console group case's assignment,
    which this build removed; `start.ts` said a ticket is held only when its
    message will be asked about, where a caption-less photo opener is held for
    the whole window and settles `fallback` unless words follow — kept, since
    words often follow, and the handbook's "no badge means the channel does
    not route" softened with it.
  - **#19: CI's `database` job was red at `098e3c1`**, on a shadow
    agent-reply test still expecting what that commit removed. The rewritten
    case is in `a5ceeb8`.
- **Fixed after the PR review** (#432, 2026-10-28; one line each, in the
  review's order, each behaviour fix with a test that fails without it; what a
  fix broke or left stale, found while making the next round, follows it).
  - **An `on_create` rule's kept strategy was dropped whenever rules followed**
    (`apply.ts`): phase one drops it only when its decision moves the ticket
    (`routing-hold.db.test.ts`).
  - **A resumed decision ran its rules again on every retry** (`apply.ts`):
    phase two is claimed (`rules_claimed_at`) and marked done before phase three
    (`rules_done_at`), and a resume skips a pass that is done
    (`settle.db.test.ts`, `apply.db.test.ts`).
  - **`settle_routing` started a second pass beside a slow one** a minute after
    its phase one (`apply.ts`): a caller whose claim fails ends nothing, and a
    resume leaves a claim younger than `RULES_RUNNING_MS` (the hold's ten-minute
    grace) to its claimant, looking again without a key, and ends an older
    one's hold without the rules, with a warning (`settle.db.test.ts`,
    `apply.db.test.ts`).
  - **That claim lost the category's pass when a person ended the hold between
    phase one and the claim** (`apply.ts`): it was refused once the row was
    decided, so an agent's reply or a console assignee or group change in that
    moment cost the ticket the `on_update` pass and the policy's second look
    for good, while `routeNow` still answered `decided` and neither Jev nor the
    console ran its own. The claim is on `rules_claimed_at` alone, and a resume
    that finds the ticket no longer work gives the pass up by marking it
    claimed as it decides the row, so a caller that only stalled runs nothing
    when it wakes (`apply.db.test.ts`, `settle.db.test.ts`).
  - **That let assignment beat the rules, and a stalled router run them on a
    resolved ticket** (found by an adversarial review of the fixes; `end-hold.ts`,
    `apply.ts`). A person deciding the row after phase one ran their
    `afterHoldEnded` before the router's rules, so a rule's `assign_group` left
    a Sales agent holding a Merchant Care ticket; the row they decided was one
    the window's job never resumes, so a router that stalled ran its rules on a
    ticket resolved since, and one whose claim failed lost the pass for good.
    Once phase one has written, nothing but the router finishes the decision:
    `endHold` ends nothing for a person either, their write stands, and the
    router's phase three and `afterHoldEnded` follow its rules
    (`apply.db.test.ts`, `settle.db.test.ts`, `agent-reply.db.test.ts`,
    `hand-to.db.test.ts`).
  - **The router's pass ran on a ticket nobody may work, or on a category it
    never decided on** (the same review; `apply.ts`): the caller that wins the
    claim gives the pass up on a ticket resolved, deleted, merged or marked spam
    since phase one, and on one whose category changed since, whose writer ran
    that category's pass itself (`claimRules`; `apply.db.test.ts`). That did
    not make each category's rules run once in every order of two writers, as
    this line said: an edit committed between the claim and the pass's read ran
    them twice, and one whose writer lagged ran them after the router had
    assigned. The second give-up is gone since the second review of the fixes
    (below); what holds now is that each write in the gap that defers — every
    one but a customer's message and a write on a ticket nobody may work, which
    run their own — is passed once, before the assignment, whichever side of the
    claim it lands on, short of the cap of five passes; and a pass re-armed over
    a claimant that died part-way runs once that claim is `RULES_RUNNING_MS`
    old, some of the dead claimant's rules then running again.
  - **Phase one's `routed` line sorted before the `category_changed` it decided
    on** when phase one waited for that writer's lock (the same review;
    `apply.ts`): stamped `CHANGE_STAMP`, as `endHold`'s is (`apply.db.test.ts`).
  - **Jev's late answer on `in_flight` ran no rule for the category it wrote**
    (the same review; `lib/category-ai/run.ts`): an earlier message answered
    while a decision on another category was in flight returned without a
    relabel. It asks `routerDecidedOn` (`lib/routing/state.ts`), shared with
    the console (`run.db.test.ts`). Since the second review of the fixes that
    answer re-arms the router's pass instead (below).
  - **A console category edit on a ticket resolved in its window ran no
    update rules** (the same review; `routerDecidedOn`): `not_open` counted as
    the router's pass; it answers false, as the router owed that ticket nothing
    (`ticket-actions.db.test.ts`).
  - **A rule's lines inside the move's transaction were stamped with its
    start** (the same review; the engine, `lib/assignment/index.ts`), so after a
    wait on the ticket's lock they sorted before a change committed meanwhile:
    `recordLineIn`, shared by both, stamps `CHANGE_STAMP`
    (`routing-events.db.test.ts`).
  - **A refusal swallowed in that savepoint could hide a statement that
    committed later** (the same review, unconfirmed): `recordLineIn` answers
    only an error Postgres returned, and throws anything else on — the admission
    gate's "lost", a cancel — so the transaction rolls back
    (`lib/assignment/index.db.test.ts`).
  - **The owner's path handed out a ticket resolved since its snapshot** (the
    same review; `lib/assignment/index.ts`): the hand-back to a number's owner
    takes the rota's locked re-read too (`lib/assignment/index.db.test.ts`).
  - **A console category edit meeting `none` or `in_flight` ran a second pass
    on the category the router had read** (`ticket-actions.ts`): it reads the
    routing stage in the write's own transaction, and skips its pass when the
    router decided on that very category (`routerDecidedOn`;
    `ticket-actions.db.test.ts`). Half fixed: queued behind phase one's lock,
    the edit still ran the rules twice in about half of runs (below).
  - **The held reply answered only the opening message** (`after-hold.ts`),
    which on a comment thread a passer-by's reply opened is refused, so the
    customer's own comment was never acknowledged: once somebody else opened
    the ticket it answers the requester's earliest inbound reply that is not a
    reaction (`heldFollowUp`; `begin.db.test.ts`, `ingest-routing.db.test.ts`).
  - **A throw after Hand to's transaction failed the action** (`hand-to.ts`),
    leaving the page on the old group and assignee: the assignment and the
    queue's name are best-effort, and a failed assignment is answered as done
    with a sentence to check who holds the ticket (`hand-to.db.test.ts`,
    `ticket-actions.db.test.ts`).
  - **The pick's locked re-read did not ask whether the ticket was still work**
    (`lib/assignment/index.ts`): status, deleted, merged and spam are re-read
    under the lock too (`not_assignable`), on every ticket, since the race is
    older than this plan (`lib/assignment/index.db.test.ts`;
    `docs/PROJECT-STATE.md` §6.105).
  - **A console category edit routed a `pending` ticket before its `on_create`
    rules** (`ticket-actions.ts`): on `pending` it writes the category and
    nothing else, and `beginRouting` routes on it (`ticket-actions.db.test.ts`).
  - **A number's handover assigns a held ticket without `endHold`**
    (`lib/whatsapp/number-owner.ts`): answered, not changed, for the reasons
    in the last item.
  - **A rule's `routed` line sorted before the move or assignment it was routed
    by** (`lib/assignment/index.ts`, the engine): `group_changed` and `assigned`
    are written in the write's transaction ahead of `endHold`, in a savepoint,
    in the order the console writes them (`routing-events.db.test.ts`).
  - **That left `reselect-policy.db.test.ts`'s re-time after a failed
    `auto_assign` passing for nothing**: it refused `group_changed`, whose
    savepoint now logs a refusal instead of throwing. It refuses the pick's
    `assigned` line, over a group with somebody to pick, and asserts the
    engine logged the failed action, so the call really throws and only the
    `routed` carrier says the move committed; it fails with a carrier set only
    once the call returns.
  - **`beginRouting` took a transaction and a row lock on every new ticket**
    (`begin.ts`): it looks for an undecided routing row unlocked first, as
    `endHold` does (`locks.db.test.ts`).
  - **The window was a second `UPDATE` of the row just inserted** (`start.ts`),
    firing `notify_conversation_change` again: it is a value on each ingest
    path's insert (`routingWindowValues`), with one `now` for the window, the
    row and the job (`begin.db.test.ts`).
  - **Two test fixtures still held a ticket by its routing row alone**
    (`run.db.test.ts`'s `mailTicket`, `agent-reply.db.test.ts`'s `heldMail`):
    they put the window on the insert as ingest does, with the plan and the
    `now` they pass `startRouting`, and assert the ticket is held by its own
    columns exactly when the plan is live. Every test in both passed with or
    without the window, so none read the hold off the ticket; without it, ten
    now fail.
  - **`whatsappRoutingMode` lived in the action file**: it moved into
    `whatsappEditColumns` in `7c657ff` (`coexistence-state.db.test.ts`).
  - **Three copies of "is this ticket work"** (`hand-to.ts`): `routingHold`
    asks `isWorkable` since `7c657ff`, and `handToTarget` and assignment's
    `isWorkToHandOut` now ask it too, each adding the read-only channel, which
    is assignment's question rather than the router's, since a bot ticket never
    routes. Nothing answers differently, so the Hand to, assignment and sweep
    tests already there are its test.
  - **A dead `decided` branch in `undecidedRouting`**: removed in `7c657ff`.
  - **A writer's own pass in the gap was unordered with the router's end of the
    hold** (found by a second adversarial review of the fixes;
    `lib/routing/state.ts`, `apply.ts`, `hand-to.ts`, `ticket-actions.ts`,
    `lib/category-ai/run.ts`): a console category edit, a console group move,
    Hand to or Jev's late answer landing after phase one ran a pass of its own,
    which could come after the router had assigned, and a rule's `assign_group`
    in it left a Sales or Billing agent holding a Merchant Care ticket. Each now
    calls `deferToRouter` in its write's transaction, which clears the claim and
    the mark — since the third review, keeping a claim still running as its
    instant in the mark (below) — and runs no pass, policy or `routeNow` of its
    own; phase three, finding the claim cleared, runs the pass again before it
    ends the hold, at most five times (`MAX_PASSES`), and the router no longer
    gives its pass up on a changed category. Hand to there assigns nobody and
    answers `awaiting_route` (`ticket-actions.db.test.ts`, `apply.db.test.ts`,
    `settle.db.test.ts`, `hand-to.db.test.ts`, `run.db.test.ts`).
  - **The console's assignee case after phase one ran a second pass beside the
    router's** (found while making that fix; `ticket-actions.ts`): it re-arms
    the router's pass too, naming somebody or not, and the person's pick stands
    (`ticket-actions.db.test.ts`).
  - **A category edit queued behind phase one still ran its rules twice in
    about half of runs** (the same review; `apply.ts`): the claim compared one
    snapshot and the pass read a later one. The claim and the read of the
    ticket the pass runs on are one transaction under the ticket's lock, and
    the pass runs on that read (`applyRules`), so a write lands wholly before
    the claim or wholly after it (`ticket-actions.db.test.ts`,
    `apply.db.test.ts`).
  - **A category write whose own `routeNow` failed lost its rules' pass** while
    a decision on another category was in flight (the same review;
    `ticket-actions.ts`, `run.ts`, `state.ts`): on `failed` both writers ask
    `routerDecidedOn`, which now takes the ticket alone and counts an undecided
    row as the router's pass to run (`ticket-actions.db.test.ts`).
  - **The console's `group_changed` and `assigned`/`unassigned` and
    `changeStatus`'s `status_changed` sorted before the `routed` line they
    followed** when the edit waited on phase one's lock (the same review;
    `ticket-actions.ts`, `lib/tickets/status.ts`): stamped `CHANGE_STAMP`
    (`ticket-actions.db.test.ts`, `status.db.test.ts`).
  - **The owner path's `assigned` sorted before a change it waited for**, where
    the rota's pick sorted after it (the same review;
    `lib/whatsapp/number-owner.ts`): `recordOwnerAssigned` and
    `handOverNumber`'s `assigned` lines are stamped `CHANGE_STAMP`;
    `accountable_changed` keeps its instant, which the rollup reads
    (`number-owner.db.test.ts`, `lib/assignment/index.db.test.ts`).
  - **No test held `recordLineIn` to a real cancel, nor the rota's `assigned`
    to its stamp** (the same review): a `statement_timeout` cancel is thrown on
    and the move rolls back, and the rota's pick sorts after a change it waited
    for (`lib/assignment/index.db.test.ts`).
  - **Two sentences said more than the code does** (the same review): AGENTS.md
    had the owner's hand-back re-read the group and the hold, where it re-reads
    the assignee, the work and whether the owner is still the active
    accountable agent; and `routeAndPick`'s comment had a hold only ever end,
    where losing an assignee before the window and its grace are over puts one
    back (`lib/assignment/index.ts`).
  - **A person's group move on a decision in flight left a rule's pick kept for
    the group the ticket had left** (found by a third adversarial review of the
    fixes; `lib/routing/state.ts`, `ticket-actions.ts`, `hand-to.ts`): the
    hold's end assigned in the new group under a rule about the old one. The
    console's group case and Hand to re-arm with `movedGroup`, which drops
    `held_strategy` and `held_actor_label` as phase one's own move does — since
    the fifth review through `endHold`, for every mover (below); a
    category, assignee, priority, tags or status re-arm keeps the pick, since an
    `on_create` rule's has no later pass to make it again
    (`ticket-actions.db.test.ts`, `hand-to.db.test.ts`). That alone left the
    pick a router's pass made after the move, having read the ticket before it;
    the round first dropped such a pick as the router claimed its pass again, in
    a group the replaced pass had not read, which the next line replaced.
  - **That kept a pick or not by timing** (found by a fourth adversarial review,
    of this round's fixes; `lib/routing/held-assignment.ts`,
    `lib/assignment/index.ts`, the engine, `apply.ts`): compared at the claim
    against the group the replaced pass had read, a rule's move in that pass
    read as a person's whenever an unrelated write had re-armed it, and a pass
    never run again — its router dead before `settle_routing` took over, or the
    five-pass cap reached — left the stale pick for the hold's end, which
    assigned in the person's group under the rule's label.
    `recordHeldAssignment` locks the ticket, then the routing row, and keeps a
    pick only while the ticket is in the group the rule matched it in
    (`matchedInGroupId`, the engine's `Pass.groupId`), answering `moved`
    otherwise; the drop at the claim is gone (`ticket-actions.db.test.ts`, the
    router's death among its cases, and `lib/assignment/index.db.test.ts`). The
    cap's path meets the same check and has no test of its own.
  - **A re-arm erased a claim still running, so a `settle_routing` falling due
    ran a second pass beside it** (the third review; `lib/routing/state.ts`,
    `apply.ts`): that pass ended the hold and assigned while the first pass's
    last rules were still to come, and one of them moved the ticket away from
    the agent it chose. The re-arm keeps a running claim's instant in
    `rules_done_at` (decision 16); a resume leaves the pass to that claimant
    until the instant is `RULES_RUNNING_MS` old, looking again without a key,
    and then runs it with a warning; a fresh claim clears the mark; and a re-arm
    over a pass already done clears both, so a resume runs it at once, as before
    (`settle.db.test.ts`).
  - **The branch where `routeNow` fails and `routerDecidedOn` answers had no
    test** (the third review): a console category edit and Jev's answer whose
    phase one a trigger refuses run no pass of their own, and the window's end
    runs the category's rules once; the console test that had been named for
    that case is renamed for what it guards (`ticket-actions.db.test.ts`,
    `lib/category-ai/run.db.test.ts`).
  - **The console's priority, tags, custom-field and status edits, and the
    priority classifier, still ran their own pass beside the router's** (the
    third review; `ticket-actions.ts`, `lib/tickets/status.ts`,
    `lib/priority-ai/run.ts`): a rule keyed on priority moved an urgent ticket
    to Escalations after the router had handed it to somebody in Sales, who kept
    it. Each defers (decision 15); `changeStatus` takes a `deferToRouter`
    option, which only the picker passes, and answers whether it deferred, and
    the tags write is a transaction (`ticket-actions-gap.db.test.ts`,
    `status.db.test.ts`, `lib/priority-ai/run.db.test.ts`).
  - **A write on a ticket nobody may work handed its pass to a router that gives
    it up** (the fourth review; `lib/routing/state.ts`, `ticket-actions.ts`,
    `lib/tickets/status.ts`): a category, group, assignee, priority, tags or
    field edit, or the priority classifier's answer, on a ticket resolved after
    phase one ran no rule at all. `deferToRouter` reads `isWorkable` under the
    write's lock and answers false, and the writer runs its own pass, a group
    move still dropping the kept pick; the console's category case does not
    route a decision in flight it was refused on (`decisionInFlight`), which
    `routerDecidedOn` would have counted as covered; and `changeStatus`'s own
    check is gone (`ticket-actions-gap.db.test.ts`,
    `lib/priority-ai/run.db.test.ts`).
  - **A deferred priority or status write moved the clocks after its commit**
    (the fourth review; `lib/sla/index.ts`, `lib/errors.ts`): the router's pass
    read the deadline from before the change, so a rule asking
    `is_first_response_overdue` passed over an urgent ticket, or escalated one
    moved back to Open whose pause, once credited, left it not overdue.
    `onPriorityChangedIn` and `onStatusChangedIn` move them in the write's
    transaction, in a savepoint, with the policies and the hours loaded before
    it opens — since the fifth review only on a decision in flight, and
    best-effort (below) — throwing on only a statement that got no answer
    (`gotNoAnswer`, which `refusedByPostgres` now shares); a write that does not
    defer re-times after its commit as before (`ticket-actions-gap.db.test.ts`,
    `lib/priority-ai/run.db.test.ts`, `lib/errors.test.ts`).
  - **The docs lagged the round** (the fourth review): AGENTS.md named only the
    console's category, group and assignee cases, Hand to and Jev's answer as
    deferring, had the re-arm clear the done mark, and had a re-armed pass
    claimed and run at once, and this plan proposed a CHECK that would refuse
    the re-arm's own state. Corrected, with the decisions behind the deferral
    (15, 16) and what it leaves (below). Comments reworded in the round that
    still say too much are under Left.
  - **A rule's move after phase one kept a pick a person's move dropped**
    (found by a fifth adversarial review, of the round's working tree;
    `lib/routing/end-hold.ts`, the engine, `lib/assignment/index.ts`,
    `hand-to.ts`, `ticket-actions.ts`, `state.ts`): the router's pass kept round
    robin for Sales, a rule then moved the ticket to Escalations — later in the
    same pass, or in a customer's message's — and the hold's end assigned there
    under the Sales rule's name, where the same move landing before the pick was
    kept assigned nobody. `endHold` takes `movedGroup`, which every writer of a
    ticket's group passes, and on a decision in flight drops the pick before it
    answers false; `deferToRouter`'s own option is gone, so one mechanism covers
    every mover until the router ends the hold (a move after it is under Left),
    and a rule later in the same pass keeps its pick again for the new group
    (`apply.db.test.ts`; the console's cases of a rule's move in the router's
    pass now assign nobody, `ticket-actions.db.test.ts`).
  - **The clocks' policies and hours were read before every priority and status
    write, outside any try** (the fifth review; `lib/routing/state.ts`,
    `ticket-actions.ts`, `lib/tickets/status.ts`, `lib/priority-ai/run.ts`): a
    catalog that could not be read failed the edit or the classification itself,
    where `5f0c69e` wrote it and logged the re-time's failure, and a write that
    kept its pass read them twice. `clockInputsIfInFlight` reads them only when
    an unlocked read finds a decision in flight, best-effort; a write that
    defers without them re-times after its commit and still hands its pass over
    (Left; `ticket-actions-gap.db.test.ts`, `lib/priority-ai/run.db.test.ts`).
  - **Four comments said more than the code does** (the fifth review):
    `deferToRouter` had whatever resolves a re-armed ticket run a pass that read
    the write, where a rule in a pass that read the ticket before it does not
    (Left); `MAX_PASSES` named two writers; `apply.ts`'s header had everything a
    write in the gap owes the clocks move ahead of the router's pass, where only
    a priority's re-pricing and a status's pause or resume do; and `inWrite` and
    `recordLineIn` justified throwing a cancel on by the gate's give-up.
  - **A rule finding the ticket already in its group left the pass on the group
    it had read** (found by a sixth adversarial review, of the round's working
    tree; the engine, `lib/assignment/index.ts`): the router's pass sent sales
    tickets to Escalations and a later rule kept round robin there, and a
    customer's message moving the ticket to Escalations first made the router's
    move a no-op, so `Pass.groupId` stayed on Sales and the pick was refused as
    `moved`; landing after, the customer's move was the no-op, and Ezz was
    assigned. `assign_group` sets `Pass.groupId` whether it moved the ticket or
    found it there, and a grouped `auto_assign` does when `assignConversation`
    reports the ticket in its group (`Routed.inGroup`) — found by its read, or
    by its move finding another writer had put it there since
    (`apply.db.test.ts`, both actions at each place the customer's move can
    land).
  - **Why the handover was answered rather than changed — and is left so, by
    decision (2026-10-29).** A handover that
    assigns a held ticket is what `decide()`'s `taken` outcome exists for: an
    assignee ends a hold whoever gave it (`isHeld`), and at the window's end the
    router records `taken`, moves nothing, writes its `routed` line ("kept the
    ticket in …: somebody had already taken it") and runs what the hold owed, so
    the held reply waits at most the rest of one window, and the handover's own
    `assigned` line is on the timeline meanwhile. `alignAccountable` reopening a
    held ticket resolved in its window meets the same answer. Ending holds in
    `number-owner.ts` would add one more module outside `lib/routing/` to those
    that end holds, with neither of `endHold`'s outcomes fitting it — a handover
    is no person or rule deciding where one ticket goes, which is why its events
    carry no `actorAgentId` — for a case production has never had: no channel
    routes yet, and an owned number's new tickets are never held, so a ticket on
    a number is held only if the number had no active owner when it arrived, and
    meets a handover only when an admin gives it one inside that ticket's
    window. The review's general cure, ending a hold at the assignee write
    itself (one writer, or a trigger), is a change to every assignee writer, and
    its own change.
- **Left, with the reason.**
  - **`transferred_away_count` counts only Hand to's `unassigned`**, the one
    assignment event that names `from` (`docs/PROJECT-STATE.md` §5.5). Older
    than this plan.
  - **The widget's open/closed line** still reads the channel's default
    group's calendar (Risks).
  - **`/reports/routing` is Stage 6's** (below), deployed on 2026-10-29.
  - **`sendCannedReply` and the engine's `loadTicket` still act on a deleted
    or merged ticket** in general (review #3). Only the router's resume path
    is guarded, which is the one place 5.1 made reach such a ticket.
  - **The category writer, Jev and the priority classifier still lock the
    ticket `FOR UPDATE`.** They lock before they write, so they close no
    deadlock; they hold a customer's message back until they commit, which
    is short. Moving them to NO KEY UPDATE is a change of its own.
  - **Nothing in `db/sql` holds `held_strategy` and `held_actor_label` to both
    or neither.** Only `recordHeldAssignment` sets the two, together, and every
    clear clears both; a CHECK would make that a fact rather than a habit. The
    claim columns take no such CHECK: every combination of the two is a state
    the code writes — unclaimed, claimed, done, and a done mark with no claim,
    which `deferToRouter` leaves on purpose (decision 16) — so the one this list
    proposed before, holding `rules_done_at` to a row with `rules_claimed_at`,
    would throw inside the writer's transaction on every re-arm over a claim
    still running, failing the console's edit, Hand to, Jev's answer or the
    priority classifier's.
  - **A customer's message runs its own pass beside the router's** (decision
    15). A reply reopening a ticket resolved in the gap moves `status.category`
    and `reopen_count`, so a rule keyed on them can move the ticket after the
    router has assigned it, and leave that agent holding it: the race a reopen
    meets on any ticket somebody holds. Closing it would put `deferToRouter` in
    `reopenResolved`'s transaction and skip the inbound pass's rules and
    `autoAssign` on all five paths; not reproduced, since it needs a resolve and
    a reopen inside a gap of seconds.
  - **A write after phase three's commit races the router's assignment**, tens
    of milliseconds behind it: it meets a decided row and runs its own pass, as
    a write races the rota on any ticket.
  - **A move after the router's end of the hold keeps a rule's pick about the
    group the ticket left** (found by the sixth review). A move landing between
    phase three's commit — phase one's, on a ticket with no category — and
    `afterHoldEnded`'s read of the pick, with the policy's second look and
    re-time between them, meets a decided row, so `endHold` drops nothing
    (decision 17), and the hold's end can assign in the new group under the old
    group's rule. It is the race of the item above — a customer's message whose
    rule moves the ticket, a console move or Hand to, against the router's
    assignment — with this outcome too. Clearing the pick on a decided row as
    well would leave the gap between `heldFollowUp`'s read and the rota's lock;
    the cure is keeping the group the pick is about, which
    `recordHeldAssignment` is handed, and having the assignment drop the
    strategy when the ticket, read under its lock, is elsewhere, as the rota
    answers `moved`: a column and a change to `assignConversation`, its own
    change. The comments that describe the pick's group —
    `held_strategy`'s in `db/schema/routing.ts`, `held-assignment.ts`'s header,
    `phaseTwo`'s in `apply.ts` and `keepForHold`'s in
    `lib/assignment/index.ts` — say "while the hold lasts" and point here.
  - **A write on a decision stalled past the hold's grace still defers**, Hand
    to's included, so the sweep may assign the ticket before the resumed pass
    runs, and a rule in that pass may move it on from its holder. That is the
    grace being a valve for a stuck job rather than a second window, as it is
    for a ticket whose `settle_routing` never came.
  - **A pass the router has run five times is not run a sixth**: the hold ends
    with a warning, and the last re-arming writer's rules are not run
    (`MAX_PASSES`). Only re-arms landing during five consecutive passes reach
    it, writers editing faster than a pass runs, who are not deciding where the
    ticket goes, and the hold has to give.
  - **A write whose ticket a rule then resolves, in a pass that read the ticket
    before the write** — the router's own, claimed before it — has its rules run
    nowhere: that pass was not owed them, and the one the write re-armed is
    given up on the resolved ticket. A ticket the rules resolved in that moment
    is owed nothing more, as a fresh decision would find it `not_open`.
  - **A group move's, Hand to's or a category write's re-time follows the
    router's pass** (decision 15). Deferred, the write skips its own
    `afterRoutingChanged`, which the router calls once phase three has ended
    the hold, with whether the group or the category now differs from what
    phase one left; so a rule in the router's pass asking
    `is_first_response_overdue` reads the deadline from before the move or the
    category — the old group's hours, the old policy's targets. The router's
    own move costs the same, by decision 5's order (step 3): the policy is
    chosen once the whole change is over, so the rules' moves and the writes the
    router passed choose one between them, where re-selecting inside each write
    would choose once per write.
  - **A priority or status write that defers without the clocks' inputs**
    re-times after its commit (`clockInputsIfInFlight`): its unlocked read raced
    phase one, or the load failed. The router's pass may then read the deadline
    from before the change, the case the in-write re-time closed, on that race
    or a failed read alone; the clock itself is right once the re-time lands,
    and a write is not failed for a catalog it could not read.
  - **A pass re-armed over a claimant that died runs once that claim is
    `RULES_RUNNING_MS` old**, and some of the dead claimant's rules then run a
    second time: which of them ran is recorded nowhere, and the write the pass
    is owed for came after them.
  - **Three comments say more than the code does.** `updateTicket`'s note on a
    customer's message (`app/(console)/ticket-actions.ts`) counts four ingest
    paths where five continue a ticket — email, WhatsApp, Meta, the widget and
    the portal's reply — and says the message decides nothing about the ticket,
    where a reopen changes what rules read (above). `deferToRouter`'s docstring
    and `apply.ts`'s header say every writer with a pass of its own in the gap
    defers, and name no exception for a customer's message. And
    `restore-resolved-at.ts` has the event follow the column by at most the
    request and the lock wait, where the column is stamped on the app host's
    clock and the event on the database's (`CHANGE_STAMP`), so the two agree
    only within those and any skew between the hosts; the handler's real
    tolerance, the same reporting day except near midnight, still holds.
    AGENTS.md states the deferral as the code has it; the comments go with the
    next change to those files.
- **Deploying it.** Web first, then the worker and **all four** crons, before
  any channel leaves `default_group`. Done so on 2026-10-29, with one
  expectation different: the classifier was in Shadow rather than off, which
  holds nothing, since routing starts only under `apply`. The reads are under
  5.1's deploy and checks, in the status section.
  - **Before.** Read `git log origin/main..origin/dev` and every migration in
    it (deploy rule 7). Expect 51 migrations, the newest `1793058419292`; no
    `category_ai_settings` row; no route group on any category and no
    categorised ticket (all read at 10:06–10:31 UTC on 2026-10-28). Check
    §5.5's `pg_stat_activity` query in `docs/PROJECT-STATE.md` for a long
    transaction or a strong lock: `0051` adds two columns to `conversations`
    and one to `channels`, each a brief exclusive lock, and seven foreign keys
    from the new table, each taking a share-row-exclusive lock on
    `conversations`, `channels`, `groups`, `ticket_categories`, `agents` or
    `messages`.
  - **Web**, whose preDeploy applies `0051` and replays `db/sql`, so the
    trigger and the CHECK land with it. A worker on 5.1 before the migration
    would fail every insert into `conversations` and every whole-row select
    (rule 1). Nothing is held or enqueued in between, since no channel can be
    in a category mode before the column exists, and none is after it.
  - **Then the worker and the four crons.** `shipblu-sla-sweep` and
    `shipblu-time-automations` must run 5.1 before a channel is moved: an old
    `assign_sweep` assigns a held ticket, and an old time-based rule's
    `auto_assign` assigns one and its `assign_group` moves one without ending
    the hold, so the router may then move it away from the rule's group.
  - **Checks.** 52 migrations; the three types, the three columns and
    `routing_decisions` with RLS on; `routing_decisions_decided_complete`;
    `notify_conversation_change` naming both routing columns; every channel on
    `default_group`; no `routing_decisions` row and no `settle_routing` job;
    every job since the deploy completed; no warning or error on the six and
    no 5xx; `/api/health` on the new commit. Signed in: `/admin/channels`
    shows the Routing select on each form and the readiness panel.
  - **The handbook.** Production held no console handbook at 10:08 UTC on
    2026-10-28 (no `handbook-` article, no `seed_console_handbook` job ever),
    so there is nothing to seed: the first seed writes these words. If it has
    been seeded since, run `seed_console_handbook dryRun=true` once web is
    live, read what it reports, then `overwrite=true`.
- **Rolling it back.**
  - **The switch first: set every channel back to `default_group`.** New
    tickets are never held again. Tickets already held settle at the end of
    their own window as `released`, are assigned where they are, and get
    their held reply; routed tickets stay where they were routed.
  - **Then, if the code must go, redeploy `ad6a062`** on all six, once no
    `settle_routing` job is pending or processing: the old worker has no
    handler for one, and it would retry to `dead`. The old web's preDeploy
    replays its own `db/sql`, so `001` puts back the old
    `notify_conversation_change()` without the two routing columns. `0051`'s
    columns and table stay, unread there — the old schema names none of them
    and an insert takes their defaults — and so does the CHECK, on a table
    nothing writes. Dropping them is a forward migration of its own.

**5.2 — Turning it on, channel by channel (operations).**

1. **Prerequisites.**
   - All six services run 5.1.
   - Stage 0.5 is shipped and 0.6 is done:
     - each route group has a non-manual strategy and members who accept
       tickets;
     - no channel defaults to the retired Support group.
   - The sweep has assigned something in the last day. 0.7 found it idle for
     want of anyone to assign to, so this is the proof that 0.6 fixed it.
   - The classifier is in `apply`, with category route groups set.
   - The comment channel rows exist (Q11), and the count of comment tickets
     whose `channel_id` is not a comment row is 0. Until then, a comment ticket
     takes its routing mode from the DM channel's row.
2. The Instagram DM channel and the comment channels go to `category_shadow`
   for a week. Read `routing_decisions` against the agents' own moves.
3. Then they go to `category`.
4. Messenger goes to `category_shadow` now, and to `category` the day of the
   Freshworks swap. Before the swap it would route copies of tickets that
   Freshchat agents are answering.
5. Email and webchat follow on the same evidence. The coexistence numbers
   stay `default_group`; `routingModeOf` enforces it.

**Rollback.** Set a channel's mode back to `default_group`. New tickets are
never held again. Tickets already held settle at the end of their own window
(up to the configured window) as `released`, and are assigned in their current
group with their held reply sent. Already-routed tickets stay where they are,
which is correct.

### Stage 6 — reporting

Web first (it migrates `metrics_daily`), then the worker and crons, with
`shipblu-nightly` before any `rollup_metrics from=` rebuild.

- `metrics_daily` gains a category dimension: a fifth single-dimension slice
  and `byCategory` beside `byGroup`. This changes its unique index and the
  slice reconcile (`slicesFor` and `reconcileFailure` in
  `lib/reports/rollup.ts`), then `rollup_metrics from=` rebuilds history.
- Live open/awaiting by category beside `channelLoad`.
- `/reports/routing` shows, per channel:
  - routes by outcome;
  - time to decision against the window;
  - the fallback and `taken` shares;
  - routed tickets still unassigned.

  Those are the numbers that say whether the window and the threshold are
  right, and whether ask 5 is met.

#### 6, as built

Built on `claude/jolly-noether-hxhez1-stage-6` as draft #433, whose fourteen
review threads were answered on `claude/epic-heisenberg-w60nbl`. That branch
carries #433's three commits, rebased onto 5.1 at `357b25c` (#432, then in
review) and since merged with #432's final head `ec8487b` and with `dev`
(`4622f71`), and a fix for each thread, and replaces #433 as the stage's pull request,
#434. #432 was squash-merged into `dev` as `9d5b4fb` on 2026-10-29, and #434
targets `dev` since, with its own review's thirteen threads answered (below).
Four builders
worked from one written design, each piece with its own tests. The organisation's
spend limit stopped the first session's screenshot pass, docs, full check and
adversarial review on 2026-10-28; the review on #433 and the docs are answered
below, and the screenshot pass is still owed. What follows is what is on the
branch, what was verified, and what is left, in order.

**Decisions, as built.**

1. **A category figure follows the ticket's current category**, for every
   figure: created, first response, resolved, reopened, and CSAT through the
   surveyed ticket's row. It is the rule the group already follows, and
   `byCategory` is drawn beside `byGroup`. A category charges nobody, so the
   reason the agent slice is frozen as of each instant does not apply, and a
   person's correction is the ground truth 4.2 grades against, which a rebuild
   should take up. "As of creation" would file every ticket under no
   category: `CHANGE_STAMP` stamps the first `category_changed` after
   `created_at`, even in `createTicket`, and the back-classified backlog (Q12)
   would never reach its own days. The drift is the group's: the nightly
   recomputes three days, and an older day moves only on a `from=` rebuild.
   Nothing snapshots a category onto `csat_surveys`.
2. **One row per slice per day, and one dimension per row, are facts.**
   Migration `0052` adds `metrics_daily.category_id` (`restrict`, as every
   reference to a category is) and replaces `metrics_daily_dimensions_idx` —
   NULLS DISTINCT, so it enforced nothing on any slice — with
   `metrics_daily_slice_key`, UNIQUE NULLS NOT DISTINCT over the day and all
   four dimensions. `db/sql/003` adds `metrics_daily_one_dimension`
   (`num_nonnulls(group_id, agent_id, channel, category_id) <= 1`). A slice
   written twice, or a row naming two dimensions, would otherwise be summed
   into another slice by every reader, and `reconcileFailure()` cannot see it.
   Production pre-flight, read-only, 2026-10-28: no duplicate slice, no row
   naming two dimensions, one totals row on each of the 67 days, Postgres
   17.6. So both build there.
3. **The engine** (`lib/reports/rollup.ts`). `Dimensions` is built from one
   `DIMENSIONS` list, so the bucket key and `totalsOf` cannot miss one. The
   accumulator keeps each slice's dimensions in its Map value
   (`sliceAccumulator`, exported for unit tests), where the old
   `key.split('|')` round trip could silently drop a fourth.
   - `slicesFor` adds the category slice only for a categorised ticket.
   - `reconcileFailure` keeps the channel-sum equality (category slices have
     `channel = null`) and adds two invariants: at most one all-null slice,
     and per column the category slices sum to no more than the totals.
     `reconcileFailure()` names which one a day broke.
   - The handler's per-day line reads `<day>: N rows (K by category), …`.
   - `reconcileFailure` is asked of a day's slices before anything is
     written (#433's review): a day that fails is not written, keeps the rows
     and the marker the last run to write it left, and the run carries on to
     the older days and then fails. A day no run wrote before has nothing to
     keep: every report reading up to today shows it empty from that night,
     and the CSAT page, which stops short of it, does too once a later day is
     written (`countedThrough` is the newest day computed whole, a `max()`).
     So its line says `has no rows until a run reconciles it` rather than
     `keeps its previous rows`, and `rollup_metrics day=<day>` writes it once
     the cause is fixed, after the nightly's three days. Asked after the write, as it was, the day
     was published anyway and the one-totals-row rule could never fire, since
     `metrics_daily_slice_key` refused the second totals row first.
   - A constraint violation is not caught per day. It means the rollup's own
     code is wrong in a way `reconcileFailure` cannot name, every day would
     fail the same way, and the day's transaction rolls back whole, so the day
     keeps its previous rows.
4. **Every totals read names every dimension null.** `TOTALS_SLICE` in
   `lib/reports/queries.ts` serves `totals()`, `daily()` and `rolledUpDays()`.
   A category slice has the other three dimensions null, so without it every
   categorised ticket is counted twice in every headline figure: the overview,
   the CSAT page and its export, and the dashboard's History. `AGENT_SLICE`
   names the category null too. A test fails with it removed.
5. **The overview** (`/reports`) draws "By category" after "By group":
   `byCategory` (registry order, retired categories kept and marked) plus a
   "No category" remainder (`uncategorised()`, totals less the category slices,
   unclamped), read in the same statement as the categories so the two halves
   of the subtraction are one moment's. A line from `categoryCoverage()` names
   the window's days last rolled up by code that did not file by category, or
   says that none in the window has one, so the section never vanishes on a
   window with no category (§6.54). It counts those days one by one
   (`categoryFiling`), off `rollup_days.categories_computed_at` (`0054`), which
   this rollup writes with `computed_at` and the code before it never writes.
   A day rebuilt by hand ahead of the history's rebuild, or by a rollback's
   nightly, is then told apart from the days around it, where the first
   category slice in the window called every later day covered. Its reads go through
   `allLimited(3)`, and its header links to the routing report. It is not on
   the CSAT page: surveys snapshot group, agent and channel but not category,
   so a by-category CSAT would re-file scores on a relabel. Nor does this
   table draw a CSAT column, for the same reason. The rollup still files each
   score under its ticket's category, so a category slice is one partition in
   every column and "No category" stays exact.
6. **The live board** (`/admin/dashboard`) gains "Open work by category":
   `backlogCuts()`, one scan of the open backlog grouped by channel and by
   category (`grouping sets`), its category cut full-joined to the registry.
   Active categories always show, retired ones only while they hold open work,
   and "No category" comes last. Each row links to `/inbox?category=<id>`.
   - The dashboard's reads go through `allLimited(3)`. It had put ten
     statements on eight places.
   - A held ticket is unassigned by design. So `queueSnapshot` counts the
     tickets being routed through `heldSql` (`lib/routing/held-sql.ts`), the
     SQL twin of `isHeld`, server-only because `hold.ts` is client-safe, and
     held to `isHeld` and `routingHold` by a test over the same rows.
   - The Unassigned tile says how many of them are being routed, and turns
     amber only for the rest.
7. **`/reports/routing`** (`report.view`; reads in `lib/routing/report.ts`;
   page and `parts.tsx` under `app/(console)/reports/routing/`). Each read is
   one statement taking the page's `now`, run through `allLimited(2)`. Each
   line is per `routing_decisions.channel_id` and live or shadow, never mixed,
   and filed on the reporting zone's day the ticket entered routing (`within` on
   `started_at`). The figures:
   - **Outcome counts.** Entered, decided (`stage = 'decided'`, never
     `outcome is not null`, which phase one writes while still holding),
     deciding, stranded and the eight outcomes. Stranded begins at exactly
     the instant the grace runs out, as `isHeld` ends the hold.
   - **The fallback and taken shares** are over the router's own decisions
     (category, no route, fallback, taken). Over all decisions, a channel whose
     holds a rule ends (production's two web chat rules) reads 0% fallback and
     looks perfect. "A person or rule decided first" is its own share.
   - **Time to decision** runs from `coalesce(phase_one_at, decided_at) -
started_at`, over a settled category only. It shows p50, p90 from ten
     rows, and the share inside the window. The page warns when two window
     lengths were in force in the range, and gives the settle job's lag past
     the window.
   - **Why a fallback fell back**: a category that arrived after the decision
     (Jev, a person, or a rule or form), and what Jev had said by then
     (nothing asked, unsure, every call failed).
   - **Routed, then assigned**, with the median wait. Every taken ticket is
     listed.
   - **Now, not range-bound**: routed tickets nobody has been assigned since
     they entered routing (no `assigned` event since `started_at`), ten minutes
     after their hold ended (`decided_at`, two `*/5` sweeps), by the ticket's
     current group and strategy; stranded rows, with the recovery command. A
     ticket assigned and then reclaimed, unassigned or handed on is waiting for
     reasons that are not routing's, and the dashboard's Unassigned counts it.
     Lists stop at 50 with an exact total.
   - **The shadow comparison**: each would-be decision against the group a
     person moved the ticket to.
   - **State and empty states** are built from the classifier's mode and each
     channel's mode now, through `routingModeOf`.
   - `ROUTING_OUTCOME_LABELS` lives in `mode-copy.ts`. The readiness panel
     takes a required `canViewReport` prop for its link, which
     `/admin/channels` passes as `report.view`.

**Left out, on purpose.** A history of open-by-category: it would be a snapshot
(its own table, sampled hourly), never recomputed from `conversations`.
By-category CSAT (above). A per-category routing table, and a `?channel=`
drill-down; `routing_decisions_channel_idx` is ready for the second. A "no
category" inbox filter.

**Verified on the pushed head, 2026-10-28.**

- **Passed, on the whole tree:**
  - `tsc`, `eslint`, `prettier --check`;
  - `vitest`: 276 files, 4,303 tests;
  - `knip`;
  - the repo rules: 34 checks, none violated;
  - `db:generate`: no drift;
  - `npm run build`, run from a real checkout of this commit: Turbopack
    refuses the worktree's symlinked `node_modules`, so build the worktree's
    commits from a real checkout.
- **Database tests passed, on a freshly migrated database:** every file in
  Stage 6's areas, 19 files and 257 tests — `lib/reports`, `lib/routing`, the
  rollup handler, the WhatsApp ingest's totals check, the resolve stamp, the
  constraint test and the routing page.
- **Mutation runs:** each builder showed its invariant tests failing with the
  code they guard broken.
- **Not run:**
  - The full `test:db` tier and the CI `database` job's steps.
  - The screenshot pass. It got far enough to reorder the routing page's
    outcome columns and split its table, with a test of what it changed, and
    was stopped before it looked again.
  - The adversarial review.

**#433's review, answered.** Fourteen threads, each a commit on
`claude/epic-heisenberg-w60nbl` with a test that fails without it where the
fix has behaviour:

- **The rollup refuses before it writes** (two threads): `reconcileFailure`
  moved ahead of the day's transaction, above.
- **"No category" is one statement's**: `byCategory` reads the totals slice
  beside the category slices and returns the rows and the rest together, so a
  rollup committing between two reads can no longer print it short or
  negative.
- **No CSAT by category on the overview either**: the table leaves the column
  out, for the CSAT page's reason (5, above).
- **"Still unassigned after routing" counts a ticket nobody was assigned since
  it entered routing** (no `assigned` event since `started_at`), not merely one
  unassigned now: a ticket reclaimed, unassigned or handed on after it was
  worked waits for reasons that are not routing's.
- **The stranded read has an index of its own**: `0053` adds
  `routing_decisions_undecided_idx`, partial on the undecided rows, so the read
  on every load stays the size of what is stranded. The test asks the planner
  for it.
- **The live board's two backlog cuts are one statement** (`backlogCuts`,
  `grouping sets`), one snapshot and one scan instead of two.
- **The routing page**: its instants are written in the reporting zone
  (`formatDateTime` takes a zone); "held for N minutes" is said only where a
  ticket entering routing now is held, asked through `routingStartFor`; its
  thresholds are said from `ROUTING_GRACE_MS` and `STILL_UNASSIGNED_AFTER_MS`
  rather than typed as "ten minutes".
- **The readiness panel's report link is drawn**: `/admin/channels` passes
  `report.view`, and the prop is required, so leaving it out does not compile.
- **One `asDate`, one map of strategy labels**
  (`lib/assignment/strategy-copy.ts`), where there were two and four copies.
- **The docs**: the AGENTS.md paragraph on totals reads, `heldSql` beside
  `isHeld`, the routing report named where the decided-complete CHECK is;
  README's five slices; PROJECT-STATE's header, §5.1's shadow week and §5.5's
  reconcile; the handbook's reports and channels articles; and the stale
  comments.

**#434's review, answered.** Thirteen threads, in ten commits (`17997c8`
answers four), each with a test that fails without it where the fix has
behaviour:

- **Unfiled days are counted one by one** (`categoryFiling`): the coverage
  line names the window's days with figures last rolled up by code that did
  not file by category, where the first category slice in the window called
  every later day covered. `0054` adds `rollup_days.categories_computed_at`,
  written with `computed_at` by this rollup and never by the code before it,
  so a day a rollback's nightly rebuilds reads as unfiled again.
- **`0055` indexes `routing_decisions(started_at)`** for every range-bound read
  on `/reports/routing` and the history's first and last. The test plans each
  on a year of rows with fresh statistics: on an empty table the planner
  prefers the channel index for the timing read.
- **"Routed, then assigned" is bounded by `started_at`**, as "still
  unassigned" is, and its median wait floored at zero, so the app's clock and
  the database's cannot drop an assignment or make a wait negative.
- **The tiles and the By category table are one statement's**: `byCategory`
  returns the totals it was read with, and the tiles print them.
- **Every slice predicate is built from `DIMENSIONS`** (`sliceWhere`), through
  a column map the type holds to it, so a fifth dimension left out does not
  compile.
- **An owner with a blank name still makes a number owned** on the readiness
  panel, named by email.
- **Every report prints its instants in the reporting zone**: the CSAT
  comments, the suggestions hint and the classifier report's runs.
- **Smaller**: `reconciles()` removed for `reconcileFailure`; `inArray` for the
  report's IN lists; `SETTLE_ACTOR` in a leaf module; `sumOutcomes` and
  `minutesInWords` exported rather than copied into the page; the
  `computeDay` mock reset after each test; the overview test's rows
  mid-window.

**Verified again on `4622f71`, 2026-10-29**, the head with every thread
answered and `dev` merged: `tsc`, both `eslint` runs, `prettier --check`,
`vitest` (4,309 tests), `knip`, the repo rules and `npm run build`; the full
`test:db` tier on Postgres 17, migrated and `db/sql` replayed twice, then
seeded (118 files, 1,584 tests); and every CI check.

**Left to do, in order.**

1. ~~The screenshot pass.~~ Done on 2026-10-29 on the deployed code
   (`9b4bc5b`), over seeded data at 1400×900 and 390×844. It covered
   `/reports` at 30 and 90 days in three coverage states (filed, a gap,
   nothing filed), `/reports/routing` at 7 and 30 days and with nothing
   routed, `/admin/dashboard`, `/admin/channels`, `/reports/category-ai` and
   `/reports/csat`. All 24 captures answered 200, with no console error and
   no horizontal page scroll on the phone. The visual review confirmed 23
   findings and refuted 20. The follow-up pull request into `dev`, #438, fixes 20 of
   them; each is named there with its file. Two more changed shared
   components, so they went in after, in the same pull request:
   - **A sideways-scrolling table now shows that it scrolls.** At 390px
     every `/reports` breakdown hid Within SLA and CSAT inside `Table`'s
     own `overflow-x-auto`, with only a header cut mid-word to hint at
     them. `Table`'s background is now `.scroll-cue` (`app/globals.css`):
     a shade on each edge with columns beyond it, in CSS alone. It is left
     to right only, because Chromium places a `local` background in a
     right-to-left box as though it scrolled left to right; under
     `dir="rtl"` the cue is off, and only the console draws `Table`.
   - **`Columns`' axis labels are HTML.** As SVG `<text>` in a 720-unit
     `viewBox` they rendered at about 4px at 390px. Each is now centred on
     its slot and held inside the chart by `translate` against `cqw`.
     `axisTicks` (`lib/charts/scale.ts`) lays them out as drawn, at their
     width in characters, and thins them evenly until none touches, once for
     the narrowest `sm` chart and once for the narrowest phone (286px, a
     360px window).
   - **The two reviews of these, answered in the same pull request.** The
     panel's idle and no-key notices are shared with `/reports/routing`
     through `mode-copy.ts`, and drawn only over a row that would route; a
     row idle only for the classifier keeps its warnings on purpose, as what
     Apply would meet; and the scroll cue's shades are linear, so a tall
     table's header has one.

   One is left, and decided, but not built:
   - **A second web chat row cannot be edited.** `ChannelEditor` returns
     null for every `webchat` row, and the Chat widget card configures only
     the oldest active one. So a second row's saved mode, name, default group
     and active switch are unreachable. The readiness panel says truly that
     such a row's mode does nothing; nothing on the page can change it.
     **Decided on 2026-10-29: make it editable, with an active switch.**
     Every web chat row gets the editor other channels have (name, default
     group, routing), and web chat rows alone get an active switch, since
     the widget uses the oldest active row and a second row's settings do
     nothing while the first is active. The last active web chat row cannot
     be switched off, so the widget always has a row. The Chat widget card
     keeps configuring the oldest active one. The first wording of this
     decision named an active switch among what other channels have; none
     has one.

2. In production after the deploy, the verification rows added for Stage 6 to
   the table below. Read clean on 2026-10-29; the first nightly's rows are left.

**Deploy.** Done on 2026-10-29 in this order, with these reads (6's deploy and
checks, in the status section).

- **Order.** Release after 5.1 and apart from it, so Stage 6's rollback has a
  commit that keeps 5.1. Web first: only web migrates, and the new readers
  must name the category null before any writer stores a category slice. Then the
  worker, then all four crons, of which `shipblu-nightly` is the writer
  (`cleanup && rollup_metrics`, 00:00 UTC).
- **An old nightly against the new schema is safe.** It inserts four
  single-dimension slices with `category_id` null, which satisfy the key and
  the CHECK, and loses only the category slices of the three days it rebuilds.
- **`0053`** is one `CREATE INDEX` on `routing_decisions`, not concurrent,
  since a migration runs in a transaction: a SHARE lock for the milliseconds
  the table takes to read, which is young and small in production. An ingest
  inserting a routing row on a channel in a category mode waits that long.
  **`0055`** is the same shape on the same table: `routing_decisions(started_at)`,
  which every range-bound read on `/reports/routing` and the history's first
  and last use, where the channel index leads on a column none of them
  constrains.
- **`0054`** adds `rollup_days.categories_computed_at`, nullable with no
  default, so a catalog change under an ACCESS EXCLUSIVE lock held for
  milliseconds. Every existing row reads unfiled, which is the truth: each was
  rolled up before categories. The overview then names those days in its By
  category section until the history's rebuild files them; the first Stage 6
  nightly files its three. A rollback's nightly writes `computed_at` alone, so
  a day it rebuilds reads unfiled again once Stage 6 is back.
- **Before web, read-only:**
  - the duplicate-slice query and the two-dimension query (both 0 on
    2026-10-28);
  - §5.5's `pg_stat_activity`;
  - not within 23:50–00:10 UTC.
- **The first Stage 6 nightly** proves the writer with no hand write.
- **The `rollup_metrics from=2026-08-18` rebuild** writes no category rows
  today: nothing in production carries a category. Its moment is after 4.2's
  `backfill_category_ai mode=apply`, and again whenever the backlog is
  re-filed. It runs from the worker's shell, on Stage 6 code, with the user's
  go-ahead.
- **Rollback.**
  1. Stop the writers: the nightly and the worker go back first.
  2. Count category rows, then
     `delete from metrics_daily where category_id is not null`. This is
     required whenever any exists: the old web reads one as a second totals
     row.
  3. Redeploy web.

  `0052`'s column, key and CHECK stay, since the old code satisfies all three.

## Verification queries (run after each stage, read-only)

| Stage | Question                                                  | Shape                                                                                                                                                 |
| ----- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Every comment ticket on a comment channel, and only those | `count(*) filter (where (coalesce(external_id,'') ~ '^(facebook\|instagram):comment:') <> (channel in ('facebook_comment','instagram_comment')))` = 0 |
| 1     | No comment reply queued as email                          | `jobs` where `type='send_email'` joined to comment-channel messages = 0                                                                               |
| 1     | The SLA did not change under comments                     | Comment tickets created after 1.2 with a null `sla_policy_id` = 0, and every one on the default policy (Q11)                                          |
| 1.3   | The CHECK is live and validated                           | `pg_constraint` for `conversations_comment_channel_matches_external_id`: one row, `convalidated = true`, matching `db/sql/008`                        |
| 1.3   | Nothing refused since                                     | No `process_webhook` attempt since failed on a `conversations` insert; no Meta delivery unprocessed (1.3, as built)                                   |
| 2     | Detector still writing                                    | `subcategorised` events in the last hour > 0 during traffic                                                                                           |
| 2     | Old names gone                                            | No `pg_class` relation named `ticket_categories%`, `conversation_categories%`, `category_metrics_daily%` or `ai_category_runs%` before Stage 3        |
| 3     | Registry seeded                                           | 3 active rows; every `route_group_id` resolves to a non-manual group                                                                                  |
| 4     | Classifier healthy                                        | `ai_category_runs` (label `live`) errors = 0; p90 message→run < 10 s; `unknown` share per channel; calls per ticket                                   |
| 4     | Ownership honoured                                        | No `jev:category` event after a non-Jev `category_changed` on the same ticket, ordered by the stamped `created_at`                                    |
| 5     | Nothing stranded                                          | Live `routing_decisions` rows not `decided` whose window ended more than 10 minutes ago = 0                                                           |
| 5     | Routes match categories                                   | `outcome='category'` rows whose `to_group_id` ≠ the category's `route_group_id` at decision time = 0                                                  |
| 5     | Routed means assigned                                     | `outcome='category'` tickets still unassigned N minutes after `decided_at`, broken down by group and strategy                                         |
| 5     | Nothing taken by accident                                 | `outcome='taken'` per week, which should be near 0; each one is read                                                                                  |
| 6     | One row per slice                                         | `group by day, group_id, agent_id, channel, category_id having count(*) > 1` = 0 (a fact once `metrics_daily_slice_key` exists)                       |
| 6     | One dimension per row                                     | `num_nonnulls(group_id, agent_id, channel, category_id) > 1` = 0                                                                                      |
| 6     | Categories never exceed the totals                        | per day and column, the category slices' sum above the totals row = 0 days                                                                            |
| 6     | Category slices match the tickets                         | yesterday's `tickets_created` per category slice = worked tickets created that Cairo day by `category_id`                                             |
| 6     | The routing report adds up                                | `/reports/routing`'s outcome counts for a window = `routing_decisions` grouped by `channel_id, shadow, outcome` over `started_at` in it               |

## Risks not closed by the design

- **The evaluation rests on very few tickets.** Sales on Facebook DMs is
  about 70 classifiable tickets so far. The archive backfill in `record` mode
  helps, but merchant support may take months to reach 30 labels.
- **Sales versus merchant support is hard to tell from words.** An existing
  merchant asking about rates (`billing.pricing`) and a prospect asking about
  rates (`commercial.pricing_enquiry`) can write the same sentence, and no
  record tells them apart in production. Expect merchant support to be the
  weakest class until shipping accounts are linked.
- **A wrong answer settles, and merchant support routes on thin evidence.**
  Q5 routes merchant support to Merchant Care from the first day of `apply`,
  before its precision can be measured on 30 labels. A false merchant answer on
  the first message therefore sends a sales or customer ticket to Merchant Care,
  and stops a later, correct answer from re-routing it.
  - **Bounding it.** A supervisor reads every merchant route for the first two
    weeks (4.2), and "Hand to <group>" undoes one in a click.
  - **Stopping it.** Emptying the route group stops merchant support routing
    without stopping it labelling.
  - **Going further.** A per-category "may settle" flag makes a class
    record-only, behaving like `unknown`.
- **Customer text goes to TypeSafe a second time per message.** The
  data-processing caveat recorded for canned suggestions
  (`docs/PROJECT-STATE.md`, the canned-suggestion section) applies. The support
  lead confirmed on 2026-10-20 that TypeSafe's terms cover it (Q16), and
  `docs/PROJECT-STATE.md` records that beside the canned-suggestion caveat in
  4.1.
- **Two classifiers each run an `on_update` pass at creation.** A rule "group
  is Sales and priority is urgent" fires on whichever pass comes last. Rules
  are level-triggered, so the last pass sees both facts. The router's own pass
  replaces the category classifier's pass rather than adding a third.
- **The webchat widget's open/closed line uses the channel's default group's
  calendar** (`lib/widget/session.ts:98`), before any category exists. On a
  `category` webchat channel it can disagree with the routed group's
  out-of-hours reply.
- **Inbound Sales Team reclaims after 10 minutes.** A routed sales ticket
  bounces back to the queue whenever its holder is offline for 10 minutes
  before the first reply. That is configured on purpose, but it is worth
  knowing.
- **Escalation counts from the ticket's creation, not from when it entered
  the group** (`worker/handlers/assign-sweep.ts:206`). A route lands within
  minutes, so this is harmless, but it is not exact.
- **A person can end a route by taking the ticket.** In working hours, an agent
  who opens a held ticket from "My groups" and assigns it ends the hold. The
  "Routing…" badge says what they are doing, and nothing stops them, which is
  deliberate: a person is never overruled.
- **Closed in 1.2, on review: an automation's `send_reply` could answer a
  comment in public.** `sendCannedReply` now refuses one on any comment ticket
  (`isCommentTicket`, so a comment still on its platform's channel too), before
  1.2's condition builder offers the comment values that would aim a rule at
  them. A rule may answer a comment again only with a trigger that names the
  comment, which the engine does not have; that stays the support lead's call.
  What follows is the risk as recorded before. The
  auto-response picker keeps an every-channel rule off comments (1.1); the
  automation engine has no such guard, and `deliverAutomatedReply` on a comment
  ticket goes out through `send_meta` as a comment reply. The engine's
  `channel` fact is the stored column (`lib/rules/facts.ts`), so any rule a
  comment ticket satisfies reaches it: one naming no channel, one saying
  `channel is not email`, and — until the backfill moves the old rows — one
  saying `channel is facebook`. Q11 keeps conditions on the platform, which
  after 1.2 stops only the last. Latent: production has three automation rules
  and none sends a reply (read 2026-10-20). Closing it is a refusal in
  `sendCannedReply` itself, by channel or external id — not a rule-editor check,
  which `channel is not email` walks past — and whether a comment may ever be
  answered by a rule is the support lead's call, in its own change.
- **Re-selecting the SLA before the first response changes today's behaviour**
  for a group move made before anyone answered. That is deliberate (decision
  3), but anyone reading the old `onGroupChanged` comment needs the new one
  beside it.

## Decisions taken with the support lead (2026-10-20)

Each question this plan raised, its default, and the answer. The numbers are the
ones the stages cite (Q2, Q5, Q8, Q11, Q12, Q15).

1. **What Jev classifies.** The new category only. Jev's _subcategory_ answers
   stay a shadow measurement, and promoting them is a separate, argued change.
   _Default accepted._
2. **Names.** "Category" on screen, beside an unchanged "Status category".
   Arabic: التصنيف for category and التصنيف الفرعي for subcategory, which also
   sets 2.A's handbook text. _Default accepted._
3. **A fourth value.** **Courier jobs** is added, for couriers and outsourcing
   companies looking to work with or for ShipBlu. `unknown` stays the escape
   hatch for greetings and content-free openers. _Changed from the default
   (no fourth value)._ It has no route group (see Still open).
4. **Category and subcategories are independent.** _Default accepted._
5. **Where each category routes:**
   - Sales → Inbound Sales Team.
   - Merchant support → Merchant Care, from the first day of `apply`. _Changed
     from the default, which held merchant support back until its own
     evaluation reached 30 labels; see Risks and 4.2._
   - Customer support → Customer Care.

   Support is unused once the three are staffed. That moves every channel's
   default group (0.6).

6. **The hold window.** 5 minutes, tuned from the shadow data. _Default
   assumed; not separately answered._
7. **A person changing the category.** During the hold it routes the ticket.
   After the hold it relabels, and "Hand to <group>" moves and re-assigns.
   _Default accepted._
8. **Agents see their groups' tickets.** The key stays in `AGENT`, so 0.5
   switches it on for everyone. _Default accepted._
9. **Coexistence numbers never route,** enforced in code. _Default accepted._
10. **Messenger stays in shadow until the Freshworks swap;** Instagram and the
    comment channels go live first. _Default accepted._
11. **The comment channels:**
    - **Names.** "Facebook comments" and "Instagram comments".
    - **Default group.** The same as their platform's channel.
    - **Out-of-hours replies.** Never posted publicly on a comment unless a
      rule names the comment channel.
    - **Existing rules and policies.** None of those naming Facebook or
      Instagram gains the comment values. _Answered: no._ Comment tickets
      therefore take the default SLA policy, as they do today (1.2).
12. **Historic data.** Reports are rebuilt for the comment split from
    2026-08-29. The open backlog is back-classified, without routing, as 4.2's
    last step. _Default accepted._
13. **The rename reaches the database,** URLs, permission keys, the job name
    and the `CATEGORISE_*` variables, keeping stored history. _Default
    accepted._
14. **Permissions.** Every agent may change a ticket's category, and admins
    manage the list. _Default accepted._
15. **SLA.** A ticket's policy may be chosen by its category and/or its channel
    and/or its group. Sales gets its own targets, and the four existing policies
    are restructured as written in 0.2. _Answered: yes._ Three things are
    worth knowing about how that works:
    - **Matching is ordered, not combined.** Each policy is one condition
      over any mix of the three facts, with `all` or `any`. Policies are
      tried by position, and the first that matches decides; their targets
      are not merged. So a specific policy (Merchant Care on chat) sits above
      a general one (any chat channel), and the default is last.
    - **The category is usually not known at the first instant.** It arrives
      seconds, or after a greeting minutes, later. A ticket therefore starts
      on the policy its channel and group give it, and the policy is chosen
      again when the category lands, provided nobody has answered yet
      (decision 3). After the first response the policy holds.
    - **Priority stays a dimension inside each policy.** Every policy prices
      its targets per priority, so "Sales, urgent" and "Sales, low" are one
      policy's two rows, not two policies.
16. **TypeSafe's data-processing terms** cover a second per-message call
    carrying customer text. _Answered: yes._

### Still open

None blocks Stage 1. The first two are needed before Stage 5 turns on.

- **Where courier jobs go.** The default is no route group, so a courier-jobs
  ticket stays in its channel's default group: Customer Care, once 0.6 has run.
  If those enquiries belong to another team (operations, fleet), naming a group
  on the category's row is all it takes.
- **Moving channel defaults off Support.** Customer Care, as 0.6 proposes, or
  another group per channel? The coexistence number "Nayera Mohamed" already
  defaults to Merchant Care and stays there.
- **Whether an automation may ever answer a public comment.** Since 1.2,
  `sendCannedReply` refuses every `send_reply` on a comment ticket. Allowing one
  needs a trigger that names the comment that set the rule off, which the
  engine does not have, and it is a change of its own. The default is never.
- **How a supervisor says a ticket fits no category.** Found building 4.2's
  report: choosing None on a ticket with no category writes nothing, so a
  greeting Jev settled as a category cannot be labelled as one, and that false
  positive never reaches precision. Recording it needs a writer of its own — a
  review event beside the select, say, which the grading reads as "no category"
  — and whether the evaluation needs it before `apply` is the support lead's
  call. Without it, step 3's precision counts only tickets a person put a
  category on.
