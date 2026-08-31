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
| `npm run typecheck`               | `tsc --noEmit`                           |
| `npm run lint`                    | ESLint (flat config)                     |
| `npm run format` / `format:check` | Prettier                                 |
| `npm run build`                   | Next production build                    |
| `npm run db:generate`             | Generate a migration from schema changes |
| `npm run db:migrate`              | Apply migrations + post-migration SQL    |

Iterating on one thing — use these rather than the whole suite:

```bash
npx vitest run lib/kb/slug.test.ts     # one file
npx vitest run -t 'strips the quote'   # one test, by name
npx vitest lib/hours                   # watch mode, one directory
npx eslint app/\(console\)/actions.ts  # one file
npx prettier --write AGENTS.md         # one file
```

`tsc` has no useful single-file mode here; run `npm run typecheck` whole.

## What CI checks

`.github/workflows/ci.yml` runs on every pull request, in three jobs:

| Job          | What it runs                                                          |
| ------------ | --------------------------------------------------------------------- |
| `verify`     | `tsc`, `eslint`, `format:check`, `vitest`, `build` — one job each     |
| `repo-rules` | `scripts/ci/repo-rules.mjs`, and migration drift against `db/schema/` |
| `database`   | migrations, `db/sql/` and every DB-only job handler, on real Postgres |

Run the same thing locally when you want the answer sooner:

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
node scripts/ci/repo-rules.mjs
```

**`npm run build` is not optional, which is why CI runs it separately.** Several
failure modes in this project — React's export-condition resolution under the
wrong `NODE_ENV`, ambiguous route segments — appear only at build time and never
in `tsc` or the dev server. `npm run build` pins `NODE_ENV=production`
deliberately; if a build fails with
`Cannot read properties of null (reading 'useContext')`, check the environment,
not the React version.

`scripts/ci/repo-rules.mjs` is where the conventions that used to be prose in
this file now live — the env-var catalogue, the job registry, the `db/sql`
rules, the confinement of the delivery payload, and the rest. Each check carries
the reason it exists. If one of them is wrong, change it there and say why in
the same commit; do not add your call site to an exemption list.

Three things CI still cannot check, so they remain yours:

- **Which side of the read/write boundary a sanitiser call sits on.** CI keeps
  `sanitize-html` in one module. It cannot tell that you called it on the way in.
- **Raw SQL outside a job handler.** The `database` job runs the handlers; a
  query in a page or an action is still only ever executed in production.
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
`lib/`, and revalidates.

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

**Server actions** (`app/**/actions.ts`) start `'use server'` — CI checks the
directive — and follow one shape: authorise (`requireAgent()` /
`requirePermission()` plus `can()`), write, `revalidatePath()`, return a state
object with `error: string | null`. Never
trust an id or address arriving in a `FormData` field — re-read the row
server-side.

**Authorisation lives in code.** `proxy.ts` runs on the Edge and only checks
that a session cookie exists; it cannot tell a revoked session from a live one.
Re-check on every page and every action with `requireAgent()` or
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

**Background work.** Anything slow, external or retryable is a job — with one
narrow exception, written down because it looks like a violation: a control an
agent presses and _waits on_, whose entire output is the provider's answer, calls
the provider in the action instead. `refreshRequesterProfile` is the only one
today. The rule exists so a customer's ticket never depends on Graph being up and
so unattended work gets retried; a person clicking a button is neither, and
queueing it would put the one sentence they are waiting for into a worker log
they cannot read — which is exactly how a missing Meta approval hid for a month
(`docs/PROJECT-STATE.md` §6.27). Where this applies, the provider call itself
stays in one shared function the job and the action both use
(`lib/meta/profile-refresh.ts`), so the two paths cannot answer differently for
the same subject. Everything else is a job: add the type
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

`npm run job -- <type>` takes trailing `key=value` pairs as the payload
(`npm run job -- backfill_meta_profiles force=true limit=50`), so a handler's
options are reachable without hand-inserting a `jobs` row.

**Environment variables** are declared in `lib/env.ts` (Zod, parsed lazily) and
in `render.yaml` in the same commit — CI fails a pull request where the two
disagree, in either direction. Three env groups hold them:
`shipblu-shared` for what is identical in every environment, `shipblu-support-production` for
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
  vocabulary — §6.35.

A WhatsApp business account's access token is read
directly from `process.env`, for a different reason: its variable's _name_ is a
database value, so it cannot be in the schema — and must therefore start `WHATSAPP_TOKEN_`, or
an admin typing a variable name would be choosing which secret gets sent to Meta
as a bearer token (`lib/whatsapp/accounts.ts`).

**Explaining a control.** A label short enough to fit a dense table is rarely
long enough to explain itself. `InfoTip` from `components/tooltip.tsx` is the
console's answer — an ⓘ that opens on hover, focus _and_ tap, portalled to
`document.body` because every admin table and the content column clip their own
overflow. Reach for a `Field` hint when the explanation should always be on
screen, and `InfoTip` when it should be one gesture away. Never `title=` on a DOM
element — it never appears on a phone, which is where the console is read, and
CI rejects it.

**Bilingual and RTL.** Arabic is the default locale and the front door; every
public URL keeps an explicit locale segment. Use `direction()` from
`lib/kb/locale.ts` and never assume LTR. Slugify through `lib/kb/slug.ts` —
ASCII slugify erases Arabic entirely — and decode dynamic route params with
`decodeSlugParam()`, because Next hands them over still percent-encoded.

**Time.** Cairo observes DST again. Build test instants from wall-clock with
luxon and let the timezone database convert; never hand-convert fixtures. SLA
clocks are working-time, resolved through `lib/hours/resolve.ts` by every
consumer so a due date and the report measuring it cannot disagree.

**Measured time is a union, never a sum.** Presence and focus are recorded as
intervals by hot paths that are deliberately approximate — two instances racing
leave overlapping rows, and a tab closing and reopening shreds one shift into
fragments. `lib/reports/intervals.ts` merges them before anything is measured.
Summing durations instead is the obvious implementation and it is wrong in the
one direction that matters: it reports more hours than the day contained and
pushes occupancy above 100%, where it stops meaning anything. An interval's end
is `coalesce(ended_at, last_beat_at)`, so a stream that died without signing off
contributes the time it can account for rather than every hour since.

**A snapshot cannot be recomputed.** Anything of the form "how much was open at
time T" has to be sampled at the time — `conversations` carries only current
state, so counting it during a rebuild writes today's answer onto an old date.
`agent_backlog_snapshots` is sampled hourly for that reason, and the nightly
rollup reads it rather than owning it: `rollup_metrics` rebuilds by delete and
insert, and would otherwise destroy the only copy. Hourly rather than at
midnight because Render's cron schedules are UTC and Cairo's offset moves.

## Tests

Vitest, `*.test.ts` next to the code, node environment, no database. Put tests
where bugs actually hide — email threading order, quote stripping, the WhatsApp
24-hour boundary, business hours across DST, Arabic slugs, the condition
language — not on glue code. Add one when you fix a bug of that kind.

**Vitest runs without a database, so no SQL is executed there.** A query
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
against the real database before it is pushed — `execute_sql` on the production
project answers it in one call, and reading the row count back is also how you
learn the predicate selects what you meant.

Playwright (`npm run test:e2e`) exists but is not part of the pre-push loop.

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
  §2 has the ids. Staging is suspended and pinned to a feature branch rather
  than to `main` — check what you are about to deploy.
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
- Email bodies and imported KB HTML are attacker-controlled. **Sanitise on
  write, never on read**, through `lib/html/sanitize.ts`.
- Attachment paths derive from ids we generate, never from a supplied filename.
  The bucket is private; mint short-lived signed URLs.
- Public endpoints (KB feedback and views, the widget) are rate limited in
  memory — do not add a row per rejected request.
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
has to match — prefer a check in `scripts/ci/repo-rules.mjs` over a paragraph
here. A rule in prose is enforced by whoever last read the prose.
