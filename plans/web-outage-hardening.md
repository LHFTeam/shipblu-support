# Web outage safeguards — September 2026

## Evidence and limits

The September 8 incident had page renders hanging while `/api/health` and
webhooks still answered. Production instrumentation reproduced two postgres.js
pools: Next's route-handler and SSR bundles each instantiated `db/client.ts`,
and the old global assignment was disabled in production. This proves the
health-check blind spot, not the initial cause of a connection stall. Occupancy
inside the incident's process was not recorded before restart. Neither later
`pg_stat_activity` snapshots nor a low backend count establishes that the client
pool was healthy through Supavisor.

The first reported stuck render began at 11:06:04 UTC, before the 11:09:53
`57014`. Server statement time does not include client-side pool queue time.
An ordinary query error does not inherently poison subsequent Next renders.
The installed Next 16.3.1 close/abort logging defect is a separate issue: upstream
PR 96715 fixes misleading RSC disconnect reporting, not a database hang.
An isolated partial-200 reproduction is not the same as the observed full-HTML
requests receiving zero bytes. Also, an `_rsc` parameter does not prove prefetch:
the router-state shortcut depends on request headers as well as loading boundaries.

## Implemented policy

- One lazy `globalThis` web pool per Node process, shared by both Next bundles.
  Keep `max: 10`. Two accidental pools were not a capacity target. Increasing
  this needs workload measurements and a connection budget including replicas,
  deploy overlap, worker, crons and LISTEN; the database limit is 60, and
  Supavisor client slots do not map one-to-one onto backends.
- A 5-second server statement timeout and a 10-second client deadline for web
  database operations. The client timer begins before `BEGIN` queues for a
  connection and covers the transaction callback, savepoints and COMMIT too.
  `SET LOCAL statement_timeout` runs within the same transaction: session SET
  is not a safe configuration mechanism through transaction-mode Supavisor.
  Ordinary operations therefore gain BEGIN/SET LOCAL/COMMIT round trips.
- Next's compiled `NEXT_RUNTIME === 'nodejs'` selects the web adapter. A
  production worker, cron, seed or migration run outside Next gets the raw
  client with its existing limits. There are no new deployment variables.
  The adapter supports the installed Drizzle driver's unsafe/values/begin/
  savepoint protocol; raw tagged calls deliberately refuse to bypass it.
- A client deadline invalidates and force-ends that pool generation, refuses
  further use of its cached clients and waits 5 seconds before allowing a new
  generation. Concurrent DB work can fail too; HTTP/SSE sockets and the process
  are not deliberately killed. A `57014` on its own never retires anything.
  There are **no retries**: an interrupted write or COMMIT can have an unknown
  outcome. JavaScript callbacks cannot be cancelled, but late callbacks cannot
  issue more queries on the retired client. Logs identify pool/operation IDs,
  elapsed time and outstanding operations, without SQL, parameters or credentials.
- `/api/health` uses fixed loopback HTTP to render `/api/health/render` in this
  same instance. A process-local secret guards the page, which checks the app
  schema with an agents read before emitting a fresh nonce marker. A successful
  status alone is insufficient: require HTML, the marker and a complete bounded
  body within 3.5 seconds. Reject redirects, streamed errors and stalled bodies.
  One in-flight probe and a 1-second result cache bound public probe traffic.
  A missing/invalid token does no DB work. Health returns 503 on failure and
  no longer counts queue rows or returns raw database errors.

The 3.5-second health budget is inside Render's 5-second check window. An aborted
probe does not cancel its page's JavaScript; the DB deadline bounds that work.
Render's existing sustained-failure handling is the second line of defence, not
an application restart tripwire attached to a user-reachable SQL error code.

## Verification and rollout

Unit tests cover deadlines before acquisition and during execution, late
completion/rejection, stale-client refusal, ordinary 57014, savepoints, lazy
initialisation, module-copy deduplication, background isolation, and readiness
false positives including 200 headers with an unfinished body.

The database CI job uses disposable PostgreSQL 17 to exercise real Drizzle row
mapping, transaction settings and savepoints, server timeout recovery, a held
pool slot, client retirement and reconnect. It then builds and starts production
Next, exercises the real readiness page plus a DB-backed route handler, and
requires exactly one pool creation. Fault-injection scripts refuse non-loopback
databases and any database not named `shipblu_ci`. This verifies PostgreSQL and
the installed application stack, not the historical Supavisor failure itself.

No schema changes, dependency upgrade, live configuration changes or deployment
are included. Merge/deploy only after CI is green. On staging, verify completed
login/help/inbox pages and representative report/search/action latency before
production: the initial timeout values and extra round trips need real workload
validation. Check deadline/cooldown rates, not just health status. Roll back the
commit if the budgets or adapter cause regressions; no migration needs undoing.

Left out: identify the initiating network/pooler stall with new incident
telemetry; tune pool size/budgets from measurements; upgrade Next in a separate
compatibility-tested PR after verifying a stable release includes PR 96715.
