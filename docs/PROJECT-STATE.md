# ShipBlu Support — working brief

For an agent joining this build. The README explains what the system is and how
it is designed; **this file is about the state of the work** — what is live,
what is merely built, what is left, and the mistakes that have already cost us
time. Read both. Do not re-derive settled decisions.

Last updated: 2026-08-19, against `main` at `62fbdaf`.

---

## 1. Status in one paragraph

Every phase of the original plan except migration importers is **built and
merged**: email ticketing, WhatsApp, Facebook and Instagram, the agent console,
the bilingual knowledge base with its Freshdesk importer, the chat widget, SLA
policies, automation rules, CSAT and reporting, and a live dashboard for admins
at `/admin/dashboard`. Since then the **customer portal** has landed too — the
bare domain now opens the Arabic help centre, and one Sign in button
authenticates customers and agents alike. Production is healthy on `04b5c60`,
4 ms database latency, empty job queue, no dead jobs.

Since then, **shipments**: tickets link to parcels and to shipping accounts,
tracking numbers and SBIDs are detected in message text as it arrives, the inbox
searches on both, and the console finally has customer, account and shipment
pages — the first screens ever to use the `contact.view` and `contact.edit`
permissions, which had been in the list and checked nowhere since the start.

**But almost none of it is configured.** The database holds 1 agent, 0 channel
rows, 0 SLA policies and 0 automation rules. The remaining work is mostly not
code — it is configuration, live-provider verification, and cutover. Treat
"phase N is complete" as a statement about the codebase, never about the
product being usable by the support team.

---

## 2. Live infrastructure

Everything is in **Frankfurt / eu-central-1**. Colocation is deliberate and is
worth protecting: the health endpoint reports 4 ms to the database, and a
console page issues 10–30 queries.

### Render — workspace `tea-da1f2lgjo6nc738hobmg`

| Service                          | Type                          | Id                         | Branch                       |
| -------------------------------- | ----------------------------- | -------------------------- | ---------------------------- |
| `shipblu-support`                | web (standard, autoscale 1→3) | `srv-da1jgtg1ne8s73ciqulg` | `main`                       |
| `shipblu-support-worker`         | worker (starter)              | `srv-da1jgtg1ne8s73ciqujg` | `main`                       |
| `shipblu-support-staging`        | web (starter)                 | `srv-da1jgtg1ne8s73ciqul0` | a feature branch — see below |
| `shipblu-sla-sweep`              | cron `*/5 * * * *`            | `crn-da1jgtg1ne8s73ciqup0` | `main`                       |
| `shipblu-time-automations`       | cron `*/15 * * * *`           | `crn-da1jgtg1ne8s73ciquog` | `main`                       |
| `shipblu-whatsapp-template-sync` | cron `0 * * * *`              | `crn-da1jgtg1ne8s73ciquk0` | `main`                       |
| `shipblu-nightly`                | cron `0 0 * * *`              | `crn-da1jgtg1ne8s73ciqumg` | `main`                       |

**Staging is currently suspended, and it is pinned to the feature branch
`claude/shipblu-support-app-03p2we` rather than to a staging branch.** Both are
deliberate-looking but neither is written down anywhere else, so: if you resume
staging, check what branch you are actually about to deploy. Do not assume it
tracks `main`.

### Supabase — org `ihngokrzwjmgpogkecug`

| Project                 | Ref                    | Use        |
| ----------------------- | ---------------------- | ---------- |
| ShipBlu Support         | `nqbcfnvqqyqawmffgiql` | production |
| Shipblu Support Staging | `funavpkflkhthegahuay` | staging    |

Postgres 17.6. RLS is **enabled with zero policies and never `FORCE`**. The app
connects as `postgres`, the table owner, which bypasses RLS — adding FORCE would
break every query in the app. This is a lockdown against direct PostgREST
access, not an app-level authorisation mechanism; authorisation lives in code.

### Environment variables — the rule

**Any value that is the same on more than one service is declared once, in the
`shipblu-shared` env group, and nowhere else.**

Render gives service-level variables precedence over group values, so a key
declared in both places silently takes the service value. That cost us a
debugging session on `DATABASE_URL`. Service-level entries now exist only as
deliberate exceptions, each commented in `render.yaml`:

- staging: `DATABASE_URL`, `DATABASE_URL_SESSION` (its own database),
  `EMAIL_PROVIDER=local` and `META_PAGE_ACCESS_TOKEN=''`, so staging cannot
  reach a real customer on any channel;
- web service only: `EMAIL_WEBHOOK_SECRET`, which has exactly one consumer.

When you add a variable, add it to `render.yaml` in the same commit. The
blueprint is meant to describe the running system; it is not documentation that
drifts.

---

## 3. Working with other agents on this repo

More than one agent session works on this repo at once, and they do not share
context. This has already produced duplicated work: two sessions independently
diagnosed and fixed the same percent-encoded-route bug, and a whole PR had to be
thrown away. That is the single most likely way for you to waste an afternoon.

- **`git fetch origin main` before you plan, not just before you push.** Main
  moved by 20 commits during one session's context window.
- **Read the log before claiming a bug.** `git log --oneline -30 origin/main`
  costs nothing and would have caught both duplicates.
- **Claim your seam out loud** in the PR or to the user before starting on
  anything that takes more than one commit.
- **Prefer rebasing onto main over merging main in.** The history reads as a
  sequence of intentions; merge commits from parallel sessions obscure it.
- Never push to `main`. Commit → push → PR → merge → verify the deploy.

Commit messages here carry the reasoning — the trade-off taken and what the
naive alternative would have broken. They are the durable record of _why_, and
they are worth reading when something looks strange. Keep writing them that way.

---

## 4. Before every push

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
```

All four are clean on `main`. `npm run build` is not optional: several failures
in this project — the React export-condition one in §6.1, ambiguous route
segments — appear only at build time and never in `tsc` or the dev server.

Tests go where bugs actually hide: email threading resolution order, quote
stripping, the WhatsApp 24-hour boundary, business hours across DST, Arabic
slugs, language detection, the condition language. Not on glue code.

**Verify, do not infer.** Any claim about production should be backed by a query
or a log line, and §6.2 is a warning about what happens when it is not.

---

## 5. What is left

In rough priority order. Nothing here is blocked by anything else.

### 5.1 Configuration and cutover — the real remaining work

The system cannot take a single real ticket until this is done, and none of it
is code:

- **Channel rows.** `channels` is empty. Email mailboxes, the WhatsApp business
  number, the Facebook page and Instagram account, and a `webchat` channel each
  need a row. The env vars are the credentials; the rows are what the app
  routes on. A `portal` row is worth adding too: without one, tickets opened
  from the customer portal land with no default group, so nothing routes them.
- **Agents.** One account exists. The team needs inviting, and `groups` (3 rows)
  needs its membership.
- **SLA policies and automation rules are both empty**, so the sweep and the
  time-based cron currently run over nothing every 5 and 15 minutes. Whatever
  Freshdesk enforces today needs transcribing.
- **Unset config:** `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_DOMAIN`,
  `EMAIL_WEBHOOK_SECRET`, `KB_PUBLIC_HOST`, `WIDGET_ALLOWED_ORIGINS`.
- **The shipment detection patterns are a guess and need confirming.**
  `SHIPMENT_TRACKING_PATTERN` and `SHIPMENT_SBID_PATTERN` are unset, so the
  defaults in `lib/shipments/detect.ts` are in force: a tracking number must
  carry letters _and_ digits, and an SBID must be anchored on its keyword.
  Nobody has told us the real formats. That is deliberate rather than an
  oversight — the two failure modes are not symmetric, and an under-detection is
  repaired by one agent click plus a backfill re-run, while an over-detection
  puts junk shipments on real tickets and eventually out over an API. But it
  does mean detection will find less than it should until someone checks. The
  variables live in the `shipblu-shared` group because the web service and the
  worker have to agree: the worker links on the pattern, the console searches on
  it, and a service that disagreed would link a ticket the search could never
  find again. After correcting one, run the backfill from `/admin/import` — the
  live path only ever sees new messages.
- **`/admin/import` now has a second card** whose figures answer whether the
  pattern is right: it splits links into those the detector found and those
  agents made by hand, and says so plainly when the second number is larger.

### 5.2 Live-provider verification

Everything below passes unit tests and has never been exercised against the real
provider. Each is a round trip somebody has to actually watch:

- **Postmark**, once credentials exist: send a reply, reply to it from Gmail
  _and_ Outlook, confirm it threads onto the same ticket rather than opening a
  new one. Threading is the thing naive helpdesks get wrong, and the two bugs in
  §6.4 were both found by reading the API docs rather than by testing — there
  may be a third.
- **The widget on a genuine third-party origin**, not localhost. The
  `frame-ancestors` allowlist and the visitor token are what you are testing.
- **The KB on its custom domain**, including that Freshdesk's old article URLs
  redirect. 174 `kb_redirects` rows exist and none has been followed in anger.
- **A WhatsApp template send outside the 24-hour window** — the one path the
  end-to-end test in §7 could not cover.
- **The portal's verification and reset emails through Postmark.** The whole
  flow has been driven end to end against a local Postgres with
  `EMAIL_PROVIDER=local`, so the links, the tokens and the single-use rules are
  exercised — but nothing has yet been delivered by a real provider to a real
  inbox. Watch two things in particular: that the link survives corporate link
  scanners (verification tolerates a replayed token for exactly this reason, a
  reset deliberately does not), and that `Auto-Submitted: auto-generated` keeps
  autoresponders from opening a ticket per verification email.

### 5.3 Phase 7 — ticket, conversation and contact importers

Not started. The KB importer is the working model: idempotent on
`(source_system, external_id)`, re-runnable, enqueued from `/admin/import`, and
it repairs its own earlier rows rather than duplicating them. Every
customer-facing table carries those two columns for exactly this reason.

### 5.4 The shipping platform read API — designed, not built

The queries the endpoint would call exist and are used by the console today, in
`lib/shipments/queries.ts`: `conversationsForTrackingNumber`,
`conversationsForSbid`, `getShipmentByTrackingNumber`, `getShippingAccountBySbid`
and `contactsForSbid`. None of them takes a `SessionAgent`, which is the seam —
the console wraps them with the agent's permissions and the endpoint would wrap
them with the key's. Baking `can()` in would force the endpoint to invent a fake
agent, which is how an API ends up reaching further than any human.

What is left is the endpoint and its credential. There is still **no inbound API
key mechanism anywhere in this system**: `lib/auth/tokens.ts` and the widget's
visitor token (only the SHA-256 stored) are the precedent to extend, and a new
`api_keys` table is the missing piece. Two things to decide before writing it,
both much cheaper now than as a retrofit:

- one server-to-server platform key, or per-merchant keys? It determines whether
  `shipping_account_id` belongs on the key row.
- the endpoint must pass `restrictedChannels()` in its scope. A bot transcript is
  kept off the shop floor for the team; handing one to an external caller is
  worse.

Whatever it returns should stay conversation _summaries_ and a deep link, never
message bodies — the same reasoning as the deliberately tiny `pg_notify` payload.

### 5.5 Loose ends

- One imported article's detected language disagrees with its category. The
  importer counts and reports these rather than silently refiling them; someone
  who reads Arabic should look at it.
- `logged_in` and `selected_companies` knowledge base articles are still not
  served, even though customers can now sign in. Wiring them up means threading
  the viewer through every query in `lib/kb/queries.ts`; until then
  `publiclyVisible()` treats an unevaluated rule as deny, which is the safe
  reading but means the two visibility levels are inert in the editor.
- Ticket statuses show customers the configured `customer_label` or a plain word
  for the category in their own language — never the status's own name. That
  field has no per-locale variant, so setting it pins one language for every
  reader; leaving it null is usually the better answer.
- ~~`metrics_daily` rows written before the totals-slice fix are inflated.~~
  Repaired. `rollup_metrics` now takes a range (`{"from","to"}`, `{"days":N}`)
  and rebuilds those days from the source tables, and every write asserts that
  the totals row equals the sum of its channel rows — the invariant the bug
  broke — failing the run if it does not. To rebuild history after any future
  change to the figures, enqueue a job row rather than waiting for the nightly:

  ```sql
  insert into jobs (type, payload) values ('rollup_metrics', '{"days": 90}');
  ```

  The running worker claims it within seconds. `npm run job -- rollup_metrics`
  cannot carry a payload (`run-job.ts` passes `{}`), so the queue is the route
  for anything other than the default three-day window.

- **Connections are left mid-transaction by the pooler. Reaped, not solved.**
  Backends appear as `state=active` + `wait_event=ClientRead` with an open
  transaction — the extended query protocol interrupted after Execute and
  before Sync, i.e. a client that stopped mid-statement. They hold their locks
  and a `max_connections` slot (60) until killed; on 2026-08-19 two sat on
  `agents` for six hours and blocked every deploy (§6).

  What was ruled out, with evidence:

  - _Deploys and instance restarts._ No deploy ran at either leak onset.
  - _Aborted server renders._ 60 console requests killed 40 ms in, mid-render,
    against plain Postgres: zero stuck backends. The pooler has to be in the
    path.
  - _The client library._ postgres.js defers `end()` while a query is in flight
    and sends a proper Terminate; it never closes mid-query.

  What triggers it inside Supavisor (or the Render↔Supabase network) is **not
  established** — it cannot be instrumented from the app side.

  So it is reaped rather than prevented: `transaction_timeout = '5min'` is set
  on the `postgres` role, which terminates any transaction spanning longer than
  that, including the implicit single-statement kind these are (verified on
  17.6: `25P04`). `idle_in_transaction_session_timeout` would _not_ catch them,
  because they report `active` rather than `idle in transaction`. Migrations opt
  out in `db/migrate.ts` — building an index legitimately runs long.

  If the leak rate ever rises enough to matter before the reaper fires, find
  them with:

  ```sql
  select pid, state, wait_event, now() - xact_start as age, left(query, 80)
  from pg_stat_activity
  where xact_start < now() - interval '5 minutes' and pid <> pg_backend_pid();
  ```

---

## 6. Traps that have already bitten us

Each cost real time. Most are also comments in the code.

1. **`NODE_ENV=development` is set globally in this container** and breaks
   React's export-condition resolution during prerender, failing with
   `Cannot read properties of null (reading 'useContext')`. `npm run build` pins
   `NODE_ENV=production` for exactly this reason. This was first misdiagnosed as
   a Next/React version incompatibility, and a version matrix was bisected
   before anyone checked the environment.
2. **RSC prefetches of a `force-dynamic` route return 200 without running the
   page.** A 200 in the request logs is not evidence the page renders. Only full
   navigations — no `?_rsc=` — tell you anything. This turned a 404 hunt into an
   afternoon.
3. **`npm ci` under `NODE_ENV=production` skips devDependencies**, which broke
   Render builds; hence `npm ci --include=dev`. The same pruning removes `tsx`,
   which the worker needs _at runtime_ — it lives in `dependencies` deliberately.
4. **`generateValue: true` on a per-service env var evaluates independently per
   service.** `APP_SECRET` came out different on every service, which would have
   made every customer email reply fail HMAC verification and silently open a
   new ticket instead of threading.
5. **Render gives service-level env vars precedence over group values** (§2).
6. **Next hands dynamic route params over still percent-encoded.** Every Arabic
   slug 404'd while the pages above them, which take no parameter, looked
   healthy — so it read as an import bug. `decodeSlugParam()` in `lib/kb/slug.ts`
   is the fix; use it in any new route that matches a param against stored text.
7. **Egypt reinstated DST in 2023** — Cairo is UTC+2 in winter, UTC+3 in summer.
   Hand-converted test fixtures produced six failures against correct code.
   Build test instants from Cairo wall-clock with luxon and let the timezone
   database do the conversion.
8. **WhatsApp's 24-hour window belongs to a (business number, customer) pair.**
   Replying from a different number is a re-engagement message to someone who
   never engaged — and the send API _accepts_ it, with the rejection arriving on
   a status webhook a second later, so no pre-send check can catch it. The
   sending number is resolved from the conversation for this reason.
9. **ASCII slugify erases Arabic entirely**, collapsing every Arabic article
   onto one URL.
10. **Freshdesk visibility must default closed.** `visibility === 3 ?
'agents_only' : 'public'` publishes internal content the first time
    Freshdesk adds a level we have not seen.
11. **A worker retrying a bad password every few seconds trips Supavisor's
    shared auth circuit breaker**, locking every other service out of the
    database. `lib/queue/backoff.ts` classifies failures so auth errors back off
    hard.
12. **Postmark's `MessageID` is an internal UUID, not the RFC `Message-ID`
    header.** Storing it as the message's channel id breaks threading for every
    reply. `SendResult` keeps `providerMessageId` and `rfcMessageId` separate.
13. **One untranslated item can veto an entire language.** Freshdesk language
    discovery probed a single category; ShipBlu's first category is an
    untranslated internal staff guide, so `en` 404'd there and the English pass
    was skipped for the whole account — reporting success, with half the
    knowledge base missing. Probe several items, and articles as well as
    categories. Any "does this exist?" check against one sample has this shape.
14. **A silent success is worse than a failure.** That import read "58 articles"
    and looked clean. Counts that can hide a systematic gap should be broken
    down along the dimension that can fail — per language, per channel, per
    account.

15. **Replaying `db/sql/` took an ACCESS EXCLUSIVE lock on every busy table.**
    The file dropped and recreated identical triggers on each deploy, so a
    deploy needed an exclusive lock on `agents`, `conversations`, `messages` and
    the rest to do nothing at all — and any concurrent _reader_ blocked it. On
    2026-08-19 two connections left mid-transaction on `agents` sat in
    `ClientRead` for six hours, and every deploy from 16:45 onward died on
    `DROP TRIGGER IF EXISTS touch_updated_at ON agents` after burning the full
    two-minute `statement_timeout` — reporting only "canceling statement due to
    statement timeout", which points at the migration rather than at the
    connection actually responsible. The trigger DDL is now skipped when the
    trigger already exists, so the steady state takes no locks, and
    `db/migrate.ts` sets `lock_timeout = 10s` and prints the `pg_stat_activity`
    query to run when it does hit one. **Connections left mid-transaction are a
    live problem in their own right** — new ones appear within minutes; see §5.5.

16. **`CREATE INDEX CONCURRENTLY` cannot go in `db/sql/`.** `db/migrate.ts`
    sends each file as one `sql.unsafe(contents)`, which under the simple query
    protocol wraps the whole file in an implicit transaction, and
    `CONCURRENTLY` cannot run inside one. The three shipment trigram indexes
    there build on tables that were empty at first deploy, so the blocking build
    cost nothing — but an index on a table the size of `messages` needs its own
    migration. There is a note to this effect in the file itself.

17. **A module reachable from the search parser must not call `env()`.**
    `lib/shipments/detect.ts` reads its three variables straight from
    `process.env`, because `env()` validates the whole schema and the detector is
    imported by `parseSearchTerm` — going through it made an inbox search fail on
    a missing `DATABASE_URL` in any context without a database. Same shape as the
    bug that made `APP_URL` optional. The variables are still declared in
    `lib/env.ts` so that file stays the catalogue of what this system reads.

---

## 7. Verification already done

- **WhatsApp, end to end on production.** A synthetic webhook was enqueued; the
  job completed in 170 ms on the first attempt. The same `wamid` redelivered
  under a different event id was logged as a duplicate and wrote nothing. Every
  test row was then deleted and the ticket sequence reset.
- **Error 131047 diagnosed from the data**, not guessed: `webhook_events` showed
  inbound arriving on the real business number while the failure status came
  back on the test number.
- **The Freshdesk KB import is complete and correct.** 58 Arabic articles and 54
  English, all published, across 3 categories and 12 folders. The 4-article gap
  is exactly `دليل الموظف`, the internal staff guide, which has no English
  version in Freshdesk — so nothing is missing. Its 4 folders are the only
  `agents_only` ones; every other folder is public. That visibility came from
  Freshdesk and matches the category's meaning, so it needs no decision.
- **Production health:** `status: ok`, 4 ms database latency, queue empty, no
  dead jobs. Job history shows only completed work.

### Tooling notes for this environment

Supabase and Render MCP tools work and are the fastest way to check real state —
`execute_sql` against `nqbcfnvqqyqawmffgiql` answers most "is it actually
configured?" questions in one call. Outbound HTTPS goes through an agent proxy;
`curl` to the production health endpoint works. Never disable TLS verification.

---

## 8. Security constraints — non-negotiable

- **A production database password was pasted into chat and must be treated as
  compromised.** It was rotated. Never echo credentials, in any direction.
- Secrets never enter the repo. `render.yaml` uses `sync: false` or the env
  group, always without values.
- RLS: enabled, zero policies, **never FORCE** (§2).
- Email bodies and imported KB HTML are attacker-controlled. **Sanitise on
  write, never on read** — the stored row is then safe for every consumer, and
  re-sanitising on read would mask a gap upstream. Remote images are blocked by
  default in email; article iframes are restricted to an allowlist of video
  hosts.
- Attachment paths derive from ids we generate, never from a supplied filename.
  The bucket is private; the console mints short-lived signed URLs.
- Public endpoints (KB feedback and views, the widget) are rate limited in
  memory. Writing a row per rejected request would be a cheaper way to hurt the
  database than the endpoint itself.
- The widget iframe runs on our origin, so the visitor token lives in _our_
  localStorage and embedding it never gives the host site access to a
  conversation.
- `X-Frame-Options: DENY` everywhere except `/widget`, which uses
  `frame-ancestors` with an explicit allowlist.
