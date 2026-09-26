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
| `verify`     | `tsc`, `eslint`, `format:check`, `vitest`, `knip`, `build` — one each |
| `repo-rules` | `scripts/ci/repo-rules.mjs`, and migration drift against `db/schema/` |
| `database`   | migrations, `db/sql/`, DB-only jobs, `*.db.test.ts`, on real Postgres |

Run the same thing locally when you want the answer sooner — the `verify` job
calls these same npm scripts, so `npm run lint` fails on a warning here as it
does there:

```bash
npm run typecheck && npm run lint && npm run test && npm run knip && npm run build
node scripts/ci/repo-rules.mjs
```

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
`lib/`, and revalidates.

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
as a bearer token (`lib/whatsapp/accounts.ts`).

**Explaining a control.** A label short enough to fit a dense table is rarely
long enough to explain itself. `InfoTip` from `components/tooltip.tsx` is the
console's answer — an ⓘ that opens on hover, focus _and_ tap, portalled to
`document.body` because every admin table and the content column clip their own
overflow. Reach for a `Field` hint when the explanation should always be on
screen, and `InfoTip` when it should be one gesture away. Never `title=` on a DOM
element — it never appears on a phone, which is where the console is read, and
CI rejects it.

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

**The one AI provider, and the one thing it is allowed to touch.**
`lib/typesafe/` calls TypeSafe's System One endpoint and `lib/categorise-ai/`
asks it the categorisation question — the repo's first and only model call. It is
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
test states every row it depends on and no test can lean on another's. The
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
