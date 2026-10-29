# AGENTS.md

Working notes for coding agents on ShipBlu Support — a self-hosted helpdesk
(email, WhatsApp, Facebook, Instagram, web chat, knowledge base, customer
portal) built as one Next.js app plus a background worker over Supabase
Postgres.

These rules apply to the whole repo. An `AGENTS.md` deeper in the tree wins for
its own subtree; an explicit instruction from the person you are working with
wins over both.

## Rules that must not be broken

- Run `npm install` before anything else. A fresh clone has no `node_modules`
  and every check below fails with a module-resolution error until it does.
- Never push to `dev` or `main`. Branch → PR into `dev` → merge.
- Sanitise attacker-controlled HTML on write, never on read.
- Verify state before any write against live infrastructure. See
  [Tool use](#tool-use-and-live-infrastructure).

Most of what this list used to carry is now enforced on every pull request — see
[What CI checks](#what-ci-checks). What is left is what a machine cannot check: a
push to `dev` or `main` it cannot prevent, a sanitiser call it cannot place on the right
side of the read/write boundary, and a production write it cannot verify for
you.

## Read these first

Three sources, in this order, before you plan anything:

| File                    | What it answers                                                       |
| ----------------------- | --------------------------------------------------------------------- |
| `README.md`             | What the system is, and the design decisions behind it — with reasons |
| `docs/PROJECT-STATE.md` | What is actually live, what is left, and the traps that already bit   |
| `plans/*.md`            | The reasoning behind the most recent features                         |

`docs/PROJECT-STATE.md` §6 lists bugs that each cost real time. Read it before
debugging anything that looks like an environment, deploy, timezone or
threading problem — the answer is often already there.

Do not re-derive settled decisions. If a design looks wrong, check whether the
README already explains why it is that way, and say so explicitly if you still
disagree.

## Setup and commands

Node 22 (`engines` pins `>=22 <23`).

```bash
npm install                    # required first; nothing below works without it
cp .env.example .env.local     # DATABASE_URL at minimum
npm run db:migrate             # drizzle migrations + replay of db/sql/*.sql
npm run dev                    # web app
npm run worker:dev             # queue consumer, separate terminal
npm run job -- cleanup         # run one scheduled job by hand
```

| Command                           | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `npm run test`                    | Vitest unit tests                        |
| `npm run test:db`                 | The database tier, `*.db.test.ts`        |
| `npm run typecheck`               | `tsc --noEmit`                           |
| `npm run lint`                    | ESLint (flat config)                     |
| `npm run lint:strict`             | Type-aware ESLint over the source tree   |
| `npm run format` / `format:check` | Prettier                                 |
| `npm run build`                   | Next production build                    |
| `npm run db:generate`             | Generate a migration from schema changes |
| `npm run db:migrate`              | Apply migrations + post-migration SQL    |

Iterating on one thing — use these rather than the whole suite:

```bash
npx vitest run lib/kb/slug.test.ts     # one file
npx vitest run -t 'strips the quote'   # one test, by name
npx vitest lib/hours                   # watch mode, one directory
npx eslint app/\(console\)/ticket-actions.ts  # one file
npx prettier --write AGENTS.md         # one file
```

`tsc` has no useful single-file mode here; run `npm run typecheck` whole.

## What CI checks

`.github/workflows/ci.yml` runs on every pull request, in three jobs:

| Job          | What it runs                                                                         |
| ------------ | ------------------------------------------------------------------------------------ |
| `verify`     | `tsc`, `eslint`, `lint:strict`, `format:check`, `vitest`, `knip`, `build` — one each |
| `repo-rules` | `scripts/ci/repo-rules.mjs`, and migration drift against `db/schema/`                |
| `database`   | migrations, `db/sql/`, DB-only jobs, `*.db.test.ts`, on real Postgres                |

Run the same thing locally when you want the answer sooner — the `verify` job
calls these same npm scripts, so `npm run lint` fails on a warning here as it
does there:

```bash
npm run typecheck && npm run lint && npm run test && npm run knip && npm run build
npm run lint:strict
node scripts/ci/repo-rules.mjs
```

`repo-rules.mjs` reads the tree through `git ls-files`, so a file you have not
`git add`ed is invisible to every rule: a new route importing a new module reads
as `dead-exports` on the module, and a new page that breaks a rule passes. Stage
new files before you run it.

`lint:strict` is `eslint.strict.config.mjs`: the type-aware rules — floating and
misused promises, `await` on a non-promise, a switch that no longer covers its
union — over `lib/`, `worker/` and `app/`. They are kept out of `lint` because
reading the whole program is what makes them slow. A `default` arm counts as
covering a switch, because it is somebody's decision about the unknown case.

**`npm run build` is not optional, which is why CI runs it separately.** Several
failure modes in this project — React's export-condition resolution under the
wrong `NODE_ENV`, ambiguous route segments — appear only at build time and never
in `tsc` or the dev server. `npm run build` pins `NODE_ENV=production`
deliberately; if a build fails with
`Cannot read properties of null (reading 'useContext')`, check the environment,
not the React version.

`scripts/ci/repo-rules.mjs` runs the conventions that used to be prose in this
file — the env-var catalogue, the job registry, the `db/sql` rules, the
confinement of the delivery payload, and the rest. Each lives in its own module
under `scripts/ci/rules/`, named as the violation labels it, and carries the
reason it exists; what they share is `scripts/ci/lib.mjs`, and the table naming
which ones run is `RULES` in `scripts/ci/rules.mjs`. If one of them is wrong,
change it there and say why in the same commit; do not add your call site to an
exemption list. A rule with a `<name>.test.mjs` beside it is tested against a
small git repository built per case (`scripts/ci/fixture.mjs`), which runs the
function `RULES` pairs with the rule's name; a change to what it accepts or
refuses changes a case there too.

`knip` gates **dependency hygiene and nothing else** — `dependencies`,
`devDependencies`, `optionalPeerDependencies`, `unlisted`, `unresolved` and
`binaries`, named as a positive `include` allowlist in `knip.jsonc` so a knip
minor that adds a default-on category cannot silently widen a blocking job.

Its unused-_export_ categories are excluded, and `files` with them. Run bare it
reports ~110 exports, which is not a backlog: it mixes genuinely dead code with
functions used inside their own module (drop the `export`, not the function) and
with exports whose only consumer is `repo-rules.mjs` reading them by regex —
deleting `handlers` on knip's word would break the job-registry check. `files`
is excluded for a different reason: no `entry`/`project` is declared, so the
`worker/` tree is reachable only through the `worker` script in `package.json`,
and landing a module one commit before importing it would fail a check whose
message talks about dead files. `npm run knip:exports` is the hand-run and
covers exactly the complement of the gated list — all eleven of knip's other
issue types, which is checked against its `ISSUE_TYPES` rather than assumed; `knip.jsonc` carries the
reasoning, including which two categories the first attempt got wrong.

**A dead value export is gated all the same, by `repo-rules.mjs` rather than by
knip.** The two arrived from opposite directions in the same fortnight and are
complementary rather than duplicates, so do not delete either as redundant: knip
answers "is this dependency real", `dead-exports` answers "does anything import
this". The second asks the module graph — an export is live when another module
names it in an `import` or a re-export — so it separates the three cases above
instead of conflating them, and it carries the framework-convention exemptions
(`GET`, `metadata`, `dynamic`) that make knip's bare number ~110 in the first
place. It checks **values only**; an exported _type_ is deliberately out of
scope, because most are referenced only from the signature they name and
flagging them would push the codebase to un-export shapes callers need. So
`knip:exports` is what still covers the type half — not, as it read before this
check existed, the whole of unused exports.

Three things CI still cannot check, so they remain yours:

- **Which side of the read/write boundary a sanitiser call sits on.** CI keeps
  `sanitize-html` in one module. It cannot tell that you called it on the way in.
- **Raw SQL outside a job handler.** The `database` job runs the handlers and
  the `*.db.test.ts` tier; a query in a page or an action that no database test
  reaches is still only ever executed in production.
- **Anything about live infrastructure.** See
  [Tool use](#tool-use-and-live-infrastructure).

## Layout

```
app/(console)/   agent console: inbox, contacts, kb, reports, admin
app/(auth)/      login, first-admin setup, invites
app/help/        public help centre and customer portal (served on its own host)
app/api/         webhooks, SSE, widget, attachments, health
app/widget/      the embeddable chat widget iframe
lib/<domain>/    all business logic, one directory per domain
components/      shared UI primitives (ui.tsx) and small client components
db/schema/       Drizzle table definitions
db/migrations/   generated — never hand-edit
db/sql/          idempotent SQL Drizzle cannot express, replayed after migrating
db/runbooks/     SQL a person runs by hand (a rollback); never replayed, each tested
worker/handlers/ one file per job type, registered in worker/handlers/index.ts
proxy.ts         Next 16 middleware: host routing + the signed-out redirect
```

**A rollback runbook in `db/runbooks/` lasts until the next migration.** It
undoes a migration by renaming back and deleting that migration's row, and a
later deploy applies the migration again only while it is the newest one
applied. So its test reads `db/migrations/meta/_journal.json` and fails as soon
as anything follows that migration, with a sentence saying what to do: the PR
adding the new migration deletes the runbook and its test, and writes the way
back from the new state into the stage's plan.

Put logic in `lib/`, not in route files. A page or action authorises, calls into
`lib/`, and revalidates. A page never imports `db/client`, and neither does a
layout or a helper module beside it: a query there runs nowhere before
production, and in `lib/` a `*.db.test.ts` can reach it. CI checks every module
under `app/` except server actions, `route.ts` handlers and tests (`page-db`).
`app/probe/page.tsx` is the one exception, because reaching the database from a
page is what the render probe tests.

The layers point one way, and `npm run lint` holds them: `lib/` and `worker/`
never import from `app/`, and `components/` never import from `db/` — not even a
type, since a component that needs a row's shape can take it from the `lib/`
function that reads it.

**A page under `(console)` outside `admin/` brings its own scroll container.**
The shell is `h-dvh overflow-hidden` so the inbox can own the full height and
manage its own panes, which means a page that does not open an
`app-scroll relative h-full overflow-y-auto p-6` wrapper is not merely unpadded —
every row below the fold is rendered where nobody can scroll to it, and the page
reads as half-finished rather than as broken (§6.53). `admin/layout.tsx`
supplies one for everything beneath it; nothing else does. CI checks it
(`console-scroll`): every other console page either says `overflow-y-auto` or
renders `<InboxShell>`, which owns its panes. **A scroll container is also
`relative`.** `sr-only` is `position: absolute`, so inside an unpositioned pane
it is placed against the document, past every `overflow-hidden`, and stretches
the page under the shell. Scrolling past the end of the pane then moves the
whole console (§6.81, twice). CI refuses a class list that scrolls vertically
unless a position applies wherever it scrolls — unprefixed or under the scroll's
own variant, on every branch of the expression, with no `static` to take it
back (`scroll-positioned`).

## Do not edit

Generated or managed elsewhere. Change the source, or the tool that writes them.
CI regenerates the migrations and fails on any diff, and rejects a pull request
that modifies or deletes a migration that already exists:

| Path                | Change it via                                 |
| ------------------- | --------------------------------------------- |
| `db/migrations/**`  | edit `db/schema/`, then `npm run db:generate` |
| `package-lock.json` | an `npm` command, never by hand               |
| `next-env.d.ts`     | Next writes it                                |
| `.env`, `.env.*`    | local only, never committed                   |
| `.next/`, `out/`    | build output                                  |

Database-level behaviour that Drizzle's DSL cannot express goes in `db/sql/`,
not into a generated migration.

One exception, for an order `db/sql/` cannot give: it replays after every
migration, so SQL that a generated migration needs run _before_ it goes in a
migration of its own, made by `npx drizzle-kit generate --custom`. That writes
an empty file and a snapshot copied from the last one, so the drift check
regenerates nothing; the file is filled in by hand before anything applies it,
and is guarded so a database that does not need it passes straight through.
`0047_free_old_pkey_names` is the one so far: a fresh database had to give up
the old `ticket_categories_pkey` name before `0048` created the new table.
Once applied it is as fixed as any other migration.

## Conventions

**TypeScript.** Strict. Path alias `@/*` maps to the repo root. Prettier and
ESLint enforce formatting and unused-identifier rules — run them, do not
hand-police them.

**Comments carry the reasoning.** This codebase explains _why_: the trade-off
taken and what the naive alternative would have broken. Match it. A comment
restating the code is noise here. Same for commit messages.

**Server actions** (`app/**/actions.ts`, or a `<domain>-actions.ts` sibling)
start `'use server'`, and `'use server'` appears nowhere else — not in `lib/`,
not inline in a page — because every export of such a module is a public POST
endpoint and reviewers look for those in action files. CI checks both
directions. Actions follow one shape: authorise (`requireAgent()` /
`requirePermission()` plus `can()`), write, `revalidatePath()`, return a state
object with `error: string | null`. Never
trust an id or address arriving in a `FormData` field — re-read the row
server-side.

Two shared modules carry that shape, so an action file does not spell it out
again. `lib/http/form-data.ts` reads the fields — `text()`, `int()`,
`optionalNumber()`, `localeOf()` and `uuidField()`, which answers `null` for
"not set" and `undefined` for "not a uuid" because Postgres raises 22P02 on a
malformed one and an action that throws returns no state at all.
`lib/http/action-state.ts` is the answer: `ActionState` and `ok()`, whose
`nonce` changes on every success so a form keyed on it clears twice in a row.
The inbox's action files — `reply-`, `ticket-`, `meta-`, `shipment-`,
`side-conversation-` and `subcategory-actions.ts` — answer with
`app/(console)/action-state.ts`, the same state plus a `message`, kept outside
every `'use server'` file so a component can name the type without importing an
action module. Admin settings actions answer with `SettingsState` / `AdminState`
from `admin/settings-shared.ts`, a plain module for the same reason. `contacts/`
and `kb/` build theirs on `lib/http`'s `ActionState`. The sign-in, availability
and new-ticket forms and the three help-centre forms have shapes of their own,
and the help centre's are not a mistake to tidy: its `error` is a `StringKey`
the page translates, not a sentence. A new action file anywhere else answers
with `lib/http/action-state.ts`.

A form — in the console, the help centre or the sign-in pages — submits through
`useActionForm` (`components/use-action-form.ts`), not a bare
`<form action={…}>`, whenever a native reset could move one of its fields:
anything uncontrolled, and any controlled select or checkbox. React 19 resets a
form after every function action, a refusal included, so the bare shape wipes
the reply an agent or a customer is about to correct and leaves a controlled
`<select>` disagreeing with the state everything around it is drawn from
(§6.80). The hook's `key` is also the one to clear a form on after a success: it
holds the last success's nonce, where `state.nonce ?? 0` fell back to 0 on a
refusal and remounted the form. A form whose success redirects needs no key,
even back to its own route: Next remounts the page for a server action's
redirect. A form of hidden fields, buttons and controlled text boxes has nothing
a reset moves and may keep `action=`; the purge panel is one. Spread the hook's
`form` onto the element, `<form {...form}>`: a form given only its `action`
still submits, through React's reset. The `form-reset` repo rule refuses that
shape anywhere under `app/` where it can see a field the reset moves. The hook
also turns an action that throws into a refusal, so a dropped connection keeps
the draft rather than falling through to `global-error`; a form whose retry
reaches a customer passes `LOST_SEND`, and one whose `error` is a `StringKey`
passes `{ lost: 'errorNoAnswer' }`. The type insists on that last: the hook's
own sentence is not a key, `t()` finds nothing for it, and the customer would be
told nothing at all.

**An action's revalidation is what refreshes the page; the form does not.** Next
renders the current page into a server action's response whenever the action
revalidated anything — whatever path it named — and the client applies it with
the answer. So nothing re-reads the page after a success: a `router.refresh()`
there is a second full render, and on a ticket page it ran beside
`LiveUpdates`' own (§6.89). What a form does next — close an editor, put a
composer away — goes in `useActionForm`'s `onSuccess`. The other side of it is
that an action answering success without revalidating leaves the screen as it
was, and the `action-revalidates` repo rule refuses that: every success an
action answers (`ok()`, or `{ error: null }` outside the help centre) comes after
a `revalidatePath`, a `redirect` or the shared `refresh()` on every branch that
reaches it. A refusal that returns before anything is written revalidates
nothing, so a control that shows no error, and whose refusal means the screen is
out of date, re-reads it then (`rereadOnRefusal` in `useFieldAction`).

**Authorisation lives in code.** `proxy.ts` only checks that a session cookie
exists; it cannot tell a revoked session from a live one. It runs on Node.js in
Next 16, not the Edge, so that is a choice rather than a limit — its header says
why. Re-check on every page and every action with `requireAgent()` or
`requirePermission()`. RLS is enabled with zero policies and never `FORCE`. Add
new permission keys to `PERMISSIONS` in `lib/auth/permissions.ts` with a comment
saying why the capability is separate.

**Database.** Two connections: `db` on the Supavisor _transaction_ pooler
(prepared statements disabled), `sessionSql()` for `LISTEN`. Initialise
everything lazily — `next build` imports route modules without runtime secrets,
so nothing may open a pool or read env at module scope. Schema changes go in
`db/schema/` then `npm run db:generate`. A rename asks, for every table, column
and enum, whether it was renamed or replaced, and only at a terminal; a session
without one answers through a pseudo-terminal (Python's `pty`), each answer
named in advance, as Stage 2.B's `0046` was, and never by editing the SQL it
writes. Files in `db/sql/` must be idempotent and must not use
`CREATE INDEX CONCURRENTLY`; the whole file runs in one implicit transaction.
New tables get RLS enabled by a loop in `db/sql/` — do not add it by hand. All
three are checked, the first two by replaying the files and the last by asking
the database which tables ended up covered. A lock that must outlive one
statement belongs to a transaction: an advisory lock is `pg_advisory_xact_lock`
taken inside `db.transaction` (`lockThread` in
`lib/tickets/live-conversation.ts`), never `pg_advisory_lock`, because the
pooler hands the backend to another client when each transaction ends, and a
session lock would stay behind on it, held for somebody else.

**postgres.js must never pipeline through the transaction pooler.** Once every
connection is busy, postgres.js writes the next query onto a connection still
waiting for its answer. Supavisor v2.9 hands that backend back at the first
ReadyForQuery and loses the replies owed after it, and nothing can make
postgres.js give up on a query it has sent. A loss the pooler records as idle
costs a connection until the process restarts, and one it records as busy until
the five-minute `transaction_timeout` kills the backend; that is the 2026-10-11
freeze (§6.91). The admission gate in `db/client.ts` keeps postgres.js below
that point for every query and transaction on `db`. Anything that reaches the
pool without passing `unsafe()` — a tagged template on `getSql()` — is gated by
hand, as `databaseProbe()` is, and the `pool-confinement` repo rule keeps
`getSql()` and `$client` inside `db/client.ts` and tests. Nothing cancels a
query postgres.js holds but is not running: that cancel strands a connection in
`connecting` for up to an hour, or stops a transaction's queue for good, so the
deadline waits for the query instead. Nor does anything report a `COMMIT` as
failed because it is slow: its place is counted lost, and the caller waits for
the real outcome. `max_pipeline: 0` is not the fix: it also
breaks `begin()`. A page that reads several things at once, or re-reads itself
while something moves, should weigh what that costs on eight places:
`allLimited`, and a version to poll rather than the render
(`/api/admin/onboarding-progress`).

**The delivery platform.** `lib/shipments/platform.ts` is the only thing that
knows how to read a parcel off `api.shipblu.com`, `lib/shipments/sync.ts` the
only thing that writes what it says, and `lib/shipments/detail.ts` the only thing
that reads `shipments.data` back out. Three rules hold there. The endpoint's
`?pin=` is **not checked**, so a tracking number is the only credential guarding
the recipient's name, address, phone and COD amount — the payload therefore lands
only in `shipments.data`, and the public shape must never grow a passthrough
field or the tracking page publishes all of it (`docs/PROJECT-STATE.md` §6.38).
Anything drawing that payload goes through `publicTracking()` or
`agentTracking()`, which build a fresh object from a named field list rather than
spreading what they were given: a page picking its own fields off `data` makes
the privacy promise only as good as the newest page. CI enforces both halves —
who may touch the column, and that the public type stays a named list. An unauthenticated lookup
also never writes a row — `lib/shipments/lookup.ts` reads an unknown number
straight through — or the number space becomes a way to fill `shipments`.
`tracking_events` arrive in **no order at all**, so nothing outside
`platform.ts` — which sorts them — may read `events[0]` or the last element as
"latest". A return is signalled by `rto_requested` and **not** by the status,
which stays `delivery_attempted` for the whole of it, so anything deciding what a
parcel is doing reads the flag: draw `RETURN_STEPS` rather than `TRACKING_STEPS`,
and word the events after `returnProgress().startedAt` through
`returnStatusLabel`, because `in_transit` means opposite things on the two legs
(`docs/PROJECT-STATE.md` §6.40). And the calendar dates (`estimated_date`,
`preferred_date`) stay strings: `new Date('2026-08-29')` is midnight UTC, which
is 02:00 in Cairo and the day before further west.

A second endpoint, `/api/v1/orders/<platform_order_id>/current-estimated-date/`,
gives the estimate the platform holds _today_ — ten days from the booked one on
a real parcel — and is keyed by the numeric order id, which is why
`shipments.platform_order_id` is stored: the tracking number 404s there. It
returns a full instant whose **time component is an artifact of when you asked**
(two calls three seconds apart differ by three seconds), so take the leading
`YYYY-MM-DD` and never convert through a `Date` — the value carries `+03:00`, so
a call answered after 21:00 UTC reads as the previous day in UTC.

**Background work.** Anything slow, external or retryable is a job — with two
narrow exceptions, written down because they look like violations. The first: a
control an agent presses and _waits on_, whose entire output is the provider's
answer, calls the provider in the action instead. `refreshRequesterProfile`,
`claimThreadControl`, `refreshShipment` and `refreshShipmentDetail` are the four
today. The rule exists so a customer's ticket never depends on Graph being up
and so unattended work gets retried; a person clicking a button is neither, and
queueing it would put the one sentence they are waiting for into a worker log
they cannot read — which is exactly how a missing Meta approval hid for a month
(`docs/PROJECT-STATE.md` §6.27). Where a job does the same work, the provider
call itself stays in one shared function the job and the action both use
(`lib/meta/profile-refresh.ts`, `syncShipment`), so the two paths cannot answer
differently for the same subject; `claimThreadControl` has no job twin. The
reply box's canned-response suggestion (`/api/canned-suggestions`) is the first
exception in a different shape: started by focus rather than a press, and a
route rather than an action, because Next sends a client's actions one at a time
and a provider call made as one would queue the agent's Send behind it. It is
also worth little late — an answer that lands after the agent has started typing
is held, not drawn, and appears only if the box is emptied again or on a later
focus — so a queued retry, landing later still, buys almost nothing. Nothing
retries: a failure is recorded on its row, and that message gets no suggestion.
The second is the Embedded Signup exchange — `beginCoexistenceOnboarding` in
`lib/whatsapp/onboarding.ts`, behind the `connectBusinessAppNumber` action —
forced by the code Meta's window hands the browser: it lives thirty seconds and
is spent once, so a queued job could not be sure of running before it died, and
a dead code is a business sent through Meta's window again. Only what the code
forces happens in the action — exchange it, prove the token reads the WABA the
browser named, seal it, record the attempt — and everything after the exchange
is the `complete_coexistence_onboarding` job, run with the stored credential, so
a closed tab abandons nothing and the first run, a retry and a later "copy the
history again" cannot differ. Everything else is a job: add the type
to `JobType` in `lib/queue/index.ts`, a handler under `worker/handlers/`, and
register it in `worker/handlers/index.ts`. CI checks that the three agree, and
that every cron in `render.yaml` names a type that exists. Use `dedupeKey` for anything a webhook retry could
duplicate — but note that **a key is spent for good, not until its job
finishes**: `jobs_dedupe_idx` is a plain unique index over the whole table, so
the conflict target still matches a job that completed months ago, and a job that
reached `dead` is never cleaned up at all. Key on the subject only where the work
is genuinely once-ever for it (one send, one media download). Anything that might
legitimately need to run again for the same subject — a profile refresh, a
per-row backfill — must make its handler idempotent and enqueue without a key,
or the retry silently does nothing. Webhooks persist to `webhook_events` and
return 200 immediately; they never do the work inline.

**A Facebook or Instagram batch is retried whole when any item in it fails**
(`process-meta-webhook.ts`), so the items that worked run again on every retry,
and the one that failed lands after siblings newer than it. Every item type
there therefore does nothing on a second run and moves a ticket's "last"
columns only forward (`latest()`), before `onCustomerReply`, which starts the
reply clock from the newest of them under the ticket's lock — and not at all
when an agent has answered since. A new item type meets both, or a retry
duplicates it or winds a ticket back. A WhatsApp batch still
retries only for history or when everything failed, which is a change of its
own to make.

**The worker is a pool, and a running job's lock is kept fresh.**
`worker/pool.ts` refills a slot as each job finishes, so a slow job holds only
its own slot, and refreshes the lock of every job it is running each
`HEARTBEAT_EVERY_MS` so the stalled sweep returns only a dead worker's jobs.
Two consequences for handlers. Nothing but the job itself ends a hung job, so
every outbound call in a job path carries a deadline (`lib/http/deadline.ts`).
And a job still runs at least once, not exactly once: a worker stopped
mid-job — a deploy's shutdown window is short — leaves its job to be run again,
so a handler must tolerate a second run. `completeJob` and `failJob` write only
over the attempt that holds the row — `completeJob` also over that attempt
reclaimed and not yet claimed again, since a run that finished needs no second
one (§6.85).

`npm run job -- <type>` takes trailing `key=value` pairs as the payload
(`npm run job -- backfill_meta_profiles force=true limit=50`), so a handler's
options are reachable without hand-inserting a `jobs` row.

**A payload is a schema, written once.** `jobs.payload` is jsonb, so a handler
is handed whatever somebody wrote into the row — a caller, a replay, or those
`key=value` pairs. A new job type gets an entry in `JOB_PAYLOADS` in
`lib/queue/payloads.ts`; `enqueue` is typed from it, so a caller sending the
wrong shape does not compile, and the handler reads the row with
`parseJobPayload(job, type)` rather than checking fields in its own words. Use
`z.strictObject` for any job an operator runs through `npm run job`, and always
for one with a `dryRun`: a mistyped key is then refused, where `z.object` drops
it and `dryrun=true` becomes a run that writes. `z.object` is for payloads only
code writes. Every operator-run schema is strict now; the last four to move were
`backfill_meta_profiles`, `sync_stale_shipments`, `rollup_metrics` and
`sync_shipment`, where a typo was dropped and the default ran, so
`backfill_meta_profiles limt=50` walked every contact. A type with no entry
still takes any object, so the entry is a convention the compiler does not
force.

An instant in a payload is read by its schema, never by the handler. jsonb
holds it as text, and `new Date()` reads text with no offset in the host's zone
and a bare date as UTC midnight, so `since=2026-10-01T00:00` meant one instant
on Render and another on a laptop in Cairo (`docs/PROJECT-STATE.md` §6.102).
`scanBound` in `payloads.ts` reads a backfill's `since` (inclusive) and `until`
(exclusive) in Cairo, a date alone as that whole day, and an explicit `Z` or
offset as given, and hands the handler a `Date`; its `z.input` stays a string,
so `enqueue` takes the text and the reading happens only where the job runs. A
calendar date that names a report day is not an instant and stays a
`YYYY-MM-DD` string: `rollup_metrics`' `day`, `from` and `to` are cut into
instants by the handler, with `dayWindow` in the reporting zone, which comes
from `business_hours` and so cannot be known to the schema.

**`PermanentJobError` is for a failure no retry can fix**, and it sends the job
to `dead` on its first attempt instead of spending the rest. That means input
that is wrong: a payload failing its schema (which `parseJobPayload` throws), or
a subject row that is gone — `subjectGone()` in
`worker/handlers/subject-gone.ts`, since a job is only ever enqueued after its
row commits, so a missing row is "not any more", not "not yet". It is **not**
for a provider that said no — that is transient, or it is recorded on the row a
person reads, as `send_whatsapp` marks the message failed — and not for a job
type with no handler, because the web service can enqueue a type before the
worker that runs it is deployed and a retry is what rescues that job.

**Logging goes through `logger(tag)`** from `lib/log.ts`: one line per event,
`[tag] message key=value`. The tag is usually the job type or the domain
(`send_whatsapp`, `presence`), and **the prefix is the format** — Render's log
search and `docs/PROJECT-STATE.md` quote lines by it, so moving a message moves
it word for word. Success fields are primitives by type, so a request body
cannot be spread into a line; `warn` and `error` take the caught value as their
second argument, so the stack and any `cause` still print. It never reads
`env()`, for the reason `lib/webhooks/log.ts` gives, and that file stays the
only thing that prints a raw delivery. It strips the credential headers and
nothing else — the body prints verbatim, customer content included — which is
why `LOG_ALL_INCOMING_WEBHOOKS` is for a debugging session only. `npm run lint`
refuses a bare `console.*`. The files where `console` is the point — the logger,
the webhook dump, `scripts/` and the other command-line entry points, and two
hand-run diagnostics — are named in `eslint.config.mjs`, each with its reason. A
single call site that must stay a bare `console` takes an
`eslint-disable-next-line no-console -- <why>`, not a place on that list.

**Environment variables** are declared in `lib/env.ts` (Zod, parsed lazily) and
in `render.yaml` in the same commit — CI fails a pull request where the two
disagree, in either direction. Three env groups hold them:
`shipblu-support-shared` for what is identical in every environment, `shipblu-support-production` for
anything that can reach a real customer or the production database, and
`shipblu-support-staging` for staging's own — declare a value in exactly one of them.
Render gives service-level variables precedence, and a key declared in both
places silently takes the service value; two groups linked by one service and
both declaring a key is the same trap without the precedence rule to settle it.
A value never appears in the file: `sync: false` is not allowed inside an env
group, so each group lists its dashboard-owned keys as a comment beside its
literal ones. A module reachable from the search parser must read `process.env` directly
rather than `env()`, which validates the whole schema (see
`lib/shipments/detect.ts`). The one place "one Meta app, one credential" does not
hold is Instagram, which this app is connected to **twice**: through the Facebook
Page the account is linked to, and directly through **Instagram Login**. The
second is a separate identity inside the same app — its own host
(`graph.instagram.com`), its own token (`INSTAGRAM_ACCESS_TOKEN`), its own app
secret (`INSTAGRAM_APP_SECRET`, also read as `META_INSTAGRAM_APP_SECRET`) and its
own App Review vocabulary (`instagram_business_*` rather than `instagram_*`).
`lib/meta/connection.ts` names the two and decides which one a call goes out
over; nothing else may re-derive that. Three rules follow, each of which has
already cost a customer channel:

- **Both app secrets are tried on every `instagram` delivery, and neither can be
  removed while both connections are live.** Unsetting one resumes 403s for that
  half of the traffic — §6.26 and §6.29 cost 3,888 dropped deliveries between
  them, and the second was the fix for the first applied a step too early.
- **`standby` is a fact about one connection, not about the account.** The
  handover protocol belongs to the Page, so a Page delivery arriving in `standby`
  says nothing about a reply sent with the Instagram account's own token.
- **A Meta doc example proves nothing until you check which host its URL names.**
  The two connections differ in the host, the token, the ids _and_ the field
  vocabulary — §6.35. The referral webhook field is the smallest instance:
  Instagram spells it `messaging_referral` and the Page `messaging_referrals`,
  and Graph rejects the whole field list rather than the one bad name.
- **An App Review _feature_ is not a permission, and nothing here can check
  one.** A feature — Human Agent, Business Asset User Profile Access — is
  granted to the _app_, appears in no token's `scopes`, and is **not** covered by
  a role on the app the way a permission is at Standard Access. So
  `check_meta_permissions` reporting every capability granted says nothing about
  it, and the App Dashboard's usage counter for one cannot leave zero before the
  grant: a call stopped at the capability gate is never counted against the
  feature it was stopped by. `FEATURES` in `lib/meta/capabilities.ts` lists the
  ones this system depends on so the job can name what it did not check — §6.61.

**`HUMAN_AGENT` may only be put on a message a person actually wrote.** The tag
is Meta's Human Agent feature and its allowed usage is a human agent answering
inside seven days; putting it on something the software composed is a false
statement about work nobody did, and the feature reference is explicit that
unapproved usage risks messaging restrictions on the app. So `messagingTag(state,
author)` takes the author as a required argument, `send_meta` derives it from
`messages.author_agent_id` rather than from the job payload — the column
recording the person is the only thing that can substantiate the claim — and
`automatedReplyBlocked` in `lib/tickets/outbound.ts` stops **every** automated
sender — the automation engine, the out-of-hours acknowledgement, the CSAT
survey and the survey's thanks after a tapped rating — at **24 hours** on a
Facebook or Instagram direct message, not at seven days. The seven days belong
to a human.
It is shared with WhatsApp's template rule because a guard only some of the
senders apply is not a guard, and it refuses before the row is written:
delivery refuses it too, but by then the customer's timeline carries a reply
that permanently failed. Route a new automated sender through it and through
`carrierFor`, which is the same lesson twice — `send_csat` kept private copies
of both and so surveyed Facebook tickets by email.

**One exception, and it is Meta's, asked for by name.** Messenger's customer
feedback card has a tag of its own, `CUSTOMER_FEEDBACK`, valid on that card and
nothing else, for seven days after the customer's last message. So the survey
asks `automatedReplyBlocked(ticket, now, 'feedback_template')`, and `send_meta`
tags the card through `feedbackTemplateTag`, a function beside `messagingTag`
rather than a case in it: `HUMAN_AGENT` on the card and `CUSTOMER_FEEDBACK` on
anything else are then type errors, not branches to get right. Nothing else may
pass that kind; on Instagram, which has no card, it changes nothing.

Two things it must be given rather than guess. **A Meta comment ticket has no
messaging window**: it is answered on the comment edge, which `send_meta` reaches
before it consults the clock, so the guard takes the ticket's channel and
`external_id` and never blocks one — a `facebook_comment` or `instagram_comment`
ticket by its channel, and one back on its platform's channel, as rolling back
Stage 1.2 leaves every one (below), by its `external_id`. And **the clock is the
real one** — the ingest lifecycle hands
a message's own `sentAt` down as its timestamp, and that is exactly
`lastCustomerMessageAt`, so passing it as `now` compares a value with itself and
reports every window open. That is precisely the replayed backlog the guard is
for.

**A comment is a channel; the platform is not.** `facebook_comment` and
`instagram_comment` are values of the `channel` enum, so what is keyed on a
conversation's channel — `conversations.channel`, `channels.type`, the copies
frozen into `csat_surveys` and `canned_suggestions`, rules, auto-responses and
reports — can tell a public comment from a direct message. What names where a
delivery came from keeps the platform: `contact_identities.channel`,
`webhook_events`, `messages.meta.platform`, the `external_id` prefix and
every Graph call. A commenter is the same Facebook or Instagram user as the one
in the inbox, and an identity split by channel would make them two contacts. So a conversation's channel is compared through
`isMetaChannel`, `metaPlatformOf` and `isCommentChannel`
(`lib/tickets/channel-policy.ts`), never as `=== 'facebook'`, which silently
stops matching the comment half. Four comparisons stay strict on purpose.
Three are Messenger's feedback card — the `feedback_template` case of
`automatedReplyBlocked`, `decideSurvey` choosing the card and `send_meta`
sending it — which exists only in a Messenger thread. The fourth is
`recordMetaFeedback` matching a tapped rating's platform against its survey's
ticket; beside it, it refuses a comment by its external id too, so a tap can
never thank a commenter on the public thread. A TypeSafe request sends the
platform rather than the channel, so the vocabulary the model was asked in does
not move under it.

**The database holds the pair.** Since Stage 1.3 of
`plans/ticket-category-routing.md`, `conversations_comment_channel_matches_external_id`
(`db/sql/008_comment_channel_check.sql`) refuses a ticket whose channel and
external id disagree: a comment id off a comment channel, a comment channel
without one, or one holding the other platform's comment. So a comment ticket
is on its comment channel, and a test fixture builds it there too — a
`*.db.test.ts` that inserts a comment id on `facebook` now fails at the insert.
**Detecting a comment is still the channel test _or_ the external id** —
`isCommentTicket(channel, externalId)` in `lib/tickets/channel-policy.ts`, the
one copy every reader calls — on purpose: the plan's rollback of Stage 1.2
undoes the move while 1.1's readers stay deployed. It re-deploys 1.1's ingest,
which files new comments on `facebook`/`instagram`, then moves the old ones
back, and from then on the external id is the only half that answers. Without
it the out-of-hours picker and the survey's thanks would post in public, and the
survey and the console reply would message privately. Meta's direct messages ask
the same of `liveConversationFilter`, so a chat never continues a public thread.
So a test of that shape does not build its ticket on `facebook`: it builds one
the way 1.2 files it and moves it back with `withoutCommentChannelCheck()` from
`lib/testing/db.ts`, which drops the CHECK for one `describe` with the plan's
own SQL and restores it after.
The difference is public wherever the software replies on its own, because a
reply on a comment ticket is posted under the customer's comment where anybody
reading the post sees it. The out-of-hours picker handles it: a rule with no
channel matches every channel _except_ the comment ones, and only a rule naming
a comment channel answers there. The sender then answers only a comment from
the ticket's own requester (`answersRequester`, in `maybeSendAutoResponse`),
because anybody may reply under a customer's comment and that reply is filed
on the customer's ticket; and it names that comment as the reply's target, so
a reply written before the job runs does not become it. The requester is the
root comment's author once the root is stored: a reply stored before its root
opens the ticket under the replier, and the root, when it arrives, makes its
author the requester, and its first line the subject, with a
`requester_changed` event (`adoptRootAuthor` in `ingest-meta.ts`). A later
reply never moves it, because its author is somebody under the customer's
comment. The sender judges the message
the lifecycle hands it by id, never the newest inbound row, which after a
batch retry is a passer-by's reply stored before the requester's older comment. `pickRule` takes the stored channel and
external id and reads a comment filed on its platform's channel as its comment
channel — which the CHECK makes impossible today, and which keeps a rule naming
the platform to that platform's direct messages once rolling back 1.2 has put
comments back there; every caller must supply the external id, so none can skip
the mapping by forgetting it. Its reply leaves
`{{customer_name}}` blank, because the contact's name can have come from a
private channel and the reply is published under the post. **The automation
engine never answers a comment**: `sendCannedReply` refuses a `send_reply` on
a comment ticket, by `isCommentTicket`, because the engine is handed a ticket
rather than the comment that set the rule off — an `on_update` rule fires on a
passer-by's reply as readily as on the customer's — and its reply would be
posted under whichever comment came in last. Whether a rule may ever answer a
comment is the support lead's call, in its own change, with a trigger that
names the comment.

**An agent's reply on a comment ticket names one of the requester's comments
too.** A private reply is delivered to whoever wrote the comment it names, and
Meta allows one per comment, ever, so answering the newest comment on the
ticket can hand a passer-by what the agent wrote for the customer. `sendReply`
names the comment the agent picked in the composer — re-read against the ticket
and its requester, because its id arrives in a form field — or the requester's
newest, and stores it as `meta.commentId`; a public reply takes their newest the
same way, "newest" meaning still on the post where one is. It refuses a private
reply to a comment deleted from the post, or to one already answered by a
private reply that has not failed: Meta refuses both, but only once the reply
is on the timeline, marked failed. The composer disables the same two
(`canTakePrivateReply`). `send_meta` never falls back to anybody's comment: a
row naming none takes the requester's newest (`lib/tickets/reply-comment.ts`),
and a private reply with none of theirs is refused on the row. The composer's list and that
read ask one question, `isRequesterComment` (`lib/meta/comments.ts`). Because an
outbound row now carries `commentId`, `moderatableComment` takes the row's
direction: a moderation request naming the reply would otherwise act on the
customer's comment.

Graph request shapes are written down in `lib/meta/comments.ts` and
`lib/meta/send.ts` rather than built inline, and asserted there against Meta's
reference, because **a wrong shape is invisible in the response**: Graph refuses
a nonexistent edge with `100 "Unsupported post request … does not exist, cannot
be loaded due to missing permissions, or does not support this operation"`, which
is word for word what it says about a comment the customer deleted. When adding
or changing one, read the node reference **for the version `GRAPH_VERSION`
actually names** (`lib/meta/graph.ts`, the one declaration every Graph client
imports) — an edge missing from it is a finding, not an omission by the
doc, and removal notices sit on a separate legacy page that a search for the
working endpoint will not surface (§6.43).

The direct-message body splits on the **platform**, which is the one place it is
not the connection: `messaging_type` is documented for Messenger and appears in
neither Instagram send reference — not the `graph.facebook.com` one nor the
`graph.instagram.com` one. Both list `recipient`, `message`, `sender_action`,
`payload` and `reply_to`, and describe the human agent case as tagging the
response. Branching on the connection instead would leave the Page-borne half of
Instagram sending a Messenger body into an Instagram inbox.

**Only the tagged Instagram body drops it; the in-window one keeps it**, and that
asymmetry is a statement about evidence, not about Meta. The tagged path has
never once succeeded, so moving it toward the documentation costs nothing. The
in-window path is the channel's live traffic and works today with
`messaging_type: RESPONSE` on it — and with `INSTAGRAM_ACCESS_TOKEN` unset it
goes out over the Page connection to `graph.facebook.com`, where the parameter is
documented as part of every send. Do not tidy the two halves into consistency
without a live round trip: the risk is every in-window Instagram reply, to fix a
send that has never worked.

A WhatsApp business account's access token is read
directly from `process.env`, for a different reason: its variable's _name_ is a
database value, so it cannot be in the schema — and must therefore start `WHATSAPP_TOKEN_`, or
an admin typing a variable name would be choosing which secret gets sent to Meta
as a bearer token (`lib/whatsapp/accounts.ts`). That variable is the middle of
three sources. `tokenForAccount` resolves **stored → `WHATSAPP_TOKEN_*` →
`META_PAGE_ACCESS_TOKEN`** (`resolveCredentialSource`, pure and tested beside
`resolveAccount`): a credential Meta minted for the account through Embedded
Signup wins over a variable an admin named, which wins over the shared token.
Storing one clears the variable, so a row written through the console never
has two sources and the order only matters for a row edited straight in the
database. **A stored credential that cannot be opened throws and never falls
through** to the next source. Falling through is the obvious implementation,
and it is the "went out from the wrong WABA" failure the module already
describes: a send authenticated as a different credential either fails with a
sentence about the wrong thing or, worse, succeeds from a business the customer
never messaged.

**The stored WhatsApp credential.** `whatsapp_account_credentials` is the one
credential the database holds, and it exists on an instruction: if coexistence
needs the backend to store a token, store it securely and properly. A business
token minted by Meta's Embedded Signup is one no person ever holds and no
variable can name — Meta hands it to the server for a WABA the popup may have
just created — so the alternative to storing it is a step on Render or in
Business Manager per number, during which the number answers nobody and the
24-hour window for copying the phone's chats runs out. Four properties make
holding it acceptable, and each is enforced rather than asked for:

- **The row is ciphertext under a key the database never sees.** AES-256-GCM
  under `WHATSAPP_CREDENTIAL_KEY` (`lib/whatsapp/credential-envelope.ts`), with
  the key's id in the envelope, in the `key_id` column and in the authenticated
  data beside the account and WABA ids — so an envelope copied onto another
  row, or left on a row whose WABA id was edited, fails to open rather than
  sending one business's credential on another's behalf. Losing the key loses
  every stored credential, by design: the recovery is reconnecting each number
  through Meta's window, one popup each.
- **No code path on the web service decrypts a stored token.** That is a
  property of the code paths, not of what the service could do — it holds the
  symmetric key, because it seals the token on the way in. `storedTokenFor` is
  the one export that hands a decrypted token out (the reseal opens envelopes
  and returns none), `lib/whatsapp/accounts.ts` the only module that may call
  it, and the resolvers built on it (`tokenForAccount`,
  `credentialsForAccount`, `credentialsForPhoneNumberId`) may be imported only
  from `worker/` — or from `lib/whatsapp/onboarding-complete.ts`, which only the
  worker may import. CI holds all of that (`credential-confinement`), and with
  it that only `lib/whatsapp/credentials.ts` names the table, that it never
  selects a whole row, and that `CredentialStatus` — the shape the admin page
  renders into an RSC payload — has no field that could carry the secret. An
  action that needs the token enqueues a job.
- **One source per account.** Storing a credential clears `token_env_var`, and
  an account holding one refuses a variable and a change of WABA id
  (`storedCredentialEditRefusal`) — "forget the stored credential first" —
  because two sources make "which token sent this?" a question with two
  answers.
- **Everything that happens to one is a row** in `whatsapp_credential_events`:
  `stored`, `resealed`, `refused`, `removed`, naming the agent and surviving the
  account, so "who removed the credential for WABA X, and when?" still has an
  answer once both rows are gone.

Two things about the key's variables are deliberate. Their names do not start
`WHATSAPP_TOKEN_`, and must not: `parseTokenEnvVar` lets an admin name any such
variable as a bearer token, so a key so named could be typed into the "token
variable" box and sent to Meta. And both stay plain `z.string().optional()` in
`lib/env.ts` — never a `min()` or a `regex()` — because `env()` parses the whole
schema on every page, action and connection, so a format rule there turns one
mistyped key into a console that does not load rather than a WhatsApp
connection that says what is wrong with it (the `LOG_ALL_INCOMING_WEBHOOKS`
lesson, `docs/PROJECT-STATE.md` §2). `parseKeyring` validates at first use and
`coexistenceReadiness()` reports it on the page before any button. Rotation is
`WHATSAPP_CREDENTIAL_KEY_PREVIOUS` = old, `WHATSAPP_CREDENTIAL_KEY` = new,
`npm run job -- rotate_whatsapp_credentials dryRun=true` and then without, then
unset `_PREVIOUS`; the dry run opens every envelope it would move, which is what
proves the previous key is the one the rows were sealed under before anything
depends on it.

**A WhatsApp reaction is stored as a message and is not one.** It arrives as
`type: 'reaction'`, from the customer or echoed from our own number, and
`parseWebhook` files it apart from both. `ingestWhatsAppReaction` puts the row on
the person's newest conversation with that number, closed or not — nowhere, when
that is a copied history, and never on a ticket with another of our numbers —
and changes nothing else — no
clock, `last_message_at` included, no reopen, no ticket of its own, nothing
downstream of a message — for the reasons `applyMetaInteraction` gives for a
Facebook or Instagram reaction, though unlike that path it keeps a row. The
row stays a `kind: 'reply'`, with the delivery in `raw_body` naming the
message it is about, so the timeline draws it on that message
(`lib/tickets/reactions.ts`) — and as a line of its own only when that message
is not on the ticket; and so anything that
picks "the latest message" or "what the customer last said" for what it says
leaves reactions out: `notReaction()`
in a query (`lib/tickets/not-reaction.ts`), `isReaction(meta)` over rows already
in hand (`lib/whatsapp/reaction.ts`), held to the same answer by
`not-reaction.db.test.ts`. A new reader that forgets shows a 👍 as the
customer's last words — it was the inbox preview, the canned suggestion's anchor
and the language automated replies went out in.

**A media message's text can be a stand-in nobody wrote.** A file sent without
a caption is stored with the words ingest wrote for it — `[image]`,
`[voice note]`, `[document: awb.pdf]`, `[2 attachments]` (`displayText` in
`lib/whatsapp/parse.ts` and `lib/meta/parse.ts`) — and they stay stored,
because the inbox card, the subject and search need something to show. A chat's
thread leaves one out only where `isMediaStandIn` (`lib/tickets/message-media.ts`)
rebuilds it from the row's own type, voice flag and filename and the file is
drawn in its place. A bracket regex would also hide a caption like
`[urgent] where is my COD`, the `[story_mention]` that is the only sign of a
story, and the name a document was sent under. What the customer _said_ is a
different question, with a different rule, below.

**What the customer said looks past every label of ours, not only the stand-ins
a thread hides.** Beside those, a WhatsApp edit, a document's file name and a
pin's address arrive wrapped in a label, and a chat ticket's subject is its
opening message's first line, so it can be a label too — cut short of its
bracket at 80 characters — or, with no first line, a name ingest gave it
(`UNNAMED_SUBJECT`). A reader that only shows the latest message — the inbox
preview — keeps the label; that is what it is for. Anything that picks one
message as what the customer last said looks past it: `carriesCustomerText()` in
a query (`lib/tickets/carries-customer-text.ts`), and over rows already in hand
`hasCustomerText(bodyText)`, `lastCustomerWords(timeline)` and
`subjectWords(subject)` (`lib/tickets/customer-text.ts`) — one set of patterns,
held to one answer by `carries-customer-text.db.test.ts`. The rule is the whole
message in brackets, so `[urgent] where is my COD` is words. It is not
`isMediaStandIn`, on purpose. It is looser, because a story mention or a
document's name says nothing for the customer though an agent needs to see it.
And it needs no stored file, because the out-of-hours acknowledgement and the
automations choose their language as the message is ingested, before its
`download_media` job has normally stored one. The priority classifier's
question, `requesterLocale`, the ticket page's knowledge panel and canned
picker, and the language a canned suggestion is filed under use it. The earlier
messages both TypeSafe questions send as context (`earlierMessages`) still carry
labels, and so do the subcategorisers, which read every message rather than the
last. A reader that forgets answers an Arabic customer in English for sending a
photo of the damaged parcel, which the out-of-hours acknowledgement and the
automation engine would have done (§6.97).

**A coexistence number is live on the phone and on Cloud API at once**, and
four rules keep the two sides from being read as each other. The copied
history is a record, not traffic (`lib/tickets/ingest-whatsapp-history.ts`):
each thread is one resolved `import` conversation, and nothing a live message
sets off runs for it — no SLA clock, no automation, no out-of-hours reply, no
subcategorisation, no shipment linking, no media download and no 24-hour window,
because `last_customer_message_at` stays null and a live message never
continues an imported conversation. A reply the business typed on the phone
arrives as an `smb_message_echoes` delivery and is the team's reply: outbound,
no author, labelled "WhatsApp Business app", moving `last_agent_message_at`
forward and never `last_customer_message_at` — on a plain support number the
same echo is our own send coming back and stays ignored. It answers only what
came before it: `onAgentReply` stops the next-response clock only when the
reply is at least as new as `last_customer_message_at`, and
`first_responded_at` takes the earliest reply, so the SLA does not depend on
the order deliveries are processed in. With no live conversation on that number,
the business writing first files a _resolved_ conversation (`resolved_at` null,
no survey) that the customer's reply reopens. The copy of contacts
and history is once per onboarding, inside 24 hours of the exchange, with the
Business app open on the phone (`canRequestSync`; Meta's 2593107 and 2593108
both mean "reconnect"). And `saveChannel` carries `coexistence` and the stored
`phoneNumberId` over rather than rebuilding `config` as `{phoneNumberId}`,
which is how a rename used to wipe the connection while the number kept
routing. Nor does a coexistence number route by category, whatever its row
says: moving its tickets between groups changes nothing about who types the
replies (`routingModeOf`, **Routing by category**).

**A Business-app number connected in Meta's own interface is adopted, not
signed in.** WhatsApp Manager and Business Suite can put a phone's number on
Cloud API without Meta's window, so no code is exchanged and nothing is stored.
"Add a number connected in Meta" on its business account's row
(`adoptBusinessAppNumber`) records the attempt with `origin = 'adopted'` and
queues the same `complete_coexistence_onboarding`, which then connects the
number with the account's one source — its stored credential, or the
`WHATSAPP_TOKEN_*` variable it names — and **never with
`META_PAGE_ACCESS_TOKEN`**, the Page's own token, which reaches no WABA
(`docs/PROJECT-STATE.md` §6.28); `credentialFor` refuses it by name. That is
the job's rule: once connected, the number sends through `tokenForAccount` like
any other, so an account whose variable is blanked afterwards falls to the
shared token and its sends fail with the sentence naming it. An
Embedded Signup attempt still uses only the credential it stored. The channel
it makes carries `coexistence.adopted`, and its `onboardedAt` is when it was
added here: Meta's 24 hours for the copy began earlier, when the number was
connected there, so the window drawn can outlast Meta's and a late request is
refused by Meta (2593108) on the row. The variable must hold a system user
token generated for this app and assigned the WABA in Meta's Business settings:
a token for another app is refused before anything is subscribed, since the
subscribe would otherwise subscribe that app, and the number step proves the
assignment.

The same message can reach us under two wamids — the business app's echo of a
reply names it from one chat, a customer's reaction to that reply from another
— so pairing one WhatsApp message with another tries the exact string and then
`wamidKey()` (`lib/whatsapp/wamid.ts`), as the reaction fold does
(`docs/PROJECT-STATE.md` §6.94). String equality stays right where the same
delivery comes back — a redelivery's dedupe, a status update — because Meta
repeats its own wamid there, and the unique index on `channel_message_id` is
what serves it.

**A WhatsApp conversation is the customer and the number they wrote to.**
`ThreadKey` (`lib/tickets/live-conversation.ts`) keys a `whatsapp` conversation
on the contact and the `channels` row of our number, so a merchant writing to
one team member's number and then to another's has two tickets, each answered
from its own phone and measured against its own person. Keyed on the person
alone, the second number's message continued the first number's ticket, an echo
typed on one phone stopped the clocks of a ticket with the other, and a reaction
was filed across them (§6.99). A null `channel_id`, a number no row names,
matches only another null and never "any number": a wildcard would let a ticket
with no row take that customer's messages to every number. The message, the
echo and the reaction build the key through one `threadKey()` in
`ingest-whatsapp.ts`; the bot and the widget stay keyed on the person and emit
the statement they always did. The message and echo paths take `lockThread`,
then look for the live conversation inside their transaction: looked for before
it, a customer's message and the phone's reply processed at once each opened a
ticket, and the half the reply missed kept a clock nothing could stop (§6.100).
A number no row names is filed under **no row**, and only borrows a row's
default group — the plain support row's, else the first WhatsApp row's. It
never routes by category, since there is no row whose mode the router could
re-read when it decides (`planRouting`). Every reader of whose number a ticket
is on — owner, visibility, a handover, a reopen, the ticket page — keys on
`channel_id`, so a row's id
handed out there makes the ticket that number's on some paths and not others: a
coexistence row's files a stranger onto somebody's phone, and the support row's
charged its owner for a number they never held. Each such message logs
`[whatsapp_ingest] no channel row for this number, filed under no row phone_number_id=…`, which usually means a number connected at Meta and never
added under `/admin/channels`. Once the row is added, the customer's next
message continues the ticket open under no row and files it under the row
(`findOrAdoptLive`) instead of opening a second beside it, and
`db/sql/009_whatsapp_channel_backfill.sql` places any left on the next deploy —
under active rows only, the only ones the resolver threads on.

**A WhatsApp number can belong to a person, and then two columns say different
things.** `channels.owner_agent_id` is who owns the number now.
`conversations.accountable_agent_id` is whom a ticket's SLA counts against,
frozen onto the ticket: ownership changes, and `rollup_metrics` rebuilds the
last three days from current state, so reading the owner at report time would
re-file the days before a handover onto somebody who did not hold the phone
then. Both are written only in `lib/whatsapp/number-owner.ts`, and a ticket's
accountability is written at three moments: ingest creating it on an owned number
(`ownerStamp`, in the insert, assignee included), `handOverNumber` (the number's
open and pending native tickets), and its coming back out of resolved or
closed after the number changed hands (`alignAccountable`). That last is
`reopenWithOwner`, which every status writer goes through — `changeStatus`, the
`set_status` action and `reopenResolved`, which every customer's reopen uses —
so a new writer cannot forget it: reopened by hand and then continued by the
customer as an open ticket, which never realigns, a ticket stayed with the
previous owner for good. Six rules hold:

- **Reassignment moves the work, never the breach.** Assignment, reclaim, a
  supervisor's reassignment, an automation and a merge never write
  accountability. A handover or a reopen moves the assignee too, but only off
  the number's previous owner or nobody: a ticket somebody was deliberately
  given stays with them.
- **The owner is outside the rota.** `assignConversation` hands an unassigned
  owned ticket straight back to its active owner — group, hours, presence,
  capacity and skills unasked, the cursor unmoved, though a group a caller
  named is still applied first — so "Unassign" on one returns it in the same
  request. The sweep never reclaims an active owner's own ticket. They answer
  from the phone with the console closed, and every one of those gates
  measures the console. A ticket held for the router is handed to nobody, its
  owner included — but an owned number's new ticket is stamped with its owner
  in the insert and so is never held (`lib/routing/start.ts`).
- **A deactivated owner stays on the number and counts as nobody**
  (`effectiveOwnerId`): new tickets and reopens treat it as a team number — the
  group's rota assigns, and a breach counts against whoever holds the ticket —
  the tickets the owner had stay theirs until a handover, and reactivating them
  restores the number. `/admin/channels` warns.
- **Whose breach it is reads `accountableOrAssignee()`**
  (`lib/tickets/accountable.ts`) everywhere that says so — the rollup's agent
  slices as `accountableOrAssigneeAt` (as of each figure's own instant, from the
  `accountable_changed` events, so rebuilding a day after a handover leaves its
  figures where they were; every figure but CSAT, which stays with the agent
  each survey was about), the live board's Breached, `agent_backlog_snapshots.breached_count`
  and `sla_breached.data.accountableAgentId` — so the dashboard and tomorrow's
  report name one person. What somebody is carrying — open, awaiting a reply,
  the capacity check — stays on the assignee.
- **An owner sees what counts against them.** `heldByOrInGroupsOf` ORs in
  "accountable to me, or on a number I own" on both of its branches, so every
  reader of visibility inherits it; and the inbox asks `ownsANumber`, so an
  owner in no group is offered Unassigned and All open rather than Mine alone.
- **A handover's events carry no `actorAgentId`.** The agent rollup counts every
  event an agent acted in as a ticket they touched, and an admin handing over
  ninety tickets has worked none of them. The admin is named in `data.by` and in
  `channel_owner_changes`, the append-only record of who owned a number when,
  which outlives the channel, the agents and any purged ticket.

Only a `whatsapp` row may have an owner — a plain number or a coexistence one,
never the bot (`channels_owner_only_whatsapp` in `db/sql/003`): the bot and the
shared inboxes are the whole team's. A number
changes hands through its own action, `setNumberOwner`, behind a two-click
confirm that states how many tickets go with it, and never through
`saveChannel`, which three forms post to. See
`plans/whatsapp-number-ownership.md`.

**Explaining a control.** A label short enough to fit a dense table is rarely
long enough to explain itself. `InfoTip` from `components/tooltip.tsx` is the
console's answer — an ⓘ that opens on hover, focus _and_ tap, portalled to
`document.body` because every admin table and the content column clip their own
overflow. Reach for a `Field` hint when the explanation should always be on
screen, and `InfoTip` when it should be one gesture away. Never `title=` on a DOM
element — it never appears on a phone, which is where the console is read, and
CI rejects it.

**A text box rendered inside a form it is not a field of is a `SearchInput`.**
Enter in a single-line input submits the form that owns it, so a search or filter
box there sends whatever that form sends: the knowledge panel's
search, inside the reply form, sent half-written replies (§6.83).
`components/search-input.tsx` owns no form, so no key path reaches one, and Enter
puts a phone's keyboard away instead. No repo rule checks this, because the box
and the form are usually in different files.

**A two-click confirm is `ConfirmSubmit`** (`components/confirm-submit.tsx`), or
`useConfirmClick` from the same module for a control that is not a submit
button. Arm-then-confirm looks like two lines of state and was wrong in the
four places it was first written by hand (§6.90). A button that becomes a
submit inside its own click handler is submitted by that same click, because
React commits the change before the browser acts on the click: the merge row
merged a contact on one click. A confirm swapped in as a different button is where the second click
of a double-click lands, so a double-click deleted. The component keeps one
button, so arming leaves focus on it. It refuses a pointer click within half a
second of the last as well as the platform's own double-clicks, because the
platform's count starts again after a small drift and after every third click;
it refuses a held Enter; it is disabled while the action runs and disarms when
the action settles. It guards only itself, so it must not share a form with a
text field: Enter there submits without it, or confirms it once armed. The
`button-type` repo rule refuses a button whose `type` changes between renders
anywhere else, in the spellings its header lists. It cannot see a confirm
swapped in as a different component, nor a button inside a wrapper that two
`return`s both render.

**One palette, light.** The console, the help centre and the widget render the
same colours whatever the reader's operating system asks for. So: no
`@media (prefers-color-scheme: dark)`, no Tailwind `dark:` variant — it is that
media query spelled shorter — and `color-scheme: light` stays on `:root`, which
is the half a stylesheet cannot express by omission (it is what the browser
paints a select's dropdown, the form-control chrome and the default scrollbar
from). CI checks all three. The rule is mechanical because the failure is: a
`dark:` utility appended to a class list is a colour nobody reviewing the page
can see, and a returning dark block wakes every one of them at once against
tokens stated for light surfaces. A real dark theme is a piece of work —
re-step the tokens, decide whether the help centre follows the console, re-check
the chart series — and `light-only` comes out in that commit.

**The design system.** The console, the help centre and the widget follow the
ShipBlu Support design system, and `app/globals.css` is its token half in three
layers: `@theme` primitives that generate utilities (`bg-blu-500`, `text-2xs`),
`:root` roles and component tokens (`--color-feedback-danger-fg`,
`--color-ticket-open-border`, `--color-channel-whatsapp-bg`, `--console-gap`), and
the legacy names (`--muted`, `brand-*`, `--kb-*`) kept as aliases. Markup reads a
role as `bg-(--color-feedback-danger-bg)`, never a raw palette hue, so a change to
what "warning" looks like reaches every warning at once; a token that is not
declared in `globals.css` renders nothing, silently. A value with no role yet
gets one in `:root` beside its kin (the switch track, the pressed surface, the
rail's washes are there) rather than a primitive at the call site; the logo's
white tile in `components/brand.tsx` is the one exception, because it is the
brand's artwork rather than a state of the interface. Four rules from the system
are easy to break by accident:

- **One blue acts; coral only demands attention.** Every action is the
  `--button-primary` blue (`Button`, or `buttonClass()` on a `Link`). Coral is a
  solid count or a "this needs you now" badge (`CountBadge`, `window-closing`,
  `hub-replied`) and never a button or a tint — there is no `accent` variant.
- **Colour is never the only signal.** Every `Badge` tone carries words and, for
  most, a glyph (a note's lock, a public post's globe, a window's clock); a
  status pill without its label is a bug, not a compact variant.
- **No emoji as icons.** They render differently on every platform; everything
  is a hand-drawn icon in `components/icons.tsx`, and the directional ones
  (`ChevronLeft`, `Reply`, `Return`, `Send`, `External`) mirror themselves in
  RTL — never flip one again at the call site.
- **A `className` on a primitive does not reliably override it** (§6.93). Use
  the `!` suffix or a prop.

The shared shapes live in one place each: `components/ui.tsx` (`Button`,
`buttonClass`, fields with `tone`, `Badge`/`BadgeTone`, `CountBadge`, `Notice`,
`ErrorText` with `inline`, `Card`, `PageHeader`, `Table`), `components/chat.tsx`
(`ChatBubble`, `ChatEvent`; runs grouped by `lib/chat/runs.ts`) for the console
thread, the portal and the widget, `components/shipment-status.tsx`
(`StatusBadge`, `Stepper`) for the tracking page and the ticket sidebar,
`components/details-section.tsx`, `components/conversation-row.tsx` and
`components/views-panel.tsx`. The console's Arabic face is its own family,
`'Tajawal Arabic'`, self-hosted in `app/fonts/` — not next/font's Tajawal, which
would set Latin in Tajawal too (§6.92). Message text is the one exception:
bubbles, reply boxes and a conversation row's message lines take
`font-conversation`, which sets Arabic in `'Rubik Arabic'` (self-hosted beside
it, Arabic range only) and leaves Latin on the surface's own face, so a draft
looks like the message it becomes. Names, times, events and chips keep the
surface font.

**Ticket forms.** A form is a row in `ticket_forms` whose layout is one jsonb
document, parsed on every read by `parseFormElements` against the fields that
currently exist — an element naming a deleted or deactivated field is dropped,
the same answer `lib/rules/conditions.ts` gives a rule pointing at one. Saving
is the exception: `saveTicketForm` refuses rather than dropping, because a save
that silently discards three questions is how a form stops asking about the
warehouse without anybody noticing.

Three rules hold, and each closes something a request could otherwise do:

- **Visibility is computed twice, and the server's pass builds up from nothing.**
  `resolveVisibility` starts with no question visible and reveals each one only
  when the answers justifying it come from questions that are themselves
  visible. Starting from everything and paring down would let an answer to a
  question that was never asked sit in the facts for a pass and reveal a second
  one. An answer to a hidden field is discarded, and a required field behind a
  condition that never fired does not refuse the submission.
- **Placing a field on a form does not override `visible_to_customer` /
  `editable_by_customer`.** `elementsFor` is the one filter, called by the
  renderer and again by the submit path, so a question the page did not ask
  cannot be answered by a request claiming it was — and an internal field placed
  on a public form is left out rather than published.
- **An anonymous submission resolves the address it was given onto whatever
  contact owns it**, exactly as inbound email does, and a web form has no SPF or
  DKIM behind it. So the ticket carries an `unverified_submitter` event with the
  claimed address and the client address, and the console badges it. Do not
  "improve" this by writing a display name onto an existing contact.

**A form's defaults are read when the ticket is created, and never again.**
`createTicket` writes the default priority and the default category inside the
transaction that opens the ticket, each with its event crediting `form:<slug>`
when the form applied it, and nothing reads them back off the form afterwards.
The two differ on the console: a form that places the priority question seeds
it with the default and posts it back, so an agent who leaves it alone is
credited with it, where the category chooser is never seeded and an untouched
one is the form's. Priority learned why first: a default that wrote no event
could be recognised only by reading the form as it is _now_, so a default an
admin added later claimed every ticket the form had ever filed. The category
adds a second reason to be in that transaction rather than after it: the
on-create rules, the first policy selection and assignment's skill match all
read the row before `createTicket` returns. A default retired since is left
off, with a warning in the log, and the ticket still opens — a customer's ticket
is never refused over an admin's retire. An agent choosing a category on the
console's New form instead is under **The ticket category**, below.

Files ride in the server action's multipart body; there is deliberately no
upload endpoint, because on an open form that is an unauthenticated write to the
storage bucket. They go through the same gate as every other answer — read only
when the form asks for them, discarded when the question was behind a condition
that did not fire — since a file accepted outside that gate is the bucket write
the missing endpoint was avoiding. `next.config.ts` sets `serverActions.bodySizeLimit` just above
`MAX_FORM_TOTAL_BYTES` so the limit a customer meets is the one that can explain
itself. `lib/forms/files.ts` is client-safe and `lib/forms/attachments.ts` is
not — the same split `custom-fields.ts` makes, here because the shared file put
`node:fs` in the browser bundle. That split is now checked: CI walks the import
graph out of every `'use client'` file and fails a value import that reaches
`db/schema` or `db/client`, stopping at `'use server'` modules, which are a
boundary rather than a dependency. Only the `node:fs` case fails a build on its
own; one constant imported from a module that touches the schema ships the whole
schema and nothing complains (§6.57).

A form's slug can be Arabic, so anything putting one into a server `redirect()`
goes through `formPath` / `encodeSlugParam`. Next hands the path straight to
`res.setHeader('Location', …)`, which Node rejects above 0xFF — a `<Link href>`
needs none of this, which is why the read side was handled long before the write
side was.

**Ticket subcategorisation.** `lib/subcategorise/` is pure and rules-only; the
live path is `subcategoriseFromMessage`, called from `afterMessageStored`. Four
rules hold, and each of them closes something that has already been reasoned
through:

- **Only inbound `reply` messages are subcategorised.** Not our own replies,
  which would file every ticket where an agent pasted a canned answer, and not
  notes, which would launder an agent's opinion into the `detected` column the
  tuning pass trusts. Bot channels are excluded through `readOnlyChannels()` —
  the bot's menu is a self-service funnel, not support demand, and
  subcategorising it would report the one as the other.
- **The root cause is never detected, only recorded.** The customer does not
  know why it happened: "where is my order" has at least six causes behind it.
  A detector guessing one manufactures confident, wrong data in the exact place
  the team reasons from. The detector names the symptom; the agent names the
  cause on resolve, and accountability is derived from
  `ticket_root_causes.owner` rather than typed, so the two cannot disagree.
- **Every Arabic pattern goes through `anchored()`.** `\b` is defined over ASCII
  `\w`, so it does not exist for Arabic — `/لا/` matches inside `الغاء` and
  inside `ولا`, which is how a "no" rule files a reschedule as a refusal. Text
  is folded before matching, the opposite of `lib/kb/seed.ts`, which compares
  against an unfolded tsvector; this matcher owns both sides.
- **A subcategory is retired, never deleted**, and
  `conversation_subcategories` freezes `subcategory_key` at assignment. The
  rollups key on the same text, so a report drawn last quarter stays readable
  after somebody tidies the taxonomy. The registry tables live in
  `db/schema/config.ts` beside `ticket_statuses` rather than with the join
  table, because `conversations` references them and everything references
  `conversations`.

Confidence is an evidence grade, not a probability, and anything rendering it
says so. `SUBCATEGORISE_AUTO_MIN`, `SUBCATEGORISE_RECORD_MIN` and
`SUBCATEGORISE_DISABLED_RULES` tune the bands and kill one over-firing rule by
key without a deploy — read through `process.env` for the reason `detect.ts`
gives. Under-detection is cheap (it shows as `meta.unclassified`, which has its
own section on the review page — it carries confidence 0, so it can never
surface in a queue ordered best-evidence-first); over-detection silently moves a
number a manager staffs a team from. `combine()` picks its ceiling from the
strongest rule that contributed rather than from how many did, so a pile of
single keywords is held below the auto band however many of them agree. See
`plans/ticket-categorisation.md`.

**The ticket category.** `conversations.category_id` names a row of
`ticket_categories` — sales, customer support, merchant support, courier jobs —
and says which team's work a ticket is: one per ticket, where subcategories are
several, and independent of them (decision 3 of
`plans/ticket-category-routing.md`). On a channel that routes by category it is
what sends a fresh ticket to a team (**Routing by category**, below). Five rules
hold:

- **A routing label, never a claim about the requester.** Words are evidence of
  whose work a message is, and no evidence of who wrote it, so nothing that sets
  a category writes `requester_kind`, and the starter descriptions in
  `lib/categories/registry.ts` speak about what a message asks for.
- **Every writer writes the column and a `category_changed` event in one
  transaction**, the ticket's row locked first where it already exists and the
  event stamped with `CHANGE_STAMP` (`lib/tickets/change-stamp.ts`, priority's
  stamp generalised), so the timeline orders two writers the way the column was
  written — which Jev's ownership rule (`categoryOwned`, below) reads to decide
  whether a person has answered for a ticket. The console and the `set_category` action
  go through `setConversationCategory` (`lib/categories/write.ts`), which writes
  nothing when the value is unchanged, refuses a retired category, and stores
  the key and label at the change so a renamed category still reads as what was
  chosen.
  `createTicket` is the other writer, at creation: the column in its insert and
  the event beside it, for the reason under **Ticket forms**. It cannot call
  `setConversationCategory`, whose own transaction cannot see the uncommitted
  row, so the two share halves instead — `holdCategory`, the registry read,
  share-locked because the foreign key's key-share lock does not make a retire
  wait, and `categoryChangedEvent`, the event's values — and cannot drift apart.
  Where the first refuses a retired category, `createTicket` leaves it off and
  opens the ticket.
- **Before the first response the SLA policy follows the category and the
  group.** `reselectPolicyBeforeFirstResponse` (`lib/sla/index.ts`) chooses the
  policy again after every category write on a ticket that exists commits — the
  backfill of Stage 4 excepted — and after every group move that can come before
  an answer: the console's group case, `assign_group`, and a grouped
  `auto_assign` that moved. A move is one that changed the group —
  `moveToGroupIfElsewhere` (`lib/tickets/move-group.ts`), `movedGroup` off
  `assignConversation` — because a rule naming the group a ticket is in matches
  on every pass, and a second look owed for nothing takes up a raised priority
  as though the group had moved. An `on_create` pass and `createTicket` leave it
  to `applySlaOnCreate`, which runs after both and reads the category itself, so
  a category-keyed policy is the first one chosen and no `sla_recalculated`
  describes a change nothing made. The re-selection counts each clock from its
  own anchor with the finished pauses credited, so it can give clocks to a
  ticket that had none, and it does nothing once somebody has answered, on a
  resolved, closed, deleted, spam or merged ticket, when the same policy wins,
  or when none does. A writer reaches it through `afterRoutingChanged`, the one
  entry point, which re-selects and then, unless that re-timed the clocks
  itself, calls `onGroupChanged` — both private to `lib/sla` — so a move that
  changes the policy is re-timed once and the order cannot be taken the wrong
  way round. It takes what the writers answer — whether the category changed,
  whether the group moved — and is called once the whole change is over: by the
  console's group and category cases, by the engine once its pass is over (so a
  rule that files a ticket and another that moves it choose one policy between
  them), by Jev (`lib/category-ai/run.ts`), by the router once its decision is
  over (`finish()` in `lib/routing/apply.ts`) and by `Hand to <group>`
  (`lib/routing/hand-to.ts`). A write landing on a decision in flight leaves its
  call to the router, with its pass (`deferToRouter`, **Routing by category**),
  and the router's says whether the category or the group now differs from what
  its phase one left. Never from inside a writer, which would choose once per
  action. The `routing-result` repo rule refuses a `setConversationCategory` or
  `moveToGroupIfElsewhere` call, or an `assignConversation` handed a group,
  whose answer is dropped, since that answer is the only thing saying a
  follow-up is owed — and a module calling one that never calls
  `afterRoutingChanged`, unless it exports a writer of its
  own. A caller that must hear of a move through a throw after it passes
  `assignConversation` a `routed` carrier, as the engine does. `onGroupChanged` and
  `onPriorityChanged` still never re-select. Because a ticket can now change
  policy after a breach, an escalation is keyed per policy
  (`settlesEscalation` in `worker/handlers/sla-sweep.ts`).
- **Retired, never deleted, and the key never changes.** Both foreign keys —
  the ticket's and a form's default (`ticket_forms.default_category_id`) — are
  `restrict`; `ticket_categories_key_format` holds the key to lowercase words
  joined by underscores and refuses `unknown`, which Jev answers for "none of
  these". A rule's fact is `category.id`, the uuid off the row as `group.id` is,
  so a loader that forgot a join cannot see null. `deleteGroupIfUnused` refuses
  while a category routes to the group, retired ones included.
- **The name was the subcategory registry's until Stage 2.B.** An event called
  `category_added`, `category_confirmed` or the like is a subcategory event and
  reads as one; `category_changed` is this field's. On a fresh database the old
  `ticket_categories_pkey` was still taken when the new table was created, so
  migration 0047 — hand-written, guarded, a no-op in production — renames the
  three old `_pkey` names first, and both databases name the new key alike.

`seed_ticket_categories` puts the starter set in by key and leaves every admin
edit alone; production runs it by hand, since deploys run only `db:migrate`.
`ticket.set_category` gates changing it (every agent holds it), and
`admin.categories` the list on `/admin/categories`.

The same permission gates the Category chooser on the console's New form: drawn
only for an agent who holds it, and refused by the action from anybody else.
The chooser is never seeded with the form's default. Left alone it posts an
empty value, and `submitForm` applies the default as it reads the form at submit,
credited to the form — an untouched default is no person's judgement, and only
a person's `category_changed` is ground truth when Jev is graded (Stage 4.2). Seeded, it
would post the default back as the agent's choice, and a stale one if an admin
changed it in between. An agent's pick is credited to the agent, and `none`
over a default writes no column and no event, since `to: null` would read
"cleared the category" on a ticket that never had one. Only the agent variant
of `Requester` carries a choice, so a help-centre POST cannot name a category
however it is written: a chosen category is one Jev leaves alone.

**Routing by category.** A channel's `routing_mode` says how its new tickets
find their group: `default_group`, as always; `category`, where the ticket is
_held_ — assigned to nobody, its out-of-hours reply kept back — until its
category settles, and then moves at most once, to the group the category names
(`ticket_categories.route_group_id`); or `category_shadow`, where nothing is
held and the router records where the ticket would have gone. `lib/routing/`
decides once per ticket (decision 5 of `plans/ticket-category-routing.md`); the
README says why it is a setting and not a rule. The rules:

- **The mode is read through `routingModeOf(channel)`, never off the column.**
  It answers `default_group` for a coexistence number, whose replies are typed
  on the phone, for the bot, and for a value it does not know: a misread mode
  leaves a ticket where it went before Stage 5, the safe side of every mistake
  here. Both writers keep the column agreeing — `saveChannel` refuses a
  category mode on such a row and decides a WhatsApp row's mode inside its
  UPDATE, so a number adopted while the form was open keeps `default_group`,
  and `complete_coexistence_onboarding` resets it in the statement that takes
  the row's lock. `routingLock()` asks `routingModeOf` which rows those are, so
  the form, the action and the panel give one reason.
- **Only a ticket an inbound ingest path inserts routes** — email, WhatsApp, a
  Meta direct message or comment, the widget — and only while the classifier is
  in `apply` (`routingStartFor`): off or in shadow it files nothing, and a hold
  would wait out every window for nothing. Never a `createTicket` ticket, which
  brings its own group, a continuation, a reopen, imported history or a
  conversation the business wrote first; nor spam, a ticket with an assignee at
  its insert (an owned number's, its owner's from the first moment), or a
  WhatsApp number no row names, which has no mode to re-read when it decides.
- **The hold starts in the insert, whose transaction reads nothing on the
  pool.** `planRouting(channel)` reads the mode and the classifier's memo before
  it. Inside it, `routingWindowValues(plan, ticket, now)` is spread into the
  conversation's own insert, so the window is a value of the row the statement
  creates rather than a second version of it written a statement later, and
  `startRouting(tx, plan, ticket, now)` writes the `pending` `routing_decisions`
  row and the `settle_routing` job `on: tx` once the opening message is stored,
  so all three commit with the ticket or not at all. Both ask one predicate
  (`starts`, in `lib/routing/start.ts`), so a ticket the insert holds always has
  the row and the job that end its hold, and each path takes one `now` for both,
  so the window, the row's copy of it and the job's `run_at` are one instant. In
  the insert, because the priority classifier's update pass, a group-less
  `on_create` `auto_assign`, a sweep and a second message can each assign a
  ticket in its first second; in two halves, because a pooled read inside a held
  connection is §6.91's self-deadlock, and on WhatsApp a throw there loses the
  message. The window counts from processing, so a late email still gets all of
  it, and its length is copied from
  `category_ai_settings.routing_window_minutes`, so a change never moves one
  already running.
- **Held is `isHeld()` over the ticket's own columns** (`lib/routing/hold.ts`):
  a window, no decision, no assignee, and under `ROUTING_GRACE_MS` (ten minutes)
  past the window's end. Assignment answers `awaiting_route`, never recorded;
  the out-of-hours reply returns; the sweep does not escalate; the inbox draws
  "Routing…" — through `routingHold` (`lib/tickets/inbox-badges.ts`), which the
  row, the header and the sidebar's hints share, and which asks too that the
  ticket be work: open or pending, not spam, not merged. No status, spam or
  merge writer ends a hold, so a ticket resolved in its window keeps the columns
  until `settle_routing` records `not_open`, and a badge there, or "choosing its
  category now routes it", would promise a route that never comes. The grace is
  a valve for a stuck job, not a second window: a decision or a stamp ends a
  hold, so it never lapses at the instant `settle_routing` falls due, when a
  sweep could assign the ticket in the group it is leaving. An assignee ends it
  whoever gave it, and the router then records `taken` and never moves the
  ticket. Both columns are in `queue_relevant` (`db/sql/001`), so the badge
  clears on the hold ending alone. A reader that counts held tickets rather than
  holding a row asks `heldSql(now)` (`lib/routing/held-sql.ts`), the same
  predicate in SQL, in a module of its own because `hold.ts` is client-safe and
  that one imports the schema. It reads the hold's columns alone, so it counts
  over a population already narrowed to work (the open backlog), and
  `held-sql.db.test.ts` holds it, `isHeld` and `routingHold` to one answer on
  the same rows. The live board's Unassigned tile counts those as being routed,
  not as work nobody picked up.
- **The ticket's row is locked first, and `FOR NO KEY UPDATE`**, then the
  group's or the routing row's, by the router, `endHold` and `deferToRouter`
  (each behind its caller's own write, which took the ticket's),
  `assignConversation` and Hand to, so no two of them wait on each other in
  opposite orders. NO KEY UPDATE, never UPDATE: it serialises against every
  other writer of the row just the same, and leaves alone the KEY SHARE that a
  message or an event inserted for the ticket takes through its foreign key.
  Every ingest path continuing a ticket inserts
  the message and then updates the ticket in one transaction, so a `FOR UPDATE`
  taken _after_ a write of one's own — `endHold` behind an agent's reply, a
  console move or a rule's — waits on the message's KEY SHARE while the ingest's
  update waits on the write, and Postgres aborts one: a reply stored and never
  sent, or the customer's message lost, on any ticket, routed or not
  (`docs/PROJECT-STATE.md` §6.106). So a lock on a ticket's row taken after the
  same transaction has written it is NO KEY UPDATE, always. Taken before any
  write, FOR UPDATE closes no cycle but holds every inbound message on the
  ticket until it commits, which is why these writers take NO KEY UPDATE there
  too; the older ones that lock first and write a non-key column (the category
  writer, Jev, the priority classifier) still say UPDATE, which costs a message
  a wait and nothing more. `endHold` and `beginRouting` read the routing row
  before they lock anything, so a ticket that never routed takes no lock there
  at all — and in the creation pass, which every new ticket on every channel
  runs, no transaction either. The unlocked answer cannot go stale: the row is
  born in the insert's transaction, which has committed before anything reads
  it, and a decided row is never undecided again. `assignConversation`'s rota
  re-reads under its lock the assignee, the group, the hold and whether the
  ticket is still work — open or pending, not deleted, merged or spam, the
  router's own `isWorkable`, which Hand to's offer asks too (`not_assignable`),
  the status through `statusCategoryOf`, since no join may sit under the lock —
  and answers `moved` for a ticket that left the group since its snapshot, which
  a re-read under the group's lock alone could not see. Taken off the snapshot,
  a resolve landing while the pick read its roster left the ticket resolved in
  somebody's name, and the cursor moved past them for work they never got. The
  hand-back to a number's owner (`handBackToOwner`) re-reads less: the
  assignee, whether the ticket is still work, and that the owner is still its
  active accountable agent, since a handover or a deactivation meanwhile makes
  the ticket somebody else's to answer for. Not the group, because the owner is
  outside the rota and no roster or cursor is read; nor the hold, which is read
  off the snapshot ahead of the owner and the rota both, and which an
  unassigned ticket the snapshot found not held cannot have entered since —
  the one way back into a hold is losing an assignee before the window and its
  grace are over.
- **A person or a rule deciding first ends the hold, through `endHold()` after
  the write and in its transaction** — after, so the group it records is the one
  the write left; in it, so neither commits without the other. The write's own
  line — `group_changed`, `assigned` — goes in that transaction too, ahead of
  `endHold`, so the timeline reads the move before the `routed` line it caused
  whoever made it: `endHold` stamps its line `CHANGE_STAMP`, and a rule's line
  written after the commit, as it was, sorted after the decision it was the
  reason for. It goes through `recordLineIn` (`lib/assignment`), which the
  engine and `assignConversation` share, stamped `CHANGE_STAMP` as it is
  written — the transaction's start would sort it before a change committed
  while the move waited on the ticket's lock — and in a savepoint, because the
  line records the write and is not it: refused by Postgres, it is answered and
  logged, and takes neither the write, the hold's end nor their follow-up down
  with it. Anything Postgres did not return — the admission gate giving the
  statement up as lost, a cancel — is thrown on instead, so the transaction
  rolls back rather than go on queueing behind a statement that may yet commit
  a move the caller has been told failed. The same stamp, for the same reason,
  is on the console's own `group_changed` and `assigned`/`unassigned`, on
  `changeStatus`'s `status_changed` and on the owner path's `assigned`
  (`recordOwnerAssigned`, and `handOverNumber`'s), each written once its write
  holds the ticket's row: stamped with the transaction's start, an edit that
  waited on the router's phase one sorted before the `routed` line it came
  after, and an owner handed a ticket after a wait sorted before the change it
  waited for, where the rota's pick in the same place sorted after it.
  `accountable_changed` keeps its instant, which the rollup reads as when
  accountability moved (`accountableOrAssigneeAt`). `manual` is the console's
  group change, an assignee change naming somebody, an agent's reply and Hand
  to; `rule` is `assign_group` to another group, `auto_assign` naming another
  group (`endsHoldAs`, in the move's own transaction) and `assign_agent` naming
  somebody. Only an action that changes something, judged against the locked
  row: a rule naming the ticket's own group matches on every pass and would end
  every hold on its channel, and "Unassigned" or a group-less `auto_assign`
  decides nothing about where the ticket goes. A no-op on a ticket with no
  undecided row — one read, and no lock — so a caller need not ask first.
  **Once phase one has written the router's decision, nothing but the router
  finishes it**: not a rule, whose move is part of the pass the router waits
  for, and not a person — an agent's reply, the console's group or assignee
  case, Hand to — whose write stands but ends nothing (`endHold` answers
  false). Ended by the person, the hold let their `afterHoldEnded` assign before
  the router's rules, and a rule's `assign_group` then left a Sales agent
  holding a Merchant Care ticket. Decided for the router, as the row once was
  with the router's outcome kept, it was a row the window's job never resumes:
  a router that stalled ran its rules on a ticket resolved since when it woke,
  and one whose claim on the pass failed left the pass owed for good. **A write
  in that gap with an `on_update` pass of its own re-arms the router's pass and
  runs none.** The console's category, group and assignee cases, Hand to and
  Jev's answer each call `deferToRouter(tx, id)` (`lib/routing/state.ts`) in the
  write's own transaction, once the write holds the ticket's lock. It takes the
  routing row's lock and, on a row whose phase one is written and which is not
  yet decided, clears the router's claim on its pass and the mark of it done,
  and answers true; the writer then runs no pass, no `afterRoutingChanged` and no
  `routeNow`, and Hand to assigns nobody. The router's pass, run again on the
  ticket as the write left it, is the one the write is owed, and the router's
  end of the hold waits for it (**A decision is two phases**). Run beside the
  router's, the writer's pass was unordered with the hold's end: landing after
  the router had assigned, a rule's `assign_group` in it moved the ticket on and
  left the assignee where they were, a Sales agent holding a Merchant Care
  ticket. An agent's reply runs no pass and re-arms nothing. The console's other
  cases, the priority classifier and a customer's message do not call it yet,
  and still run their own pass beside the router's. Before phase one, what the
  hold owed (`afterHoldEnded`) follows the caller's own `on_update` pass, never
  precedes it: the console's group and assignee cases call it after
  `afterTicketUpdate`, so the rules decide the group before anybody is assigned
  and before the held reply chooses its calendar.
- **A rule's pick waits with the ticket, strategy and all.** A group-less
  `auto_assign`, or one naming the group the ticket is in, is answered
  `awaiting_route` like any assignment on a held ticket, and when it names a
  strategy `assignConversation` keeps it on the routing row with the rule's
  `automation:<rule>` label (`held_strategy`, `held_actor_label`;
  `recordHeldAssignment` in `lib/routing/held-assignment.ts`, one statement
  after the pick's transaction, best-effort). `afterHoldEnded` assigns with
  them, so the `assigned` event names the rule and a round-robin rule over a
  group left on `manual` — how a rule turns assignment on without moving a
  ticket — still assigns, where the hold's end used to pick with the group's own
  strategy and assign nobody. Phase one drops them only when its decision moves
  the ticket, since the rule spoke about the group the ticket has left, and
  phase two's pass keeps them again if an `on_update` rule matches it where it
  now is. A decision that leaves the ticket where it was keeps them, rules owed
  or not: the rule still speaks about that group, and an `on_create` rule has no
  later pass to ask again — phase two runs `on_update` rules only, and dropping
  the pick there left every held ticket on a manual group unassigned once its
  category settled. `endHold` drops them, since whoever ended the hold decided
  instead, and a grouped `auto_assign` that ended it picks with its own strategy
  at once.
- **A category is not a stamp.** A person's category edit during the hold routes
  the ticket in place of the update pass the edit would have run, and what is
  owed is read off the routing row in the write's own transaction — the stage
  moves only under the ticket's lock, which the write holds, so the answer is
  the one the write met, as the classifier reads it. Live `pending`: nothing,
  not even the policy, because the creation pass's `beginRouting` routes on the
  category after the `on_create` rules (or `settle_routing` does, at the
  window's end); routed at once, the ticket was decided before a rule had its
  word, and a rule's `assign_group` then ended nothing. A decision in flight,
  its phase one already written: nothing more, a cleared category included,
  since the write's own transaction re-armed the router's pass
  (`deferToRouter`), which runs on this category before the router assigns. Live
  `holding` otherwise: `routeNow`, and the edit's pass is skipped when the
  router answers `decided`, which ran the rules on this category. On `none` or
  `in_flight` somebody decided between the edit's commit and the router's lock,
  or began to, and on `failed` the window's job is still to come;
  `routerDecidedOn(id)` (`lib/routing/state.ts`, which the classifier asks too)
  says whose pass covers the edit. An undecided row, or one the router decided,
  has its phase one after this write, which found none under its lock, so that
  phase one reads the write and the router's pass is the edit's, on this
  category or a later writer's. A `manual` or `rule` outcome never read the
  category, and a `not_open` one ran no pass — the router owed a ticket resolved
  in its window nothing, which is not the edit's pass having run — so the edit
  runs its own, as it does when the row is gone. Nothing there compares
  categories: a router that decided before the write is one the write found in
  flight, and deferred to. In shadow the edit records the would-be decision once
  `beginRouting` has begun, then carries on as though nothing routed. Clearing a
  category leaves the window running. A rule's `set_category` after the creation
  pass is routed by `settle_routing`, since an action never re-enters the
  engine. After the hold an edit only relabels, and `Hand to <group>`
  (`ticket.assign`, `lib/routing/hand-to.ts`) moves the ticket, clears its
  assignee with an `unassigned` naming `from`, and assigns it in the new group —
  without the clearing the holder stays, since the Group field and
  `assign_group` both keep an assignee. On a decision in flight — offered there
  because somebody holds the ticket, or its grace ran out on a router that
  stalled — it moves and clears all the same and hands the rest to the router
  (`deferToRouter`): no pass, no policy and no assignment of its own, answering
  `awaiting_route` and naming no queue, since nothing of the router's is known
  yet. Its own assignment, the grace run out, would hand the ticket to the new
  group's rota before the router's pass had moved it on. It is not offered on a
  number whose active owner the rota would hand the ticket straight back to, nor
  on a coexistence number. The button posts the group it named and the assignee
  the page was drawn with, and the action compares both under the lock, refusing
  `changed` or `reassigned`: the assignee decided whether the button asked
  twice, so a page drawn before a colleague took the ticket must not unassign
  them in one click. It says the ticket waits in a queue only when the rota
  answered that nobody there could take it (`waitsIn`), naming the group a rule
  moved it on to; after a rule resolved it or somebody moved it, the redrawn
  page says where it went. Everything after the hand-over's transaction is
  best-effort, since the move and the unassignment stand: an assignment that
  throws is answered as done, with a sentence sending the agent to look who
  holds the ticket (`assignmentFailed`), where a throw failed the action and
  left a page showing the old group and assignee.
- **A decision is two phases with the rules between, each its own transaction**
  (`routeNow`, `settleRouting` in `lib/routing/apply.ts`). Phase one, under the
  ticket's lock, runs `decide()` and writes the move, the decision row and one
  `routed` event, and the ticket stays held. The `on_update` pass runs whenever
  the ticket carries a category, whatever the outcome but `not_open`, because
  its writer gave that pass up to the router; a ticket with none has nothing for
  it to react to, and its hold ends in phase one. Phase three ends it; then
  `afterRoutingChanged` with whether phase one, or a write the router passed
  since, moved the group or changed the category, then assignment and the held
  reply. Rules before assignment, as in the creation pass: the other way round
  leaves the route group's agent holding a ticket a rule moves on, since
  `assign_group` never touches an assignee and `auto_assign` answers
  `already_assigned` before it moves, and tells the customer the wrong team's
  hours. Never one transaction across phases: the rules, the SLA and assignment
  lock the ticket on connections of their own and would wait until the pooler
  killed it (§6.91). **Phase two runs once for every write it is owed for, and
  never twice for one.** `finish()` claims the pass (`rules_claimed_at`) in a
  transaction that takes the ticket's lock, then the routing row's, and reads
  the ticket the pass then runs on — `applyRules` on that read, never a read of
  its own; where no `on_update` rule exists, one conditional statement and no
  transaction, since there is nothing to read the ticket for — and marks it
  done (`rules_done_at`) in a statement of its own before phase three, only
  while the claim is still its own, so a phase three that fails keeps the mark.
  A writer re-arming the pass (`deferToRouter`) holds the ticket's lock from
  its write to its commit, so it lands wholly before the claim, and the pass
  reads it, or wholly after: then phase three, under the ticket's lock and then
  the routing row's, finds the claim cleared and runs the pass again on the
  ticket as the write left it before it tries again; and a write after phase
  three meets a decided row and runs its own pass, as any write after the hold
  does. So every change in the gap is passed once, and before anybody is
  assigned. With the claim one statement and the pass reading the ticket a few
  statements later, an edit committed between the two was read by the router's
  pass and passed again by its writer, every rule keyed on it firing twice; and
  with a writer's own pass beside the router's, the writer's could land after
  the router's assignment, where a rule's `assign_group` left the wrong team's
  agent holding the ticket. One caller runs at most five passes (`MAX_PASSES`)
  and then ends the hold all the same, the pass marked claimed and done, with a
  warning: writers relabelling faster than a pass runs are not deciding where
  the ticket goes, and the last one's rules are the pass not run. The claim is
  the one record of whether the pass is still to run, and nothing decides a row
  whose phase one owed a pass without first claiming it or giving it up; a
  claim that is another caller's by phase three — re-armed and claimed again —
  leaves the hold's end to them. The caller that wins the claim gives the pass
  up itself in one case: a ticket nobody may work any more — resolved, closed,
  deleted, merged or marked spam since phase one, whose category's rules would
  otherwise reach a customer nobody may answer — which is owed the hold's end
  and nothing after it. It once gave the pass up on a category changed since
  phase one too, to that category's writer, whose pass then came after the
  assignment. Phase one's `routed` line is stamped `CHANGE_STAMP`, so it sorts
  after the `category_changed` it decided on when it waited for that writer's
  lock. A caller whose claim fails ends nothing — the claimant ends the hold
  after its last rule, and ending it sooner lets assignment beat a rule still to
  come; or the window's job gave the pass up and ended it (below) — and
  `settleRouting` then looks again, without a key, once `RULES_RUNNING_MS` is
  up. A process dying between phases leaves the hold, and `settle_routing`
  completes a phase one older than `PHASE_ONE_RESUME_MS`: a pass nobody claimed
  it claims and runs, and so one a writer re-armed, never read as a dead
  claimant's since a cleared claim is no claim — even one the write cleared from
  a claimant that died part-way, some of whose rules then run a second time, for
  a write that came after them; a pass done it skips; a claim younger than
  `RULES_RUNNING_MS` — the hold's ten-minute grace, for the grace's own reason —
  it leaves to its claimant, looking again then, before it asks whether the
  ticket is still work, since the claimant owns phase three; and an older claim,
  whose claimant died part-way, it answers by ending the hold without the rules,
  with a warning, because which of them ran is recorded nowhere, and a pass
  half-applied once is a smaller harm than a `send_reply` sent twice. So does a
  phase three that fails, whoever the caller: after `routeNow` the window's job
  is always still to come while the row is undecided — the first, or the one
  requeued on meeting this decision in flight — and `settleRouting`, which
  nothing comes after once its key is spent, throws so the queue retries it,
  which runs no rule a second time unless a writer has re-armed the pass since
  (sooner than the minute, the retry requeues itself without a key). Without the
  claim every retry ran the whole pass again, and a slow pass met a second one
  started beside it once its phase one was a minute old. Completing a decision
  reads the ticket again under the lock, and one resolved, closed, deleted,
  merged or marked spam since is owed nothing (`isWorkable` in `decide.ts`,
  `not_open`'s own test): its hold ends with the outcome phase one wrote and its
  pass is given up, marked claimed in the statement that decides the row — the
  caller the job took over may only have stalled, and on waking asks the claim
  alone — so no rule runs, nobody is assigned and no reply goes, where finishing
  from the stored row ran a category's rules on a deleted ticket.
- **The creation pass is `on_create` rules, `applySlaOnCreate`, then
  `beginRouting`, and it stops on `routed`.** After the rules, so a rule gets
  the first word: its stamp has ended the hold, or its `set_category` is routed
  at once. After the first SLA selection, where the plan had it before, because
  that order left a ticket a rule had filed and the route did not move with no
  policy, and gave a moved one its first through an `sla_recalculated`
  describing a change nothing made. Best-effort: a throw answers `continue`,
  and `settle_routing` treats `pending` as `holding`.
- **The classifier's follow-up is chosen by the routing row it reads under its
  write's lock** (`deferToRouter(tx, id)`, then `undecidedRouting(tx, id)`),
  since the stage moves under that lock. A decision in flight, its phase one
  already written: nothing, because the write re-armed the router's pass, which
  runs on what Jev wrote before the router assigns. A late answer for an
  earlier message lands there when a later one's decision is being finished,
  and its own relabel then, run after the router had assigned, let a rule's
  `assign_group` move the ticket away from its new holder. Live `pending`:
  nothing, because `beginRouting` routes on the category and a rule gets the
  first word. Live `holding`: `routeNow` _instead of_ `afterTicketUpdate`, which
  would be a second update pass assigning before the router's. Undecided shadow:
  the would-be decision recorded once begun, then the relabel. Anything else:
  the relabel. When `routeNow` answers anything but `decided`, the relabel is
  owed unless `routerDecidedOn` says a router's pass reads the write, as the
  console's edit asks, or the router found the ticket `not_open`
  (`decidedNotOpen`, where Jev parts from the console: Jev never files a
  resolved ticket).
- **What a hold kept back is owed by state, not by one caller.** Whatever ends a
  live hold — the router, `settle_routing` whatever it decides but `not_open`,
  which assigns and sends nothing (`routeNow` answers `none` for it), a caller
  that `endHold` answered `true` — calls `afterHoldEnded` once its transaction
  commits. It reads what is owed off the routing row itself (`heldFollowUp`):
  assignment, with the strategy a rule asked for meanwhile, then the
  out-of-hours reply to the message the hold kept from being acknowledged. That
  is the one that opened the ticket (`routing_decisions.message_id`), which the
  creation pass would have answered, while its author is still the requester;
  otherwise the requester's earliest inbound reply that is not a reaction. A
  comment thread a passer-by's reply opened makes the root comment's author the
  requester during the hold (`adoptRootAuthor`), the reply refuses the
  passer-by's message (`answersRequester`), and the customer's own comment, held
  unanswered like everything else, was never acknowledged. Never the newest
  inbound row, which after a batch retried whole is as often somebody else's.
  The engine calls it after a pass whose rule ended a hold, from where the whole
  pass left the ticket, which is not re-entry. One reply, by the claim on
  `auto_responded_at`; and since a job can now send it minutes after the
  message, it skips a ticket not open or pending and one a person answered in
  this closed stretch (`answeredInThisStretch`), so an agent's 23:02 reply that
  ended the hold is followed by "we are closed" neither then nor after the
  customer's 23:05 message.
- **`settle_routing` is the window's end by definition, once ever.** Priority
  40, behind `classify_category`'s 30 and ahead of the default 100, which orders
  only the claim: the worker runs what it claims at once, so the settle sees an
  answer that has landed and not one still waiting on TypeSafe, which is then a
  late answer and relabels the ticket where the window left it. Its key,
  `settle_routing:<id>`, is spent for good, right only because a ticket routes
  once, and is enqueued on the insert transaction, so a duplicate delivery
  rolled back with its ticket spends nothing. Meeting a phase one younger than a
  minute or a claim on its rules younger than `RULES_RUNNING_MS`, or losing its
  own claim, it enqueues itself again **without** a key: the first is spent, and
  this is the same work legitimately asked for again (**Background work**).
  Failing its own phase three, it throws rather than answering `decided`, since
  a job that completes is the last one the ticket gets, and the queue's retry
  finishes the decision (above) — a plain error, never `PermanentJobError`,
  since a retry is what fixes it. It is conversation-scoped in `purge-jobs`,
  ends on `subjectGone` for a purged ticket, and runs by hand as
  `npm run job -- settle_routing conversationId=…`.
- **Shadow is defined, not assumed.** A shadow row has the job and no window, so
  nothing is held and the rota assigns on arrival. `decide()` never answers
  `taken` there, or a shadow week on a staffed group would report nearly every
  ticket kept, and only `default_group` releases one. It records when a category
  settles or at the window's end, a `pending` row waiting for `beginRouting`
  so that a rule gets the first word in shadow too, and a person's or a rule's
  move or assignment through `endHold` — but not an agent's reply
  (`decidesShadow: false`), since the rota assigned that agent on arrival,
  which a live hold would have prevented. It never writes
  `routing_decided_at`, so moving the channel to `category` later starts
  clean.
- **The readiness panel on `/admin/channels` reads what the code reads**
  (`lib/routing/readiness.ts`): `routingModeOf`, `routingStartFor` behind
  `filesRoutableTickets` (`lib/routing/filing.ts` — the filing row and an
  active owner, which `/reports/routing`'s "is held" sentence asks too),
  `routeGroupSummaries` (assignment's `filterCandidates`), a group's hours as
  assignment asks them, and the engine's own condition evaluator for the active
  rules that would end a hold on the channel. A panel that reasoned for itself
  would agree with the router until the day one of them changed. It refuses
  nothing — a team that picks from its queue is a choice — but says what each
  choice does, since a routed ticket that lands with nobody is otherwise found
  by a breach report. `saveChannel` likewise saves a category mode while the
  classifier is not in `apply`, and says it holds nothing.

`routing_decisions` holds one row per ticket that entered routing, written only
by `lib/routing/` and under the ticket's lock — `deferToRouter`'s re-arming
among them, in its caller's transaction — but for the held strategy, which
`recordHeldAssignment` sets on an undecided live row, and phase two's mark, and
its claim where no `on_update` rule exists, which `finish()` writes, each in one
statement of its own holding no other lock to close a cycle with — and
`routing_decisions_decided_complete` (`db/sql/003`) refuses a decided row
without its outcome or `decided_at`, which would leave `/reports/routing`
(`lib/routing/report.ts`) short without a word. The timeline gets one `routed`
event per live decision, one that moved nothing included, naming the category,
the group, Jev's probability and the outcome, and one when `endHold` writes
`manual` or `rule`.

**The one AI provider, and the four things it is allowed to touch.**
`lib/typesafe/` calls TypeSafe's System One endpoint, and four modules ask it a
question: `lib/subcategorise-ai/` asks which subcategory a message belongs to,
`lib/priority-ai/` how urgent it is, `lib/category-ai/` which team's work it is,
and `lib/canned-suggest/` which canned response an agent would send next. Jev
answers a `choice` over options the request offered, so none of them can be
handed a word of free text — the subcategoriser gets a key, the priority
classifier a level, the category classifier a key, the composer an id.

The subcategoriser is a **shadow**: every answer lands in `ai_subcategory_runs`
and nothing else, so no rollup, no review queue and no primary ladder can see
it. That separation is not caution to be tidied away later.
`conversation_subcategories.confidence` is an evidence grade, hand-assigned
and combined by noisy-OR, and three screens explain it as one; TypeSafe returns
a probability. One column holding both would be undetectable from the outside.
Anything wanting to promote a result argues for it in its own change.

Four rules hold there, and the job is inert until somebody starts it — presence of
`TYPESAFE_API_KEY` is its flag, the `instagramLoginConfigured()` device, and the
key lives in the environment groups rather than the shared one because every
use sends real customer text to a third party:

- **The option list comes from `ticket_subcategories`, never from
  `TAXONOMY`.** A retired subcategory leaves the rules path at once; if it did
  not leave the model's choices at the same moment the two would answer over
  different vocabularies and every disagreement between them would be an
  artefact.
- **`meta.unclassified` is always offered, and the instructions name it.** Given
  55 options and no way out, a model asked about "؟" names something, and a forced
  guess is the over-detection `plans/ticket-categorisation.md` warns about.
- **The rules baseline is computed in the same call**, from
  `detectSubcategories` — not read back from `conversation_subcategories`, whose
  rows agents have since confirmed, rejected and added. The first measures the
  detector; the second measures the team.
- **Nothing retries inside the provider.** Backoff is the queue's, per
  `lib/email/providers/postmark.ts`, which is also why `@typesafe-ai/sdk` is not
  used: it retries internally and brings an error taxonomy where the only thing a
  handler reads is `isTransient`.

The job is hand-run and on no cron — a shadow run is an experiment with a label
on it. `dryRun=true` builds every request, calls nothing and writes nothing, which
is why it can sit in CI's `database` job loop and put the selection and report
queries in front of real Postgres. See `plans/categorisation-through-typesafe.md`.

`lib/priority-ai/` asks how urgent each inbound customer message is, and it is
**not** a shadow: under `PRIORITY_AI=apply` it writes `conversations.priority`,
which moves SLA deadlines. It earns that where the subcategoriser could not
because priority has no second quantity to be confused with — the column is a
level, not an evidence grade, and one ticket in the archive had a priority set
by hand. What it may not do is overrule anybody: `lib/priority-ai/decide.ts` is
the only place that decides whether an answer may be written, and its rules are
tests. A priority set by a person, a rule, a form default or an agent opening
the ticket is never touched; only the answer to the customer's opening message
may lower a ticket, and later ones only raise; and every answer, applied or not,
is a row in `ai_priority_runs` with its full distribution, because those rows
are the only labels priority has. A new writer of `conversations.priority`
writes the column and its `priority_changed` event in one transaction, stamps
the event with `CHANGE_STAMP` (`lib/tickets/change-stamp.ts`) so events sort
in the order the column was written, and calls `onPriorityChanged` after it
commits — as the console, the `set_priority` automation and the classifier do.
The policies price their targets per priority, and the classifier decides whose
priority a ticket carries from the column and those events read together. See
`plans/priority-through-typesafe.md`.

`lib/category-ai/` asks which team's work a customer message is, and it may
write too: under `apply`, set on `/admin/categories` (`category_ai_settings`,
one row — read through a 30-second memo where a message is stored, uncached by
the job and the page), a confident answer sets `conversations.category_id`
through `setConversationCategoryOn` as `jev:category`. On a ticket routing has
nothing more to say about, it then calls `afterRoutingChanged` and
`afterTicketUpdate`, so an unanswered ticket's SLA policy is chosen again and
`on_update` rules keyed on the category run; on one still held it routes the
ticket instead, or re-arms the pass of a decision in flight, and the router runs
both (**Routing by category**). What it may not do is decided in
`lib/category-ai/decide.ts`, whose rules are tests. It asks about the first five
customer messages on a ticket nobody has answered; the earliest message with a
confident answer settles the ticket, and the rest are
recorded `after_settle` without a call; `unknown` never settles however sure;
and a category a person, a rule, a form's default or an agent opening the ticket
chose is owned and never touched, read off the `category_changed` events and the
column together, under the ticket's row lock once the call is over (before it,
the events alone decide, since the column read apart from them can straddle a
Jev write). Every message the job decides about is one row in
`ai_category_runs` under the `live` label, those known beforehand to be owned,
settled or capped included. A message that reaches no decision has none, by
design — the skips, the switch found off when the job runs (jobs still queued
at a rollback among them), a question that cannot be built, an unset key, a
message never queued — so the one gap is a `classify_category` job in `dead`. A
backfill writes under a label of its own (`backfill_category_ai mode=record`),
judging each message as of when it arrived; its `apply` mode files open tickets
from a record label's answers and fires nothing — the one category writer that
owes no follow-up, through `fileBacklogCategory`, which `routing-result` lets
only the backfill call. The question
offers the active categories by English label and description, with `unknown`
added in code, and its fingerprint covers both, so an edit on `/admin/categories`
is a new question no report averages with the old. `/reports/category-ai` grades
one label, question and mode at a time, and its rules are
`lib/category-ai/grade.ts`'s tests: one settling answer per ticket, in the order
the live job judges messages; ground truth only a person's `category_changed`
given before Jev, a rule or a form wrote the category, since agreeing with a
write leaves no event and every label after one is a disagreement — so a ticket
written to first is in no rate read off labels, and in `apply`, where every settle is Jev's
filing, Filed by Jev is the grade; rates that mix Jev's answers weighted for a
sample drawn evenly from each; the cap counted as the live job counts it, across
the label's other views; and a labelling list that never says what Jev chose,
which would make the label Jev's answer read back. See `plans/ticket-category-routing.md`, decision 4.

The suggestion is **live**: its answer is shown to an agent, as grey text in an
empty reply box that Tab (or Use, on a phone) puts in — Tab only once the text
has been on screen in the focused box for half a second, because the ghost is
there the moment the box takes focus and a quicker Tab is a keyboard user
passing through (`TAB_TAKES_AFTER_MS` in `lib/canned-suggest/keyboard.ts`). It
is still never _applied_, and that is the line it argues from — nothing reaches
a customer without the agent taking the text and pressing Send, so
`messages.author_agent_id` stays the agent and the `HUMAN_AGENT` rule above is
untouched: it is the same act as picking from the list. Six rules hold:

- **The admin switch is the flag; the key is a precondition.** Production holds
  `TYPESAFE_API_KEY` for the shadow run, so key-as-flag would have switched
  suggestions on for every agent on deploy. `canned_suggestion_settings` is a
  one-row table (`suggestionsLive()` reads it through a 30-second memo), off
  until an admin turns it on at `/admin/canned`, per database — so staging stays
  off although it holds a key.
- **The options are exactly the agent's own list, plus a `none` added in code.**
  `listCannedResponses(agent)`, through `cannedVisibleTo`, so another agent's
  personal response never leaves the building; and `none` is offered and named in
  the instructions on every request rather than depending on a row that happens
  to exist — the lesson of `meta.unclassified`.
- **The history is read on the server, and only `reply` rows go.** The route takes
  a ticket id and nothing else. Notes are an agent's private working and never
  leave; `system` and `forward` rows are not the conversation.
- **One call per agent, per ticket, per newest message.** The unique index on
  `canned_suggestions (conversation_id, agent_id, anchor_message_id)` is the cache
  and the race guard, so clicking in and out of the box, or two tabs, costs one
  call. Nothing retries; a failure is a row with `error`.
- **The text inserted is the stored body.** The route returns an id; the composer
  resolves it against the list it already holds, through the same
  `insertCannedResponse` the picker uses — so an accepted suggestion is counted in
  `usage_count` exactly like a pick, and Jev's answer never becomes text.
- **The grade is frozen at send.** `sendReply` posts the suggestion's id back,
  shown or not, and `recordSuggestionOutcome` records what the reply carried and
  whether that was Jev's choice (`sent_choice`, `sent_matches`, `sent_edit`) —
  "carried" meaning every canned response inserted since the box was last
  empty, so a suggestion followed by a closing from the list still counts. The report at
  `/reports/canned-suggestions` counts those columns; it never re-judges them, so
  deleting a canned response cannot re-grade the past. See
  `plans/canned-suggestions-through-typesafe.md`.

**Knowledge base article formatting.** `lib/kb/format.ts` is the standard, and
it is code rather than prose because it is enforced: `normaliseArticleHtml`
runs on every write, wrapped round the sanitiser as
`normaliseArticleHtml(sanitiseArticleHtml(html))` — sanitise first, always, and
CI checks the pair. An article body is plain semantic tags: no `class`, no
`style`, no per-element `dir` (the help-centre shell sets it once), no `div` or
`span`, and **no `h1`** — the article page owns the page's only `h1` and
`.kb-article` dresses `h2`–`h6`, so a body `h1` renders as paragraph text
(§6.49). `br` is a line break inside a paragraph, never spacing between blocks.
Read the module's header before adding a rule: it carries the evidence for each
one, all of it from the imported corpus, and the two invariants that make a
regex pass over markup safe — it only ever runs on sanitize-html's own output,
and it never touches a text node. Applying it to what is already stored is
`normalise_kb_formatting`, which is idempotent and cuts a `kb_article_versions`
row per article so the pass is undoable from the console.

**Who on the team may read an internal article.** `kb_visibility` answers
whether a _customer_ may (`lib/kb/visibility.ts`); `min_role` on `kb_articles`
and `kb_folders` answers which of _us_ may, and the two are separate axes on
purpose. `agents_only` already means "no customer, ever", whoever is signed in —
a `supervisors_only` beside it would put a role branch inside the predicate that
keeps internal runbooks out of Google, and would make every exhaustive switch
over `kb_visibility` answer a question it was not asked.

`lib/kb/internal.ts` owns the rule, and three things about it are load-bearing:

- **The floor is read only where the content is internal.** A floor on something
  a customer can open is not a boundary, it is a console hiding from an agent
  what a stranger can read. The folder counts too — production's internal
  articles are marked `public` on the row and are internal only through their
  folder — so an article's floor is the stricter of its own and its folder's,
  and null on anything public.
- **`readableByRole(role)` takes the role as a required argument**, the same
  device `articleVisibleTo` uses for its viewer: there is no zero-argument
  version to call by accident, so a new internal read model cannot forget the
  rule without failing to compile. Every one applies it — `admin.ts` for the
  console list and the editor, `agent-search.ts` for the composer panel — and so
  do the five console actions that reach an article by an id out of a
  `FormData` field, because `kb.edit` is supervisor and up, which is exactly the
  population an admins-only article is kept from.
- **The seniority ladder is generated, never retyped.** `agent_role` happens to
  be declared most-senior-first, so `least()` and `<=` would work by accident
  today and silently re-grade every article the day a role is inserted into the
  middle of the enum. The CASE arms come from `ROLES_BY_SENIORITY` in
  `lib/auth/permissions.ts`, and compare as text so no `agent_role` operator is
  needed — the `operator does not exist: text = channel` shape under
  [Tests](#tests).
- **The pure half lives in `lib/kb/floors.ts`** — the labels a control shows,
  and `floorFor`/`folderFloor`, the twins of `effectiveFloor` for rows already in
  hand. Split by which side of the wire runs it, like `lib/forms/files.ts`, and
  the twins answer null wherever the SQL does, the most junior role included:
  "every agent" and "no floor set" are the same audience, and a twin that
  disagreed would badge a row the list beside it reports as unrestricted.

A floor is written only where the content is internal, and both writers decide
that server-side: `saveArticle` reads the target folder rather than trusting the
form, because the editor renders the control only for an internal article — so a
submission with no `minRole` field is a form that never offered one, not somebody
clearing a floor, and clearing it there would drop the floor off every article
that is internal through its folder. Neither may accept a folder above the
caller, for the same reason the five id-in-`FormData` actions may not accept an
article above them.

The team's own handbook is the content this exists for: `lib/kb/handbook.ts`
holds it, `seed_console_handbook` puts it in the database idempotently, and the
`database` CI job runs that job twice and asserts the second run changes
nothing. Its floors are on the folders rather than on the articles, so an
article added to one later inherits the right audience instead of needing
somebody to remember. Ship a content fix by re-running with `overwrite=true`,
which cuts a `kb_article_versions` row for what it replaces; without it the job
reports what drifted and leaves it alone, because these articles are meant to be
edited in the console.

**Bilingual and RTL.** Arabic is the default locale and the front door; every
public URL keeps an explicit locale segment. Use `direction()` from
`lib/kb/locale.ts` and never assume LTR. Slugify through `lib/kb/slug.ts` —
ASCII slugify erases Arabic entirely — and decode dynamic route params with
`decodeSlugParam()`, because Next hands them over still percent-encoded.

**A search over text people write in Arabic widens the query, never the
column.** The same name is أحمد on one contact and احمد on the next, and ILIKE
treats them as different words. `arabicVariantPattern` in `lib/search/arabic.ts`
turns each letter Arabic spells several ways (ا/أ/إ/آ, ي/ى/ئ, ه/ة, و/ؤ) into a
bracket expression for `~*`, which the trigram indexes that already exist
serve. Folding the column through `translate()` instead is a different
expression, so it would need a new index on every table it touched, `messages`
included. The letter table is the subcategoriser's too, so the two agree on
which letters are one letter — and on no more: the subcategoriser also strips
tatweel and tashkeel from the text it reads, which a search can do to the query
(`cleanQuery`) but not to the column.

Every free-text search in the console — the inbox, the contacts page, the merge
picker and the knowledge base list — goes through `lib/search/text.ts`:
`cleanQuery` first, and an empty-query check on its answer rather than on the
input, because a query that was only a pasted U+200F, a tatweel or a fatha
cleans to `''` and `%%` matches every row with any text; then `textPatterns`
once, and `textMatches(column, …)` on each column people write in. Email, phone
and tracking columns stay `ilike(column, patterns.pattern)`. A new search box
that builds its own ILIKE for a name is how the same agent came to find a
customer in one box and not in the next.

**Anything a customer reads is a `*_ar` / `*_en` pair, and either side covers
the other.** Auto-response bodies, ticket field labels, form names, canned
responses and holiday names all take that shape: both columns `not null default
''`, the write path requiring one of the two rather than both, and the read path
falling back to whichever was filled in. A team that writes only Arabic gets a
complete configuration, and nothing renders a hole where a translation was
never typed. The trap it closes is the half-localised message: a body chosen for
an Arabic reader that interpolates a name only stored in English is translated
everywhere except the one word the sentence is about.

Two different questions decide the language, and they are not the same module.
**Anything that writes to a customer unattended goes through
`lib/tickets/locale.ts`** — the out-of-hours acknowledgement and an automation's
canned reply both call `requesterLocale()`, which picks the most recent inbound
`reply` carrying words the customer wrote, outside any label of ours — on a
public comment thread, the requester's own — and hands it to
`preferredLocale()`. Each of those narrowings closes a way the answer goes
wrong: the last inbound row of _any_ kind includes the English `system` notice
we write when a form attachment fails, a photo sent without a caption is
stored as our own English `[image]`, and on a comment thread the newest words
can be a passer-by's reply under the customer's comment. Only there: an
email's CC'd colleague still speaks for the conversation, or a requester whose
own mail carried no words would fall to `contacts.locale`. A sender that reads the language off a
message it already happens to be holding is how the two came to disagree, so do
not reintroduce that shortcut — one indexed query is the price of the invariant.

The console's pickers are deliberately outside this. They open on
`detectLocale()` from `lib/kb/language.ts`, the value the inbox page already
computed to search the knowledge base, so the knowledge panel and the canned
picker beside it cannot disagree. The two detectors differ at the margins —
`detectLocale` calls text Arabic from a fifth of its letters, `preferredLocale`
from a majority — and that is the right way round: one is a default an agent
overrules with a click, the other has already been sent. Do not trust
`contacts.locale` alone in either; nothing writes it, so every contact reads as
'en'.

**The starter canned responses are content with rules, and the rules are
tests.** `lib/tickets/canned-library.ts` holds them and `seed_canned_responses`
puts them in, finding its rows by `canned_responses.seed_key` rather than by
title, so a response the team renamed is not duplicated. It judges a row by its
title, folder and two texts, never by the HTML derived from them, and leaves an
edited response alone unless given `overwrite=true`. That has no undo, because a
canned response has no version table. So a content fix ships as `overwrite=true
keys=<key,...>`, which replaces only the entries named, and an entry removed
from the library is reported rather than deleted. `canned-library.test.ts` is
the style guide.
Every body is sendable exactly as it stands, because nothing interpolates and an
automation sends it unread, so it carries no placeholder. It carries no link,
because `support.shipblu.com` still serves Freshdesk and agents add links from
the knowledge panel. It is at most 1000 bytes of UTF-8, Instagram's limit for a
direct message, so roughly 550 Arabic characters. The Arabic addresses the customer as «حضرتك» and uses no
imperative, because neither the customer's gender nor the agent's is known. Any
policy a response states is quoted from the help centre, so a change to a
help-centre article that one quotes also changes the library, in the same PR.
Both the seed and `saveCannedResponse` derive the stored columns through
`cannedBodyColumns`, so a seeded row and a typed one cannot differ in a way only
a customer's inbox would show.

**Time.** Cairo observes DST again. Build test instants from wall-clock with
luxon and let the timezone database convert; never hand-convert fixtures. SLA
clocks are working-time, resolved through `lib/hours/resolve.ts` by every
consumer so a due date and the report measuring it cannot disagree. A day's
instants come from `dayWindow()` in `lib/hours/wall-clock.ts`, never from
`start.plus({ days: 1 })`: Cairo springs forward at midnight, so that day opens
at 01:00 and a day added to it ends an hour into the next. For the same reason
a count of days is taken on the dates, never on the instants between them
(`docs/PROJECT-STATE.md` §6.101). A date and time written with no offset names
an instant through `wallClockInstant()` beside it, never
`DateTime.fromISO(text, { zone })`, which picks between the two instances of
the hour the autumn change repeats by the offset in force on the day it runs
(§6.102). Every luxon `DateTime` names the zone it reads in, too, and the
`luxon-zone` repo rule refuses one that does not: CI runs in UTC, where every
date has its midnight, so a bare `DateTime.fromISO(date)` passes there and
fails on a machine in Cairo whenever a window opens on the day the clocks
spring forward. A calendar date takes `'utc'`, as does a value carrying its own
offset; a wall-clock time written without one goes through `wallClockInstant()`.

**A date a client component draws is joined from its fields.** It is written
twice, by Node on the server and by the browser to hydrate, and the punctuation
in an engine's whole string is locale data each ships its own copy of — a comma
after the weekday made every ticket page a hydration error (§6.96). So in the
browser bundle a date is formatted by `lib/format.ts`, the one module there
that may build an `Intl.DateTimeFormat`, which joins the `formatToParts` fields
with separators of its own; a server page's whole-string formatter lives where
no client component can reach it (`lib/kb/dates.ts`). Drawing a whole string
only after hydration is not the way round it: the `client-dates` repo rule holds
all of this, and cannot tell an effect from a render.

**An inbound email happened when it reached us.** Every instant its ingest
writes (the new ticket's `created_at`, the message's, `last_message_at`,
`last_customer_message_at`) is `webhook_events.received_at`, passed by
`process_webhook` as `InboundDelivery`. It is never the mail's `Date` header,
which is the sender's clock, wrong in either direction, and is kept only as
`meta.dateHeader`. The instant is a separate argument, not a field on what a
provider parses, so no driver can supply it. The "last" columns move forward
only (`latest()`), because deliveries are not processed in arrival order
(§6.77).

**Measured time is a union, never a sum.** Presence and focus are recorded as
intervals by hot paths that are deliberately approximate — two instances racing
leave overlapping rows, and a tab closing and reopening shreds one shift into
fragments. `lib/reports/intervals.ts` merges them before anything is measured.
Summing durations instead is the obvious implementation and it is wrong in the
one direction that matters: it reports more hours than the day contained and
pushes occupancy above 100%, where it stops meaning anything. An interval's end
is `coalesce(ended_at, last_beat_at)`, so a stream that died without signing off
contributes the time it can account for rather than every hour since.

**A connection is not a person.** `agents.last_seen_at` is refreshed every 25
seconds for as long as a console tab is open, so anything asking "is somebody
working?" that reads it answers yes for an empty desk. Only `agents.last_input_at`
— a key, a pointer, a scroll, reported by `components/agent-activity.tsx` — moves
when a human does, and it is what both idle timers in `presence_policy` are
measured from. Four rules hold there, and each closes something that is invisible
once it is wrong:

- **Nothing on the request path may write `last_input_at` or
  `sessions.last_activity_at`.** A prefetch, a poll or the presence keepalive
  refreshing either one makes every timer unreachable while leaving the columns
  looking healthy — and "nobody was ever signed out" is indistinguishable from
  "the timeout works" from the outside.
- **Why the switch went off is a fact, not a boolean.** `accepting_off_reason`
  separates the agent's own away, a supervisor's, and the timer's, because only
  the last may be undone by the next keypress. Without it, returning from lunch
  resurrects an away somebody set deliberately.
- **The browser reports, the server decides.** The idle report from
  `/api/presence/activity` buys promptness, not trust: `applyIdleAway` re-checks
  the window against the column the same endpoint is the only writer of. The
  sign-out is enforced in `getSessionAgent()`, which is the one path every page
  and action already takes, and swept in the background for the console nobody
  closed.
- **One clock, two windows, and the sign-out is never shorter than the away.**
  Two idle detectors would eventually disagree about the same agent; a sign-out
  that fires first makes the away state unreachable. `lib/presence/idle.ts` is
  the single copy of every one of these decisions and the only part with tests,
  because the sweep, the endpoint and the browser all have to answer identically.
- **The away timer measures the person; the sign-out measures the session, and
  the browser must not measure it for itself.** The console reports at most once
  a minute, so `sessions.last_activity_at` is routinely a whole beat behind the
  last key — and the countdown before a sign-out is itself only a minute long. A
  browser counting from its own last keypress therefore warns up to a minute
  after the deadline it is warning about: "Stay signed in" posts to a session
  `getSessionAgent()` has already deleted, and the unsent reply the countdown
  exists to protect goes with it. So `AgentActivity` anchors on
  `SessionAgent.sessionIdleForMs` — a duration, not an instant, because the two
  machines' clocks need not agree — and moves it only on a beat the server
  accepted. `idleTick` takes both clocks and is where which one answers which
  question is stated and tested.
- **Switching a timer on must not act retroactively.** Nothing beats while the
  windows are off, so the moment an admin enables the sign-out every session in
  the table is already older than it — the first sweep would destroy the lot,
  with no countdown, because the consoles rendered before the change do not know
  a countdown exists. `signOutCutoff` therefore measures from the later of the
  session's activity and `presence_policy.updated_at`. The away timer needs no
  such grace, and that asymmetry is the point: being parked is undone by a
  keypress, being signed out throws away an unsent reply.

**A snapshot cannot be recomputed.** Anything of the form "how much was open at
time T" has to be sampled at the time — `conversations` carries only current
state, so counting it during a rebuild writes today's answer onto an old date.
`agent_backlog_snapshots` is sampled hourly for that reason, and the nightly
rollup reads it rather than owning it: `rollup_metrics` rebuilds by delete and
insert, and would otherwise destroy the only copy. Hourly rather than at
midnight because Render's cron schedules are UTC and Cairo's offset moves. The
live board's open work by category has no history for the same reason.

**A totals read names every dimension null.** A `metrics_daily` row is one
slice: the totals, with group, agent, channel and category all null, or exactly
one of them named. Both halves are constraints rather than habits —
`metrics_daily_slice_key` (UNIQUE NULLS NOT DISTINCT over the day and the four
dimensions; the index before it was NULLS DISTINCT and refused nothing) holds
one row per slice per day, and `metrics_daily_one_dimension` (`db/sql/003`)
refuses a row naming two — so a reader selects a slice by its nulls alone. Each
slice is then the totals row with one column filled in, and a totals read that
leaves a dimension out reads that dimension's slices as more totals: without
the category, every categorised ticket counted twice in every headline figure,
the CSAT page and the dashboard's History, and `reconcileFailure` cannot see
it, since it checks what the rollup writes, not what a page reads. So the
totals are read through `TOTALS_SLICE` (`lib/reports/queries.ts`) and an
agent's slice through `AGENT_SLICE`, both built by `sliceWhere` from
`DIMENSIONS` and a column map the type holds to it (`lib/reports/rollup.ts`),
never a list of nulls typed out again. A new dimension goes into `DIMENSIONS`
and that map (it does not compile without both), the key and the CHECK in one
commit, and deploys web first, because an old reader meeting the new slices
double-counts until it is replaced. The rollup
asks `reconcileFailure` of a day before it writes it, and writes nothing for a
day that fails. A category figure follows the ticket's category as it stands
when its day is rolled up, as the group's does: the nightly recomputes three
days, so a relabel reaches an older day only through `rollup_metrics from=`.

**A report's window comes from `rangeIn()`, never from `current_date`.** The
rollups bucket a day in the reporting zone so an evening shift does not land on
tomorrow; `current_date` is the _database's_ date, and the database is UTC. A
query that mixes the two is wrong by a day at one edge for the first two hours
of every Cairo morning, and looks entirely correct while it is. So the page
resolves the window once, through `rangeIn(zone, days)` in `lib/reports/rollup.ts`,
and hands the two `YYYY-MM-DD` strings to every query it runs — which also means
the dates printed in the header are provably the dates the figures were selected
on. A live query comparing a `timestamptz` against that window names the zone
too (`::timestamp at time zone <zone>`), rather than casting a date in UTC.

**Say what the window holds, not just what it asked for.** A range control over
a young rollup is indistinguishable from a broken one: `rollup_metrics`
recomputes three days a night and several rollups have no backfill, so every
window wider than the history returns the same rows and the buttons look dead.
The subcategory report (`/reports/categories` at the time,
`/reports/subcategories` since Stage 2.A) was reported as exactly that bug. A
report with a range control therefore prints the window it selected and, when
the figures start after the window opens, says where they start and why (§6.54).

## Tests

Vitest, `*.test.ts` next to the code, node environment, no database — a test
that needs Postgres is a `*.db.test.ts`, below. Put tests where bugs actually
hide — email threading order, quote stripping, the WhatsApp 24-hour boundary,
business hours across DST, Arabic slugs, the condition language — not on glue
code. Add one when you fix a bug of that kind.

**A test that needs a DOM opts in, one file at a time.** `// @vitest-environment
happy-dom` on its first line gives that file happy-dom and leaves every other
test in node. It is still a `*.test.ts`, because that is all vitest collects, so
it builds elements with `createElement` rather than JSX, and it drives React with
React's own `act` and `createRoot` — no testing library. Mock `next/navigation`
through `vi.hoisted`, since `vi.mock` runs before the module's own lines.
`components/use-action-form.test.ts` is the first, and holds the hook to what
§6.80 and §6.89 cost to learn. happy-dom is not a browser: the form-reset bug
was found in Chromium and only reproduced here afterwards, so behaviour that
depends on a real engine is still measured in one before it is relied on.

**`npm run test` runs without a database, so no SQL is executed there.** A query
Postgres will reject still passes every static check: `tsc` type-checks the
Drizzle builder, not the statement it emits, and a raw `sql` fragment is a
template string to all of them. `backfill_meta_profiles` shipped green and died
on its first real run with `operator does not exist: text = channel` —
`meta->>'platform'` is `text` and `contact_identities.channel` is an enum.

The `database` CI job closes that for job handlers. It applies the migrations to
an empty Postgres 17, replays `db/sql/` twice to prove it is idempotent, and then
runs every handler whose work is SQL and needs no credential. An empty database
is enough: Postgres plans a statement before it matches no rows, and planning is
where that error is raised.

It does not cover queries in pages and actions. So a raw `sql` fragment, a
`->>`, a cast or a join across an enum **outside a job handler** still gets run
against a real database before it is pushed — a `*.db.test.ts` beside it, or
`execute_sql` on the production project, which answers it in one call; reading
the row count back is also how you learn the predicate selects what you meant.

**The database tier is where a query is tested, not only planned.** A file named
`*.db.test.ts` is left out of `npm run test` and run by `npm run test:db` — in
CI as the last step of the `database` job, after `npm run db:seed` — against a
migrated Postgres named by `TEST_DATABASE_URL`, never `DATABASE_URL`. Start the
file with `withCleanDatabase()` from `lib/testing/db.ts`: every test begins from
a truncated database holding only what the seed writes (`db/baseline.ts`), so a
test states every row it depends on and no test can lean on another's. Code that
takes its transaction as an argument can be tested the other way, as
`lib/admin/purge-*.db.test.ts` are: fixtures written inside a transaction the
test rolls back, on a connection of its own to `TEST_DATABASE_URL`. The
files run one at a time, since they share the database. Because it truncates
every table it reaches, the helper refuses any database that is not the one
`TEST_DATABASE_URL` named, or not on this machine. Locally, once:

```bash
createdb shipblu_test
export TEST_DATABASE_URL=postgresql://postgres@localhost:5432/shipblu_test
# db:migrate prefers DATABASE_URL_SESSION, so name both.
DATABASE_URL=$TEST_DATABASE_URL DATABASE_URL_SESSION=$TEST_DATABASE_URL npm run db:migrate
npm run test:db
```

**A bare `Date` interpolated into a `sql` template is the same class of trap.**
postgres.js gets it as an untyped parameter, assumes text and throws
`ERR_INVALID_ARG_TYPE`; drizzle maps a Date only when a typed operator tells it
the column, and a template never does. Interpolate `at.toISOString()` behind an
explicit `::timestamptz`. `customerWroteSet` and `staleTemplateFilter` are
both exported purely so a test can read `toSQL().params` back and assert no raw
Date survives — do that for any new fragment holding an instant. An `EXPLAIN` of
the statement typed out by hand does **not** catch this: the literal is a literal
there, and the bug is in what drizzle binds.

One shape in particular: **`any(...)` in a raw fragment is only correct when
what is inside the parentheses is an array _column_.**

```ts
sql`${domain} = any(${companies.domains})`; // right — a column, interpolated as an identifier
sql`${col} = any(${values})`; // wrong — a JS array, one bind parameter per element
```

The second reaches Postgres as `any($2, $3)` — a row constructor — and is
answered `op ANY/ALL (array) requires array on right side` (42809). The two read
identically, which is why this is not a CI check: telling them apart needs the
type of the interpolated expression, not its spelling. Use `inArray()` for a
list of values (§6.46).

There is no browser test suite. Playwright was declared — a dependency and a
`test:e2e` script — with no config and not one spec, and was removed rather than
kept as a promise (`plans/refactor-in-stages.md`, 0.5). It comes back in the PR
that adds its first spec. `npm ci` still installs it, as an optional peer of
`next` that the lockfile already held and npm does not prune — that is not a
dependency of ours, and nothing here imports it. One lesson from it outlives
it: `knip` counts a dev dependency as used whenever its binary appears in a
`package.json` script, so a green dependency check is not evidence that every
dev dependency is earning its place.

## Tool use and live infrastructure

The Supabase and Render MCP tools reach the real production project. **No tool
is off limits** — they are the fastest way to answer "is it actually
configured?", and `execute_sql` against the production project usually does it
in one call.

The constraint is not which tool, it is what you know before you call it. Before
any **write** — `apply_migration`, write SQL, `update_environment_variables`,
`trigger_deploy`, a service or database change:

- **Read the current state first** and quote it in your reasoning. What is the
  value now, which rows match, what does the service run today.
- **Confirm you are pointed at the right target.** Production and staging are
  separate Supabase projects and separate Render services; `docs/PROJECT-STATE.md`
  §2 has the ids. Staging is suspended, tracks `main` and deploys itself on
  commit — check what you are about to deploy, and that staging's
  `EMAIL_PROVIDER` is `local`, before resuming it.
- **Know the blast radius.** How many rows does the `WHERE` clause match — run
  it as a `SELECT` first. What breaks if this env var is wrong on the other
  service. Which tables does this migration lock, and is anything holding a
  conflicting lock right now (§5.5 has the `pg_stat_activity` query).
- **Have the way back.** Say what undoes the change before you make it.
- **Land config in the repo too.** A variable set in the Render dashboard is
  also added to `render.yaml` in the same commit, without its value. The
  blueprint describes the running system; it is not documentation that drifts.

Verified before, then done, beats fast then reconstructed.

## Git and working alongside other agents

Develop on a feature branch and open the pull request against **`dev`**, the
integration branch; **never push to `dev` or `main`**. Commit → push → PR into
`dev` → merge. `main` is what Render builds — every service in `render.yaml`
names `branch: main` — so a change merged into `dev` reaches staging and
production only once `dev` is merged into `main`. Verify the deploy then, not at
the merge into `dev`, and say in a stage's plan which of the two a step waits
for. CI runs on every pull request whatever its base, and on a push to `main`;
a merge into `dev` runs nothing after it, so the pull request's own run is the
only one a change gets before `main`.

More than one agent session works on this repo at once and they share no
context. Two sessions have already fixed the same bug independently and a whole
PR was thrown away.

- `git fetch origin dev` before you plan, not just before you push. `main`, when
  it was the integration branch, moved 20 commits inside one session's context
  window.
- `git log --oneline -30 origin/dev` before claiming a bug exists — and
  `origin/main` before claiming production has it, since a fix can sit on `dev`
  for a while before it ships.
- Claim your seam out loud before starting anything longer than one commit.
- Prefer rebasing onto `dev` over merging `dev` in.

`.github/pull_request_template.md` is the PR body's shape: why, how it was
verified, what deploys with it and what rolls it back. Fill it in rather than
deleting it, and drop the sections that genuinely do not apply.

## Security — non-negotiable

- Secrets never enter the repo. `render.yaml` uses `sync: false` or the env
  group, always without values. Never echo a credential in any direction. CI
  rejects a committed `.env` and a `sync: false` inside an env group, but it
  cannot unsay a credential you pasted into a comment or a log.
- **A dump contains no usable credential without a key the dump does not
  contain, and `whatsapp_account_credentials` is the one place to look.** Every
  other credential lives in the environment and is named from a row. A
  WhatsApp business account's token is named, or stored sealed — never
  plaintext — and nothing but the worker opens one (`credential-confinement`).
  A second table holding a secret is a second place to look and a second
  argument to make; make it in its own change.
- **Some Graph credentials ride in a URL, and a fetch tracing span records the
  URL whole.** `lib/meta/client.ts` sends the Page token as `access_token`, the
  Embedded Signup exchange sends the app secret and the code as query
  parameters, and `debug_token` takes the inspected token as `input_token` —
  the endpoint's only shape. WhatsApp's sends and media downloads, and the
  app token on `debug_token`, go in an `Authorization` header and are not
  exposed this way. Nothing traces today; whoever adds an
  `instrumentation.ts` keeps the `graph.facebook.com` and `graph.instagram.com`
  query strings out of every span in the same change, and
  `NEXT_OTEL_FETCH_DISABLED=1` alone does not (`docs/PROJECT-STATE.md` §6.88).
- Email bodies and imported KB HTML are attacker-controlled. **Sanitise on
  write, never on read**, through `lib/html/sanitize.ts`.
- Attachment paths derive from ids we generate, never from a supplied filename.
  The bucket is private; mint short-lived signed URLs.
- Public endpoints (KB feedback and views, the widget) are rate limited in
  memory — do not add a row per rejected request.
- **A host page telling the widget who its visitor is makes a claim, not a
  statement of fact.** It arrives from a browser. An unsigned identity may only
  decorate the contact the visitor's token already resolved to — it never adopts
  another contact, and it never writes `contact_shipping_accounts`, which is an
  assertion about whose account somebody may speak for. `WIDGET_IDENTITY_SECRET`
  is what promotes a claim to a fact. `docs/embedding-the-widget.md` is the
  contract the other side implements; changing what the signature covers breaks
  a deployed integration silently, so add a second accepted form instead.
- Side conversation recipients come from a directory and are re-read
  server-side; a free-text address is checked against the requester's own
  identities and our mailbox in the action, not only in the composer.
- `X-Frame-Options: DENY` everywhere except `/widget`, which uses
  `frame-ancestors` with an explicit allowlist. CI checks both are still in
  `next.config.ts`.

## Verify, do not infer

Back any claim about production with a query or a log line. "Phase N is
complete" in the docs describes the codebase, never the product — the system
still cannot take a real human support ticket. But do not read "not configured"
as "no data" either: the bot channel has been copying real traffic in since
August, so there is an archive worth measuring against. `docs/PROJECT-STATE.md`
§1 carries the current figures; that is the file that gets updated, not this one.

A 200 in the request logs is not evidence a page renders — RSC prefetches of a
`force-dynamic` route return 200 without running it, so only full navigations
(no `?_rsc=`) tell you anything. And a silent success is worse than a failure:
break down any count that could hide a systematic gap along the dimension that
can fail — per language, per channel, per account.

## Keeping this file current

A stale AGENTS.md is worse than none, because the next agent follows it
confidently. When you learn something durable — a new convention, a command
that changed, a trap that cost you an hour — update this file or
`docs/PROJECT-STATE.md` in the same PR that taught it to you.

`CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file.
Edit `AGENTS.md`; CI fails if either becomes a copy.

If what you learned is mechanical — a shape two files have to share, a name that
has to match — prefer a check in `scripts/ci/rules/`, registered in
`RULES` in `scripts/ci/rules.mjs`, over a paragraph here. A rule in prose is enforced
by whoever last read the prose.
