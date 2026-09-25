# Query optimisation, and what a cleanup pass should and should not touch

_Written 2026-09-09, against `main` at `4c3cecd`. Every figure below comes from
the production project `nqbcfnvqqyqawmffgiql` — `pg_stat_statements` over the
47 days since its last reset (2026-07-24), the Supabase performance advisor, and
`pg_stat_user_indexes`. Nothing here is inferred from reading the code alone._

## Read the workload before optimising it

One thing has to be said first, because it decides how much of the rest is worth
doing. **The measured workload is not the workload this system will have.**

The app is not live. It takes no real human tickets. The WhatsApp traffic that
dominates every figure below — 200,111 of 205,974 webhook events, 143 MB of
payload, 97% of all ingest — is a **mirror** of conversations happening between a
bot in another service and customers. We are not a party to it. And the WhatsApp
app secret is **deliberately** mismatched right now, so that traffic can be
ignored while Facebook and Instagram get the attention.

That matters for a specific reason: the top of a `pg_stat_statements` ranking
here is mostly the cost of ingesting a mirror that will be switched off. Tuning
against it would be tuning against a workload nobody will ever run. So the
findings below are split by whether they survive that change:

- **Durable** — true regardless of traffic mix: missing indexes on join columns,
  the `jobs` bloat mechanism, a delete that materialises rows to count them,
  connection churn, a retention rule with a hole in it.
- **Artefacts of the mirror** — real numbers, but they describe today's tenant
  and not tomorrow's. Recorded so nobody mistakes them for production load.

### The WhatsApp signature failures are intentional

Stated here because the raw data reads alarming and the next session will find it
too. Since **2026-08-30 15:01:41 UTC** every WhatsApp webhook has been stored
`signature_verified = false` and never enqueued, answered `403` — 399 of them.
The same `metaAppSecret()` verified 901 Facebook Page deliveries over the same
window, so the secret on the web service is fine and the mismatch is with the
WABA's app.

**This is a deliberate test condition, not an incident.** Nothing that affects us
is being dropped: the messages are the bot's, not ours. Do not "fix" it without
asking — it is what keeps the mirror out of the way.

Two things follow from it that are worth keeping. The first is a real bug, below.
The second is smaller: with WhatsApp muted, the bot archive stops growing, and
that archive is the only real corpus this system has ever had — the out-of-hours
plan measured against 18,417 inbound messages from it, and categorisation was
tuned on it. Worth knowing before the next feature wants a corpus to reason from.

## The one bug this turned up

**Unverifiable webhook payloads are exempt from retention forever.** `cleanup`
prunes `webhook_events` with:

```sql
processed_at is not null and processed_at < now() - interval '30 days'
```

A payload that fails signature verification never gets a `processed_at`, so it
never matches, so it is never deleted. It sits there permanently:

| Rows      | Verified | Processed | Oldest     | Payload  |
| --------- | -------- | --------- | ---------- | -------- |
| 201,328   | yes      | yes       | 2026-08-18 | 301 MB   |
| **4,647** | **no**   | **no**    | 2026-08-19 | 6,706 kB |

6.7 MB is nothing today. The problem is not the size, it is that the exemption
runs the wrong way round. That module's own comment says why the rule exists —
"raw webhook payloads contain customer PII we have no reason to keep once the
message they produced has been stored" — and an unverified payload is the case
where we have _even less_ reason to keep it, indefinitely, and no message to show
for it. The oldest rows are from **19 August**: the Instagram §6.26/§6.29
signature failures, still on disk three weeks later. So this predates the
WhatsApp change and was only made visible by it.

The fix is a second clause with its own clock — retain unverified rows briefly as
the evidence they are stored to be, then drop them — not a widened predicate that
loses the distinction.

## Durable query findings

**1. `conversations.group_id` has no index**, and the assignment sweep pays for
it: 5,821 runs, 24.1 ms mean, 140 s total — the most expensive statement this app
issues. Joining `conversations → groups` cannot be driven cheaply from the
13,807-row side without it. It is one of **43 unindexed foreign keys** the advisor
reports; the ones on paths that will matter when the app is live are
`conversations.group_id`, `conversations.channel_id`, `messages.author_agent_id`,
`messages.author_contact_id` and `conversation_events.actor_agent_id`. The other
38 are on admin screens, `INFO`-level for a reason — adding all 43 would put
write cost on every table to speed up pages nobody opens.

This one is durable in the strongest sense: the sweep runs every five minutes
whatever the channels are doing, and it gets _more_ expensive as real tickets
arrive, not less.

**2. `webhook_events_unprocessed_idx` is 13 MB serving 155 scans in 47 days.**
Its comment claims it serves "the worker's claim query: unprocessed, oldest
first", but the worker claims from `jobs` — this index only ever backs the ingest
lifecycle's own lookups. Its leading column `processed_at` is non-null on ~98% of
rows, which is exactly the case a partial index exists for:

```sql
create index webhook_events_unprocessed_idx on webhook_events (received_at)
  where processed_at is null;
```

Kilobytes instead of megabytes, cheaper on every insert, and it interacts with
the retention bug above — once unverified rows expire, the unprocessed set stays
genuinely small.

**3. `jobs` holds 1,150 live rows in 52 MB**, 30 MB of it indexes, with
`jobs_dedupe_idx` alone at 15 MB. The advisor flags it as the one bloated table
in the database. The cause is the shape AGENTS.md already documents — a plain
unique index over the whole table, ~200,000 insert-and-delete cycles per 47 days.
The _volume_ is a mirror artefact; the _mechanism_ is not, so reclaim the bloat
and hold it down with per-table autovacuum settings rather than changing the
design.

**4. The nightly cleanup materialises rows it only counts.** Both deletes end
`.returning({ id })` and use nothing but `.length`; the `jobs` delete pulled back
201,135 ids at 1,816 ms a run. Use the row count. Two-line change, no behavioural
risk, and it stops being a per-row cost that scales with whatever traffic
arrives.

**5. Connection churn is measurable and it is ours.** `pgbouncer.get_auth` ran
248,185 times — a Supavisor client authentication apiece — and postgres.js's
catalogue introspection ran 30,579 times, dragging back **13 million rows** to
relearn array type OIDs. That is ~650 fresh backends a day, and the likely cause
is `idle_timeout: 20` in `db/client.ts` recycling pool connections every 20 idle
seconds.

Treat this one carefully. §5 of `docs/PROJECT-STATE.md` records a stuck-backend
leak that is **unexplained and reaped, not solved**; raising `idle_timeout` cuts
churn but holds `max_connections` slots (60) for longer, which is the resource
that leak consumes. Change one number, watch, keep the `pg_stat_activity` query
from §5 to hand. Right now the database is healthy: 18 connections, 1 active,
nothing stuck.

**This is not where the freeze comes from.** The recurring web-service freeze
was diagnosed separately on 2026-09-09 and is not a database problem at all:
`plans/web-freeze-2026-09-08.md` has it, and §62 the short version. Churn is
still worth reducing, but nothing on this page would have prevented that
outage, and the pool finding that matters there is the **absence of a checkout
timeout** on `max: 10` rather than `idle_timeout`.

## Mirror artefacts, recorded so they are not mistaken for load

**`SELECT name FROM pg_timezone_names` is the single most expensive statement in
the database** — 223 calls, 853 ms mean, 190 s total, 5.1% of all execution time,
266,708 rows. It is **not in this repo** (`grep` finds nothing), so it is Supabase
Studio's timezone picker or an extension. Nothing to do; worth writing down that
the biggest query in the database is not ours.

**The worker polls an empty queue 2.2 million times.**
`WORKER_POLL_INTERVAL_MS` defaults to 1,000 ms and 99.99% of claims return
nothing. Tempting to wake on `LISTEN/NOTIFY` instead — but each poll is 0.05 ms,
the failure mode of a missed wake-up is a stalled queue, and the call count is
inflated by a mirror that will not be there. If it is ever worth doing, the shape
is a longer idle interval with notify as the fast path, not notify alone.

**155,163 lookups by `channel_message_id` found six rows in total.** This is
`applyWhatsAppStatus` in `lib/tickets/ingest-whatsapp.ts:405`, and its own comment
already calls the case exactly: "a status for a message we never sent … when
another tool shares the number". That is precisely what the mirror is. Not a bug,
and it disappears with the mirror. Do not read that call count as send volume —
this system has only ever sent **64** messages, 18 of them with a channel id.

**`webhook_events` is 516 MB, ~90% of the database**, 143 MB of it WhatsApp
payload JSON. Retention is working as designed on the verified rows; this is
simply the steady state of mirroring ~20,000 events a day.

### One thing not to touch

`messages_search_idx` (0 scans), `conversations_search_idx` (0),
`conversations_subject_trgm_idx` (0) and `messages_body_trgm_idx` (5) are on the
advisor's unused list, ~8 MB together. **Do not drop them.** They back inbox
search, which is built and simply has not been used, because the app is not live.
"Unused in 47 days" and "not needed" are the same reading only if you already
know the feature is live — and here nothing is. Same caution for
`conversations_form_idx` and `conversations_tags_idx`. This is the general hazard
of optimising a pre-launch system from usage statistics: absence of use is the
default, not a signal.

## On the refactor and the comments

> **Superseded on 2026-09-25 by `plans/refactor-in-stages.md`**, for the part
> about the refactor. A staged refactor has since been asked for explicitly.
> That plan answers the risks below instead of avoiding them: small
> single-seam PRs, moves kept apart from behaviour changes, seams claimed in its
> tracking table, and the three large files split last, behind a gate. What this
> section says about the comments still stands.

The stated scope was "refactor code properly" and "clean up and update project
comments". Both deserve a straight answer, because the evidence does not support
doing them the way they were asked for.

**There is nothing broken to refactor.** The full pre-push loop passes clean on
`4c3cecd`: `tsc --noEmit`, `eslint .`, `prettier --check`, `repo-rules.mjs`
(19 checks, no violations), and **1,532 tests in 113 files**. There are **zero**
`TODO`, `FIXME`, `HACK` or `XXX` markers in 100,939 lines. A repo-wide
refactoring pass has no defect to fix here, and two real costs: AGENTS.md records
that two sessions have already fixed the same bug independently and **a whole PR
was thrown away** — a sweeping diff across 100k lines is the best available way
to cause that again.

**The comments are the asset, not the debt.** This codebase's comments carry
reasoning — what was tried, what broke, what the naive alternative would have
cost — and `docs/PROJECT-STATE.md` §6 is sixty-odd traps that each cost real
time. "Cleaning up" prose whose value is precisely that it is long would destroy
the most useful documentation in the project. Two comments this pass found are
factually wrong, which is the only kind worth changing:

- `webhook_events_unprocessed_idx`'s, which names a query that does not use it.
- `cleanup`'s retention paragraph, which states a PII rule the code does not
  actually enforce on unverified rows.

So the scoped alternative:

- **Fix comments that are factually false**, found by checking claims against the
  database rather than by reading for style. Two so far.
- **Delete confirmed dead exports.** A crude scan suggested 40; verifying them
  individually left **three** (`agentExists`, `markRead`, `onInboundMessage`) —
  the rest are used in type positions, inside their own module, from
  `next.config.ts`, or exported deliberately so a test can read `toSQL().params`
  back. Add `knip` to CI first so the check is mechanical and the next session
  does not redo the scan; AGENTS.md is explicit that a mechanical rule belongs in
  `scripts/ci/repo-rules.mjs`, not in prose.
- **Leave the three large files alone for now.** `app/(console)/actions.ts`
  (2,050 lines), `inbox/[number]/view.tsx` (1,969) and
  `admin/settings-actions.ts` (1,780) are the only real size outliers. Splitting
  them is defensible but it is a large diff with no behavioural win, on exactly
  the files another session is most likely to be editing. Do it when something
  else requires opening them.

## Sequence

Three commits, smallest blast radius first, each independently revertible. None
of them touch the WhatsApp secret or the webhook verification path.

1. **Fix the retention hole and its comment.** Give unverified rows their own
   clock in `cleanup`, and correct the paragraph that claims a rule the code does
   not apply. Verify the new predicate as a `SELECT` first — 4,647 rows expected,
   and AGENTS.md requires reading state before a write.
2. **Index the five hot foreign keys**, in `db/sql/` and idempotent per the house
   rule, not by hand in a migration. `EXPLAIN` each against production first; the
   assignment sweep's 24 ms is the number to beat, and it is the one figure here
   that gets worse rather than better as the app goes live.
3. **Reclaim `jobs`, make `webhook_events_unprocessed_idx` partial, drop the
   `.returning()` from `cleanup`, add `knip` to CI and delete the three dead
   exports.** Check `pg_stat_activity` for a conflicting lock before the reindex;
   §5.5 has the query.

Then update `docs/PROJECT-STATE.md`: the retention hole belongs in §6, and the
fact that the WhatsApp secret is intentionally mismatched belongs somewhere a
session finds it _before_ spending an afternoon diagnosing it, as this one did.

Everything above is safe to do while WhatsApp stays muted and Facebook and
Instagram have the attention. Nothing on this list is urgent — item 1 is a slow
leak, item 2 is the only one whose cost grows on its own.
