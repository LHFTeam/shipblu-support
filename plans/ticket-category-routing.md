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

## Status and handoff (2026-10-21, 22:00 UTC)

A session picking this plan up starts here. Everything after this section is
the design as it was reasoned and as each stage was built. This section says
where the work stands, what comes next and how, and what has already bitten.
Whoever moves any of it updates this section in the same PR. Every figure here
was read from production, Render or GitHub at the time in the heading:
re-read before acting on one.

### Where it stands

| Stage | Code                                                                                                                                        | Production                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Merged: #386 (`01488c9`)                                                                                                                    | Live since 2026-10-20. Its two operational steps were never done (below)                                                                                                                           |
| 1.1   | Merged: #387, then `dev` → `main` in #389 (`1f89219`)                                                                                       | Live since 2026-10-21 10:13 UTC                                                                                                                                                                    |
| 1.2   | Merged: #391 (`31f7379`) and follow-up #392 (`7b7d276`), then `dev` → `main` in #393 (`634a28d`), which also carried another session's #390 | **Done.** All six services live on `634a28d` by 17:38 UTC, worker first. The user ran the backfill and the rollup from a shell, so neither left a `jobs` row. Every check that follows reads clean |
| 1.3   | Built in #395 (with this section), not merged. As built below                                                                               | —                                                                                                                                                                                                  |
| 2–6   | Not started                                                                                                                                 | —                                                                                                                                                                                                  |

**1.2's checks, read at 21:54 UTC.**

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

1. **Review and merge 1.3 into `dev`.** It is built, in #395, as recorded
   under [1.3, as built](#13-as-built).
2. **Merge `dev` into `main` only once 1.3's gate holds.** The gate is a
   read-only query. Read it on the day of the merge and quote it in the PR.
   The gate guards the merge rather than the deploy, because whoever next
   deploys `main` ships 1.3, whatever else they meant to ship.
3. **Deploy 1.3**: web, then the worker, then the crons. Read the lock
   precautions below first, then run 1.3's verification rows.
4. **Stage 2** may start whenever it suits. It is a different seam from Stage
   1, but its migrations land one at a time, after 1.3 (deploy rule 2).
5. **Before Stage 5**, a person does 0.2's reorder and 0.6's staffing, and the
   support lead answers the questions still open (below).

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
  never null, because `channel` is NOT NULL and every arm coalesces. Do not use
  `NOT VALID`: the point is that every row is checked, once.

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

  Locally, migrate `shipblu_test` again before `npm run test:db`. A database
  migrated before the branch has no CHECK, and the suite passes on it.

  As built: the seven fixtures were rewritten, and the one case that existed
  only for a pre-1.2 row (ingest-meta's "a reply on a thread filed before
  comments had a channel") went, with send-reply's and meta-feedback's legacy
  halves. The new test has fourteen cases: seven refused, six accepted, and an
  update that splits the pair.

- **`split_comment_channels` is retired in the same PR.** After the CHECK it can
  match nothing, and its test cannot build a fixture. Remove all of it:
  - `worker/handlers/split-comment-channels.ts` and its `.db.test.ts`;
  - the import and the registration in `worker/handlers/index.ts`;
  - `| 'split_comment_channels'` in `lib/queue/index.ts`;
  - its `JOB_PAYLOADS` entry in `lib/queue/payloads.ts`;
  - its line in `scripts/ci/db-jobs.txt`.

  CI checks that those agree. The job stays in git history and in 1.2's
  as-built note.

- **No runtime code path changes.** `isCommentTicket(channel, externalId)` keeps
  its external-id half, and `pickRule` keeps `ruleChannel`. With the CHECK in
  place both give the channel test's answer, so keeping them costs nothing. And
  if 1.3 is rolled back, they are still what keeps a legacy row from being
  answered in public. What changes are the comments that promise otherwise, or
  that name the retired job:
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
  day, returns 0 on production (`nqbcfnvqqyqawmffgiql`):

  ```sql
  SELECT count(*) FROM conversations WHERE NOT (CASE channel
    WHEN 'facebook_comment' THEN coalesce(external_id, '') ~ '^facebook:comment:.'
    WHEN 'instagram_comment' THEN coalesce(external_id, '') ~ '^instagram:comment:.'
    ELSE coalesce(external_id, '') !~ '^(facebook|instagram):comment:' END);
  ```

  It returned 0 at 21:54 UTC on 2026-10-21. Staging's database
  (`funavpkflkhthegahuay`) has only its first migration applied and holds no
  tickets, so its first deploy, whenever staging is resumed, adds the CHECK to
  an empty table.

- **Deploy order and precautions.**
  - **Order: web first, then the worker, then the crons.** Only web's
    preDeploy (`npm run db:migrate`) replays `db/sql`. The worker and crons
    change only in that the retired job is gone, and nothing enqueues it.
  - **The lock.** `ADD CONSTRAINT … CHECK` holds an ACCESS EXCLUSIVE lock on
    `conversations` while it validates every row (about 69,000). `db/migrate.ts`
    sets `lock_timeout` to 10 s, so one long transaction on the table fails the
    deploy.
  - **Just before triggering:**
    - run the gate again;
    - list what holds a lock on `conversations`, which must show nothing more
      than a few seconds old: `select a.pid, l.mode, a.state, now() -
a.xact_start as age, left(a.query, 80) from pg_locks l join
pg_stat_activity a using (pid) where l.relation =
'conversations'::regclass and a.pid <> pg_backend_pid();` (§5.5's query
      lists only transactions older than five minutes, which the role's
      `transaction_timeout` reaps, so it reads clear when this would not);
    - stay clear of the nightly rollup at 00:00 UTC.
  - **If the preDeploy fails,** the previous release keeps serving and the
    constraint is absent. Read the deploy log, then the gate query.
- **1.3's verification**, read-only, after the deploy:
  - `SELECT convalidated, pg_get_constraintdef(oid) FROM pg_constraint WHERE
conrelid = 'conversations'::regclass AND conname =
'conversations_comment_channel_matches_external_id'` returns one row, `true`,
    matching the file.
  - No ingest has failed on it since: `SELECT count(*) FROM jobs WHERE type =
'process_webhook' AND created_at > '<deploy instant>' AND last_error ILIKE
'%Failed query: insert into "conversations"%'` is 0. A refused comment fails
    its `process_webhook` job, not the web, and the row does not name the
    constraint: `errorMessage` keeps drizzle's `Failed query: …` text, and
    Postgres's "violates check constraint" is on its `cause`, which nothing
    stores.
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
      ALTER TABLE conversations
        DROP CONSTRAINT conversations_comment_channel_matches_external_id;
    END IF;
  END $$;
  ```

  Its preDeploy drops the constraint, so nobody types DDL against production,
  and every later replay finds nothing to drop and takes no lock. Not a bare
  `DROP CONSTRAINT IF EXISTS`: `ALTER TABLE` takes ACCESS EXCLUSIVE before it
  checks `IF EXISTS`, so every later deploy would lock `conversations` to do
  nothing — the failure `001_extensions_and_triggers.sql`'s trigger loop
  records from 2026-08-19. Rolling back 1.3 never needs 1.2 rolled back,
  because no code path depends on the CHECK.

### Working on this repo without the outgoing session's context

- **`dev` is the integration branch, and GitHub keeps deleting it.** The
  repository's "Automatically delete head branches" setting removes `dev`
  whenever a `dev` → `main` PR merges: at #389, and again at #393. Both times
  it was recreated from `main` with the user's agreement. Before branching,
  run `git ls-remote origin dev`. If it prints nothing, ask the user, since
  creating `dev` is a push to `dev`, which `AGENTS.md` forbids an agent to do
  unasked. Then branch from `origin/dev`, open the PR into `dev`, and leave the
  `dev` → `main` merge to the user. The lasting fix is turning that setting off
  or protecting `dev`, and that is the user's call.
- **A `dev` → `main` merge ships every session's work.** `634a28d` carried #390
  beside 1.2. Before choosing a stage's deploy order, read
  `git log origin/main..origin/dev` and every migration in it (deploy rule 7).
- **Deploys are by hand.** `autoDeploy` is off on every production service.
  Render's workspace is `tea-da1f2lgjo6nc738hobmg`:

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
  `pg_ctlcluster 16 main start` if it is down. Then migrate (again, whenever
  `db/sql` or a migration changed) and run:

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
- **A gap older than this plan.** An automation's `send_reply` on a
  `whatsapp_bot` ticket would be queued as an email, as `carrierFor`'s docstring
  in `lib/tickets/outbound.ts` records. It was found during 1.1, and nothing
  here depends on it.

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
  Priority has been in `apply` since 2026-10-13, despite
  `docs/PROJECT-STATE.md` §1 still saying it "ships off".
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
make, it is listed again under [Questions](#questions-for-the-support-lead) with
the default this plan assumes.

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
- **The `--custom` flag is not used.** It saves the _old_ snapshot, so every
  later generate would prompt again.

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
picker is a [question](#questions-for-the-support-lead), not a dependency.

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
    `message_id`), as `backfill_categorise_ai`'s table is
    (`db/schema/categorise-ai.ts:54-64,123`). So the same message can be
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
`stateFor` functions, `lib/categorise-ai/request.ts` and
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
| Anything else (never entered routing, or already decided)    | `reselectPolicyBeforeFirstResponse`, then `afterTicketUpdate`, as priority does.                         |

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
3. Under the lock, `routing_decided_at` is set, the row moves to `decided`, and
   `reselectPolicyBeforeFirstResponse` runs on the group as it now stands.
4. `assignConversation` runs, then the held out-of-hours reply.

This is the creation pass's own order (`lib/tickets/lifecycle.ts:26-43,93-99`).
The other way round leaves a Sales agent holding a Merchant Care ticket.
`assign_group` never touches the assignee, and `auto_assign` returns
`already_assigned` before it moves anything. It would also tell the customer
Sales' hours.

If the process dies between phases 1 and 3, the hold lasts until
`settle_routing`. That job completes a decision whose phase 1 is more than a
minute old. A younger one belongs to a caller still in flight, and the job
leaves it alone.

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
  `auto_assign` with no group means "assign within the current group", and it
  is held like any other assignment.

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

- **Priority.** Its queue priority is 40: behind `classify_category`'s 30, so
  an answer already queued at the window's end is applied first, and ahead of
  the default 100.
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
`endHold`'s callers, `apply.ts`, `settle_routing` whatever its outcome — calls
`maybeSendAutoResponse` after its commit. The claim on `auto_responded_at`
keeps it to one send. It gains two guards, because its documented
precondition, that every caller has just reopened the ticket
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

The settled design in `README.md:352-357` ("The routing rules are the automation
rules") is amended in the same PR, with the reasons at the top of this file. The
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
   _type_. `routing_mode`, the routing outcome and the classifier mode are
   created with `CREATE TYPE`, whose values may be used and defaulted in the
   migration that creates them.
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
    backfill moves it (`ingest-meta.db.test.ts` pins both).
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
    handoff](#status-and-handoff-2026-10-21-2200-utc).
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
returns 0, with all six services on 1.2. Adding the CHECK validates every
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
   the job. Never deploy an old commit such as `1f89219` instead: `main` also
   carries other work since then, #390 among it. First
   deactivate every `auto_responses` row naming a comment channel: 1.1 still
   matches one, without `answersRequester`, so a passer-by's comment would earn
   a public acknowledgement addressed to the requester. Then the same for
   automation rules, since 1.1's `sendCannedReply` has no comment refusal: list
   the active rules with a `send_reply` action as a `SELECT` first
   (`actions::text like '%send_reply%' and is_active`), and deactivate each
   one a comment ticket could satisfy — a comment channel named, no channel
   condition, or a channel condition that excludes rather than names — unless
   the support lead approves it by name.
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

- **Schema.** The four table names, two column names, two enum type names, and
  every explicit index string on those tables are renamed in `db/schema`:
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
  - it renames the three implicit `_pkey` indexes, guarded on `indrelid`.

  A guard on the name alone would one day find Stage 3's constraint on the new
  `ticket_categories` and fail every replay.

- **Raw SQL with no database test is tested before merge.** These were never
  executed in CI: `categoryTotals`, `areaTotals`, `channelTotals`,
  `causeCoverage`, `ruleScores`, `categoryUsage` and `runLabels`. They get a
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

  This exact sequence, including the later roll-forward, is rehearsed on the
  Supabase branch before 2.B merges.

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
  2.A redirect from that path.
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

**3.2 — Where a person sets it at creation.** Web, worker and crons; no schema
beyond one column.

- A form gets `default_category_id`, recorded at creation as a
  `category_changed` by `form:<slug>`. Like `priorityChosenBy`, this is read at
  the time and never from the form as it stands later.
- The console's new-ticket form gets a category chooser, which counts as
  owned. Production has no forms today, so this can follow later without
  blocking anything.

### Stage 4 — Jev sets the category

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
    of new traffic, following the `backfill_categorise_ai` precedent.
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
- **Runs table.** `ai_category_runs`, whose name is free after the gate.
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
  - **Until Stage 5:** an applied answer calls
    `reselectPolicyBeforeFirstResponse`, then `afterTicketUpdate`, as
    priority's does.
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

**4.2 — Shadow, then evaluate, then apply.** Operations, plus the report.

1. Run `backfill_category_ai mode=record` over the archive, then switch the
   live classifier to `shadow` for at least two weeks.
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
5. **Back-classify the open backlog (Q12).** Preconditions:
   - the classifier has been in `apply` for a week;
   - `backfill_category_ai mode=apply dryRun=true` has been read, including
     which rules it would wake.

   Then run it without `dryRun`.

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
  - `README.md:352-357` is amended, with the reasons at the top of this file.
  - `AGENTS.md` gets a "Routing by category" section with decision 5's rules.
  - The handbook gets an article on routing, the hold, the "Routing…" badge
    and "Hand to <group>".

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
  slice reconcile (`lib/reports/rollup.ts:171-190,533-559`), then
  `rollup_metrics from=` rebuilds history.
- Live open/awaiting by category beside `channelLoad`.
- `/reports/routing` shows, per channel:
  - routes by outcome;
  - time to decision against the window;
  - the fallback and `taken` shares;
  - routed tickets still unassigned.

  Those are the numbers that say whether the window and the threshold are
  right, and whether ask 5 is met.

## Verification queries (run after each stage, read-only)

| Stage | Question                                                  | Shape                                                                                                                                                 |
| ----- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Every comment ticket on a comment channel, and only those | `count(*) filter (where (coalesce(external_id,'') ~ '^(facebook\|instagram):comment:') <> (channel in ('facebook_comment','instagram_comment')))` = 0 |
| 1     | No comment reply queued as email                          | `jobs` where `type='send_email'` joined to comment-channel messages = 0                                                                               |
| 1     | The SLA did not change under comments                     | Comment tickets created after 1.2 with a null `sla_policy_id` = 0, and every one on the default policy (Q11)                                          |
| 1.3   | The CHECK is live and validated                           | `pg_constraint` for `conversations_comment_channel_matches_external_id`: one row, `convalidated = true`, matching `db/sql/008`                        |
| 1.3   | Nothing refused since                                     | `jobs` whose `last_error` names the constraint = 0                                                                                                    |
| 2     | Detector still writing                                    | `subcategorised` events in the last hour > 0 during traffic                                                                                           |
| 2     | Old names gone                                            | No `pg_class` relation named `ticket_categories%`, `conversation_categories%`, `category_metrics_daily%` or `ai_category_runs%` before Stage 3        |
| 3     | Registry seeded                                           | 3 active rows; every `route_group_id` resolves to a non-manual group                                                                                  |
| 4     | Classifier healthy                                        | `ai_category_runs` (label `live`) errors = 0; p90 message→run < 10 s; `unknown` share per channel; calls per ticket                                   |
| 4     | Ownership honoured                                        | No `jev:category` event after a non-Jev `category_changed` on the same ticket, ordered by the stamped `created_at`                                    |
| 5     | Nothing stranded                                          | Live `routing_decisions` rows not `decided` whose window ended more than 10 minutes ago = 0                                                           |
| 5     | Routes match categories                                   | `outcome='category'` rows whose `to_group_id` ≠ the category's `route_group_id` at decision time = 0                                                  |
| 5     | Routed means assigned                                     | `outcome='category'` tickets still unassigned N minutes after `decided_at`, broken down by group and strategy                                         |
| 5     | Nothing taken by accident                                 | `outcome='taken'` per week, which should be near 0; each one is read                                                                                  |

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
