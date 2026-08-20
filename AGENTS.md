# AGENTS.md

Working notes for coding agents on ShipBlu Support — a self-hosted helpdesk
(email, WhatsApp, Facebook, Instagram, web chat, knowledge base, customer
portal) built as one Next.js app plus a background worker over Supabase
Postgres.

## Read these first

Three files, in this order, before you plan anything:

| File                    | What it answers                                                       |
| ----------------------- | --------------------------------------------------------------------- |
| `README.md`             | What the system is, and the design decisions behind it — with reasons |
| `docs/PROJECT-STATE.md` | What is actually live, what is left, and the traps that already bit   |
| `plans/*.md`            | The reasoning behind the most recent features                         |

`docs/PROJECT-STATE.md` §6 is a list of bugs that each cost real time. Read it
before debugging anything that looks like an environment, deploy, timezone or
threading problem — the answer is often already there.

Do not re-derive settled decisions. If a design looks wrong, check whether the
README already explains why it is that way, and say so explicitly if you still
disagree.

## Setup and commands

Node 22 (`engines` pins `>=22 <23`).

```bash
npm install
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

## Before every push — all four, always

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

All four are clean on `main`; keep them that way. **`npm run build` is not
optional.** Several failure modes in this project — React's export-condition
resolution under the wrong `NODE_ENV`, ambiguous route segments — appear only
at build time and never in `tsc` or the dev server. `npm run build` pins
`NODE_ENV=production` deliberately; if a build fails with
`Cannot read properties of null (reading 'useContext')`, check the environment,
not the React version.

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

Logic lives in `lib/`, not in route files. A page or action authorises, calls
into `lib/`, and revalidates.

## Conventions

**TypeScript.** Strict. Path alias `@/*` maps to the repo root. Prettier:
single quotes, semicolons, trailing commas, width 100, two spaces. Unused
identifiers must be prefixed `_` or removed.

**Comments carry the reasoning.** This codebase explains _why_, not _what_ —
the trade-off taken and what the naive alternative would have broken. Match
that: a comment restating the code is noise here, a comment recording a
decision is the point. Same for commit messages.

**Server actions** (`app/**/actions.ts`) start `'use server'` and follow one
shape: authorise (`requireAgent()` / `requirePermission()` plus `can()`), write,
`revalidatePath()`, return a state object with `error: string | null`. Never
trust an id or address that arrived in a `FormData` field — re-read the row
server-side.

**Authorisation is in code, not the database.** `proxy.ts` runs on the Edge and
only checks that a session cookie exists; it cannot tell a revoked session from
a live one. Every page and every action re-checks with `requireAgent()` or
`requirePermission()` against the database. RLS is enabled with zero policies
and **never `FORCE`** — the app connects as the table owner, so adding FORCE
breaks every query. New permission keys go in `PERMISSIONS` in
`lib/auth/permissions.ts` with a comment saying why the capability is separate.

**Database.** Two connections: `db` on the Supavisor _transaction_ pooler
(prepared statements disabled), `sessionSql()` for `LISTEN`. Both initialise
lazily — `next build` imports route modules without runtime secrets, so nothing
may open a pool or read env at module scope. Schema changes go in `db/schema/`
then `npm run db:generate`; database-level behaviour (extensions, triggers,
trigram indexes, `NOTIFY`) goes in `db/sql/`, must be idempotent, and must not
use `CREATE INDEX CONCURRENTLY` — the whole file runs in one implicit
transaction. New tables need RLS enabled; `db/sql/` now does that by loop, so
do not add it by hand.

**Background work.** Anything slow, external or retryable is a job: add the
type to `JobType` in `lib/queue/index.ts`, a handler file under
`worker/handlers/`, and register it in `worker/handlers/index.ts` — an
unregistered type fails loudly rather than being dropped. Use `dedupeKey` for
anything a webhook retry could duplicate. Webhooks persist to `webhook_events`
and return 200 immediately; they never do the work inline.

**Environment variables** are declared in `lib/env.ts` (Zod, parsed lazily) and
in `render.yaml` in the same commit. Shared values belong in the
`shipblu-shared` env group only — Render gives service-level variables
precedence, and a key declared in both places silently takes the service value.
A module reachable from the search parser must read `process.env` directly
rather than `env()`, which validates the whole schema (see
`lib/shipments/detect.ts`).

**Bilingual and RTL.** Arabic is the default locale and the front door; every
public URL keeps an explicit locale segment. Use `direction()` from
`lib/kb/locale.ts`; never assume LTR. Slugify through `lib/kb/slug.ts` — ASCII
slugify erases Arabic entirely — and decode dynamic route params with
`decodeSlugParam()`, because Next hands them over still percent-encoded.

**Time.** Cairo observes DST again. Build test instants from wall-clock with
luxon and let the timezone database convert; never hand-convert fixtures. SLA
clocks are working-time, resolved through `lib/hours/resolve.ts` by every
consumer so a due date and the report measuring it cannot disagree.

## Tests

Vitest, `*.test.ts` next to the code, node environment, no database. Tests go
where bugs actually hide — email threading order, quote stripping, the WhatsApp
24-hour boundary, business hours across DST, Arabic slugs, the condition
language — not on glue code. Add one when you fix a bug of that kind.

Playwright (`npm run test:e2e`) exists but is not part of the pre-push loop.

## Git and working alongside other agents

Development happens on a feature branch; **never push to `main`**. Commit →
push → PR → merge → verify the deploy.

More than one agent session works on this repo at once and they share no
context. Two sessions have already fixed the same bug independently and a whole
PR was thrown away.

- `git fetch origin main` before you plan, not just before you push. Main moved
  20 commits inside one session's context window.
- `git log --oneline -30 origin/main` before claiming a bug exists.
- Claim your seam out loud before starting anything longer than one commit.
- Prefer rebasing onto main over merging main in.

## Security — non-negotiable

- Secrets never enter the repo. `render.yaml` uses `sync: false` or the env
  group, always without values. Never echo a credential in any direction.
- Email bodies and imported KB HTML are attacker-controlled. **Sanitise on
  write, never on read**, through `lib/html/sanitize.ts`.
- Attachment paths derive from ids we generate, never from a supplied filename.
  The bucket is private; mint short-lived signed URLs.
- Public endpoints (KB feedback and views, the widget) are rate limited in
  memory — do not add a row per rejected request.
- Recipient addresses for side conversations come from a directory and are
  re-read server-side; a free-text address is checked against the requester's
  own identities and our mailbox in the action, not only in the composer.
- `X-Frame-Options: DENY` everywhere except `/widget`, which uses
  `frame-ancestors` with an explicit allowlist.

## Verify, do not infer

Any claim about production must be backed by a query or a log line. The
Supabase and Render MCP tools are the fastest route — `execute_sql` against the
production project answers most "is it actually configured?" questions in one
call. Note that "phase N is complete" in the docs is a statement about the
codebase, never about the product being usable: channels, agents, locations,
SLA policies and automation rules are all still empty.

A 200 in the request logs is not evidence a page renders — RSC prefetches of a
`force-dynamic` route return 200 without running it. Only full navigations
(no `?_rsc=`) tell you anything. And a silent success is worse than a failure:
counts that can hide a systematic gap should be broken down along the dimension
that can fail — per language, per channel, per account.
