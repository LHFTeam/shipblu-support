# ShipBlu Support — working brief

For an agent joining this build. The README explains what the system is and how
it is designed; **this file is about the state of the work** — what is live,
what is merely built, what is left, and the mistakes that have already cost us
time. Read both. Do not re-derive settled decisions.

Last updated: 2026-08-22, against `main` at `9112536`.

---

## 1. Status in one paragraph

Every phase of the original plan except migration importers is **built and
merged**: email ticketing, WhatsApp, Facebook and Instagram, the agent console,
the bilingual knowledge base with its Freshdesk importer, the chat widget, SLA
policies, automation rules, CSAT and reporting, and a live dashboard for admins
at `/admin/dashboard`. Since then the **customer portal** has landed too — the
bare domain now opens the Arabic help centre, and one Sign in button
authenticates customers and agents alike.

Since then, **shipments**: tickets link to parcels and to shipping accounts,
tracking numbers and SBIDs are detected in message text as it arrives, the inbox
searches on both, and the console finally has contact, account and shipment
pages — the first screens ever to use the `contact.view` and `contact.edit`
permissions, which had been in the list and checked nowhere since the start.

And since **that**: **contact merging** and a **register of ShipBlu's sixteen
locations**. The console section is now `/contacts` rather than `/customers`,
matching the table name it has always had. A duplicate is folded into the record
an agent is looking at — identities, tickets, messages, account memberships and
parcel roles move, and the loser stays as a tombstone that redirects — behind a
new `contact.merge` permission held by supervisors and above. `locations` holds a
name, a unique code and a shared mailbox per hub, joined to nothing on purpose;
see `plans/contact-merge-and-locations.md` for why, and §5.1 for the sixteen rows
nobody has entered yet.

And then **side conversations**: an agent can open a thread with a hub, an
internal team or a vendor from inside a ticket, and the answer comes back onto the
ticket rather than into their personal mailbox — never onto the customer's timeline.
This is the first thing to join `locations` to anything: the picker's hubs are
its rows, which is what that table was entered for. Teams and vendors are not
locations, so they keep their own small directory at `/admin/recipients`. Built
and verified end to end against a local Postgres. The team directory has since
been filled to three rows, but `locations` has not, so the picker still offers no
hub at all — see §5.1, because a hub is the recipient an agent most often wants.

And **shared locations**: a pin a customer drops is kept as coordinates rather
than flattened into prose and rendered as a card with a Maps link. **Every pin in
the archive is now readable** — the backfill ran on 2026-08-21 and recovered all
821, so all 845 open on a map. This is the first feature in the system whose case
was made entirely from production data rather than from the plan; §6.17 is the
trap found while measuring it, and §6.20 the one found while running it.

The **help centre's UI was then rebuilt on the portal's design**, so the two
halves a signed-in customer moves between stop looking like different products.

And now **ticket assignment**. Until this landed a ticket reached a group and
stopped there; a person only ever got one by picking it out of a dropdown. Each
group can now hand its tickets out by round robin or by load, optionally filtered
by skills, gated on its own business hours, with per-agent caps, opt-in
reclaiming from agents who have gone offline, and escalation of anything nobody
picks up. Three pieces of scaffolding that had been in the schema doing nothing
since the first migration are finally read: `groups.escalate_to_agent_id` /
`escalate_after_mins`, `group_members` as an actual constraint rather than a
roster to draw, and `agents.presence`, which the dashboard has rendered from day
one and **nothing had ever written** — so every agent read `offline` forever. It
is written now, by the SSE stream and by nothing else. Every group ships on
`manual`, so none of it changes behaviour until somebody opts a team in.

And now **agent productivity reporting**, at `/reports/agents` behind a new
`report.agents` permission. It answers punctuality, availability, speed and
efficacy per agent per day: first and last connection, time at the desk,
available time, adherence to their group's calendar, tickets assigned and
resolved, backlog at day end, measured handling time, occupancy, and the reopen
rate that keeps the speed columns honest.

Most of that **could not be answered before, because nothing recorded it**.
`agents.presence`, `last_seen_at` and `is_accepting_tickets` are current-state
columns with no history; `sessions` rows are deleted on logout. So this change is
mostly three new append-only capture tables — `agent_presence_intervals` written
by the SSE stream's existing single writer, `agent_focus_intervals` written by a
new beat from the ticket page, and `agent_backlog_snapshots` sampled hourly —
plus `agent_metrics_daily`, rebuilt nightly by the same `rollup_metrics` job that
already owns `metrics_daily`. **The report is empty until the capture has run for
a day**, and on this database it will stay near-empty until humans work tickets:
see the paragraph below.

The focus beat also finally writes `conversation_presence`, which has existed
since the first migration for collision detection and which **nothing had ever
written** — the same shape of dead scaffolding `agents.presence` was before
assignment landed. It is worth grepping for others.

And now **custom ticket fields carry values**, which is one of those others found
by doing exactly that. An admin has been able to define a field since the first
migration, `ticketFieldOptions()` has offered it to the condition builder as
`custom.<key>`, and `lib/rules/facts.ts` has read `conversations.custom_fields`
to answer it — but **nothing had ever written that column**, so every rule
written against a custom field matched nothing and said so to nobody. Two forms
write it now: the conversation sidebar, and the portal's new-ticket form for the
fields an admin marks visible and editable by customers. The two required flags
were the same shape of dead scaffolding and are enforced as of this change. See
§5.5 for the three decisions behind it, and §6.21 for the bundle trap found while
building it.

**The bot channel is live, and everything else is not.** This is the single most
important thing to understand about the current state, and the easiest to read
backwards.

`channels` holds exactly one row: `whatsapp_bot`. Through it, real traffic has
been arriving since 2026-08-18 — **3,552 conversations, 9,544 messages and 3,476
contacts** in three days, around 1,500 conversations a day. The database is not
empty and the system is not idle.

But that channel is **read-only observation by design**. Another service owns
that number and holds the conversation; we receive a copy of both sides.
`lib/tickets/channel-policy.ts` marks it read-only _and_ restricted, excludes it
from "all channels" even for an admin, and keeps it out of the SLA sweep, the
time-based automations and every reporting metric. Nobody on the team works
those conversations. They are transcripts, not a queue.

Every human channel put together holds **7 conversations** — 3 email, 2
WhatsApp, 1 Facebook, 1 Instagram — all of them test traffic from 18–19 August.
There is no email mailbox row, no human WhatsApp row, no `webchat` row and no
`portal` row. `sla_policies` and `automation_rules` are both still empty, so the
crons that sweep them run over nothing every 5 and 15 minutes. `locations` is
still empty, all sixteen of them.

So: **the system still cannot take a real human support ticket**, and the
remaining work is mostly not code — it is configuration, live-provider
verification, and cutover. The agent productivity report is the sharpest example
of what that costs: on 2026-08-21 production held **3 agents, 1 assigned
conversation and 7 agent-authored messages**, so every figure on that page will
read as a near-empty row until the team is actually working in the product. That
is an argument for having landed the capture early, not for reading the report
yet. Treat "phase N is complete" as a statement about the
codebase, never about the product being usable by the support team. But do not
read "not configured" as "no data": there is a real archive now, it is worth
measuring things against, and §6.17 is what happens when you measure carelessly.

---

## 2. Live infrastructure

Everything is in **Frankfurt / eu-central-1**. Colocation is deliberate and is
worth protecting: the health endpoint reports 2–4 ms to the database, and a
console page issues 10–30 queries.

### Render — workspace `tea-da1f2lgjo6nc738hobmg`

| Service                          | Type                          | Id                         | Branch                       |
| -------------------------------- | ----------------------------- | -------------------------- | ---------------------------- |
| `shipblu-support`                | web (standard, autoscale 1→3) | `srv-da1jgtg1ne8s73ciqulg` | `main`                       |
| `shipblu-support-worker`         | worker (starter)              | `srv-da1jgtg1ne8s73ciqujg` | `main`                       |
| `shipblu-support-staging`        | web (starter)                 | `srv-da1jgtg1ne8s73ciqul0` | a feature branch — see below |
| `shipblu-sla-sweep`¹             | cron `*/5 * * * *`            | `crn-da1jgtg1ne8s73ciqup0` | `main`                       |
| `shipblu-time-automations`       | cron `*/15 * * * *`           | `crn-da1jgtg1ne8s73ciquog` | `main`                       |
| `shipblu-whatsapp-template-sync` | cron `0 * * * *`              | `crn-da1jgtg1ne8s73ciquk0` | `main`                       |
| `shipblu-nightly`                | cron `0 0 * * *`              | `crn-da1jgtg1ne8s73ciqumg` | `main`                       |

¹ `shipblu-sla-sweep` runs **two** jobs, `sla_sweep && assign_sweep`, chained the
way `shipblu-nightly` chains cleanup and the rollup — same cadence, neither long,
and a second container booting every five minutes to run a query that usually
returns nothing is not worth it. The order matters and the `&&` does too: the SLA
sweep goes first so a ticket the assignment sweep is about to hand to somebody
carries its breach flags when they open it, and a failure in the first half takes
the run red rather than reporting success because the second half worked. So the
service name understates what it does — grep `render.yaml` for `startCommand`
rather than trusting a cron's name.

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
connects as `postgres`, the table owner, which bypasses RLS — so adding FORCE would
break every query in the app. This is a lockdown against direct PostgREST
access, not an app-level authorisation mechanism; authorisation lives in code.

**That invariant is now enforced by `db/sql/`, and it was not before.** Drizzle
does not emit `ENABLE ROW LEVEL SECURITY`, so the enabled state on the original
tables was set by hand and every table added since arrived without it. Seven
reached production that way — the five from the shipment work and
`contact_sessions` / `contact_tokens` from the customer portal before it. Since
Supabase grants `anon` and `authenticated` full DML on everything in `public`,
those seven were readable _and writable_ with the anon key that ships in client
bundles. Fixed in production on 2026-08-20 and now re-applied by a loop on every
deploy, so a new table is locked down whether or not anybody remembered.

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

- **Channel rows.** `channels` holds one row, `whatsapp_bot`, and it is the
  observed bot number rather than anything the team answers (§1). Email
  mailboxes, the _human_ WhatsApp business number, the Facebook page and
  Instagram account, and a `webchat` channel each still need a row. The env vars
  are the credentials; the rows are what the app routes on. A `portal` row is
  worth adding too: without one, tickets opened from the customer portal land
  with no default group, so nothing routes them. The `webchat` row is in the
  same position now that the help centre carries the chat launcher on every
  page: a chat still opens a ticket without it, but with no channel and no
  group, and it is also the row whose default group decides which schedule the
  widget calls "we are here" — with none, the global default applies.
- **Every bot transcript is one-sided, and the fix is one job away.** The app has
  never been subscribed to `message_echoes`, so the archive holds what customers
  said to the bot and nothing the bot said back — 10,007 inbound rows on
  `whatsapp_bot` and **zero outbound**. The missing half is never delivered
  rather than delivered and dropped, and its size is known exactly, because the
  delivery statuses _do_ arrive: 14,828 distinct outbound wamids in the three
  days to 2026-08-22 against 10,024 inbound messages, so roughly 60% of each
  conversation is absent. The receiving code has been ready since the channel
  landed — `lib/whatsapp/parse.ts`, `ingestWhatsAppEcho` — and has only ever seen
  Meta's documentation sample replayed by hand, five payloads on the test number
  `16505551111`. `META_APP_ID` is set, so all that is left is
  `npm run job -- subscribe_meta_webhooks` — from a Render shell on
  `shipblu-support-worker` once this is on `main`, because that is where the
  credentials are and the job ships with this change rather than being deployed
  already. It reads the fields Meta has now, adds what is missing, and refuses
  to write a list that would drop `messages`.
  Do not do this with a hand-written `curl`: the Graph call _replaces_ the field
  list rather than adding to it, so naming only the new field unsubscribes
  `messages` and stops inbound WhatsApp entirely, and Meta answers that with a 200.
- **Agents.** Three accounts exist. The rest of the team needs inviting, and
  `groups` (3 rows) needs its membership — which is now load-bearing rather than
  decorative: auto-assignment only ever considers members of the ticket's group,
  so a group with an empty roster hands out nothing and says `no_group_members`
  on the timeline.
- **Assignment is configured but off.** Every group is on `manual`, which is the
  deliberate default and means the module changes nothing until somebody chooses
  otherwise at `/admin/groups`. Whoever configures it should also decide the
  per-agent caps and, if skills are used, set a **skill timeout** — without one,
  a mistake in a skill's conditions is a ticket no human ever sees. `/admin`
  reports both, including any skill no active agent holds.
- **Locations.** `locations` is empty, and there are sixteen of them. Nothing
  routes on a location yet, so an empty table breaks nothing — but a register
  entered to fourteen is worse than an empty one, because the two missing hubs
  read as hubs that do not exist. `/admin/locations` states the count and the
  settings overview carries the same check. No seed data was written: nobody has
  given us the real names, codes and addresses, and inventing them would put
  plausible-looking wrong codes in every environment.
- **SLA policies and automation rules are both empty**, so the sweep and the
  time-based cron currently run over nothing every 5 and 15 minutes. Whatever
  Freshdesk enforces today needs transcribing.
- **The side conversation picker's two registers.** One is now filled and one is
  not. `internal_recipients` has 3 rows, all of them teams — so the picker
  offers those three and nothing else. **Every hub is still missing**, because
  the hubs are the sixteen `locations` rows nobody has entered (above), and a
  hub is the recipient an agent most often wants. Until they exist an agent
  needing one will type an address from memory, which is the exact failure the
  feature was built to prevent: a mistyped address delivers a customer's name,
  address and complaint to whoever owns that domain. Vendors — a courier
  partner, Finance — also still go in `internal_recipients` at
  `/admin/recipients`, and none is entered. Two side conversations are open
  against the three teams that exist, so the mechanism is in use.
- ~~**The shared-location backfill has not been run.**~~ Run on 2026-08-21: 821
  recovered, 0 unreadable, and `/admin/import` now reports nothing text-only. It
  stays available and is safe to re-run — a second pass recovers nothing — so
  re-run it if the parser ever learns to read a shape it currently skips. §7 has
  the figures.
- **Unset config:** `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_DOMAIN`,
  `EMAIL_WEBHOOK_SECRET`, `KB_PUBLIC_HOST`, `WIDGET_ALLOWED_ORIGINS`.
  `META_APP_ID` joined the shared group with this change and is _not_ on that
  list — it is an app id rather than a secret, only
  `subscribe_meta_webhooks` reads it, and nothing needed it before. The last of
  those is not blocking chat on the help centre and never will be: the snippet
  frames the hostname that served it, so the help centre's own iframe is
  same-origin either side of the custom domain going live. It is for the day the
  widget goes on shipblu.com.
- **Presence has never been observed with more than one agent.** It is written
  from the SSE stream and verified against a local Postgres, but the multi-tab
  case is handled by expiry rather than by reference counting: closing one of two
  tabs marks the agent offline and the surviving tab's next beat — up to 25
  seconds later — puts them back. That window is a brief skip in the rota, which
  is the cheaper error, but nobody has watched it happen with a real team.
- **The shipment detection patterns are still a guess — and the zero they
  produce is not evidence against them.** `SHIPMENT_TRACKING_PATTERN` and
  `SHIPMENT_SBID_PATTERN` are unset, so the defaults in
  `lib/shipments/detect.ts` are in force: a tracking number must carry letters
  _and_ digits, and an SBID must be anchored on its keyword. Nobody has told us
  the real formats. That is deliberate rather than an oversight — the two failure
  modes are not symmetric, and an under-detection is repaired by one agent click
  plus a backfill re-run, while an over-detection puts junk shipments on real
  tickets and eventually out over an API.

  `shipments` is empty across 9,544 messages, which looks exactly like the
  under-detection predicted above. **It is not.** 837 of those messages contain a
  run of six or more digits, and reading them shows what the digits are: GPS
  coordinate fractions from shared pins, and Egyptian postal codes inside
  geocoded addresses — `Gharbia Governorate 6745022`. Only 14 messages carry
  anything with the letters-and-digits shape at all. There is no evidence of a
  single real tracking number in the archive, which is unsurprising: the only
  live channel is the bot, and a customer talking to a bot is answering its
  prompts rather than quoting an AWB. So zero is the correct output here, and
  widening the pattern to bare seven-digit numbers on the strength of that 837
  would have attached junk shipments to hundreds of real tickets. See §6.17.

  Get the real formats from the shipping team; do not infer them from this
  archive. The variables live in the `shipblu-shared` group because the web
  service and the worker have to agree: the worker links on the pattern, the
  console searches on
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
  The help centre is not that test even on its own domain — it serves the
  snippet itself, so the frame is same-origin and `'self'` already covers it.
- **The KB on its custom domain**, including that Freshdesk's old article URLs
  redirect. 174 `kb_redirects` rows exist and none has been followed in anger.
- **A WhatsApp template send outside the 24-hour window** — the one path the
  end-to-end test in §7 could not cover.
- **A side conversation to a genuine forwarding list.** Everything below is
  verified against a local Postgres — the plus-address route, the References
  fallback, the signed-subject fallback, idempotent redelivery, and that a hub
  employee never becomes a `contacts` row. What no local test can establish is
  whether a _real_ forwarding list preserves the `Reply-To`, the plus-address in
  `To`/`Delivered-To`, or the `References` chain. Send one to an actual hub list
  and have somebody on it reply. If all three are eaten the reply opens a new
  customer ticket instead, which is visible immediately: the mail lands in the
  inbox as a new ticket from a hub address rather than on the thread.
- **Meta's Human Agent feature, which nothing has confirmed is approved.** A
  Facebook or Instagram reply sent more than 24 hours after the customer's last
  message goes out tagged `HUMAN_AGENT`, and that tag requires the Human Agent
  permission to be approved for the app. On 2026-08-20 one such send failed
  eight times and died in the queue, and Graph's only account of why was "An
  unknown error has occurred." #49 made that refusal explain itself and named
  this as the likely cause, but **the diagnosis is a hypothesis and the
  permission has never been checked** — nobody has looked at the app's review
  status in the Meta dashboard. If it is not approved then every FB/IG reply
  outside 24 hours fails, which on a support channel is most of them. That dead
  job is still the one dead row in `jobs`; it is a real customer reply that was
  never delivered. Check the dashboard before the channels are turned on, not
  after.
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
- ~~**Custom ticket fields can be defined and referenced, but never carry a
  value.**~~ Built. `conversations.custom_fields` is written by two forms now —
  the conversation sidebar in the console, gated on `ticket.edit_fields`, and
  the portal's new-ticket form for any field marked both visible _and_ editable
  by customers — so a condition on `custom.<key>` finally matches something.
  Both required flags are enforced: `required_on_create` refuses a portal
  ticket, `required_on_resolve` refuses an agent's move to a resolved status and
  the reply-and-resolve button with it, naming the fields that are empty.

  Four decisions worth not re-deriving. **Neither flag stops an automation** —
  a rule cannot fill a field in, so enforcing it there would wedge tickets
  nobody was asked to clear. **`required_on_create` is checked only against the
  fields a customer can see and edit**, because an admin can mark an
  internal-only field required and a customer has no way to answer it; without
  that filter one such field would refuse every ticket anybody tried to open.
  And **"empty" is defined once**, in `isBlank`, deliberately mirroring
  `isEmpty` in `lib/rules/conditions.ts` — otherwise a ticket could read as
  complete on the form and empty to a rule. A consequence: an unticked required
  checkbox counts as answered, because "no" is an answer. Finally, **the console
  patches the column in the database** (`custom_fields || '{...}'::jsonb`, or
  `- 'key'` to clear) rather than reading the map, merging in JavaScript and
  writing it back: the sidebar saves on every change, so two agents on one ticket
  editing two different fields would otherwise race and the slower write would
  silently undo the other.

  What is still missing is the **importer mapping**, which belongs with §5.3
  rather than here — a Freshdesk ticket's custom fields have nowhere to land
  until the ticket importer exists. `usage_count` on canned responses is the
  remaining member of this family: still incremented by nothing.

- ~~`canned_responses.usage_count` is never incremented, and the reason is
  bigger than the column.~~ Both halves are done. The composer's reply tab now
  carries a picker, scoped to the agent's own `personal` responses, their teams'
  `group` ones and everything `global` — in the query rather than in the
  renderer, because a list narrowed after it is built is a list already sent to
  the browser, and a personal response is somebody's own draft wording. Each arm
  tests its own key too, so an orphaned `personal` row with a null `agent_id` is
  visible to nobody rather than to everybody.

  `usage_count` is incremented by both senders — the agent's composer and the
  automation's `send_reply`, which had been reading the body and leaving the
  count alone. **Counted on send, not on insert**, so a response an agent
  reached for and thought better of does not score. It over-counts in one
  direction on purpose: an agent who inserts one and rewrites every word still
  registers a use, because the alternative is diffing the sent body against the
  stored one and picking a similarity threshold nobody can defend. Two snippets
  in one reply attribute to the last one picked, because the column counts
  replies rather than fragments.

  The figures start from this change, so **a response the team has sent for
  months still starts at zero** and the ranking is only meaningful once some
  traffic has gone through it. The tooltip says so.

- **The dead-scaffolding sweep, run rather than recommended.** §1 has said it is
  worth grepping for other columns nothing reads or writes; this is the answer as
  of `e5e2f8a`. Of 548 columns across 52 tables, five are referenced nowhere in
  `lib/`, `app/`, `worker/` or `components/`:

  | Column                               | What it was for                                                |
  | ------------------------------------ | -------------------------------------------------------------- |
  | `kb_articles.visible_to_company_ids` | the `selected_companies` visibility level, still inert (above) |
  | `kb_folders.visible_to_company_ids`  | the same, at folder level                                      |
  | `conversations.parent_id`            | child tickets — nothing creates one, and no UI offers it       |
  | `messages.bcc_addresses`             | BCC on an outbound email; the composer has no field for it     |
  | `conversation_presence.is_typing`    | a typing indicator; the focus beat writes the row but not this |

  None of them breaks anything by sitting there, and none is worth building on
  spec. They are listed so the next session can tell "deliberately unbuilt" from
  "somebody forgot", which is the distinction that cost the time when
  `custom_fields` turned out to be the second kind. The command is
  `db/schema` parsed for column names, grepped against those four directories —
  cheap enough to re-run whenever a feature lands.

  Note what the sweep does **not** catch: a column that is read but never
  written. That is the `custom_fields` shape and the more dangerous one, because
  the reader makes it look alive. Nothing mechanical finds those; they turn up
  by asking, of each read, who writes it.

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

17. **A count of digits is not a count of tracking numbers.** `shipments` sat at
    zero across 9,544 messages while 837 of them contained a six-or-more-digit
    run — which reads as the conservative detection pattern under-matching, and
    invites widening it to bare numbers. Reading the messages instead of the
    aggregate showed the digits were GPS coordinate fractions from shared pins
    and Egyptian postal codes inside geocoded addresses. One "tracking number"
    appearing six times, which looked like the clinching evidence of a real
    parcel being chased, was a coordinate fragment.

    Widening the pattern on that basis would have attached junk shipments to
    hundreds of real tickets — the failure `lib/shipments/detect.ts` is
    deliberately built to avoid, arrived at by way of the metric that was
    supposed to justify the change. **This is trap 14 inverted**: there, a total
    hid a real gap; here, a total invented one that was not there. Same lesson
    either way — before acting on an aggregate, read the rows underneath it.
    Both times the rows were one query away.

18. **A module reachable from the search parser must not call `env()`.**
    `lib/shipments/detect.ts` reads its three variables straight from
    `process.env`, because `env()` validates the whole schema and the detector is
    imported by `parseSearchTerm` — going through it made an inbox search fail on
    a missing `DATABASE_URL` in any context without a database. Same shape as the
    bug that made `APP_URL` optional. The variables are still declared in
    `lib/env.ts` so that file stays the catalogue of what this system reads.

---

19. **A fixed-position iframe parts an iOS caret from its field.** The caret is
    positioned against the document rather than against the fixed element the
    input belongs to, so a page scrolling behind the chat panel drags the
    visitor's cursor across the page while they are typing. They need not scroll
    deliberately either: Safari scrolls the document to reveal a focused input,
    and zooms the page in on any field under 16px, which is another scroll. The
    widget pins the host body while its full-screen panel is up and sizes both
    of its fields at 16px. Chromium reproduces none of this, emulated phone or
    not — the caret is the one part of that fix nothing here can test.

20. **A JS `Date` cannot be a keyset-paging cursor over a Postgres timestamp.**
    Both backfills paged on `(created_at, id)`, taking the cursor from the last
    row of each batch. Neither ever terminated. postgres.js hands a
    `timestamptz` back as a JS `Date`, which holds milliseconds, while the column
    holds microseconds — so a cursor read back through JS is _earlier_ than the
    row it came from, that row satisfies its own `created_at > cursor`, and the
    same batch is returned for ever. On Postgres 16 every row in a seeded table
    reports `created_at > date_trunc('milliseconds', created_at)` as true.

    Both now page on the primary key, which survives the round trip intact. The
    scan is then ordered by uuid rather than by time, which costs a backfill
    nothing.

    Worth noting how long it hid: `backfill_shipment_links` shipped with this and
    sat behind a live button on `/admin/import` for weeks. It looked correct, it
    passed review, and its unit tests all passed — because the tests covered the
    detection logic and nothing exercised the loop against a real database. The
    figure that would have given it away is that the `jobs` table has never held
    a single `backfill_shipment_links` row. **A job that has never been run is
    not tested, whatever its tests say.**

21. **luxon in a client component puts a date library in the console's bundle.**
    The custom-field editor lives in the conversation sidebar, which is a client
    component, and the module it imported also held the parser that reads a
    `datetime-local` wall clock as an instant. That needs the timezone database,
    so luxon — which had never been in a client bundle here — would have shipped
    to every agent on the busiest route in the product.

    Split by _side_, not by subject: `lib/tickets/custom-fields.ts` is what both
    sides import and is luxon-free, and `custom-fields-parse.ts` holds the
    direction that needs it and is server-only. The read direction — instant to
    Cairo wall clock — goes through `Intl.DateTimeFormat` with a `timeZone`,
    which the runtime already carries and which `lib/format.ts` has always
    relied on. Do not hand-roll the other direction to avoid the dependency:
    finding a zone's offset for a given wall clock is exactly the arithmetic
    §6.7 says not to write.

    Worth checking for on any new client component that reaches into `lib/`:
    `grep -rl luxon .next/static/chunks/` after a build answers it in one call,
    and the answer should stay empty.

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
- **Production health**, checked 2026-08-21 on `98ec9d4`: `status: ok`, 2 ms
  database latency, queue empty. **One dead job** — the `send_meta` row in §5.2,
  which is a real undelivered customer reply and not a transient failure.
  Everything else in the job history is completed work: 43,396 rows, almost all
  `process_webhook`, which is what 1,500 bot conversations a day looks like.
- **Side conversations, end to end against a local Postgres 16.** The migration
  and the `db/sql/` replay both applied clean; the `attachments_one_owner` CHECK
  refuses a row with neither owner. An agent's question was sent through
  `send_side_email` with `Reply-To: support+s1.<sig>@reply.shipblu.com`, and the
  hub's reply threaded back three separate ways — by plus-address, by
  `References` alone with the address stripped, and by the signed subject tag
  with both gone. On each: no new ticket, **no new `contacts` row**, nothing
  written to the ticket timeline, `last_message_at` moved and
  `last_customer_message_at` did not. A redelivered Message-ID was reported as a
  duplicate and wrote nothing. A genuine customer email in the same database
  still opened a normal ticket. Reading the ticket back through
  `lib/portal/tickets.ts` as the requester, the hub's words, our question, the
  hub employee's name and the hub address are all **absent from the payload**,
  not merely unrendered.

- **Shared locations, measured against the archive before the code was written.**
  Of the 821 messages whose stored payload mentions a location, all 821 have a
  `location` object carrying both coordinates; all are typed as JSON numbers, all
  fall inside valid latitude and longitude, and none sits at 0,0. So the range
  check in `lib/tickets/shared-location.ts` rejects nothing real, and the SQL
  prefilter the backfill uses has no false positives on this archive. 136 of the
  821 carry a name and a geocoded address; the other 685 are a bare pin, which is
  why the map link matters more than the label. The four gates are clean and both
  the web service and the worker are live on `98ec9d4`.

  Those figures are a snapshot taken before the deploy, which is why the run
  below counts 845 rather than 821: the archive grows by a few hundred pins a day
  and every number here is only true of the moment it was measured.

  **The live path is verified on production.** Both services went live on
  `98ec9d4` at 02:28 on 2026-08-21, and by 09:58 sixteen pins had arrived and been
  stored structurally — every one typed as a JSON number, every one in range, and
  the most recent candidate in the table is itself one of them, so nothing is
  slipping past. Thirteen are bare pins and three carry a name, which is the same
  roughly one-in-six ratio as the archive.

  The write is **additive, confirmed in the data**: `whatsappType` and
  `phoneNumberId` are still present on all sixteen rows. That was the specific
  risk — `meta` is a single jsonb column and assigning it rather than merging
  would have silently dropped the media block and the bot's `echo` flag on every
  pin.

- **The backfill, run on production on 2026-08-21.** Enqueued as a job row rather
  than clicked, which is the route §5.5 documents for a payload the one-shot
  runner cannot carry. A `dryRun` pass first, then the real one, then a third to
  prove it settles:

  | run     | candidates | already | recovered | unreadable | time   |
  | ------- | ---------- | ------- | --------- | ---------- | ------ |
  | dry run | 845        | 24      | 821       | 0          | 157 ms |
  | real    | 845        | 24      | **821**   | 0          | 8.1 s  |
  | again   | 845        | 845     | 0         | 0          | 106 ms |

  **845 of 845 pins now open on a map, and nothing was unreadable.** The dry run
  wrote nothing, confirmed by query. Checked afterwards on all 845 rows: every
  latitude and longitude is a JSON number and in range; **every row still carries
  its `whatsappType` and `phoneNumberId`**, so the jsonb merge took nothing away;
  and no row holds a pin whose `raw_body` never contained one, so nothing was
  invented. The third run left the `meta` of all 845 byte-identical, by checksum.

  The `821` in the two runs before it is the same 821 that had sat unchanged all
  day while the candidate count climbed with traffic — which is what a backfill
  figure should do, and was the sign the live path and the archive were being
  counted separately rather than confused.

- **Both backfills, run end to end against a local Postgres 16** — and the first
  run is what found the bug in §6.20. Nine messages were seeded to cover every
  branch: a bare pin, a pin with name and address, a pin on a row already
  carrying `media` and the bot's `echo` flag, an out-of-range coordinate, a
  malformed `raw_body`, a row already holding a pin, a text message mentioning
  the word, and a message with no pin at all — across two channels, so the
  per-channel tally could be checked rather than assumed.

  All of it behaved: 5 pins written at full precision, the out-of-range and
  malformed rows skipped and counted as unreadable, the already-structured row
  reported as already-done and left untouched, and the message with no mention
  never scanned. **The merge held** — the row with `media`, `echo`,
  `creationType`, `whatsappType` and `phoneNumberId` kept all five and gained
  `location`. A second run recovered nothing and left the `meta` of every row
  byte-identical, checked by checksum rather than by eye. `dryRun` wrote nothing.

  `backfill_shipment_links` was run too, since it carried the same defect, and
  now completes over the same table in 40 ms.

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
