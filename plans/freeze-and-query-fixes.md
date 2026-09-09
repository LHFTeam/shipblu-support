# Fixing what the freeze diagnosis and the query pass found

## Context

Two diagnostic documents are merged-pending on `claude/determined-bell-yuppvx`
([PR #152](https://github.com/LHFTeam/shipblu-support/pull/152)):
`plans/web-freeze-2026-09-08.md` and
`plans/query-optimisation-and-cleanup.md`. They record a chronic web-service
freeze (eight occurrences in fourteen days, peaking at 26 stream collapses in
900 ms on 09-03) plus a retention bug and four durable query findings. Nothing
has been fixed yet. This plan fixes all of it, in **four changes ordered by risk**, each
independently reviewable and revertible, with every database change landing
through `db:migrate` on deploy rather than from an agent session.

Two facts, verified in the installed sources, reshape the obvious approach:

- **postgres.js 3.4.9 has no checkout/queue timeout.** `handler()` at
  `node_modules/postgres/src/index.js:341` ends in `queries.push(query)` — no
  timer, no deadline, no rejection path. `connect_timeout` covers only the
  handshake; `idle_timeout` is cancelled while a connection is busy;
  `max_lifetime` is a _graceful_ close that will not interrupt in-flight work.
  So the bound has to be ours. The usable primitive is **`query.cancel()`**
  (`index.js:350-363`): for a query still in the queue it removes it and rejects
  with `57014` immediately, and for an in-flight one it opens a **separate**
  socket outside the pool to send a protocol CancelRequest — so it still works
  when all ten slots are gone. `connection: { statement_timeout }` is _not_ a
  substitute: it is a one-shot StartupMessage parameter, and on Supavisor's
  transaction pooler nothing guarantees it lands on the backend that runs the
  statement.
- **The indexes must not go in `db/sql/`.** That directory is for what Drizzle's
  DSL cannot express, and a plain btree index (and a partial one) is expressible;
  the migration-drift check in `.github/workflows/ci.yml:82-91` would fail a PR
  that adds them anywhere else. `db/sql/001_extensions_and_triggers.sql:64-68`
  says so directly: _"an index on a table the size of `messages` needs its own
  migration, not this file."_ And because `migrate.ts:88` sends each file as one
  `sql.unsafe(contents)` — one implicit transaction — `VACUUM` and
  `REINDEX CONCURRENTLY` **cannot** live there at all.

## 1 — Make the freeze self-limiting

The point of this PR is that no future stall can last 55 minutes, whatever
starts it. It does not depend on having proven the initiating event.

**`db/client.ts` — bound the wait, and count it.** Wrap the pool so every query
carries a deadline. Hold the raw postgres.js `Query` (drizzle's builders do not
surface `.cancel()`, so the wrapper must own the tagged query or race the
promise and cancel the underlying one), race it against a timer, and on expiry
call `.cancel()` — which evicts a queued query with `57014` and fires a
CancelRequest for an in-flight one. Keep a module-scope in-flight/queued counter
incremented on submit and decremented on settle, because postgres.js exposes no
queue depth (`queues` and `queries` are closure-locals, never attached to `sql`)
and its absence is why the last incident had no app-side evidence. Log the
counter when it crosses a threshold. Also give `closeDb()` a bounded
`pool.end({ timeout: 5 })` — a plain `end()` never rejects queued queries and
can hang as long as they do (`index.js:365-378`).

Add `DB_QUERY_TIMEOUT_MS` (default ~10000) to the Zod schema in `lib/env.ts`
**and** to `render.yaml` in the same commit — `env-parity` fails a PR where the
two disagree in either direction, and a comment counts as the declaration.

**`app/api/health/route.ts` — must not hang.** Its `try`/`catch` catches
rejections, and a queued postgres.js promise never rejects, so it never returns
its 503 — which is why Render took ~50 minutes to replace the instance. Bound
both awaits (`select 1` at L17 and `queueDepth()` at L20) and return 503 on
timeout. **Deliberately do not give it a private connection**: a health check
that stays green while the pool is exhausted reports the opposite of the truth,
and the whole failure was nothing reporting unhealthy. Report the pool counter
in the payload while here.

**`app/api/events/route.ts` and `app/api/widget/stream/route.ts` — stop
stranding session backends.** Three edits each, and the third is the one a naive
fix misses:

1. Define `cleanup` and register `request.signal.addEventListener('abort',
cleanup)` **before** the `try` — today it is at L98 in `events`, after seven
   sequential `LISTEN` round trips (L64-66), so a client that disconnects in
   that window leaves nothing attached to the request lifecycle.
2. Call `listener.end()` in the `catch` (L68-73 / L75-80), which omits it today.
3. **After** the awaits, re-check `closed` and end the listener if the request
   was aborted while `sessionSql()` was being established. Moving the abort
   registration up is not enough on its own: `listener` is still null at that
   point, so an abort mid-await would run a cleanup that has nothing to close,
   and the connection assigned afterwards leaks with `idle_timeout: 0` — i.e.
   forever.

Also stop `void listener?.end()` from swallowing failures (L90/L104), and have
`cancel()` guard on `closed` and remove the abort listener so the two paths
cannot both run.

**`worker/index.ts:97` — the same class of leak.** If `sessionSql()` succeeds at
L89 and `listen()` throws at L90, L97 sets `listener = null` and discards the
client with no remaining handle. End it before nulling.

**`app/api/presence/route.ts:64-87` — the amplifier.** The 25-second interval
fires an async chain with no in-flight guard, so under pool pressure each tick
launches another that never settles (~120 per stream over 50 minutes) while the
keepalive at L71 still goes out synchronously, so the browser never backs off.
Add an in-flight flag and skip the tick when the previous chain has not settled.
Keep the synchronous keepalive exactly as it is — its comment at L65-70 explains
why it must not depend on the database.

**Tests.** `lib/presence/idle.test.ts` is the model: pure functions, no database,
`it` names that are sentences about behaviour, and a comment naming the incident
each case prevents. Extract the deadline/cancel decision into a pure helper and
test it there; assert the stream-lifetime rule (abort during establishment ends
the connection) without opening a socket.

## 2 — Cut peak pool demand

`max: 10`, and one anonymous `/ar` already asks for more than that.

- **Memoise `getSessionCustomer()` with React `cache()`** in
  `lib/auth/customer-session.ts:70`. It is called three times per `/ar` render —
  `lib/kb/viewer.ts:19`, `app/help/[locale]/page.tsx:51`,
  `app/help/[locale]/account-nav.tsx:18` — each a three-table join plus a
  possible `contact_sessions` write. `lib/widget/session.ts:2` already imports
  `cache` from react for `webchatChannel`, so this is the existing pattern, and
  `cache()` is per-request so it cannot outlive a render.
- **Latch `needsBootstrap()`** in `lib/auth/guard.ts:45-48`. `login/page.tsx:15`
  awaits a `count(*)` over `agents` **unconditionally, ahead of**
  `getSessionAgent()`, whose cookieless short-circuit at
  `lib/auth/session.ts:95` is therefore never reached — a signed-out visitor
  still queues on the pool, which is where `/login?next=/api/presence` spent 390
  seconds. Once any agent exists this can never be true again, which the
  function's own docblock already states (_"the page stops working permanently
  the moment the first account is made"_), so a one-way process-level latch
  matches the documented intent. Reorder the two checks as well, so a signed-in
  agent redirects to `/inbox` without the count.
- **Reduce the `/ar` fan-out** at `app/help/[locale]/page.tsx:45` if it can be
  done without changing what the page shows — `supportAvailability()` alone is
  four queries via `lib/hours/catalog.ts:16-37`, and the hours catalogue is a
  candidate for the same 30-second memo `lib/presence/policy.ts:26-34` uses.
  Measure before and after; do not restructure the page.

**Explicitly out of scope, and why:** memoising `getSessionAgent()` would cut the
duplicate session join on every console render (layout `requireAgent()` plus the
page's own `requirePermission()`), but that function is where idle sign-out is
_enforced_ (`lib/auth/session.ts:135` deletes, L140-144 refreshes) and AGENTS.md
is emphatic that nothing on the request path may weaken those timers. It needs
its own change with its own reasoning, not a line in this one.

## 3 — Database hygiene

- **The retention hole**, `worker/handlers/cleanup.ts`. The predicate is
  `processed_at is not null and processed_at < now() - interval '30 days'`, so a
  payload that fails signature verification never gets a `processed_at`, never
  matches, and is never deleted — **4,647 rows today, oldest 19 August**, which
  are the Instagram §6.26/§6.29 failures still on disk. Add a second clause with
  its own shorter clock keyed on `received_at`, keeping the two cases distinct
  rather than widening the predicate. Fix the docblock, which states a PII rule
  the code does not apply to exactly the rows that have no message to show for
  themselves.
- **Drop the `.returning()`** in the same file. Both deletes use nothing but
  `.length`; the `jobs` delete materialised 201,135 ids at 1,816 ms a run. On
  drizzle 0.45.2 over postgres-js, a delete without `.returning()` resolves to a
  postgres.js `RowList` carrying **`count`** — not `rowCount`, which is the
  node-postgres spelling. The three `lib/**` helpers it calls
  (`deleteExpiredSessions` and friends) share the same `.returning().length`
  shape and can follow.
- **Five indexes, in `db/schema/`, then `npm run db:generate`** — not `db/sql/`,
  per the note above. `conversations.group_id` (the assignment sweep's 140 s,
  24.1 ms × 5,821, and the one figure that gets worse as real tickets arrive),
  `conversations.channel_id`, `messages.author_agent_id`,
  `messages.author_contact_id`, `conversation_events.actor_agent_id`. Leave the
  other 38 unindexed FKs alone — they serve admin screens, and 43 new indexes
  would tax every write to speed up pages nobody opens.
- **Make `webhook_events_unprocessed_idx` partial.** It is 13 MB serving **155
  scans in 47 days**, maintained on all 206,053 inserts, and its leading column
  `processed_at` is non-null on ~98% of rows. Redeclare it in `db/schema/ops.ts`
  as `(received_at) where processed_at is null` and regenerate. Fix its comment,
  which claims it serves "the worker's claim query" — the worker claims from
  `jobs`.
- **`jobs` bloat — prevention in the repo, reclaim by hand.** 1,150 live rows in
  52 MB, 30 MB of it indexes, `jobs_dedupe_idx` alone 15 MB.
  `ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = …, autovacuum_analyze_scale_factor = …)`
  is transaction-safe and naturally idempotent, so it is the one item here that
  genuinely belongs in a new `db/sql/005_storage_parameters.sql` (there is no
  existing `autovacuum` precedent to copy, and no repo rule covers
  `ALTER TABLE … SET`). The one-time reclaim —
  `REINDEX INDEX CONCURRENTLY jobs_dedupe_idx` — **cannot** go there, because the
  file runs in one implicit transaction. Document it as an operational step with
  §5.5's `pg_stat_activity` lock check to run first, and do not run it from a
  session.

**Tests.** Export the retention predicate and assert it with the
`toSQL().params` pattern AGENTS.md mandates for any fragment holding an instant
(`staleTemplateFilter` in `worker/handlers/sync-whatsapp-templates.test.ts` and
`interactionWindowSet` in `lib/tickets/ingest-meta.test.ts` are the two models) —
no raw `Date` may survive into `params`. Worth doing here specifically because
the `database` CI job runs `cleanup` but asserts nothing about it: it proves the
statement _plans_, not that the predicate selects what was meant. Consider an
assertion step in `.github/workflows/ci.yml` alongside the `seed_console_handbook`
one, which is the existing precedent for a handler that writes.

## 4 — Cleanup

- **Add `knip` to CI** before deleting anything, so the check is mechanical and
  the next session does not redo the scan — AGENTS.md is explicit that a
  mechanical rule belongs in `scripts/ci/repo-rules.mjs` rather than in prose.
  My own crude scan produced 40 candidates and verification left **three**
  (`agentExists`, `markRead`, `onInboundMessage`); the rest are used in type
  positions, inside their own module, or from `next.config.ts`. Do not delete
  from an unverified list.
- **Remove the dead `conversation_changed` notify.**
  `db/sql/001_extensions_and_triggers.sql:399` fires it unconditionally on every
  trigger invocation and nothing has listened to it since the §6.23 work.
  `db/sql/realtime-contract.test.ts` asserts on that line's presence by reading
  the file, so the test moves with it.

## Verification

- Per change: `npx tsc --noEmit && npx eslint . && npx vitest run && npm run build`,
  plus `node scripts/ci/repo-rules.mjs`. `npm run build` is not optional — it is
  the only thing that catches the export-condition and route-segment failures.
- Change 1, the part that matters: **reproduce first**. Hold a console tab on a
  ticket, force the idle sign-out, and count `/api/events` streams and Postgres
  backends before and after. Then
  `select count(*), state, wait_event from pg_stat_activity group by 2,3` — no
  `active` + `ClientRead` backend should survive a disconnect. A fix for a
  chronic bug with no reproduction is unfalsifiable.
- Change 1 regression signal: zero
  `terminating connection due to transaction timeout` in `postgres_logs` across
  a session of the same shape, and no new `destination stream closed early`
  bursts. Both are one `query_logs` call.
- Change 3: run each new predicate as a `SELECT` against production before the
  deploy (4,647 rows expected for the retention clause), and `EXPLAIN` the
  assignment sweep's statement before and after the `group_id` index — 24.1 ms is
  the number to beat.
- After each deploy, confirm what is actually running: `autoDeploy` is `no` on
  every Render service, so merging changes nothing until someone deploys.

## Not doing

Nothing in the WhatsApp path. Its signature mismatch is a deliberate test
condition while Facebook and Instagram get the attention, and the 155,163
`channel_message_id` lookups that found six rows are the mirror behaving
correctly, not a bug.
