# Query optimisation, and what a cleanup pass should and should not touch

_Written 2026-09-09, against `main` at `4c3cecd`. Every figure below comes from
the production project `nqbcfnvqqyqawmffgiql` — `pg_stat_statements` over the
47 days since its last reset (2026-07-24), the Supabase performance advisor, and
`pg_stat_user_indexes`. Nothing here is inferred from reading the code alone._

## The headline, which is not a query problem

This pass was commissioned to help debug "the connection issues we are having".
It found one, and it is not slow SQL: **inbound WhatsApp has been dead for ten
days.**

The last WhatsApp webhook that passed signature verification arrived at
**2026-08-30 15:01:41 UTC**. Every one since — 399 of them — was stored with
`signature_verified = false`, never enqueued, and answered `403`:

| Since 2026-09-01     | Events | Verified |
| -------------------- | -----: | -------: |
| `whatsapp`           |    271 |    **0** |
| `facebook_page`      |    901 |      901 |
| `instagram` (Page)   |     40 |       40 |
| `instagram` (direct) |      2 |        2 |

They are not stray probes. Each carries `field: "messages"` with a populated
`contacts[].wa_id`, an `x-hub-signature-256` header, and WABA
`128772296801141` — real customers writing in, dropped at the door.

**The app secret is not the thing that is wrong.** `app/api/webhooks/meta/route.ts`
verifies Facebook Page deliveries with the same `metaAppSecret()` the WhatsApp
endpoint uses, and 901 of them verified in the same window. So `META_APP_SECRET`
on the web service is correct, and the WABA is being signed by a **different**
app secret — the account has moved to another Meta app, or that app's secret was
rotated on 30 August.

The reason the app cannot cope with that is structural, and it is a trap this
repo has already paid for once. `app/api/webhooks/whatsapp/route.ts` verifies
against exactly one global secret:

```ts
const signatureVerified = appSecret
  ? verifySignature(rawBody, request.headers.get(SIGNATURE_HEADER), appSecret)
  : false;
```

`whatsapp_accounts` models a per-account **token** (`token_env_var`, guarded by
the `WHATSAPP_TOKEN_` prefix rule) but has no per-account app secret. Sending is
per-account; verifying is global. That is §6.26 and §6.29 again — the Instagram
outages that cost 3,888 dropped deliveries — and the fix that worked there was to
**try both secrets on every delivery** rather than to pick one. WhatsApp never
got that treatment because it only ever had one connection.

The traffic collapse is the consequence, not the cause: ~20,000 events/day
through 30 August, then 30–110/day as Meta backed off against sustained 403s.
Two facts make this worse than it looks. The endpoint's own console line —
`[webhook:whatsapp] stored an unverified payload` — has been firing for ten days
into a log nobody reads, and because an unverified payload is deliberately
stored **without** a `provider_event_id`, none of the 399 can be replayed by
delivery id once the secret is fixed. They are recoverable only by reprocessing
those rows directly.

### What this needs from a human

Fixing it means answering a question inside the Meta App Dashboard, not in this
repo: **which app is WABA `128772296801141` attached to now, and what is that
app's secret?** I have not touched a credential and will not. Once that is
answered, the code change is small and the shape is already decided by §6.29:
accept a set of candidate secrets and verify against each, so the two live
connections cannot knock each other out.

## What the query workload actually costs

Full ordering by `total_exec_time`. This is where "redundancies" turned up, and
almost all of them are writes and polls rather than page queries.

| Cost             |     Calls | Mean       | What it is                                          |
| ---------------- | --------: | ---------- | --------------------------------------------------- |
| 190 s (**5.1%**) |       223 | **853 ms** | `SELECT name FROM pg_timezone_names`                |
| 140 s (3.7%)     |     5,821 | 24.1 ms    | assignment sweep's unassigned-ticket scan           |
| 115 s (3.1%)     | 2,215,706 | 0.05 ms    | worker job claim — 99.99% of them empty             |
| 65 s (1.7%)      |   453,171 | 0.14 ms    | `jobs` status counts                                |
| 58 s (1.6%)      |    30,579 | 1.9 ms     | postgres.js type introspection — 13,055,646 rows    |
| 42 s (1.1%)      |        23 | 1,816 ms   | nightly `delete from jobs … returning "id"`         |
| 41 s (1.1%)      |   155,163 | 0.27 ms    | message lookup by `channel_message_id` — **6 hits** |
| 136 s (3.6%)     |   248,185 | 0.55 ms    | `pgbouncer.get_auth` — Supavisor client auth        |

Read in order of how much is worth doing:

**1. `pg_timezone_names` is the single most expensive statement in the
database** — 853 ms a call, 266,708 rows returned across 223 calls, 5.1% of all
execution time. It is **not in this repo** (`grep` finds nothing), so it is
Supabase Studio's own timezone picker or an extension. Confirm that before
spending an hour on it; if it is Studio, the finding is simply that the biggest
query in the database is not ours.

**2. The assignment sweep is the most expensive thing this app runs**, and it is
expensive for a reason the advisor names independently: **`conversations.group_id`
has no index**, so joining `conversations → groups` cannot be driven cheaply from
the 13,807-row side. It is one of **43 unindexed foreign keys**; the ones on hot
paths are `conversations.group_id`, `conversations.channel_id`,
`messages.author_agent_id`, `messages.author_contact_id` and
`conversation_events.actor_agent_id`. The other 38 are on admin screens and
`INFO`-level for a reason — adding all 43 would put write cost on every table to
speed up pages nobody loads.

**3. `webhook_events_unprocessed_idx` is 13 MB to serve 155 scans in 47 days**,
and it is maintained on every one of 206,053 inserts. Its comment says it serves
"the worker's claim query: unprocessed, oldest first", but the worker claims from
`jobs`; this index only ever backs the ingest lifecycle's own lookups. Its
leading column `processed_at` is non-null on ~98% of rows, which is exactly the
case a partial index exists for:

```sql
create index webhook_events_unprocessed_idx on webhook_events (received_at)
  where processed_at is null;
```

Kilobytes instead of megabytes, and far cheaper on insert.

**4. `jobs` holds 1,150 live rows in 52 MB**, 30 MB of it indexes, with
`jobs_dedupe_idx` alone at 15 MB. The advisor flags it as the one bloated table
in the database. The cause is the shape AGENTS.md already documents — a plain
unique index over the whole table, ~200,000 insert-and-delete cycles per 47
days — so this is bloat to be reclaimed and then held down with per-table
autovacuum settings, not a design to change.

**5. The nightly cleanup materialises rows it only counts.** Both deletes end
`.returning({ id })` and use nothing but `.length`; the `jobs` delete pulled back
201,135 ids at 1,816 ms a run. Use the row count.

**6. The worker polls an empty queue 2.2 million times.**
`WORKER_POLL_INTERVAL_MS` defaults to 1,000 ms, and 99.99% of those claims
return nothing. This system already has `LISTEN/NOTIFY` — the queue could wake on
notify and keep the poll as the fallback. Worth costing before doing: the poll is
0.05 ms and the risk of a missed wake-up is a stalled queue, so the honest
trade is a longer idle interval with notify as the fast path, not notify alone.

**7. 155,163 lookups by `channel_message_id` found six rows in total.** This is
`applyWhatsAppStatus` in `lib/tickets/ingest-whatsapp.ts:405`, whose own comment
already calls the case — "a status for a message we never sent … when another
tool shares the number". It is empty because **this system has only ever
sent 64 messages, 18 of them with a channel id** — the status callbacks belong to
messages Freshchat sent on the same number. Not a bug; the archive is a mirror.
Worth knowing before anyone reads that call count as real send volume.

**8. Connection churn is measurable and it is ours.** `pgbouncer.get_auth` ran
248,185 times (a Supavisor client authentication apiece) and postgres.js's
catalogue introspection ran 30,579 times, dragging back **13 million rows** just
to learn array type OIDs it already learned. That is ~650 fresh backends a day,
and the likely cause is `idle_timeout: 20` in `db/client.ts` recycling pool
connections every 20 idle seconds. This is the one finding that touches
"connection issues" in the pooler sense — but note what §5 of
`docs/PROJECT-STATE.md` says about the stuck-backend leak: it is **unexplained
and reaped, not solved**. Raising `idle_timeout` cuts churn; it also holds
`max_connections` slots (60) for longer. Measure, change one number, watch.

Right now the database is healthy — 18 connections, 1 active, nothing stuck.

### One thing not to touch

`messages_search_idx` (0 scans), `conversations_search_idx` (0),
`conversations_subject_trgm_idx` (0) and `messages_body_trgm_idx` (5) are on the
advisor's unused list and total ~8 MB. **Do not drop them.** They back inbox
search, which is built and simply has not been used, because this system is not
yet taking real human tickets. "Unused in 47 days" and "not needed" are the same
reading only if you already know the feature is live. The same caution covers
`conversations_form_idx` and `conversations_tags_idx`.

## On the refactor and the comments

The stated scope was "refactor code properly" and "clean up and update project
comments". Both deserve a straight answer before any of it starts, because the
evidence does not support doing them the way they were asked for.

**There is nothing broken to refactor.** The full pre-push loop passes clean on
`4c3cecd`: `tsc --noEmit`, `eslint .`, `prettier --check`, `repo-rules.mjs`
(19 checks, no violations), and **1,532 tests in 113 files**. There are **zero**
`TODO`, `FIXME`, `HACK` or `XXX` markers in 100,939 lines. A repo-wide
refactoring pass here has no defect to fix, and two costs that are real:
AGENTS.md records that two sessions have already fixed the same bug independently
and **a whole PR was thrown away** — a sweeping diff across 100k lines is the
best possible way to cause that again.

**The comments are the asset, not the debt.** This codebase's comments carry
reasoning — what was tried, what broke, what the naive alternative would have
cost. `docs/PROJECT-STATE.md` §6 alone is 60-odd traps that each cost real time.
"Cleaning up" prose whose value is precisely that it is long would destroy the
most useful documentation in the project. The one comment this pass found that is
actually _wrong_ is the one on `webhook_events_unprocessed_idx`, and it is wrong
about a fact, which is the only kind worth fixing.

So the scoped alternative:

- **Fix comments that are factually false**, found by checking claims against
  the database rather than by reading for style. One so far.
- **Delete confirmed dead exports.** A crude scan suggested 40; verifying them
  one by one left **three** (`agentExists`, `markRead`, `onInboundMessage`) — the
  rest are used in type positions, inside their own module, from `next.config.ts`,
  or exported deliberately so a test can read `toSQL().params` back. Before
  touching any of it, add `knip` to CI so the check is mechanical and the next
  session does not redo the scan. AGENTS.md is explicit that a mechanical rule
  belongs in `scripts/ci/repo-rules.mjs`, not in prose.
- **Leave the three large files alone for now.** `app/(console)/actions.ts`
  (2,050 lines), `inbox/[number]/view.tsx` (1,969) and
  `admin/settings-actions.ts` (1,780) are the only real size outliers. Splitting
  them is defensible, but it is a large diff with no behavioural win, on exactly
  the files another session is most likely to be editing. Do it when something
  else requires opening them.

## Sequence

Four commits, smallest blast radius first, each independently revertible. Steps 1
and 2 are the only ones that change what production does today.

1. **Restore WhatsApp ingestion.** Needs the Meta answer above first. Verify
   against a candidate set rather than one secret (§6.29's shape), and make the
   refusal loud somewhere a person looks — ten days of `console.warn` is what
   let this run. Then reprocess the 399 stored rows, which is the only route
   back for those customers' messages.
2. **Index the five hot foreign keys**, in `db/sql/` and idempotent per the
   house rule, not by hand in a migration. Confirm each with `EXPLAIN` on
   production first — AGENTS.md requires reading state before a write, and the
   assignment sweep's 24 ms is the number to beat.
3. **Reclaim `jobs`**, make `webhook_events_unprocessed_idx` partial, and drop
   the `.returning()` from `cleanup`. Check `pg_stat_activity` for a conflicting
   lock before the reindex; §5.5 has the query.
4. **Add `knip` to CI, delete the three confirmed dead exports, fix the index
   comment.** Then update `docs/PROJECT-STATE.md` with the WhatsApp outage and
   its cause, because that is the file that gets updated.

Steps 3 and 4 are safe to do without the Meta answer. Step 1 is the one that is
costing customers, and it is blocked on a person, so it is worth asking about
before anything else on this list gets started.
