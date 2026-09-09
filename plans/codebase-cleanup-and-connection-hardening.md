# Codebase cleanup and connection-hardening plan

## Outcome

Make connection failures fast to identify and safe to recover from, then reduce the
codebase's structural and commentary debt without changing customer-visible behaviour.

This is deliberately a sequence of small refactors, not one repository-wide rewrite.
The application already carries security, privacy, delivery, threading, localisation
and deployment invariants that were learned from production incidents. A useful cleanup
makes those invariants easier to see and harder to violate; it does not erase them in the
name of uniformity.

## Current snapshot

Measured on 2026-09-09 after fetching `origin/main`:

- 561 TypeScript/TSX/MJS source files and approximately 102,934 lines across `app/`,
  `lib/`, `components/`, `db/`, `worker/` and `scripts/`.
- About 23,737 lines begin as comments. Many explain genuine invariants, but incident
  history, current implementation detail and durable rules are mixed together.
- The largest responsibility hotspots are:
  - `app/(console)/actions.ts` — 2,050 lines;
  - `app/(console)/inbox/[number]/view.tsx` — 1,969 lines;
  - `app/(console)/admin/settings-actions.ts` — 1,780 lines;
  - `lib/tickets/queries.ts` — 937 lines;
  - `lib/meta/client.ts`, `lib/meta/errors.ts` and `lib/meta/subscriptions.ts` —
    672–750 lines each.
- There are 19 source files making `fetch` calls and 34 files containing raw SQL outside
  `db/` and the database-tested worker-handler set.
- The unit baseline is strong: 115 test files; the run observed while planning completed
  113 Vitest suites and 1,532 tests successfully.
- This Windows checkout exposes three developer-experience gaps that must be separated
  from product refactors:
  - `npm run build` uses POSIX environment-assignment syntax;
  - `core.autocrlf=true` with no `.gitattributes` makes Prettier report almost the whole
    checkout;
  - the index contains the required symlinks, but a Windows checkout materialises them as
    files and the local repo-rule check reports a false failure.
- A connection-readiness change is already in progress in the shared worktree, touching
  `db/client.ts`, a new `db/web-pool.ts`, the health route and `render.yaml`. It must be
  finished, tested and committed (or removed) before this plan takes a trustworthy
  baseline. Cleanup work must not be layered onto a moving connection implementation.

The figures identify review seams, not automatic rewrite targets. A long taxonomy or
status vocabulary is data; a long route action module that owns unrelated domains is a
structural problem.

## Non-negotiable constraints

Every phase preserves the repository rules and the settled decisions in `README.md`,
`docs/PROJECT-STATE.md` and the existing feature plans. In particular:

- Never push to `main`; use one focused branch and PR per work package.
- Webhooks persist and enqueue before returning 200. They do not perform provider work
  inline.
- Attacker-controlled HTML is sanitised on write, never on read.
- `db` uses the Supavisor transaction pool; `sessionSql()` is reserved for session-mode
  `LISTEN`; both remain lazy so builds do not require runtime secrets.
- Meta connection selection stays owned by `lib/meta/connection.ts`. Instagram's two
  live connections must not be collapsed into one platform-level credential.
- WhatsApp credentials remain WABA-scoped and resolved through
  `lib/whatsapp/accounts.ts`.
- `HUMAN_AGENT` remains restricted to a message with a real `author_agent_id`.
- Delivery payload privacy continues to be enforced by named public and agent shapes.
- Queue dedupe keys remain once-ever keys; repeatable work remains idempotent and
  unkeyed.
- Realtime topics stay narrow. A cleanup must not recreate global invalidation fan-out.
- Production is read before any write, and every live change names its target, blast
  radius and rollback first.

## Working method

Each PR follows the same contract:

1. Rebase on the latest `origin/main` and claim the exact seam being changed.
2. Capture the current behaviour with a unit, integration or contract test before moving
   it.
3. Change one boundary or one domain, without unrelated formatting or renaming.
4. Run targeted tests while iterating, then typecheck, lint, format check, unit tests,
   repo rules and the production build.
5. Run database-backed tests for any changed SQL, including page/action queries that the
   current database CI job does not execute.
6. Update the nearest durable comment and the relevant operational document in the same
   PR.
7. State deploy compatibility and rollback in the PR body. Web, worker and cron services
   do not deploy atomically.

No phase is allowed to use a lower line count, fewer files or fewer comments as its sole
success measure. The measures are clearer ownership, tested behaviour and better failure
evidence.

## Phase 0 — stabilise the baseline

Finish or explicitly discard the in-progress web database/readiness slice before any
other refactor. Its acceptance criteria are:

- the postgres.js adapter is type-safe and has tests for lazy query execution,
  `.values()`, explicit transactions, savepoints, deadlines, pool retirement, cooldown
  and close;
- request-path deadlines apply only in the Next.js Node runtime, not to the worker,
  migrations or one-shot jobs;
- readiness exercises a real Server Component and the same process-level pool used by
  application renders, with a bounded body and deadline;
- a timeout never causes an automatic replay of a write whose outcome is unknown;
- CI is green on the completed branch.

Then make a separate tooling-only PR:

- use a cross-platform build wrapper that still forces `NODE_ENV=production`;
- define line-ending policy in `.gitattributes`, after previewing the resulting diff so
  it does not become an accidental repository-wide rewrite;
- make the symlink invariant check use the Git index mode on platforms that cannot
  materialise symlinks faithfully;
- record a clean baseline of every CI command.

Do not mix these mechanical changes with application refactors. That keeps future diffs
reviewable and prevents a line-ending conversion from hiding a behavioural change.

## Phase 1 — characterise the connection system

Build a connection matrix covering six distinct boundaries:

| Boundary                | Configuration authority     | Failure classes to exercise                                              | Required evidence                                                    |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Web database queries    | `db/client.ts`              | pool wait, statement timeout, lost socket, pool retirement               | runtime, pool id, operation kind, elapsed time                       |
| Worker database queries | `db/client.ts`, worker loop | auth, circuit breaker, transient disconnect                              | failure class, retry delay, worker id                                |
| Session listeners       | `sessionSql()`              | connect failure, disconnect, abort, shutdown                             | topic class, degraded mode, cleanup                                  |
| Provider HTTP           | provider client             | DNS/reset, deadline, 429, 5xx, HTML error, malformed JSON                | provider, operation, status, request/trace id, retry class           |
| Webhook intake          | route + `webhook_events`    | unreadable body, invalid JSON, bad signature, duplicate, enqueue failure | provider, connection/account dimension, event id, final intake state |
| Queue delivery          | queue + handler             | claim race, crash, retry, permanent refusal, dead job                    | job id/type/attempt, subject id, retry decision                      |

Add deterministic fault-injection tests with local fakes that can hang, reset a socket,
delay a body, return 429/500, return HTML and close mid-response. These tests should
exercise the real boundary code; a mock that returns a finished `Response` cannot prove a
deadline or socket-reset path.

Define one diagnostic event shape for logs. It should use stable fields rather than a
single prose string, include correlation ids already present in the system, and explicitly
redact tokens, credentials, cookies and customer bodies. Provider-specific error objects
remain provider-specific; only the diagnostic envelope is shared.

This phase changes evidence, not retry or delivery behaviour.

## Phase 2 — refactor database connection ownership

Once Phase 1 pins behaviour, make database lifecycle explicit:

- keep one factory for each connection profile: web transaction pool, long-running
  worker/job pool, session listener and migration connection;
- keep lazy creation, but move runtime selection and lifecycle out of the generic Drizzle
  proxy so callers cannot accidentally receive the wrong profile;
- expose a narrow transaction-capable interface for the web adapter instead of pretending
  every postgres.js method is supported;
- preserve one shared deadline across `BEGIN`, callback, savepoints and `COMMIT`;
- make shutdown, pool retirement and Drizzle-instance replacement observable and tested;
- distinguish server statement timeout, client deadline, authentication failure and pool
  cooldown in the error model;
- keep health/readiness on the application path, while retaining a small diagnostic that
  can report queue depth without turning health into a second expensive dashboard.

Run the adapter against Postgres 17 through the transaction pool shape, not only against
mock functions. Reproduce cancellation during a read and during a write transaction and
assert that the write is never automatically retried.

## Phase 3 — harden outbound HTTP without erasing provider semantics

Introduce a thin internal HTTP boundary for mechanics that truly are common:

- an explicit deadline and abort signal;
- a bounded error-body read;
- safe JSON-or-text parsing;
- capture of response status, `Retry-After` and provider request/trace ids;
- structured diagnostic context and credential redaction;
- an injectable fetch implementation for fault tests.

Do not build one universal provider client. Meta, WhatsApp, Postmark, Supabase Storage,
the delivery platform and Freshdesk keep their own request shapes, error classes and
retry decisions. In particular, do not merge Meta and WhatsApp merely because both use a
Graph hostname.

Migrate in risk order:

1. Meta direct messages, comments, profiles and subscriptions;
2. WhatsApp sends, templates and media;
3. shipment lookup/sync, Storage and Postmark;
4. Freshdesk last, because it is a bounded read-only importer.

For every migrated operation, assert the exact request shape and the mapping of network,
rate-limit, authentication, permission, permanent-recipient and server failures. Preserve
the documented host and authentication form for each connection; do not change it as an
incidental cleanup.

## Phase 4 — make webhook persistence and queue handoff one reliable boundary

The Meta, WhatsApp and email routes repeat a valuable pipeline with different details.
Extract only the shared state transition:

1. read a size-bounded raw body;
2. emit opt-in pre-verification diagnostics;
3. parse enough to select the correct verifier;
4. verify and derive provider-specific delivery identity;
5. persist evidence with credential headers removed;
6. atomically enqueue the processing job for a verified, newly inserted event;
7. return the provider-specific acknowledgement.

The verifier, delivery-id algorithm and HTTP status stay adapter-owned. Meta's
per-connection dedupe identity and unverified-event rules are not interchangeable with
email or WhatsApp.

The event insert and `process_webhook` enqueue should share one database transaction.
Today a process failure between those writes can leave a verified event stored but never
processed. Refactor `enqueue` to accept a transaction-capable executor, while keeping the
ordinary top-level call for existing callers.

Add an explicit intake state or a queryable invariant that finds verified, unprocessed
events with no live/completed processing job. Decide whether retaining exact unverified
raw bytes is justified only after defining a byte cap, access boundary and retention
period; those bytes contain customer data and are also attacker-controlled.

Then tighten the worker boundary:

- validate every job payload at handler entry with a named schema;
- standardise outcome as completed, retryable, permanently refused or skipped;
- preserve provider explanations on the customer-visible message/event while keeping the
  raw technical cause on the job;
- add correlation from webhook event to processing job to message to outbound job;
- test claim concurrency, stalled-job reclaim and shutdown during a batch on Postgres 17.

## Phase 5 — consolidate realtime listener lifecycle

`/api/events` and `/api/widget/stream` independently implement listener creation,
heartbeat, degraded mode, abort cleanup and controller shutdown. Extract a small SSE
session helper that owns only that lifecycle.

Keep authorization, topic selection and payload refresh logic in the routes. The helper
must not be able to subscribe to an arbitrary caller-supplied identifier.

Acceptance tests cover:

- failure before and after `LISTEN` registration;
- sequential registration of multiple topics;
- one `end()` call on abort, cancel and controller error;
- no interval left behind after disconnect;
- degraded-to-polling signalling;
- slow-client or closed-controller writes;
- the widget's serialized refresh, so several notifications cannot overlap transcript
  reads.

The existing queue/channel partitioning and per-conversation topics are preserved.

## Phase 6 — split structural hotspots by domain

Do this after the connection boundaries are stable, so moves do not obscure active
diagnostic changes.

### Server actions

Split `app/(console)/actions.ts` into domain action modules for replies, ticket fields,
Meta moderation/profile/thread control, shipments, side conversations, assignment and
categorisation. Split `admin/settings-actions.ts` by the existing admin routes.

Each action remains thin: authorise, re-read untrusted ids, call `lib/<domain>`,
revalidate, and return the standard state. Move business logic to `lib/`; do not merely
move 2,000 lines into several route files.

### Read models

Split `lib/tickets/queries.ts` into inbox list, conversation detail, field/config lookup
and count read models. Preserve `conversationVisibility`/`scopeForAgent` as the shared
authorization seam and add tests that restricted channels never leak through a new read
model.

### Console view

Split `inbox/[number]/view.tsx` into timeline rendering, ticket fields, categorisation,
shipment links and shared controls. Keep state near the keyed subtree it belongs to so
the remount bug in `PROJECT-STATE` §6.58 is not reintroduced.

### Meta modules

Split `lib/meta/client.ts` by capability—transport, messaging, comments/moderation,
profiles and media—while leaving connection selection centralized. Split error
explanations by the same capability over one parsed Graph-error type. Split subscription
operations by app, Page and Instagram Login connection over the shared transport.

Use responsibility and import direction as the test, not an arbitrary maximum file size.
Static data such as taxonomies and status vocabularies may remain large.

## Phase 7 — clean and update comments as part of ownership changes

Classify comments into four groups:

1. **Keep and tighten:** security boundaries, provider contract quirks, privacy rules,
   concurrency/idempotency reasoning and counter-intuitive business invariants.
2. **Move to durable documentation:** dated incident narratives, production counts,
   rollout history and superseded decisions. `docs/PROJECT-STATE.md` remains the live
   operational record; a focused ADR is appropriate for a stable architectural decision.
3. **Update:** comments naming an old file, function, provider version, environment
   variable, deployment state or behaviour that no longer matches code.
4. **Remove:** narration of obvious code, comments that merely repeat a type/name, and
   speculative TODOs with no decision or owner.

For each changed module:

- verify the comment against the implementation, tests, commit history and current
  provider contract before editing it;
- keep the shortest statement that explains why the non-obvious choice exists and what
  breaks if it changes;
- replace fragile line-number references with a function/module or a stable document
  section where possible;
- turn a mechanical invariant into a test or `repo-rules` check, then shorten the prose;
- never delete an incident-derived warning until the replacement test or guard is in the
  same PR.

Finish with a targeted audit for stale paths, environment-variable names, job types,
Graph version references, route names and "currently/not yet" claims. Do not run an
automated comment-deletion pass.

## Phase 8 — close verification gaps

The current database CI job executes DB-only worker handlers, but 34 files with raw SQL
sit outside that set. Add a Postgres-backed query smoke suite with minimal fixtures for
the highest-risk page/action read models, then grow it whenever a raw SQL regression is
found.

Add or strengthen:

- webhook intake integration tests against Postgres;
- provider contract tests using the fault server from Phase 1;
- queue concurrency and transaction tests;
- SSE lifecycle tests;
- import-boundary checks preventing client components from reaching server-only code;
- dependency-cycle detection for `app/` and `lib/` boundaries;
- a check that outbound network operations either use an explicit deadline or carry a
  reviewed exception;
- a check that new route actions do not accumulate business logic outside `lib/`.

Guardrails should encode high-confidence mechanical rules only. Do not add complexity or
line-count rules that can be satisfied by moving code without improving it.

## Phase 9 — final verification and rollout

Before declaring the cleanup complete:

1. Run typecheck, lint, format check, all unit tests, repo rules and the production build.
2. Apply migrations and replay `db/sql/` twice on Postgres 17, even if the refactor did
   not intend to change schema.
3. Run the database smoke suite and the connection fault suite.
4. Exercise full navigations for the inbox, a ticket, admin settings, help centre,
   tracking page, portal and widget in both locales.
5. Verify locally that every webhook returns promptly while provider work stays queued.
6. Deploy to staging only after confirming its branch and environment bindings.
7. Compare pre/post latency, database connection count, queue depth, dead jobs, rejected
   webhooks and provider error rate.
8. Deploy web, worker and crons in an explicitly compatible order, then run read-only
   production checks before any synthetic write.
9. Update `README.md` only for durable architecture changes and
   `docs/PROJECT-STATE.md` for the verified live state and newly learned traps.

## Definition of done

The programme is complete when all of the following are true:

- a clean checkout is CI-green and the documented local commands work on Windows and
  Linux;
- every request-path database operation has a tested upper bound and a wedged pool cannot
  keep an instance falsely healthy;
- every outbound provider operation has a bounded wait or a documented exception;
- a connection error identifies the provider/database boundary, operation, connection or
  account dimension, retry class and trace/correlation id without exposing secrets;
- webhook persistence and queue handoff cannot split into "stored but never queued";
- verified-but-unprocessed webhook events and dead outbound jobs are directly queryable;
- session listeners clean up deterministically and degrade to polling when unavailable;
- the large action, query and view hotspots have one domain responsibility per module;
- raw SQL on high-risk page/action paths is executed in CI against Postgres;
- comments describe current reasoning, while incident history and rollout state live in
  the appropriate durable document;
- no privacy, authorization, threading, idempotency, localisation, channel-routing or
  messaging-window invariant regresses.

## Explicitly out of scope

- New product features, provider permissions, cutover configuration or live channel
  ownership changes.
- Dependency upgrades performed only because a refactor is underway.
- Schema renames or broad data-model changes without a demonstrated connection or
  ownership problem.
- Reformatting the repository in the same PR as behavioural work.
- Collapsing provider clients, ingress routes or Instagram connections merely to reduce
  the number of files.
