# Refactoring in stages

_Written 2026-09-25, against `main` at `8abc62a`. It is based on a read-only
audit of `app/`, `lib/`, `worker/`, `db/`, `components/`, `scripts/` and CI.
Every defect listed in Stage 2 was confirmed by reading the code, not inferred
from the audit's summary. There were no open pull requests when this was
written._

## Context

The request was to bring the codebase in line with best practice, planned and
carried out in stages.

**The baseline is strong.**

- Typing is strict: `strict`, `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax` are on.
- There is no `any`, no `@ts-ignore` and no TODO marker.
- There are 1,500+ tests, and CI enforces twenty invariants through
  `scripts/ci/repo-rules.mjs`.

**The debt is structural, not stylistic.** Four kinds:

1. **Logic has leaked into `app/`.**
   - `app/` has about 127 database write sites.
   - The three action files are large:
     - `app/(console)/actions.ts`: 2,036 lines
     - `admin/settings-actions.ts`: 1,840 lines
     - `admin/actions.ts`: 613 lines
   - About twenty admin pages query `db` directly.
   - `inbox/[number]/view.tsx` is a single 1,969-line client component.
2. **One lifecycle is written seven times.**
   - Inbound ingest has seven copies: email, WhatsApp ×2, Meta ×2, widget,
     portal ×2.
   - The outbound agent reply has two copies.
   - The copies have already drifted apart: Stage 2, item 2 is one result.
3. **Primitives are missing, so every file rolls its own.** There is no:
   - logger (about 240 raw `console.*` calls);
   - FormData or action-state helper (eleven state types, and `ok()` defined
     four times);
   - typed job payload;
   - non-retryable job error;
   - fetch timeout on most providers;
   - shared test fixture.
4. **The guard-rails are soft.**
   - ESLint runs only the Next presets, and warnings never fail CI.
   - `repo-rules.mjs` is one untested 1,435-line file.
   - Its `server-actions` check only matches files named `actions.ts`, so
     `settings-actions.ts` is not checked for `'use server'` today.

### What this supersedes, and why

`plans/query-optimisation-and-cleanup.md` (2026-09-09) argued against a sweeping
refactor, for three reasons:

- concurrent sessions collide and throw work away;
- the comments are the asset;
- the three large files should be left alone until something else needs them
  opened.

The refactor has now been asked for explicitly. Those three risks are real, so
this plan answers them rather than setting them aside:

- Every PR is small, covers one seam, and can be reverted on its own.
- Pure moves never share a PR with behaviour changes.
- A seam is claimed in the table below before work starts.
- No comment is removed unless it is proven false.
- The hot files are split last, behind a gate.

### Decisions taken with the requester

- **A database-backed test tier.** New `*.db.test.ts` files run only in CI's
  `database` job; unit tests stay database-free. The ingest paths are
  transactions of raw SQL, so mocking the Drizzle builder would only test the
  mock. Without real SQL underneath, the consolidation in Stage 4 is not safe.
- **Playwright is removed.** It is a dependency and a script with no config and
  no specs. It comes back with its first spec.
- **All stages are planned, with a gate before Stage 5.** Stage 5 is the first to
  split the files other sessions edit most:
  - `view.tsx`: 21 changes in the last month
  - `settings-actions.ts`: 14
  - `actions.ts`: 12

## Tracking

Claim a row before starting it, and update it when the PR opens and when it
merges. If a row is claimed and its PR is open, do not start another PR on the
same files. A follow-up PR on a merged row's files gets a row of its own while
it is open, so the table shows those files as taken again. Keep each cell inside
its column's current width — `this PR` or a PR number, and `open` or `merged` —
so an update is a one-line diff: a longer value makes Prettier re-pad every row,
and two sessions claiming different rows then conflict on all of them.

| Stage | Item                                             | Branch / PR     | Status  |
| ----- | ------------------------------------------------ | --------------- | ------- |
| 0.1   | Commit this plan                                 | #166            | merged  |
| 0.2   | Harden `server-actions` and minimum-count guards | #167            | merged  |
| 0.3   | Split `repo-rules.mjs` into per-rule modules     | #191–#192       | merged  |
| 0.4   | CI tidy-up                                       | #193–#195       | merged  |
| 0.5   | Remove Playwright                                | #173            | merged  |
| 1.1   | `lib/testing/` fixtures                          | #208, #210–#211 | merged  |
| 1.2   | Database test tier                               | #212–#213       | merged  |
| 1.3   | Characterise the seven ingest entry points       | #215–#218       | open    |
| 1.4   | Webhook route tests                              | #196            | merged  |
| 1.5   | DB test for the admin overview's raw SQL         | #214            | merged  |
| 1.x   | Test gaps the 1.1 reviews found                  | #225–#226       | open    |
| 2.1   | Email webhook dedupes before it verifies         | #168            | merged  |
| 2.2   | Portal agent replies bypass `carrierFor()`       | #169            | merged  |
| 2.3   | Contacts pages cannot scroll                     | #170            | merged  |
| 2.4   | `PermanentJobError`                              | #174            | merged  |
| 2.5   | Ids taken from `FormData`                        | #180–#182       | merged  |
| 2.6   | KB admin search does not escape LIKE             | #176            | merged  |
| 2.7   | One `GRAPH_VERSION`                              | #175            | merged  |
| 2.8   | Fetch timeouts, one provider per PR              | #184–#188       | merged  |
| 2.9   | Replies never get paragraphs (CRLF)              | #171            | merged  |
| 2.10  | Email webhook fails open without its secret      | #177            | merged  |
| 2.11  | Staging's `local` email webhook accepts anything | #177            | merged  |
| 0–2   | Follow-ups to the reviews of #187–#196           | #203, #205      | merged  |
| 3     | Shared primitives (one row per PR as opened)     |                 | open    |
| 3.1   | Queue helper: `hasActiveJob(type)`               | #197            | merged  |
| 3.2   | Email helpers: `buildReferences`, escaper name   | #198            | merged  |
| 3.3   | Shared constants: `TEAM_TIME_ZONE`               | #199            | merged  |
| 3.4   | Shared constants: proxy regex from `LOCALES`     | #200            | merged  |
| 3.5   | Constant-time compares through `safeEqual`       | #219            | open    |
| 3.6   | Widget: shared shapes move to `lib/widget`       | #220            | open    |
| 3.7   | Widget: one declaration of the postMessage names | #221            | open    |
| 3.8   | `errorMessage()` for caught values               | #222            | open    |
| 4.1   | Split `lib/tickets/queries.ts`                   | #224            | open    |
| 4.2   | Shared ingest steps                              |                 | pending |
| 4.3   | Meta Graph transport                             | #228            | open    |
| 4.4   | Worker: typed payloads, backfill, KB import      |                 | pending |
| ⛳    | Gate: check in with the requester                |                 | pending |
| 5.x   | Server side of `app/`                            |                 | pending |
| 6.x   | Client components                                |                 | pending |
| 7     | Lint tightening, finish logging                  |                 | pending |

## Ground rules for every PR

**PR size and shape**

- One seam per PR, roughly 400 changed lines or fewer, not counting pure moves.
  Each PR can be reverted on its own.
- Pure moves are separate from behaviour changes.
  - A move PR contains the moved code plus import edits and nothing else, and it
    reads that way under
    `git diff origin/main -M -C --color-moved=dimmed-zebra`.
  - A behaviour PR carries a test that fails on `main`.
- Record pure reformat commits in `.git-blame-ignore-revs`. Not moves across
  files: ignore-revs only looks for a line in the same file's parent, so it
  cannot see where moved code came from and mis-credits whatever the commit
  wrote. `git blame -C -C` follows a move with no file at all.

**Comments**

- Comments move with their code, word for word.
- Change only a reference the move broke ("above", "this file", a line number)
  or a claim that is false. The reasoning prose is the asset.

**How the repo's own checks shape the order**

- **`dead-exports` fails an export nothing imports.** So every PR that adds a
  shared helper also switches its callers over in the same PR. "Add it now,
  adopt it later" is red.
- **No `export *` barrels and no re-export shims.** `dead-exports` treats a
  namespace or wholesale re-export as opaque and stops checking that module.
  Repoint every importer instead.
- **`repo-rules.mjs` hard-codes about 25 paths.** A move that touches one updates
  the script in the same PR. It also updates the path wherever AGENTS.md, the
  README or `docs/PROJECT-STATE.md` mentions the file. Keep PROJECT-STATE edits
  to path substitutions, because it changes more than any other file.

**Concurrent sessions (AGENTS.md "Git and working alongside other agents")**

- Run `git fetch origin main` and check the open PRs before claiming a row.
- Never split a file that an open PR touches.
- A split of a hot file is opened and merged the same day. If `main` moves under
  it, redo the move from fresh `main` rather than resolving conflicts in a
  1,000-line diff.

---

## Stage 0 — guard-rails, CI and housekeeping

No change to how the app behaves.

### 0.1 Commit this plan

Add a pointer to this file from the "On the refactor" section of
`plans/query-optimisation-and-cleanup.md`.

### 0.2 Harden `server-actions` (`scripts/ci/repo-rules.mjs:650`)

- Check in both directions:
  - every `'use server'` module is named `actions.ts` or `*-actions.ts`;
  - every `app/**/*actions.ts` carries the directive.
- Add minimum-count guards, like the `declared.length < 20` that env-parity
  already has, to the checks that would pass silently on zero matches:
  `server-actions`, `client-bundle`, `dead-exports` and `job-registry`.
- Stage 5 would otherwise create new `*-actions.ts` files the check never
  looks at.

### 0.3 Split `repo-rules.mjs` as a pure move

- Helpers go to `scripts/ci/lib.mjs`, and each check to
  `scripts/ci/rules/<name>.mjs`.
- The `RULES` table and the `node scripts/ci/repo-rules.mjs` entry point stay
  where they are. CI, AGENTS.md and knip's github-actions plugin all name them.
- Then add `scripts/**/*.test.mjs` to the vitest include, with fixture tests for
  the three checks that walk the module graph: `server-actions`, `client-bundle`
  and `dead-exports`.

### 0.4 Tidy CI (`.github/workflows/ci.yml`)

- **Commands.**
  - Call `npm run typecheck`, `npm run lint` and `npm run test` rather than bare
    `npx`, so CI and `package.json` cannot drift.
  - Add `--max-warnings=0` to lint, once it is confirmed clean.
- **Actions.**
  - Pin actions to commit SHAs.
  - Add Dependabot for `github-actions` only. npm updates would compete with the
    sessions.
- **The `database` job.**
  - Move the inline psql assertions (the bilingual backfill and the handbook's
    idempotency) into `scripts/ci/*.sql`, as `db-invariants.sql` already is.
  - Run `npm run db:seed` in the job. The characterisation tests in Stage 1 need
    the default statuses.
  - Move the job's hand-kept handler list into `scripts/ci/db-jobs.txt`, with a
    "run" section and a "skip: reason" section. A repo-rules check then asserts
    that every `JobType` appears exactly once, so a new database-only handler
    cannot be forgotten.

### 0.5 Remove Playwright

Remove, through `npm uninstall` so that `package-lock.json` is regenerated:

- `@playwright/test` and the `test:e2e` script;
- its entries in `.gitignore`, `.prettierignore`, `eslint.config.mjs`,
  `tsconfig.json` and the vitest `e2e/**` exclude;
- the AGENTS.md paragraph about it.

## Stage 1 — test scaffolding and characterisation

This comes before any structural move.

### 1.1 `lib/testing/` fixtures

- **`env.ts`.** `useTestEnv()` sets `DATABASE_URL` and `APP_SECRET`, calls
  `resetEnvCache()`, and restores both afterwards. It replaces the stub copied
  into about sixteen test files.
- **`fetch.ts`.** `stubFetch` and `respondWith` replace the copies in
  `lib/meta/client.test.ts:10` and `lib/whatsapp/client.test.ts:12`, and the
  `globalThis.fetch =` assignments.
- **`time.ts`.** Cairo wall-clock builders through luxon, following AGENTS.md
  §Time.
- Adopt all three in the same PR, because `dead-exports` requires it.
- No global `setupFiles`: `lib/env.test.ts` depends on the variables being
  absent.

### 1.2 The database test tier

- `vitest.db.config.mts` includes `**/*.db.test.ts`, and the default config
  excludes those files.
- `lib/testing/db.ts` provides truncate and seed.
- The `database` job runs the tier after migrate and seed.
- Update AGENTS.md §Tests in the same PR.

### 1.3 Characterise the seven ingest entry points

The entry points are:

- `lib/tickets/ingest.ts`
- `lib/tickets/ingest-whatsapp.ts` (both)
- `lib/tickets/ingest-meta.ts` (both)
- `lib/widget/conversation.ts`
- `lib/portal/tickets.ts` (both)

Tests record what the code does today, quirks included.

- **Cases every path gets:**
  - a new ticket;
  - a threaded reply;
  - resolved → reopened, with its event;
  - a duplicate delivery.
- **Cases specific to one path:**
  - `whatsapp_bot` skips `afterInboundMessage`;
  - a Meta comment versus a direct message;
  - the side-conversation token resolves before `resolveContact`.
- **What the tests assert:** rows in `conversations`, `messages`,
  `conversation_events` and `jobs`.
- **Fixtures carry no attachments**, because email ingest uploads to storage
  inline.

Email ingest, WhatsApp ingest and `lib/tickets/lifecycle.ts` have no tests at
all today.

### 1.4 Webhook route tests

For each of the three webhook routes, pin the status code and the stored
`providerEventId`, for a verified payload and for an unverified one.

### 1.5 The admin overview's raw SQL

`app/(console)/admin/page.tsx:37-60` is twelve raw subqueries outside a job
handler. Today it first executes in production.

## Stage 2 — verified defects

Each fix is one small PR, written test-first. This stage may overlap Stage 1.

### 2.1 The email webhook dedupes before it verifies

`app/api/webhooks/email/[provider]/route.ts:79-104` stores `providerEventId` on
an unverified payload, and returns `duplicate` before it checks the signature.
So a forged delivery can claim a real delivery's id first, and the real one is
then dropped as a duplicate.

- **Fix:** store the id only when verified, as WhatsApp
  (`app/api/webhooks/whatsapp/route.ts:85-93`) and Meta already do.
- **Status code: 401 stays, and that was decided, not deferred.** Postmark's
  inbound-webhook reference retries anything but a 200 ten times over about
  ten hours, and stops on a 403. Those retries are what recover a genuine email
  once a misconfigured `EMAIL_WEBHOOK_SECRET` is corrected, so the email route
  deliberately differs from the other two. The route's comment says so.
- **A second consequence of the same ordering.** With a wrong secret,
  Postmark's retry hit the unique index and was answered `200 duplicate`, so
  Postmark marked the message delivered and the email was lost even after the
  secret was fixed. Refusing an unverified delivery before the duplicate check
  closes that too.

### 2.2 Portal agent replies bypass `carrierFor()`

- `sendReply` (`app/(console)/actions.ts:320-336`) decides whether a reply is
  email with `channel === 'email'`.
- `deliverAutomatedReply` (`lib/tickets/outbound.ts:111`) stopped doing exactly
  that, because `portal` is carried by `send_email` too.
- As a result, an agent's reply on a portal ticket is stored with no `bodyHtml`
  and no `toAddresses`. The worker then falls back to `contact.primaryEmail` and
  a single `<p>`.

Three places change:

- `sendReply` uses `carrierFor()`;
- the carrier re-derived inline at `actions.ts:372` becomes a call to
  `carrierFor()`;
- `worker/handlers/send-csat.ts:88`, which makes the same `=== 'email'` test,
  is fixed too.

### 2.3 The contacts pages cannot scroll (§6.53)

Four pages open with `p-4 md:p-6` and no scroll container:

- `app/(console)/contacts/page.tsx:32`
- `[id]/page.tsx:80`
- `accounts/[sbid]/page.tsx:46`
- `shipments/[tracking]/page.tsx:71`

So everything below the fold is unreachable.

- Add the `app-scroll h-full overflow-y-auto` wrapper to each.
- Add a repo-rules check that every `(console)` page outside `admin/` and
  `inbox/` opens one. AGENTS.md prefers a check to a paragraph.

### 2.4 A job that must not be retried cannot say so

- **The bug.** `worker/handlers/send-notification-email.ts:29-32` says a bad
  payload fails "rather than burning five attempts". But it throws a plain
  `Error`, and `failJob` (`lib/queue/index.ts:204`) retries every error.
  `worker/handlers/send-agent-invite.ts:35` has the same bug.
- **The fix.**
  - Add `PermanentJobError` to `lib/queue`. `failJob` marks it `dead` at once,
    so it stays visible and can be replayed.
  - Unit-test `failJob`.
- **Left alone.** The catch-and-return senders, such as `send_whatsapp`, record
  their failure on the message row, which is where an agent sees it.

### 2.5 Ids taken from `FormData`

- **`updateTicket`** (`actions.ts:927-975`) writes the assignee and group ids it
  was given. The foreign key proves the row exists; it does not prove the agent
  is active.
  - Validate the uuid.
  - Re-read that the agent is active and that the group exists.
- **The `delete*` actions in `settings-actions.ts`** pass `text(formData, 'id')`
  straight to a query. Pass it through `uuidField`.
- **`app/api/attachments/[id]`** answers a malformed uuid with a 500 (Postgres
  error 22P02). It should answer 404.

### 2.6 The KB admin search does not escape LIKE

In `lib/kb/admin.ts:82`, `%` and `_` in the search box act as wildcards.

- Share `escapeLike` from `lib/tickets/search.ts:67`.
- Adopt it here, and in the inline copies in `lib/shipments/queries.ts` and
  `lib/contacts/merge.ts`.

### 2.7 One `GRAPH_VERSION`

It is declared four times:

- `lib/meta/client.ts:23`
- `lib/meta/subscriptions.ts:38`
- `lib/whatsapp/client.ts:14`
- `worker/handlers/check-meta-permissions.ts:40`

AGENTS.md treats it as one value. Move it to `lib/meta/graph.ts` and import it
everywhere.

### 2.10 The email webhook fails open without its secret

Found by review of #168, not by the audit. When `EMAIL_WEBHOOK_SECRET` is unset,
`PostmarkProvider.verifySignature` (`lib/email/providers/postmark.ts`) returns
`true` with a warning, deliberately — its comment calls that a deployment choice.
In that configuration none of #168's protection applies: a forged payload is
stored as verified, under the `MessageID` it claims, and queued to become a
ticket. WhatsApp fails closed in the same situation.

`docs/PROJECT-STATE.md` §5.1 lists the key as unset. Read the web service's
environment on Render before sizing this: if it is still unset, the production
endpoint turns any POST into a ticket. The likely shape is to fail closed when
`NODE_ENV === 'production'` and keep the development convenience, with a route
test for each.

Done as #177, stacked on #168, because a late-set secret recovers the refused
deliveries only when a refused delivery is stored under no id. Render could not
answer whether the secret is set: its API does not expose values, and its log
retention starts after the last inbound email (2026-09-03). So #177 names setting
the secret as a deploy prerequisite rather than assuming either way.

### 2.11 Staging's `local` email webhook accepts anything

Found while doing 2.10. Staging runs `EMAIL_PROVIDER=local`, whose
`verifySignature` returns `true` on the grounds that "the endpoint is not
reachable from outside" — which is not true of a Render service. Staging is
suspended and sends nothing real, so this is low priority; the likely fix is for
the factory to refuse `local` under `NODE_ENV=production` for inbound, the same
line #177 draws.

### 2.8 Fetch timeouts

Only `lib/shipments/platform.ts` and `lib/typesafe/client.ts` set one today.
This is low priority, one provider per PR.

- **Idempotent GETs** get a timeout first.
- **Sends** get at least 60 seconds or no timeout at all. A timeout after the
  provider has accepted a send means a retry, and a retry means a duplicate
  message to a customer.

Found while starting this row: it matters more than "low priority" suggests,
and "no timeout" is not a safe choice for a send.

- **One slow request holds the whole queue.** `runOnce` in `worker/index.ts`
  awaits every job in a batch before it claims the next batch, and the stalled
  job sweep runs only between batches. Node's `fetch` with no signal gives up
  only after five minutes without a response, and never on a body that keeps
  trickling in. So one unresponsive provider holds every queued job — sends,
  syncs, sweeps — for at least five minutes per request.
- **A slow send can then run twice.** Nothing refreshes a job's lock while it
  runs, and a deploy's new worker sweeps on start (`reclaimStalledJobs`,
  anything locked for more than five minutes). A send still waiting past that
  is run again: the duplicate the 60-second floor exists to avoid.
- So every outbound call in a job path gets a deadline. A send's sits between
  60 seconds and the five-minute reclaim window.
- **The deadline covers the body, not just the status.** The same signal
  governs reading the response, and a deadline passing mid-body rejects with
  the signal's own reason. So each client reads the body inside its deadline
  handling. A send whose 2xx arrived is treated as accepted even if its body
  never does, because retrying it is the duplicate again.
- **Media deadlines scale with size.** A WhatsApp document can be 100 MB. The
  download and the storage upload each get a minute plus a second per 2 MB,
  so 110 seconds at most.

The structural fix is for `runOnce` to refill a slot as each job finishes
rather than awaiting the batch. That is worker work for Stage 4.4, not this
row: per-request deadlines are needed either way, because a hung request still
holds its own slot and its own lock.

### 2.9 Replies never get paragraphs

Found while verifying 2.2 end to end, not by the audit. A browser submits a
textarea's line breaks as CRLF, and `textToHtml` (`lib/html/sanitize.ts`) split
paragraphs on `/\n{2,}/`, which `\r\n\r\n` never matches. So every agent reply
and every canned response saved from the admin textarea went out as one `<p>`
joined by `<br>`s. The fix normalises line endings before splitting, with the
first tests `sanitize.ts` has had.

## Stage 3 — shared primitives

Each PR also switches every caller in its seam, because `dead-exports` requires
that.

### FormData and action state

- **`lib/http/form-data.ts`** holds `text`, `uuidField`, `int`,
  `optionalMinutes` and `optionalNumber`, lifted from
  `settings-actions.ts:77-110`, plus a new `bool`.
- **`lib/http/action-state.ts`** holds `ActionState`, `ok()` and `INITIAL`.
- Both are pure, so client forms can import `INITIAL`.
- Adopt them one action file per PR. A specialised state becomes
  `ActionState & {…}`.

### Logging: `lib/log.ts`

An in-house module of about fifty lines, with no new dependency.

- **Call shape.** `logger('send_whatsapp').info('sent', { messageId })` prints
  `[send_whatsapp] sent messageId=…` through `console.*`.
- **The `[tag]` prefix stays**, because Render log searches and
  `docs/PROJECT-STATE.md` quote those strings.
- **It never calls `env()`**, following the precedent in `lib/webhooks/log.ts`:
  a diagnostic must not be able to fail the thing it describes.
- **It is never handed headers or payloads.** `lib/webhooks/log.ts` stays the
  only raw-payload logger, because it redacts.
- **Migration order** is `worker/`, then `lib/`, then `app/`, keeping every
  message's text word for word.
- **Why not pino.** It adds a dependency to an eleven-package runtime tree. Its
  transports run in worker threads that fight Next's bundling. And JSON lines
  break the `[tag]` grep workflow.
- **Alongside it,** `errorMessage()` in `lib/errors.ts` replaces thirty-one
  copies of `e instanceof Error ? e.message : String(e)`.

### Constant-time compares

- Use `safeEqual` (`lib/auth/tokens.ts:24`) in:
  - `lib/email/providers/postmark.ts:139`
  - WhatsApp's `verifyChallenge`
  - `lib/health/probe.ts:85`
- Leave `lib/whatsapp/verify.ts`'s compare alone. It compares hex-decoded HMACs,
  which is a different operation.

### Email helpers — merged as #198

- `buildReferences` (copied in `send-email.ts` and `send-side-email.ts`) moved
  to `lib/email/threading.ts`, beside `formatMessageId` and `buildReplySubject`,
  not to `html.ts`: it decides threading order, and `threading.test.ts` is where
  that is tested.
- The worker's private `escapeHtml` became `textToEscapedHtml` in
  `lib/email/html.ts`. This plan said to keep it a separate escaper with
  byte-identical output (`'` left unescaped) and never to merge it with
  `escapeHtml`. **#198's review overrode that on purpose:** it is now
  `escapeHtml(text)` plus `\n` → `<br>`, so there is one escaper to keep in
  step. The one output difference, `'` → `&#39;`, renders the same in element
  text, and its only input, the side conversation footer, carries no
  apostrophe. Across footers for tickets 1 to 100,000 the old and new output
  are identical, so no email's bytes changed.
- What still stands: `escapeHtml` itself must not gain the `<br>`. It escapes
  attribute values too, where a `<br>` is corruption.

### HTTP helpers

- `lib/kb/rate-limit.ts` moves to `lib/http/rate-limit.ts` as a pure move. The
  widget and CSAT routes use it as well as the knowledge base.
- A new `readJsonBody(request, schema)` is adopted route by route. Error bodies
  stay byte-identical, because the widget parses them.

### Queue

Merged as #197. A typed `hasActiveJob(type)` in `lib/queue` replaced the three
raw-SQL copies in `app/(console)/admin/actions.ts`: `startFreshdeskImport`,
`startLocationBackfill` and `startShipmentBackfill`.

### Vocabulary

- `lib/tickets/vocabulary.ts` is client-safe and holds `PRIORITIES`,
  `STATUS_CATEGORIES` and the roles.
- A unit test asserts they equal the `enumValues` in `db/schema/enums.ts`.
- It replaces the hard-coded lists at:
  - `actions.ts:977`
  - `settings-actions.ts:382` and `:1209`
  - `admin/actions.ts:88`
  - `view.tsx:707`

### Constants

- Merged as #199: `TEAM_TIME_ZONE` in `lib/hours/zone.ts` replaced eleven
  `'Africa/Cairo'` literals — seven in `lib/`, and four in `app/` that meant
  the same thing (the widget, the shadow categorisation page, and both halves
  of the business hours editor). Tests keep their own literal, the zone they
  assert in. The one new test holds the constant equal to the
  `business_hours.timezone` column default, which stays a literal because it
  lands in a generated migration.
- Merged as #200: `proxy.ts` builds its locale pattern from `LOCALES` in
  `lib/kb/locale.ts`.

### Widget

- **`lib/widget/protocol.ts`** holds the postMessage names that
  `app/widget/chat.tsx` and `app/widget/embed.js/route.ts` both spell out today.
  The names do not change, because `docs/embedding-the-widget.md` is a contract.
- **Move `app/widget/types.ts` to `lib/widget/types.ts`.** That removes the only
  import from `lib/` into `app/` (`lib/widget/view.ts:11`).

## Stage 4 — structural moves in `lib/` and `worker/`

### 4.1 Split `lib/tickets/queries.ts` (937 lines) as a pure move

The new files:

- `inbox-filters.ts`: pure and client-safe (parsers and cursor)
- `visibility.ts`
- `inbox.ts`
- `conversation.ts`
- `lookups.ts`

Every importer is repointed; there is no barrel.

### 4.2 Shared ingest steps (only once 1.3 is green)

One helper per PR, and each PR switches every caller over.

- **`requireDefaultOpenStatusId(tx)`** replaces the seven copies of
  `'No default open ticket status configured'`.
- **`reopenResolved(tx, …)`** replaces three inline copies, plus the private
  `reopen()` (`ingest-meta.ts:565`) and `reopenIfResolved()`
  (`widget/conversation.ts:256`).
- **One `findLiveConversation`**, used only where the predicates are identical,
  proven by a `toSQL()` test.

**No general ingest pipeline.** These paths differ in ways that matter, and they
stay explicit at the call site:

- the side-conversation token is resolved before `resolveContact`;
- `whatsapp_bot` skips `afterInboundMessage`;
- Meta comment threads;
- the `greatest()` in `interactionWindowSet`;
- whether a message reopens at all, and what it records. Email leaves a resolved
  ticket, the customer clock and the next-response timer alone for an
  autoresponder (#227), and the widget records `visitor_replied` where every
  other path says `customer_replied`. So `reopenResolved` takes the actor and
  the reason, and each caller keeps its own decision about whether to call it.

### 4.3 The Meta Graph transport

- Move `graph()`, `MetaApiError` and the transient codes out of
  `lib/meta/client.ts` into `lib/meta/graph.ts`.
- `lib/meta/subscriptions.ts` then uses that transport instead of its three
  private wrappers.
- The request shapes in `lib/meta/comments.ts` and `lib/meta/send.ts` are
  untouched.

**Narrowed in #228.** The three wrappers in `subscriptions.ts` now share one
private `request()`, with the same messages as before. They do not use the
client's `graph()`, because that would change three behaviours the code
records as deliberate:

- `graph()` puts the token in the query string. The app token contains the app
  secret, so this module puts it in a header (`docs/meta-endpoints.md` §1).
- `graph()` treats a 2xx write whose body was lost as success. This module
  fails it, because a person re-runs the job and subscribing twice is safe.
- `graph()` throws `MetaApiError` and logs a warning. This job's output is its
  error, so the explanation of a refusal stays in the error.

With no second caller, the move into `lib/meta/graph.ts` is not done either.
That module holds only what the four Graph clients share, and the transport
stays with the one client that uses it.

### 4.4 Worker

- **Typed payloads.**
  - A zod schema per job in `lib/queue/payloads.ts`.
  - `parseJobPayload(job, schema)` throws `PermanentJobError` on bad input.
  - A typed `enqueue` overload.
  - The schemas must accept the booleans and numbers that `run-job.ts`'s
    `key=value` parser produces.
- **What stays byte-identical.** The `JobType` union text and
  `Partial<Record<JobType, JobHandler>>`, because the job-registry regex reads
  them. `PLANNED_JOB_TYPES` is deliberate.
- **Backfills.** The keyset cursor loop and the tally table move to
  `lib/queue/backfill.ts`, from:
  - `backfill-shipment-links`
  - `backfill-message-locations`
  - `backfill-categorise-ai`
- **KB import.** The KB upserts that `import-freshdesk-kb.ts` and
  `seed-console-handbook.ts` each implement move to `lib/kb/import.ts`.
  - The Freshdesk path gets a DB test.
  - The handbook path is already run twice in CI.
- **Sweeps.** Sweep logic moves from `assign-sweep.ts` into `lib/assignment`,
  and from `sla-sweep.ts` into `lib/sla`. The `automated-reply-boundary` path in
  `repo-rules.mjs` moves in the same PR.
- **Send guards.** The "already delivered" guard (four copies) and the
  mark-failed update (two copies) become shared helpers.

### ⛳ Gate

Check in with the requester before Stage 5:

- what has landed and what is still open;
- confirmation that no open PR touches the hot files.

## Stage 5 — the server side of `app/`

### 5.1 `admin/settings-actions.ts`

- Each save/delete pair moves to `app/(console)/admin/<domain>/actions.ts`,
  beside the `forms.tsx` that already lives there. About three domains per PR.
- `admin/actions.ts` splits the same way, into `agents/`, `channels/`,
  `import/` and `categories/`.
- `forms-shared.tsx` adopts `lib/http/action-state`.

### 5.2 `app/(console)/actions.ts`

**First: move the shared private guards.**

- `loadConversation`, `refuseIf*`, `refresh` and `applyStatusCategory` move into
  a plain module, `lib/tickets/console-guards.ts`.
- They cannot be exported from a `'use server'` file: every export there becomes
  a public POST endpoint.

**Then split into siblings, one PR each, each merged the same day:**

- `reply-actions.ts`
- `meta-actions.ts`
- `ticket-actions.ts`
- `shipment-actions.ts`
- `side-conversation-actions.ts`
- `availability-actions.ts`
- `category-actions.ts`

### 5.3 Deduplicate inside the actions

These changes preserve behaviour.

- **`lib/tickets/agent-reply.ts`.** It covers the whole reply sequence for
  `sendReply` and `sendTemplateReply`: store, bump `lastMessageAt`,
  `onAgentReply`, enqueue through `carrierFor`, then `afterMessageStored`.
- **It must not live in `outbound.ts`.** The `automated-reply-boundary` check
  forbids `lastAgentMessageAt` there, and that check is what keeps automated
  replies out of the response metric.
- **`lib/tickets/status.ts`.** It replaces the two copies of the status-change
  transaction, at `actions.ts:900-920` and `:1111-1128`.

### 5.4 Admin pages stop importing `db`

- Their queries move into `lib/<domain>/`. That covers `admin/import/page.tsx`,
  `admin/page.tsx` and `admin/field-options.ts`, and about seventeen others.
- Then a repo-rules check asserts that no `page.tsx` imports `db/client`.
  `app/probe/page.tsx` is the one exception, and the reason is written down.

### 5.5 One receive path for webhooks

- **`lib/webhooks/receive.ts`** handles the raw body and redacted headers,
  persists the event (with the id only when verified), and enqueues it.
- **Each route keeps its own verification and status codes in plain view.**
  That includes both Instagram app secrets.

### 5.6 Help-centre actions

- One copy each of `localeOf` and `requestMeta`.
- Share only the genuinely identical part of agent and customer sign-in:
  - `app/(auth)/actions.ts:40-75`
  - `app/help/[locale]/account/actions.ts:62-92`

## Stage 6 — client components, hottest file last

### 6.1 Break the import cycle

`composer.tsx` imports `TemplateOption` from `view.tsx`, which imports
`Composer`. Move `TemplateOption` into `inbox/[number]/types.ts`.

### 6.2 Extract the event wording

`describeEvent` and `SKIP_REASONS` (`view.tsx:749-933`) are pure wording. Move
them to `lib/tickets/event-labels.ts`, with tests.

### 6.3 Split `view.tsx`

The pieces become kebab-case siblings, the way `comment-moderation.tsx` and
`side-conversations.tsx` already are. Leaves go first, one or two files per PR:

- `header.tsx`
- `window-indicator.tsx`, after which the copy in `inbox/list.tsx:566-594` goes
- `timeline.tsx`
- `sidebar.tsx`
- `ticket-fields.tsx`, where the local `Field` becomes `SidebarField` so it no
  longer shadows the one in `components/ui.tsx`
- `categories-field.tsx`
- `shipments-field.tsx`

### 6.4 `useFieldAction`

- It replaces the nine imperative `new FormData()` + `action()` +
  `router.refresh()` calls.
- `TagField` currently ignores the error it is returned. Showing it is a
  behaviour change, so it gets its own PR.

### 6.5 The rest

- **The widget chat.** `app/widget/chat.tsx` splits into three hooks:
  `use-widget-session.ts`, `use-message-stream.ts` and `use-host-bridge.ts`.
- **The embed script.** `embed.js` stays a template literal.
- **Large pages.** `composer.tsx` and `admin/dashboard/page.tsx` split into
  section components.
- **`SubmitButton`.** Its seven copies become one in the shared UI.
- **The reports page.** Its local `Stat` and `Table` give way to `components/`.
  The RTL fix from `text-left` to `text-start` is its own PR.

## Stage 7 — tighten lint and finish logging

1. **Type-aware lint for `lib/**` and `worker/**`.**
   - Add `typescript-eslint` as an explicit devDependency. It is only transitive
     today, and knip gates `unlisted`.
   - Turn on `no-floating-promises`, `no-misused-promises` (with
     `checksVoidReturn.attributes: false`), `await-thenable` and
     `switch-exhaustiveness-check`.
   - They start as warnings in a non-blocking `lint:strict` job. Each directory
     is promoted to error once it is clean, and `app/**` comes last.
2. **Layering, through `no-restricted-imports`.**
   - `lib/` and `worker/` may not import `@/app/*`.
   - `components/` may not import `@/db/*`.
3. **`no-console` as an error.** The exceptions are `lib/log.ts`, `scripts/`,
   `db/migrate.ts` and `worker/run-job.ts`.
4. **AGENTS.md** records the new conventions:
   - the logger;
   - the form-data and action-state helpers;
   - typed payloads;
   - `PermanentJobError`;
   - the database test tier.

## Out of scope — do not do these

**Documentation and comments**

- Do not delete, shorten or "clean up" comments, or `docs/PROJECT-STATE.md` §6.
- Do not act on knip's ~110 unused exports. `knip.jsonc` explains why that number
  is not a backlog.

**`server-only`**

Do not add it to anything the worker or vitest imports, which means
`db/client.ts` and most of `lib/`. It throws outside the `react-server` export
condition.

**Database**

- Do not drop indexes that look unused.
- Do not move the category registries out of `db/schema/config.ts`.
- Do not add `relations()` nothing reads.
- Do not touch the pool or the instrumentation in `db/client.ts`. That is the
  separate §5.0 fix: the `instrumented` WeakSet.

**Meta**

- Do not reshape the Graph requests in `lib/meta/comments.ts` or
  `lib/meta/send.ts`.
- Do not tidy the Instagram `messaging_type` asymmetry.
- Do not drop either Instagram app secret.

**Things that look like duplication but are not**

- `lib/queue/backoff.ts` and `failJob`'s schedule answer different questions:
  one is the loop's backoff by failure kind, the other each job's retry
  schedule.
- Agent replies do not go through `outbound.ts`.
- `escapeHtml` and `textToEscapedHtml` stay two functions, the second built on
  the first. `escapeHtml` must not gain the `<br>`, because it also escapes
  attribute values.

**Contracts and deliberate reads**

- Do not change the widget protocol or its signature format.
- Do not replace the documented, deliberate `process.env` reads:
  - `lib/shipments/detect.ts`
  - `lib/categorise/rules.ts`
  - `lib/webhooks/log.ts`
  - `lib/whatsapp/accounts.ts`

**Authorisation**

Do not turn a `requirePermission` redirect into a returned error without saying
so in the PR.

**Sweeps**

No repo-wide `import/order` pass, and no `<button>` → `<Button>` sweep. Both
touch every file and prevent no bug.

## Verification

- **Every PR.**
  - Run
    `npx tsc --noEmit && npx eslint . && npx vitest run && npm run knip && npm run build`,
    then `node scripts/ci/repo-rules.mjs`.
  - CI's `verify`, `repo-rules` and `database` jobs must all be green.
- **Pure moves.** The diff under
  `git diff origin/main -M -C --color-moved=dimmed-zebra` shows only moved
  blocks and import lines.
- **Behaviour PRs.** The new test fails on `main` and passes on the branch.
- **From 1.2 onward.**
  - The database tier (`npx vitest run -c vitest.db.config.mts`, against a local
    Postgres) stays green through every change in Stages 4 and 5.
  - It is the proof that the ingest and action consolidations changed nothing.
- **Client-component moves.**
  - The per-route First Load JS table from `npm run build` does not grow.
  - The inbox ticket page and the widget are driven in the dev server: send a
    reply; change the status, assignee and tags; link a shipment; open the
    widget chat.
- **Raw SQL outside a job handler.** It runs through the database tier, or as an
  `EXPLAIN` against production through `execute_sql`, before it is pushed.
