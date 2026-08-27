# ShipBlu Support — working brief

For an agent joining this build. The README explains what the system is and how
it is designed; **this file is about the state of the work** — what is live,
what is merely built, what is left, and the mistakes that have already cost us
time. Read both. Do not re-derive settled decisions.

Last updated: 2026-08-26, against `main` at `22871e1`.

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
is written now, by the console's lightweight presence stream and by nothing
else. Conversation invalidations use a separate inbox-only stream, so ticket
traffic cannot make presence expensive. Every group ships on `manual`, so none
of it changes behaviour until somebody opts a team in.

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
by the presence stream's existing single writer, `agent_focus_intervals` written
by a new beat from the ticket page, and `agent_backlog_snapshots` sampled hourly
— plus `agent_metrics_daily`, rebuilt nightly by the same `rollup_metrics` job
that already owns `metrics_daily`. **The report is empty until the capture has
run for a day**, and on this database it will stay near-empty until humans work
tickets: see the paragraph below.

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

And now the **out-of-hours reply**: when a customer writes in and their group is
outside its calendar, the helpdesk answers once, on its own initiative, for the
first time. Configured at `/admin/auto-responses` by group, by channel or by
both — the most specific rule wins, a channel beats a group — with an optional
holiday body that `{{holiday}}` fills in from the calendar. The hours are not a
new setting: it is `groupHours()` from `lib/hours/resolve.ts`, the same calendar
every SLA due date is counted against, so nothing has been added that could
disagree with the clock. See `plans/out-of-hours-auto-response.md`.

Two things in it are worth knowing before reading the code. It is **deliberately
not a first response** — it does not stop the SLA clock and does not move
`lastAgentMessageAt`, because it is sent precisely when nobody is working and the
SLA is counted in working time; recording it would report a first response of
zero minutes on every ticket that arrives overnight. And it sends **once per
closed stretch**, not per message: `conversations.auto_responded_at` is claimed
with a conditional update, so the six ingest jobs six WhatsApp messages at 23:00
produce still yield one reply. The case for it is in the archive — **11,402 of
18,417 bot-channel inbound messages arrived outside production's schedule**, Sun–Fri
10:00–18:00 Cairo.

And now the **help centre's front page, a public tracking page, and the ShipBlu
design system's palette**. The front page was one blue band with a search box on
it; it is now a hero carrying the two questions people actually arrive with — a
phrase to search, and a parcel to find — over topic cards that show three article
titles each, a most-read and a recently-updated list, and a contact panel that
says whether support is answering right now (read from `widgetHours()`, so it
cannot disagree with the chat launcher beside it). Every block reads from the
knowledge base and hides itself when there is nothing in it. `/{locale}/track` is
new: a tracking number in, a status badge, a four-step progress line and the
knowledge-base answers for that status out. `noindex` and `Disallow`, and rate
limited per address, because every useful URL on it carries somebody's parcel
number.

**`.kb-shell` no longer carries the Freshdesk portal's hex.** It carries the
design system's `tokens/colors.css`, so the swap reaches every page under
`app/help/` rather than only the two the redesign covered — charcoal text on cool
neutrals, blu-500 as the one action colour, and the system's canonical logistics
status taxonomy behind the tracking badge, which is what gives "out for delivery"
violet of its own instead of sharing blue with "in transit". Typography did not
come across: the system substitutes Geist and Rubik and says so, while Lato and
Tajawal are the live portal's and the ones customers already read. Nor did radii,
spacing or its component bundle. Four of the six page types still wear the solid
blue band the system would not have given them — moving them is a change to their
layout rather than their colours, and it is the obvious next piece of work.

A **service notice** banner sits above the content on every help centre page,
from `KB_NOTICE_EN` / `KB_NOTICE_AR` / `KB_NOTICE_HREF` / `KB_NOTICE_TONE`. The
banner is built and its backing store is not: an environment variable is the
cheapest seam that still lets ops put a delay warning in front of every customer
without a deploy, and `lib/kb/notice.ts` is the one file a `service_notices`
table would change. Unset is no banner, deliberately — an operational claim about
the network has to be one somebody actually made. A notice written in only one
language is shown to everyone with its own `lang` and `dir` rather than withheld,
because the silent failure is an Arabic reader, who is the majority here, getting
no warning at all.

**The tracking page has nothing to show yet, and that is not a bug in the page.**
Nothing in this system writes `shipments.status_label` — the detector creates
stubs, and the platform sync that would fill them in is designed in
`plans/shipment-customer-tracking.md` §7 and not built. So every lookup today
lands on "no delivery status for this number yet" and offers support instead. The
page is written for both answers and starts working, with no change to it, on the
day that sync lands. Two things were deliberately left out of it against the
design that prompted the work: the recipient's name, address, phone and COD
amount behind a "confirm the last four digits" gate — a four-digit gate on a page
anyone can reload is a few thousand guesses, and the phone number it checks
against is the thing being protected — and a WhatsApp contact card, because no
public ShipBlu number exists anywhere in this codebase or its configuration and a
support channel printed on a help centre has to be one that answers.

And now **Instagram comment management**, which is the App Review item
`instagram_business_manage_comments` and which turned out to rest on four things
that were all broken at once. The comment pipeline had never run: of 2,854 Meta
deliveries stored since 19 August, **not one carries a `changes` entry**, because
`comments` is not a subscribed field on the `instagram` object — so
`ingestMetaComment`, merged with the channel in phase 2, has never been called in
production and `conversations` holds zero comment threads. Every comment call was
Facebook-shaped on both platforms, so no Instagram comment reply this system sent
could ever have been delivered. The console could not hide or delete a comment at
all — `hideComment` had sat unimported since the channel landed, and there was no
delete — which is to say the two verbs the permission is named for were the two
the product did not have. And Instagram's webhooks had stopped verifying that
morning; see §6.22, which is the one to read first. `subscribe_meta_webhooks`
now takes an object (`object=instagram` adds `comments`, `object=page` adds
`feed`) and still merges rather than replaces, an agent with the new
`ticket.moderate_comment` permission gets Hide / Unhide / Delete under a
customer's comment, and `plans/instagram-comment-management.md` carries the
order of operations — none of which is code, and the code is inert without it.

**The bot channel is live, and everything else is not.** This is the single most
important thing to understand about the current state, and the easiest to read
backwards.

`channels` holds exactly one row: `whatsapp_bot`. Through it, real traffic has
been arriving since 2026-08-18 — **10,716 conversations as of 2026-08-26**, still
around 1,500 a day. The database is not empty and the system is not idle.

But that channel is **read-only observation by design**. Another service owns
that number and holds the conversation; we receive a copy of both sides.
`lib/tickets/channel-policy.ts` marks it read-only _and_ restricted, excludes it
from "all channels" even for an admin, and keeps it out of the SLA sweep, the
time-based automations and every reporting metric. Nobody on the team works
those conversations. They are transcripts, not a queue.

Every human channel put together holds **30 conversations** — 22 Facebook, 3
email, 2 Instagram, 2 WhatsApp, 1 webchat. Email, WhatsApp and webchat are test
traffic from 18–21 August, but **Facebook and Instagram are not any more**: 105
inbound Messenger DMs and 4 Instagram ones from real people, the most recent
today, all of them filed under bare numeric ids and none of them answered by
anybody. That is not the channel being configured — no `channels` row exists for
either — it is the app being connected to a page and an account that the public
can already write to. There is still no email mailbox row, no human WhatsApp row,
no `webchat` row and no `portal` row. `sla_policies` and `automation_rules` are both still empty, so the
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

One project, two environments: `evm-da22su3l550s73b31n60` holds the web service,
the worker and all four crons, and `evm-da22vi8jo6nc73filkmg` holds staging.
That split has been real on Render since the services were created; `render.yaml`
only started describing it in the env-group change below, and before that
declared all seven services as one flat list.

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

**Any value that is the same on more than one service in an environment is
declared once, in that environment's group, and nowhere else.** There are three:

| Group                        | Scope        | Holds                                                              |
| ---------------------------- | ------------ | ------------------------------------------------------------------ |
| `shipblu-shared`             | workspace    | identical everywhere and harmless outside this system if wrong     |
| `shipblu-support-production` | `Production` | anything that can reach a real customer or the production database |
| `shipblu-support-staging`    | `Staging`    | staging's own database, and what stops it reaching anyone          |

Render gives service-level variables precedence over group values, so a key
declared in both places silently takes the service value. That cost us a
debugging session on `DATABASE_URL`. Two _groups_ linked by one service and both
declaring a key is the same trap with no precedence rule to settle it, so no key
appears in more than one group — `EMAIL_PROVIDER` is in `shipblu-support-production` and
`shipblu-support-staging`, which is safe only because no service links both.

Service-level entries now exist only as deliberate exceptions, each commented in
`render.yaml`: `EMAIL_WEBHOOK_SECRET` and the two `FRESHDESK_*` keys on the web
service, which have exactly one consumer each, and `APP_URL`, which is
per-service because the crons deliberately do not have it at all.

**`shipblu-shared` is workspace-scoped and cannot be moved into the project.** A
group scoped to a project environment cannot be linked to any service outside
it, and Render has no project-wide scope in between — a group belongs to one
environment or to the whole workspace. Services in both environments link this
one. `render.yaml` says so with `ungrouped`, which is the only way to state "no
environment" outright; a group left in a top-level `envVarGroups` list keeps
whatever scope it happens to have.

**A secret's value is never in the file, and neither is `sync: false` inside a
group** — Render's Blueprint reference does not accept it there, and a group
entry needs a literal value or `generateValue`. A literal would commit the
secret and `value: ''` would blank the live one on the next sync. So each group
lists its dashboard-owned keys as a comment beside its literal ones. The file
still names everything each group holds, which is the point of keeping it in the
repo. This is worth knowing before "fixing" the comments back into entries: the
old single group declared some twenty keys with `sync: false`, which the
reference says was never valid.

`META_PAGE_ACCESS_TOKEN` and the rest of the Meta set are in `shipblu-support-production`
rather than the shared group so staging cannot inherit them. Meta has no test
mode: a send from staging carrying a real page token arrives on a real
customer's phone. Staging used to blank the token with a service-level
`value: ''`, which worked but depended on somebody remembering to write the
override; not holding the credential at all is the same protection without the
vigilance. `pageToken()` in `lib/meta/client.ts` throws
`META_PAGE_ACCESS_TOKEN is not configured` on an unset value exactly as it did
on a blank one.

`APP_SECRET` stays in `shipblu-shared`, which means staging holds production's
email-reply signing key. Splitting it per environment would be tidier and is
deliberately not done: it regenerates production's value, and that invalidates
every reply token already sitting in a customer's mailbox. Staging sends no real
mail, so it mints no token anyone can reply to.

One family of keys is declared without being read by name: a connected WhatsApp
business account may carry its own access token, and its row names the variable
holding it. The name must start `WHATSAPP_TOKEN_` — enforced in
`lib/whatsapp/accounts.ts`, because the value is sent to Meta as a bearer token
and a free-text variable name would be a way to exfiltrate any secret in the
process. The value goes in `shipblu-support-production`; the key is listed in `render.yaml`
without it, in the same commit that names it on the account.

When you add a variable, add it to `render.yaml` in the same commit. The
blueprint is meant to describe the running system; it is not documentation that
drifts.

### The three-group split is not applied on Render yet

`render.yaml` describes it; the dashboard still has the single `shipblu-shared`
group and the old service-level entries. Nothing is broken in the meantime —
until somebody syncs the Blueprint the running config is exactly what it was —
but the file and the dashboard disagree until these run, **in this order**:

1. **Names are confirmed.** The project is `ShipBlu Support Platform` and its
   environments are `Production` and `Staging`, capitalised, as the dashboard
   has them. A Blueprint adopts a service by name and Render does not document
   what it does with a project or environment name matching nothing, so these
   three are worth re-reading before a sync rather than after.
2. **Sync the Blueprint.** It creates `shipblu-support-production` and `shipblu-support-staging`
   holding only `EMAIL_PROVIDER`, and links them. Nothing changes yet: every
   other value is still where it was, and service-level entries still win.
3. **Copy values in.** Each key listed in the `shipblu-support-production` comment moves from
   `shipblu-shared` into `shipblu-support-production`, same value. Staging's `DATABASE_URL`,
   `DATABASE_URL_SESSION`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` move
   off the staging service into `shipblu-support-staging`. Both copies existing at once
   is fine — they agree.
4. **Delete the moved keys from `shipblu-shared`.** Before step 5, not after.
   While the shared group still says `EMAIL_PROVIDER=postmark`, staging is held
   to `local` only by its service-level override; dropping that first would
   leave two linked groups disagreeing about whether staging sends real mail.
5. **Delete the redundant service-level entries:** `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` from web, worker and staging; `DATABASE_URL`,
   `DATABASE_URL_SESSION`, `EMAIL_PROVIDER` and `META_PAGE_ACCESS_TOKEN` from
   staging. Render _preserves_ a service-level variable the Blueprint stopped
   declaring, so none of these goes away on its own — and each one still shadows
   the group until it is removed by hand.
6. **Verify:** `/api/health` on production, and a staging boot. Staging is
   suspended, so that half needs a resume first.

Step 3 is also the pending `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` move the
old `render.yaml` described and never finished — the reason it was left was that
those keys held live values at service level, which is what steps 3 and 5
sequence around.

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
  Instagram account, and a `webchat` channel each still need a row.
  A WhatsApp row now also needs a **business account** to point at — Settings →
  Channels, "WhatsApp business accounts". Nothing has to be done by hand for the
  existing setup: the hourly template sync turns `WHATSAPP_WABA_ID` into the
  first connection and adopts the numbers and templates that already exist. The
  connection is what decides the token a reply sends with and which templates
  an agent may pick, so a second WABA is a row rather than a second deploy. See
  `plans/multiple-waba-connections.md`, and note the limit it states: every
  connected WABA has to sit under the same Meta app, because the app secret that
  verifies inbound webhooks is single-valued. The env vars
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
  from the presence stream and verified against a local Postgres, but the multi-tab
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
  outside 24 hours fails, which on a support channel is most of them. Check the
  dashboard before the channels are turned on, not after.

  **There are six dead `send_meta` rows now, not one.** The Instagram
  HUMAN_AGENT one from 2026-08-20, and five Facebook DMs on 23–24 August that
  failed _inside_ the 24-hour window, on the right page, in a thread this app
  holds control of — the case `insideWindowExplanation` was written for, which
  says in as many words that none of the usual causes applies. Six real customer
  replies that were never delivered. That is a second, unexplained refusal on
  the same channel and it has not been diagnosed; the trace ids are on the
  message rows.

- **Meta's Business Asset User Profile Access, which has never once been
  exercised.** The User Profile API is the only thing that can tell this system
  who a Messenger or Instagram customer is — their webhooks carry a scoped id and
  nothing else, unlike WhatsApp, which puts the profile name in the payload. As
  of 2026-08-26 that showed in the data exactly as you would expect: **all 20
  Facebook and both Instagram contacts had a null `name` and a null
  `display_name`**, against 13 of 10,211 on WhatsApp. 101 inbound Messenger DMs
  from 20 people, filed under bare 17-digit ids. The cause was not a missing
  approval — `fetchProfile` existed in `lib/meta/client.ts` and **nothing
  imported it**, so no profile call has ever left this system. Now wired: a
  `fetch_meta_profile` job per person on first sight, `backfill_meta_profiles`
  for the archive, and the picture copied into our own bucket because
  `profile_pic` is a signed CDN URL that expires.

  **Answered on 2026-08-27, and the answer is two different problems.** 16 real
  lookups ran and every one was refused, in two distinct ways, with nothing
  written: all 29 Meta identities still hold a null `profile_fetched_at`.

  - **Facebook: `(#3) Application does not have the capability to make this API
call.`** (HTTP 400, no subcode, e.g. trace `Atd8Vvy9gSxtvIvt-INHquE`). This
    is the approval answer — **Business Asset User Profile Access is not
    granted**, or the app holds only Standard rather than Advanced Access.
  - **Instagram: `(#100) The page is not linked to an Instagram account or the
linked IG account is not professional account`.** Not a permission problem
    and App Review will not fix it: the Page↔Instagram link, or an account that
    is personal rather than professional. Approval alone leaves Instagram exactly
    where it is, so this needs chasing separately.

  Note what that cost: `isProfilePermissionRefusal` was assembled from the docs
  and recognised `100/33`, `200` and `10` — **not code 3** — so for twelve
  Facebook refusals the sentence naming the feature never printed, which was the
  entire point of writing it. Both codes are handled now. The recovery path is
  unaffected and needs no re-run planning: a refusal deliberately does not stamp
  `profile_fetched_at`, so the next message from each customer re-asks and the
  archive repairs itself the moment the capability lands. `npm run job --
backfill_meta_profiles` is only needed for people who never write in again.

- **Instagram comment management, which cannot be exercised yet at all.** Three
  separate things gate it, in order, and none is code:
  1. `META_INSTAGRAM_APP_SECRET` in `shipblu-support-production`, or every
     Instagram delivery keeps being answered 403 (§6.26). Nothing about comments
     can be tested while inbound Instagram is rejected.
  2. `npm run job -- subscribe_meta_webhooks object=instagram`, to add the
     `comments` field. **Zero comment webhooks have ever arrived** — of 2,854
     Meta deliveries since 19 August, not one carries a `changes` entry — so
     `ingestMetaComment` has never run in production and there are no comment
     threads to look at.
  3. The App Review approval itself, which nothing has confirmed. Graph refuses
     an unapproved hide or delete with `100/33 "Unsupported post request"`, the
     same sentence it uses for a comment that is already gone;
     `explainMetaModerationError` names the permission in the failure so the two
     are not confused, which is the lesson from the two bullets above.

  Then: comment on the account's own post from another Instagram account, reply
  publicly from the console, hide it, unhide it, delete one. Each is a beat in
  the screencast App Review asks for, and each now writes a
  `comment_hidden` / `comment_unhidden` / `comment_deleted` event.
  `plans/instagram-comment-management.md` has the whole order of operations.

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

- **`contacts.locale` is never written, so every contact reads `'en'`.** All
  6,244 of them sit at the column default, and `lib/contacts/merge.ts` already
  documents why that is not the same as knowing: `'en'` means either "reads
  English" or "nobody has ever said". Anything that picks a language off it is
  answering an Arabic-first customer base in English — **CSAT surveys are doing
  that today** (`worker/handlers/send-csat.ts` reads the column directly). The
  out-of-hours reply works around it by reading the script of the customer's own
  message (`preferredLocale()` in `lib/auto-response/resolve.ts`), which is a
  workaround and not the fix. The fix is to set the column at ingest — the widget
  and the portal both know the locale from the URL they were opened on, and a
  WhatsApp or email contact can be read the same way the auto-response reads it.
- One imported article's detected language disagrees with its category. The
  importer counts and reports these rather than silently refiling them; someone
  who reads Arabic should look at it.
- ~~`logged_in` and `selected_companies` knowledge base articles are still not
  served.~~ Both are evaluated now. `publiclyVisible()` is gone; every query in
  `lib/kb/queries.ts` takes a `KbViewer`, resolved from the portal session by
  `kbViewer()`, and the rule itself lives in `lib/kb/visibility.ts`.

  **The viewer is a required argument, and that is the security design.** A
  missed call site is a compile error rather than an internal runbook in
  Google's index — there is no zero-argument predicate left to call by accident,
  so a query written next year cannot forget the rule. `tsc` found all fourteen
  call sites when the parameter was added.

  Two callers pass `ANONYMOUS` and always must:

  - **The sitemap.** `allPublishedArticles()` takes no viewer at all, so it
    cannot be handed a customer by someone being helpful. A `logged_in` article
    listed there would be advertised to the open web by the one file whose job
    is telling crawlers what to fetch.
  - **The widget's search.** The widget authenticates a _visitor_ — a token
    minted for a browser on somebody else's site — which is not the portal
    session that says who a customer is.

  **A folder's visibility gates the articles inside it**, so a public article in
  a `logged_in` folder needs a sign-in. The folder is what the navigation
  exposes; an article reachable by URL from a folder nobody can list is a hole
  in the hardest place to notice.

  This is only safe because every help centre page is `force-dynamic`. **A
  cached page that varied by viewer would serve one signed-in customer's render
  to an anonymous crawler** — if any of them is ever given a `revalidate` or made
  static, it has to stop calling `kbViewer()`. The comment on that function says
  so.

  `selected_companies` resolves against `contacts.company_id` against the
  article's `visible_to_company_ids`. It is **correctly evaluated but still
  serves nothing in practice**: neither the article editor nor the folder form
  offers that level, so the only source is the Freshdesk importer, and nothing
  populates `visible_to_company_ids` — an imported one has an empty allowlist,
  which matches nobody. Finishing it means a company picker in the editor and a
  mapping in the importer; until then the level is safe rather than useful.

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

  | Column                               | What it was for                                                   |
  | ------------------------------------ | ----------------------------------------------------------------- |
  | `kb_articles.visible_to_company_ids` | read by the visibility rule now; still written by nothing (above) |
  | `kb_folders.visible_to_company_ids`  | the same, at folder level                                         |
  | `conversations.parent_id`            | child tickets — nothing creates one, and no UI offers it          |
  | `messages.bcc_addresses`             | BCC on an outbound email; the composer has no field for it        |
  | `conversation_presence.is_typing`    | a typing indicator; the focus beat writes the row but not this    |

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

22. **A Messenger ticket can arrive on a page this app cannot answer, and Graph
    will not say so.** Ticket #6410 was a real "Testing" message that reached
    the inbox normally and whose reply failed three times with
    `code 1, "An unknown error has occurred."` and an HTTP 500 — the code
    `TRANSIENT_CODES` retries, so it burned every attempt and told the agent
    nothing. Two separate things were wrong and Graph answers both with that
    same sentence:

    - The message arrived on page `101449698657189`, while `FACEBOOK_PAGE_ID` is
      `955333171001884`. A page-scoped id is scoped to the page that issued it,
      so the recipient simply does not exist on the other page. Every Facebook
      message before it had come from the configured page, which is why this had
      never shown up.
    - Every event from that page arrives in the webhook's `standby` array, not
      `messaging`. That is Meta's handover protocol saying **another app holds
      thread control** — the echoes name it: `app_id` 576817601276249,
      `metadata: "freshchannel"`, so Freshchat is the primary receiver on that
      inbox and we are a secondary one. A secondary receiver may read the thread
      and may not send on it.

    The code made the second one invisible: `parseMetaWebhook` flattened
    `standby` into `messaging` and the distinction was gone one line into the
    system, so the ticket looked ordinary all the way to the composer. It is now
    carried as `standby` on the message's `meta` and both refusals are decided
    in `lib/meta/thread.ts` before a request is made — checked in the console so
    an agent is not invited to write, and again in the send job because thread
    control can move in between.

    **Neither is fixable in code.** Sending as `101449698657189` needs that
    page's own token, and sending at all needs Freshchat to hand thread control
    over. Until both are true, connecting a page to the Meta app produces
    readable tickets that cannot be answered — which is worth knowing before the
    next page is connected, because the tickets look completely normal.

23. **A debounce is not backpressure, and a global invalidation can freeze an
    I/O-bound service while CPU looks idle.** On 2026-08-25 the customer-bot
    channel was busy while one agent had the inbox open. Every message insert
    and every delivery-status update emitted the same `conversation_changed`
    notification to every console and widget. The console's 750 ms debounce
    started another full `router.refresh()` even when the previous server render
    had not completed, and rendering the thirty-row inbox re-armed automatic
    prefetches for its dynamic ticket links. One event stream therefore became
    a queue of overlapping list renders plus several detail renders each.

    Render showed the consequence rather than the cause: CPU peaked below 7%
    and memory below 220 MB, health checks and webhook writes stayed fast, but
    RSC responses remained open for up to 87 minutes and eventually returned
    502 when the instance was replaced. CPU autoscaling could not see a request
    and database-connection backlog dominated by waiting.

    The invariant is now structural. Queue notifications are semantic and split
    by channel; the restricted bot is absent from the default working queue.
    Ticket pages and widgets listen to a UUID-specific topic. Presence is a
    separate lightweight stream, so non-inbox pages hold no LISTEN connection.
    The browser allows one refresh transition at a time, collapses events during
    it into one trailing refresh with a cooldown, pauses while hidden, and the
    large inbox list disables automatic route prefetch. Do not replace any of
    those with a larger pool or instance: capacity can postpone unbounded fan-out
    but cannot make it bounded.

24. **`request.url` in a route handler names the address the server is bound
    to, not the `Host` it was asked for.** So `new URL('/login', request.url)`
    built `http://localhost:10000/login` on Render, and signing out dropped the
    agent on a dead address on their own machine. No proxy header corrects it:
    with `Host: support.shipblu.com` and `X-Forwarded-Host` both set, the
    handler still resolved to the internal listen address — only the _scheme_
    followed `X-Forwarded-Proto`, which is what makes the bug survive a casual
    look at the headers. Reach for `redirectTo()` in `lib/http/redirect.ts`
    instead: a relative `Location` is resolved by the browser against the URL it
    actually requested, so it is correct on the custom domain, the Render
    service URL and localhost alike. `proxy.ts` is not affected — middleware
    redirects go through `request.nextUrl`, which does carry the real host. The
    same trap was live in the legacy Freshdesk redirect, where it mattered more:
    a 301 is cached indefinitely, so each visitor would have remembered the
    internal address rather than merely failing once.
25. **A `next/font` variable is not one family, and its hidden half answers for
    every script.** `adjustFontFallback` (on by default) emits a metric-matched
    `local("Arial")` face — `Lato Fallback` — and splices it into the variable
    right behind its own family, so `--font-lato` is `"Lato", "Lato Fallback"`.
    That face declares no `unicode-range`, so it is a candidate for _every_
    codepoint. With `var(--font-lato)` leading the help centre stack it sat
    ahead of Tajawal, and every Arabic glyph on the Arabic-first site rendered
    in Arial on any machine that has Arial — all of Windows and macOS. It looked
    correct in development because a Linux container has no Arial, the face
    errored, and Arabic reached Tajawal by accident: the bug was invisible
    exactly where it would have been caught. **`adjustFontFallback: false` does
    not fix it** — Turbopack, the bundler both `next dev` and `next build` use
    here, accepts the option and ignores it (verified on 16.3.1 by renaming the
    variable and watching the rename land in the served CSS while the fallback
    stayed). The fix is ordering, in `.kb-shell`: name `Lato, Tajawal` before
    the variables that also contain them. Anything covering every codepoint goes
    after the script-specific family, never before it. Checking this needs
    `CSS.getPlatformFontsForNode` over CDP — a computed `font-family` shows the
    stack you asked for, never the font that painted — and, on Linux, a
    `@font-face` override standing in for the Arial the container lacks.
26. **One Meta app does not mean one app secret, and Instagram is the exception.**
    An Instagram professional account connected through **Instagram Login**
    rather than through its linked Facebook Page is a second identity inside the
    same app: its own access token, its own host (`graph.instagram.com`), and its
    own **Instagram app secret**, which is what signs the `instagram` object's
    webhook deliveries. Nothing in the payload says which secret was used — same
    object, same entry id, same `facebookexternalua`, same header shape — so the
    only symptom is `signature_verified = false`, which the endpoint answers 403
    and files as evidence. On **2026-08-26 at 07:37 UTC** the account was moved
    onto that setup and **every Instagram delivery from that minute failed
    verification: 2,309 in thirteen hours, 100% of them**, while Facebook's 111
    deliveries over the same hours kept verifying against the unchanged
    `META_APP_SECRET`. Real customers' messages were dropped — the last before
    this was written is an Arabic question about how the service works — and
    **nothing alerted, because a rejected forgery and a rejected genuine delivery
    were the same event**. Three things changed as a result: the secret is now
    chosen from the payload's own `object` and both candidates are tried
    (`lib/meta/signing.ts`); the reason is written to `webhook_events.error`, so
    the query that finds this is `select error, count(*) from webhook_events
where not signature_verified group by 1` rather than a log line nobody was
    reading; and `META_INSTAGRAM_APP_SECRET` / `INSTAGRAM_ACCESS_TOKEN` exist as
    an optional pair, unset meaning exactly the old behaviour. **The 2,309 are
    not recoverable**: only the parsed payload is stored, not the raw bytes, so
    their signatures can never be re-checked against the right secret — which is
    the argument for keeping the raw body on an unverified delivery, and the
    reason the App Review permission's own name (`instagram_business_*` rather
    than `instagram_*`) is worth reading as a statement about which setup an app
    is on.

    **Update, 2026-08-27 01:15 UTC — Instagram Login is no longer the leading
    explanation, and the outage is still live.** `META_INSTAGRAM_APP_SECRET` has
    since been set, and the new diagnostic reports, on all 495 deliveries since
    the deploy went live at 21:50:52:

    `signature did not match META_INSTAGRAM_APP_SECRET or META_APP_SECRET`

    That sentence names a candidate only when its value is set and non-empty
    (`signingCandidates` in `lib/meta/signing.ts`, and identical values are
    deduplicated to one name), so it is proof that **both secrets are configured
    and neither one signed these payloads**. 2,981 rejected and counting, 19
    hours in. Two explanations survive, and they are not the same problem:

    - The value pasted into `META_INSTAGRAM_APP_SECRET` is not the Instagram app
      secret — the wrong field copied out of the dashboard (the Instagram app
      _id_, a client token) or a stale one.
    - **The deliveries are signed by a Meta app we hold no secret for at all** —
      i.e. somebody created a _second_ app for the Instagram Login setup and
      pointed its webhook at this callback URL, rather than adding the use case
      to the existing one. This would be the bigger finding: `META_APP_ID` would
      then name the wrong app, `subscribe_meta_webhooks` would be reading and
      writing the wrong app's field list, and **App Review would have to be
      submitted on the app that actually owns the account**, which is a different
      question from which permission to submit.

    `npm run job -- subscribe_meta_webhooks object=instagram` tells the two
    apart, and reads before it writes, so it is safe to run for the answer
    alone: "This app has no instagram subscription" means the deliveries belong
    to another app, and a reported callback URL and field list means they belong
    to this one and the secret is simply wrong.

    The lesson underneath both is the one that has not been fixed: **nothing
    alerts on this.** The reason is on the row now, which is how the paragraph
    above got written, but it still took a person running a query at one in the
    morning. A rejected-delivery count belongs somewhere a human sees without
    asking; nobody has decided where.

    **Resolved 2026-08-27 01:29:01 UTC.** A credential was corrected at 01:26
    and the `service_updated` deploy carrying it went live at 01:29:22;
    Instagram deliveries verified from that minute on, and the ones since are
    all processed into tickets — `conversations` on that channel went from 2 to
    4 within the hour. **Final tally: 3,044 deliveries rejected over 17 hours
    and 52 minutes**, from 07:37:39 on the 26th to 01:29:01 on the 27th, of
    which 1,736 carried a message. None is recoverable.

    **What the fix does not tell us is which configuration we are now on**, and
    that is the gap worth reading twice. A corrected Instagram app secret and an
    account moved back onto its Facebook Page produce the identical
    `signature_verified = true` — and they are different setups with different
    App Review permissions. The verification path knew which candidate matched
    and threw it away, on the reasoning that logging it was marginal. It was not
    marginal: it was the one fact the App Review submission hangs on, discarded
    at the moment it became knowable. `noteVerifyingSecret` now names the
    matching secret in the web log once per instance, and again if it ever
    changes, so the next deployment of this answers it without anybody
    reconstructing it from a deploy timeline.

    **And the answer, read at 02:38 UTC, is "both".** Instagram deliveries
    verify against `META_INSTAGRAM_APP_SECRET` _and_ `META_APP_SECRET`,
    alternating within seconds on one web instance, and the split is by
    envelope: 9 `messaging` deliveries and 5 `standby` ones in the same burst.
    Two credentials, one Instagram account, both live. Either the account is
    connected through Instagram Login _and_ through its linked Facebook Page on
    the same app — one app holds both secrets, and that is what the Instagram
    Login setup is — or two apps are subscribed and both point here. Nothing
    visible from this side separates those.

    Three consequences, none of them optional:

    - **Neither secret can be removed.** Dropping either resumes 403s for that
      half of the traffic. `signingCandidates` trying both is not belt and
      braces here; it is load-bearing.
    - **Something else holds thread control.** `standby` is the handover
      protocol saying so, which is the condition `lib/meta/thread.ts` already
      refuses sends for — and a plausible reading of the six dead `send_meta`
      rows in §5.2, five of which failed _inside_ the window with Graph naming
      no cause. Worth checking before blaming Human Agent.
    - **The App Review answer is no longer "pick the name that matches the
      connection"**, because two connections are live. Which permission to
      submit depends on which of them the helpdesk is meant to be, and that is a
      decision nobody has made — see `plans/instagram-comment-management.md`.

    It also broke the notice that found it. Keyed on the secret alone and
    re-announcing on change, it logged a line per delivery once the two started
    alternating — the exact noise the once-only design existed to prevent, from
    an assumption ("a signing secret changes on the order of never") that was
    false within the hour. It is keyed on secret _and_ envelope now, which bounds
    it at a handful of lines and makes the pair — which credential signs which
    channel — the thing it reports.

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
- **Multiple WABA connections, against a local Postgres 16.** Migration 0011 and
  the `db/sql/` replay both applied clean, and RLS came out enabled and not
  forced on `whatsapp_accounts`. A legacy null-account template upserted onto
  itself rather than duplicating, which is the `NULLS NOT DISTINCT` case the
  constraint exists for; two accounts each kept their own `shipment_update` with
  independent statuses; marking one account's templates stale left the other's
  untouched. `phone number → account` resolved through `channels` with the
  default account as the fallback, disconnecting an account cascaded its
  templates while leaving its channel rows intact, and
  `ensureEnvironmentAccount` adopted a single-WABA install — numbers and
  templates — idempotently. Not yet exercised against a real second WABA: no
  second business account exists to connect.
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
