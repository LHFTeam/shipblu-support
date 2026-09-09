# The 2026-09-08 web freeze

_Diagnosis only. No application code was changed. Written 2026-09-09 against
`main` at `4c3cecd`, from Render logs and metrics for
`srv-da1jgtg1ne8s73ciqulg`, the Supabase `postgres_logs` / `supavisor_logs`
streams on `nqbcfnvqqyqawmffgiql`, and `EXPLAIN ANALYZE` run against
production._

## What happened

The web service stopped serving for roughly 55 minutes, 11:08–12:03 UTC.
Requests queued from 20 seconds to 40 minutes, five SSE streams collapsed, and
Render replaced the instance. It was initially read as a Supabase connection
problem, because the app's own error line names a database timeout.

**It is not a database problem.** The stall begins in the web process; the
Postgres connection failures are its consequences. And it is not a one-off —
there have been eight of these in fourteen days.

## The database was healthy. Three independent checks

1. **`supavisor_logs`, 10:00–13:00: 546 entries, zero errors, zero timeouts,
   zero pool messages** — nothing but routine `Connection authenticated` and
   `Terminate received from client`.
2. **`postgres_logs`**: checkpoints, plus the six lines in the timeline below.
   Nothing else in the window.
3. **The worker never faltered.** Same database, same pooler, same network, in
   the middle of the freeze:

   ```
   11:28:26  [worker] process_webhook … ok in 46ms
   11:35:45  [worker] process_webhook … ok in 62ms
   11:35:52  [worker] process_webhook … ok in 661ms
   ```

The third is the one to reach for first next time. **If the worker is fine while
the web service is not, the database is fine.** It costs one log query and it
separates app-side from database-side in a single step.

Supporting shape: CPU 0.1–0.3%, memory 147→157 MB, `instance_count` pinned at 1,
and **no deploy on 09-08** — the last was 09-07 17:38. So the instance was
_replaced_, not redeployed.

## The timed-out query is not slow

The statement the app reported as failing:

```
select "attachments".… from "attachments"
  inner join "messages" on "messages"."id" = "attachments"."message_id"
  where "messages"."conversation_id" = $1
```

Run against production, unchanged:

```
Nested Loop  (actual time=0.133..0.134 rows=0 loops=1)
  ->  Index Scan using messages_conversation_idx on messages
  ->  Index Scan using attachments_message_idx on attachments
Planning Time: 12.115 ms
Execution Time: 0.399 ms
```

`attachments` holds **192 rows**. Conversation #13791 has **five messages**.
Every index it wants exists. A 0.4 ms query was killed at the two-minute
`statement_timeout`.

Nor was it waiting on a lock. `log_lock_waits = on` with
`deadlock_timeout = 1s`, and there is **not one lock-wait line** anywhere in the
window. So the two minutes were spent neither planning, nor executing, nor
blocked on another transaction.

## Timeline, UTC

| Time              | Event                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| 11:06:00          | `POST /login?signedOut=inactivity` — agent idle-signed-out, signs back in    |
| 11:06:00.29–.59   | **8** `?_rsc=` prefetches in 300 ms, in two waves                            |
| 11:06:05          | `/api/events?channel=all` — 5,303 ms                                         |
| 11:06–11:08       | **16** `POST /api/focus`, several within the same second                     |
| 11:07:50          | `/api/events?…conversationId=d9e02e09…` — **105,223 ms**                     |
| 11:08:11          | the **same** conversation reconnects — 19,660 ms                             |
| 11:09:33          | worker appends an Instagram DM to #13791                                     |
| 11:09:53.765      | Postgres: `canceling statement due to statement timeout`                     |
| 11:09:53.779      | app: `Failed query: select "attachments" …`                                  |
| 11:09:57          | app: `The destination stream closed early.`                                  |
| 11:11:04          | Postgres: `terminating connection due to transaction timeout`                |
| 11:14:59–11:15:06 | Postgres: **4 more** `terminating connection due to transaction timeout`     |
| 11:10–11:51       | `/ar` 41.9 s; `/en`, `/login`, `/widget`, `/setup`, `/help/ar` 19–60 s each  |
| 11:51:06          | `/login?next=%2Fapi%2Fpresence` — **390,263 ms**                             |
| 11:51:18          | `/ar` — **2,425,078 ms (40 min)**; **4 ×** `destination stream closed early` |
| 12:03:20          | fresh instance boots; one 502 at 12:04                                       |
| 12:15             | 219 requests served normally                                                 |

## It is chronic, and 09-08 was not the worst

`destination stream closed early`, by day:

| Date      |  Count | Note                 |
| --------- | -----: | -------------------- |
| 08-26     |      1 |                      |
| 08-27     |      1 |                      |
| 08-28     |      1 |                      |
| 08-30     |      2 |                      |
| 09-01     |      7 | five within 2 ms     |
| **09-03** | **29** | **26 inside 900 ms** |
| 09-06     |      4 |                      |
| 09-08     |      5 | this incident        |

Across **twelve distinct instance ids in fourteen days**, on a service pinned at
one instance with about eight deploys. The instance is being replaced far more
often than it is being deployed, and the fan-out is growing.

## The mechanism

`db/client.ts:32–39` opens one pool, `max: 10`, and **there is no query timeout
and no pool-checkout timeout anywhere in the repo**. `connect_timeout: 10`
bounds TCP startup only. postgres.js queues work beyond `max` in memory,
**uncapped and untimed**: a query submitted when all ten slots are busy returns
a promise that settles when a slot frees and **never rejects**. Postgres sees
nothing arrive, so it logs nothing; the CPU has nothing to do, so it idles. That
is precisely the observed signature — and it is why the app-side evidence was
one misattributed `Failed query` line.

Five properties of the current code turn a burst into a self-sustaining stall.

**1. One anonymous `/ar` can exhaust the pool by itself.**
`app/help/[locale]/page.tsx:45` fans out to eight concurrent queries (the hours
catalog is four of them on its own), and `getSessionCustomer()` is called
**three times per render** — `lib/kb/viewer.ts:19`, `page.tsx:51`,
`account-nav.tsx:18` — none memoised, unlike `webchatChannel`, which correctly
uses React `cache()`. With both session cookies present that is roughly twelve
concurrent queries against `max: 10`, for the site's front door, `force-dynamic`
and uncacheable.

**2. `/login` queues on the pool before it looks at the cookie.**
`app/(auth)/login/page.tsx:15` awaits `needsBootstrap()` — a `count(*)` over
`agents` (`lib/auth/guard.ts:45–48`) — **unconditionally**, ahead of
`getSessionAgent()`, whose cookieless short-circuit at `lib/auth/session.ts:95`
is therefore never reached. A request with no session cookie at all still waits
on a pool slot. That is where `/login?next=/api/presence` spent 390 seconds.

**3. `/api/presence` amplifies the stall and hides it.**
`app/api/presence/route.ts:64–87` fires an async chain every 25 seconds with **no
in-flight guard**. Under pool pressure each tick launches another chain that
never settles — on the order of 120 outstanding per stream over 50 minutes.
Meanwhile the keepalive byte at L71 goes out **synchronously**, so the browser
never disconnects and the interval never stops. The stall keeps feeding itself
while the stream looks healthy from the client's side.

**4. The health check hangs rather than failing.**
`app/api/health/route.ts:17` awaits `db.execute(sql\`select 1\`)`on the same
exhausted pool. Its`try`/`catch`catches rejections — and a promise sitting in
postgres.js's queue never rejects. So the route never returns its 503. **This is
why the instance took ~50 minutes to be replaced**: nothing ever reported
unhealthy.`/api/health`is in`PUBLIC_PREFIXES` (`proxy.ts:35`), so the
middleware does not shield it either.

**5. The SSE routes can strand a session connection.**
`app/api/events/route.ts:60` opens its own `sessionSql()` per request (`max: 1`,
`idle_timeout: 0`) and then performs **seven sequential `LISTEN` round trips**
(L64–66) — all of them _before_ `request.signal.addEventListener('abort',
cleanup)` at **L98**. A client disconnecting inside that window leaves nothing
attached to the request lifecycle, and the `catch` at L68–73 omits `end()`
entirely; `end()` is also fired-and-forgotten at L90 and L104, so a failed close
is invisible. `EventSource` reconnects on its own and nothing caps concurrent
streams per agent. `app/api/widget/stream/route.ts:71` has the same three holes
at L75–80 and L103.

Those stranded backends are what the five `terminating connection due to
transaction timeout` lines are: `transaction_timeout = 5min`, the reaper §5
installed, doing its job.

### Certain, and inferred

Directly verified: the whole timeline, all three health checks, the `EXPLAIN`,
the recurrence table, and every one of the five code findings with their paths
and line numbers.

Inferred: that **pool exhaustion specifically** was the initiating event. It is
the only mechanism consistent with all of the evidence — an untimed unbounded
client-side queue is the one thing that makes queries vanish without reaching
Postgres while CPU idles — but it was not directly observed, because
postgres.js's queue depth is recorded nowhere. That absence is itself the
finding: an unbounded, untimed queue with no instrumentation is invisible from
both ends at once.

## The trigger

The idle sign-out at 11:06 dropped the session while the console still held live
streams. Everything then re-established simultaneously — presence, one
`/api/events` stream per conversation, and the RSC prefetches for every rail
destination (eight in 300 ms). `/api/events` reconnected for `d9e02e09` while
the previous stream for the same conversation was still open. This is §6.23's
fan-out, on the reconnect path rather than the notification path; the mitigations
listed there all sit on the notification side.

## What would have prevented it

Named for whoever picks this up; deliberately not done here.

- A **pool-checkout timeout** and a per-query timeout, so a saturated pool
  produces fast failures instead of an unbounded queue. This alone converts a
  55-minute outage into a handful of 500s.
- Moving the **abort wiring above the awaits** in both SSE routes, and calling
  `end()` in the `catch`. Two small edits, and they close the connection leak.
- A **health check that cannot hang** — its own connection, or a timeout —
  because while it can, every future stall costs a full replacement cycle.
- An **in-flight guard** on the presence interval.
- Memoising `getSessionCustomer()` with React `cache()`, and moving
  `needsBootstrap()` behind the cookie check. Both are small and both cut the
  peak slot demand of the two paths that hung longest.

One more, unrelated to the freeze but found on the way: `db/sql/001` fired
`pg_notify('conversation_changed', …)` unconditionally on every trigger
invocation, and **nothing had listened to it** since the §6.23 work replaced it
with the per-channel and per-conversation topics. **Removed 2026-09-09**, in the
same change as the dead-code pass; the contract test asserts its absence rather
than its presence.
