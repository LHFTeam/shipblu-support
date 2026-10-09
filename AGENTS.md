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
- Never push to `main`. Branch → PR → merge.
- Sanitise attacker-controlled HTML on write, never on read.
- Verify state before any write against live infrastructure. See
  [Tool use](#tool-use-and-live-infrastructure).

Most of what this list used to carry is now enforced on every pull request — see
[What CI checks](#what-ci-checks). What is left is what a machine cannot check: a
push to `main` it cannot prevent, a sanitiser call it cannot place on the right
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
worker/handlers/ one file per job type, registered in worker/handlers/index.ts
proxy.ts         Next 16 middleware: host routing + the signed-out redirect
```

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
`app-scroll h-full overflow-y-auto p-6` wrapper is not merely unpadded — every
row below the fold is rendered where nobody can scroll to it, and the page reads
as half-finished rather than as broken (§6.53). `admin/layout.tsx` supplies one
for everything beneath it; nothing else does. CI checks it (`console-scroll`):
every other console page either says `overflow-y-auto` or renders
`<InboxShell>`, which owns its panes.

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
`side-conversation-` and `category-actions.ts` — answer with
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
`LiveUpdates`' own (§6.87). What a form does next — close an editor, put a
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
`db/schema/` then `npm run db:generate`. Files in `db/sql/` must be idempotent
and must not use `CREATE INDEX CONCURRENTLY`; the whole file runs in one
implicit transaction. New tables get RLS enabled by a loop in `db/sql/` — do not
add it by hand. All three are checked, the first two by replaying the files and
the last by asking the database which tables ended up covered.

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
answer, calls the provider in the action instead. `refreshRequesterProfile` is
that one. The rule exists so a customer's ticket never depends on Graph being up
and so unattended work gets retried; a person clicking a button is neither, and
queueing it would put the one sentence they are waiting for into a worker log
they cannot read — which is exactly how a missing Meta approval hid for a month
(`docs/PROJECT-STATE.md` §6.27). Where this applies, the provider call itself
stays in one shared function the job and the action both use
(`lib/meta/profile-refresh.ts`), so the two paths cannot answer differently for
the same subject. The second is the Embedded Signup exchange —
`beginCoexistenceOnboarding` in `lib/whatsapp/onboarding.ts`, behind the
`connectBusinessAppNumber` action — forced by the code Meta's window hands the
browser: it lives thirty seconds and is spent once, so a queued job could not be
sure of running before it died, and a dead code is a business sent through
Meta's window again. Only what the code forces happens in the action — exchange
it, prove the token reads the WABA the browser named, seal it, record the
attempt — and everything after the exchange is the
`complete_coexistence_onboarding` job, run with the stored credential, so a
closed tab abandons nothing and the first run, a retry and a later "copy the
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
`automatedReplyBlocked` in `lib/tickets/outbound.ts` stops **all three** automated
senders — the automation engine, the out-of-hours acknowledgement and the CSAT
survey — at **24 hours** on `facebook` and `instagram`, not at seven days. The
seven days belong to a human. It is shared with WhatsApp's template rule because
a guard only some of the senders apply is not a guard, and it refuses before the
row is written: delivery refuses it too, but by then the customer's timeline
carries a reply that permanently failed. Route a new automated sender through it
and through `carrierFor`, which is the same lesson twice — `send_csat` kept
private copies of both and so surveyed Facebook tickets by email.

Two things it must be given rather than guess. **A Meta comment ticket has no
messaging window**: it is answered on the comment edge, which `send_meta` reaches
before it consults the clock, so the guard takes the ticket's `external_id` and
never blocks one. And **the clock is the real one** — the ingest lifecycle hands
a message's own `sentAt` down as its timestamp, and that is exactly
`lastCustomerMessageAt`, so passing it as `now` compares a value with itself and
reports every window open. That is precisely the replayed backlog the guard is
for.

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

**A coexistence number is live on the phone and on Cloud API at once**, and
four rules keep the two sides from being read as each other. The copied
history is a record, not traffic (`lib/tickets/ingest-whatsapp-history.ts`):
each thread is one resolved `import` conversation, and nothing a live message
sets off runs for it — no SLA clock, no automation, no out-of-hours reply, no
categorisation, no shipment linking, no media download and no 24-hour window,
because `last_customer_message_at` stays null and a live message never
continues an imported conversation. A reply the business typed on the phone
arrives as an `smb_message_echoes` delivery and is the team's reply: outbound,
no author, labelled "WhatsApp Business app", moving `last_agent_message_at`
forward and never `last_customer_message_at` — on a plain support number the
same echo is our own send coming back and stays ignored. It answers only what
came before it: `onAgentReply` stops the next-response clock only when the
reply is at least as new as `last_customer_message_at`, and
`first_responded_at` takes the earliest reply, so the SLA does not depend on
the order deliveries are processed in. With no live conversation, the business
writing first files a _resolved_ conversation (`resolved_at` null, no survey)
that the customer's reply reopens. The copy of contacts
and history is once per onboarding, inside 24 hours of the exchange, with the
Business app open on the phone (`canRequestSync`; Meta's 2593107 and 2593108
both mean "reconnect"). And `saveChannel` carries `coexistence` and the stored
`phoneNumberId` over rather than rebuilding `config` as `{phoneNumberId}`,
which is how a rename used to wipe the connection while the number kept
routing.

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

**Ticket categorisation.** `lib/categorise/` is pure and rules-only; the live
path is `categoriseFromMessage`, called from `afterMessageStored`. Four rules
hold, and each of them closes something that has already been reasoned through:

- **Only inbound `reply` messages are categorised.** Not our own replies, which
  would file every ticket where an agent pasted a canned answer, and not notes,
  which would launder an agent's opinion into the `detected` column the tuning
  pass trusts. Bot channels are excluded through `readOnlyChannels()` — the
  bot's menu is a self-service funnel, not support demand, and categorising it
  would report the one as the other.
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
- **A category is retired, never deleted**, and `conversation_categories`
  freezes `category_key` at assignment. The rollups key on the same text, so a
  report drawn last quarter stays readable after somebody tidies the taxonomy.
  The registry tables live in `db/schema/config.ts` beside `ticket_statuses`
  rather than with the join table, because `conversations` references them and
  everything references `conversations`.

Confidence is an evidence grade, not a probability, and anything rendering it
says so. `CATEGORISE_AUTO_MIN`, `CATEGORISE_RECORD_MIN` and
`CATEGORISE_DISABLED_RULES` tune the bands and kill one over-firing rule by key
without a deploy — read through `process.env` for the reason `detect.ts` gives.
Under-detection is cheap (it shows as `meta.unclassified`, which has its own
section on the review page — it carries confidence 0, so it can never surface in
a queue ordered best-evidence-first); over-detection silently moves a number a
manager staffs a team from. `combine()` picks its ceiling from the strongest
rule that contributed rather than from how many did, so a pile of single
keywords is held below the auto band however many of them agree.
See `plans/ticket-categorisation.md`.

**The one AI provider, and the two things it is allowed to touch.**
`lib/typesafe/` calls TypeSafe's System One endpoint, and two modules ask it
questions. `lib/categorise-ai/` asks the categorisation question, and it is
a **shadow**: every answer lands in `ai_category_runs` and nothing else, so no
rollup, no review queue and no primary ladder can see it. That separation is not
caution to be tidied away later. `conversation_categories.confidence` is an
evidence grade, hand-assigned and combined by noisy-OR, and three screens explain
it as one; TypeSafe returns a probability. One column holding both would be
undetectable from the outside. Anything wanting to promote a result argues for it
in its own change.

Four rules hold, and the module is inert until somebody starts it — presence of
`TYPESAFE_API_KEY` is the flag, the `instagramLoginConfigured()` device, and the
key lives in the environment groups rather than the shared one because the job
sends real customer text to a third party:

- **The option list comes from `ticket_categories`, never from `TAXONOMY`.** A
  retired category leaves the rules path at once; if it did not leave the model's
  choices at the same moment the two would answer over different vocabularies and
  every disagreement between them would be an artefact.
- **`meta.unclassified` is always offered, and the instructions name it.** Given
  55 options and no way out, a model asked about "؟" names something, and a forced
  guess is the over-detection `plans/ticket-categorisation.md` warns about.
- **The rules baseline is computed in the same call**, from `detectCategories` —
  not read back from `conversation_categories`, whose rows agents have since
  confirmed, rejected and added. The first measures the detector; the second
  measures the team.
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
which moves SLA deadlines. It earns that where the categoriser could not because
priority has no second quantity to be confused with — the column is a level, not
an evidence grade, and one ticket in the archive had a priority set by hand.
What it may not do is overrule anybody: `lib/priority-ai/decide.ts` is the only
place that decides whether an answer may be written, and its rules are tests. A
priority set by a person, a rule, a form default or an agent opening the ticket
is never touched; only the answer to the customer's opening message may lower a
ticket, and later ones only raise; and every answer, applied or not, is a row in
`ai_priority_runs` with its full distribution, because those rows are the only
labels priority has. A new writer of `conversations.priority` writes the column
and its `priority_changed` event in one transaction, stamps the event with
`PRIORITY_STAMP` (`lib/tickets/priority-stamp.ts`) so events sort in the order
the column was written, and calls `onPriorityChanged` after it commits — as the
console, the `set_priority` automation and the classifier do. The policies price
their targets per priority, and the classifier decides whose priority a ticket
carries from the column and those events read together. See
`plans/priority-through-typesafe.md`.

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
included. The letter table is the categoriser's too, so the two agree on which
letters are one letter — and on no more: the categoriser also strips tatweel
and tashkeel from the text it reads, which a search can do to the query
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
`reply` carrying text and hands it to `preferredLocale()`. Each of those
narrowings is a way the answer went wrong: the last inbound row of _any_ kind
includes the English `system` notice we write when a form attachment fails, and
a media message carries no text at all. A sender that reads the language off a
message it already happens to be holding is how the two came to disagree, so do
not reintroduce that shortcut — one indexed query is the price of the invariant.

The console's pickers are deliberately outside this. They open on
`detectLocale()` from `lib/kb/language.ts`, the value the inbox page already
computed to search the knowledge base, so the knowledge panel and the canned
picker beside it cannot disagree. The two detectors differ at the margins —
`detectLocale` calls text Arabic from a fifth of its letters, `preferredLocale`
from a majority — and that is the right way round: one is a default an agent
overrules with a click, the other has already been sent. Do not trust
`contacts.locale` alone in either; nothing writes it, so all 6,000 contacts
read as 'en'.

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
consumer so a due date and the report measuring it cannot disagree.

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
midnight because Render's cron schedules are UTC and Cairo's offset moves.

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
`/reports/categories` was reported as exactly that bug. A report with a range
control therefore prints the window it selected and, when the figures start
after the window opens, says where they start and why (§6.54).

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
§6.80 and §6.87 cost to learn. happy-dom is not a browser: the form-reset bug
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
explicit `::timestamptz`. `interactionWindowSet` and `staleTemplateFilter` are
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

Develop on a feature branch; **never push to `main`**. Commit → push → PR →
merge → verify the deploy.

More than one agent session works on this repo at once and they share no
context. Two sessions have already fixed the same bug independently and a whole
PR was thrown away.

- `git fetch origin main` before you plan, not just before you push. Main moved
  20 commits inside one session's context window.
- `git log --oneline -30 origin/main` before claiming a bug exists.
- Claim your seam out loud before starting anything longer than one commit.
- Prefer rebasing onto main over merging main in.

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
