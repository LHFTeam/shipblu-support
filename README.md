# ShipBlu Support

A self-hosted replacement for Freshdesk + Freshchat: email ticketing, WhatsApp,
Facebook and Instagram, a web chat widget, and a bilingual knowledge base.

**Status: phases 0–4 complete, plus the customer portal.** Foundation and job queue;
email ticketing; WhatsApp; the agent console; the bilingual knowledge base, Freshdesk
import and chat widget; SLA policies, automation rules, CSAT and reporting; Facebook and
Instagram — direct messages and public comments — with admin screens for every piece of
configuration and a live dashboard at `/admin/dashboard`; and a signed-in customer portal
behind one sign-in shared with the console.

## Architecture

One Next.js app plus a background worker, both on Render in **Frankfurt**, against a
Supabase Postgres project in **eu-central-1**. Colocation is deliberate: a console page
issues 10–30 queries, so app↔database round trips dominate page latency.

```
WhatsApp Cloud ──webhook──┐                    ┌──▶ Supabase Postgres
Messenger / IG ──webhook──┼──▶ Next.js web ────┤
Email provider ──webhook──┤                    └──▶ Supabase Storage
Agent browsers ──SSE──────┘
                                    │
                             jobs (Postgres queue)
                                    ▼
                          Background worker ──▶ Meta / email provider
                                    ▲
                            Render Cron Jobs
```

Design decisions worth knowing before changing things:

- **Webhooks persist, then return 200 immediately.** Inbound requests write to
  `webhook_events` and hand off to the worker. Meta retries aggressively on slow
  responses, so this decoupling is what makes ingestion reliable — and it doubles as
  replay and audit capability.
- **No Redis.** Postgres `LISTEN/NOTIFY` fans out to every web instance natively (so SSE
  works across autoscaled instances), and the job queue uses `FOR UPDATE SKIP LOCKED`.
  At 30 agents this is strictly simpler with no loss.
- **Two database connections.** Normal queries go through Supavisor's _transaction_
  pooler (prepared statements disabled — the pooler multiplexes backends). `LISTEN`
  needs a _session_ connection, which `sessionSql()` opens separately.
- **Server-side sessions, not JWTs.** Deactivating an agent takes effect on their next
  request. Only a SHA-256 of each token is stored. Customers get their own table and
  their own cookie, so a colleague who also emails support can hold both at once and
  neither population's session can be mistaken for the other's.
- **One sign-in for customers and agents.** The Sign in button on the help centre and the
  console's own `/login` run the same check: agents are looked up first and never fall
  through, so a staff address that is also a contact always reaches the console. Nobody is
  asked to say which kind of account they have.
- **Portal credentials hang off the verified email identity, not the contact.** A password
  proves control of one address, which is exactly what `contact_identities` already
  modelled — and its `is_verified` flag is what makes the password inert until the customer
  opens the link we emailed. Anyone can type anyone's address into the registration form;
  that is why registering against an already-verified address sends a _reset_ link rather
  than replacing the password.
- **The front door is the Arabic help centre.** `/` lands on `/ar` on every hostname. The
  console used to own the bare domain, which made the public site something you had to
  already know the URL of.
- **The help centre has its own palette and its own typefaces**, scoped to `.kb-shell` in
  `app/globals.css`. The light values are the hex from the live Freshdesk portal theme and
  the fonts are its Lato/Tajawal pairing, so the cutover is not also a redesign as far as a
  returning customer is concerned. The console's token names are redefined inside that
  scope, which is how the shared primitives in `components/ui.tsx` pick up help-centre
  colours without a second set of components. Page furniture — the blue band, the trail,
  the card, the article list — lives in `app/help/[locale]/chrome.tsx`; adding a public page
  means composing those, not restyling one.
- **One condition language for SLA policies and automation rules.** Both store the same
  `conditions` jsonb and go through `lib/rules`, so a condition written for one reads the
  same in the other. A malformed condition never matches, so a corrupt policy cannot
  become the one that applies to everything.
- **SLA clocks are measured in working time**, not wall-clock, and a status flagged
  `stops_sla_clock` pauses them — recorded as a conversation event, so the timeline
  explains why a due date moved. Breaches are found by a five-minute sweep that re-reads
  current due dates rather than by a timer per ticket, because due dates move.
- **Business hours are global with a per-group override.** One schedule is the company
  default; a group can be put on its own, which brings its timezone, operating days _and_
  holiday list with it, because all three live on the same `business_hours` row. SLA due
  dates, the breach sweep, the nightly rollup and the chat widget all resolve a ticket's
  calendar through `lib/hours/resolve.ts`, so a due date and the report measuring it never
  disagree about which hours counted. Moving a ticket to a group that works different days
  re-counts its live due dates on the new calendar. An SLA policy can opt out of the group
  override by naming one schedule, or out of business hours entirely (round the clock).
- **Automations never trigger automations.** Rule actions write to the ticket directly
  instead of re-entering the engine, which is what stops two rules from triggering each
  other forever.
- **Reporting reads only `metrics_daily`.** The nightly rollup stores four slices per day
  — totals, by group, by agent, by channel — so the reports page never aggregates over
  the full message history, and today's figures appear tomorrow.
- **The live dashboard and the nightly rollup share one definition of a day.**
  `lib/reports/rollup` computes a day's figures; the worker stores what it returns and
  the dashboard runs it against today and throws the result away. "Resolved today" on
  the dashboard and "resolved" in tomorrow's report are therefore the same measurement,
  working-hours response times included, rather than two definitions that drift.
  Everything else on that page is a live read bounded to the open backlog — the queue,
  who is holding what, what is about to breach — because a page that refreshes itself
  every twenty seconds must never run an aggregate over the archive.
- **Social messages and comments thread differently.** A Facebook or Instagram DM
  threads on the customer, like WhatsApp — one live ticket per person per platform. A
  comment threads on the root of its reply chain, so a customer commenting on two posts
  gets two tickets, each needing its own public answer. Meta echoes our own outbound
  messages back to us, and dropping those is what stops an agent replying to themselves.
- **Configuration is validated by the engines that consume it.** The admin screens parse
  conditions and actions with `lib/rules` and `lib/automations` before storing them, so a
  rule that saves is a rule that will run rather than one the sweep silently ignores.
- **One `conversations` table** with a `channel` discriminator backs both the
  Freshdesk-style ticket list and the Freshchat-style inbox. `contact_identities` maps
  one customer across email, WhatsApp and the social platforms.
- **A merged contact is a tombstone, not a deletion.** Duplicates are the normal state
  of a support database — `resolveContact()` creates a record per channel identity,
  because nothing proves at arrival time that two addresses are one human. Merging moves
  the identities, tickets, messages, account memberships and parcel roles to the
  survivor, then keeps the loser's row with `merged_into_contact_id` set, so
  `/contacts/<old-id>` still redirects to the person. Hard-deleting it would take its
  `(source_system, external_id)` with it and the next importer run would recreate the
  duplicate. A merge fills the survivor's blanks and overwrites nothing: being told two
  records are one person is not being told which name is right. `is_blocked` never
  moves in either direction, because blocking is a decision about a record rather than
  a fact about a person.
- **Locations are a register, and side conversations are its first consumer.** ShipBlu's
  sixteen hubs each have a name, a unique code and a shared mailbox. They were entered
  before anything used them precisely so that whichever feature landed first would point
  at a real row instead of a hub name typed sixteen different ways — and the side
  conversation picker is that feature. Still nothing else routes on a location: no agent
  carries one, no ticket is attributed to one. The email remains on the record rather
  than in the mail path — an agent picks it, nothing delivers a customer's reply there.
- **Side conversations are their own tables, not `conversations` rows.** A thread with
  a hub has no requester, no SLA and no customer-facing anything, and reusing
  `conversations` would mean excluding it from the inbox query, the counts, reporting,
  the sweep, the portal and the widget — a rule enforced in nine of ten places after
  the next change. Separate tables make the invariant structural: a query that does not
  name `side_conversation_messages` cannot return one. The other half is that
  `conversations.requester_contact_id` is `NOT NULL`, so the shortcut would write hub
  employees into the customer table.
- **A hub is a location; a vendor is not.** The picker reads two directories and keeps
  them apart rather than copying one into the other. `locations` is the register of
  places ShipBlu works out of, and it already exists; `internal_recipients` holds the
  parties that are not places — Finance, a courier partner. `side_conversations` carries
  a `location_id` **or** a `recipient_id`, never both, enforced by a CHECK. A single
  merged table would have meant maintaining a hub's address in two screens, which is the
  failure `locations` was created to prevent.

### Contacts, not customers

The console section is `/contacts` and everything in it says contact, matching the table
name it has always had. "Customer" is kept for the person on the other end of a ticket —
the customer portal, `last_customer_message_at`, a status's `customer_label`. A contact is
a row; a customer is who writes in.

## Local development

Requires Node 22.

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL at minimum
npm run db:migrate             # drizzle migrations + db/sql/*.sql
npm run dev                    # web app
npm run worker:dev             # queue consumer, separate terminal
```

Run a scheduled job by hand:

```bash
npm run job -- cleanup
```

### A note on `NODE_ENV`

`npm run build` pins `NODE_ENV=production`. Next resolves React's build through export
conditions keyed on `NODE_ENV`, and building with `NODE_ENV=development` fails during
prerender with a confusing `Cannot read properties of null (reading 'useContext')`. If
you see that error, check your environment rather than your React version.

## Commands

| Command                              | Purpose                                  |
| ------------------------------------ | ---------------------------------------- |
| `npm run dev`                        | Next dev server                          |
| `npm run worker`                     | Background queue consumer                |
| `npm run job -- <type>`              | Run one job (used by Render cron)        |
| `npm run db:generate`                | Generate a migration from schema changes |
| `npm run db:migrate`                 | Apply migrations + post-migration SQL    |
| `npm run test`                       | Unit tests                               |
| `npm run lint` / `npm run typecheck` | Static checks                            |

## Database

Schema lives in `db/schema/` (Drizzle) and generated migrations in `db/migrations/`.

`db/sql/` holds everything Drizzle's DSL cannot express — extensions, trigram indexes,
`updated_at` triggers, and the `NOTIFY` triggers behind SSE. Every statement there is
idempotent and replayed after each migration, so **never hand-edit generated migration
files**; put database-level behaviour in `db/sql/` instead.

### Search

Postgres has no Arabic text-search configuration, so `tsvector` columns use the `simple`
config and are paired with `pg_trgm` indexes for fuzzy and substring matching. Query
those with `word_similarity` (`'query' <% column`) or `ILIKE` — **not** the plain `%`
operator, which compares whole strings and will match nothing for short queries against
long text.

The inbox search also takes two prefixes, `track:` and `sbid:` (with `tracking:`, `awb:`
and `account:` as aliases). A prefix **narrows** the search to that one clause rather
than adding to the others, which is what makes it worth typing: `track:SB123456789`
becomes a single probe of the unique index on `shipments.tracking_number` instead of a
query that still considers every message body. An unprefixed query that is exactly one
reference sets the same field without narrowing, so the usual clauses still run.

What those clauses add over the existing body-text search is every ticket that is
_about_ a shipment rather than one that quotes it — the follow-up reply, the one an agent
linked by hand, the one where the number appeared only in a private note. The SBID clause
has a second branch for the same reason: a merchant's tickets almost never mention their
own account number.

Both the prefixes and the automatic linking go through one detector,
`lib/shipments/detect.ts`. Its patterns are a **conservative guess** — the real ShipBlu
formats were not settled when this landed — and are overridable per environment with
`SHIPMENT_TRACKING_PATTERN`, `SHIPMENT_SBID_PATTERN` and `SHIPMENT_IGNORE`. Correcting a
pattern only affects new messages; run the shipment backfill from `/admin/import` to
reach history.

## Side conversations

Answering a ticket usually means asking somebody else first. The parcel is late, it is
in the Downtown hub, and the answer the recipient wants is not in this system — so the
agent emails the hub's forwarding list, and whoever is on shift replies with what
actually happened.

A **side conversation** is that exchange, hanging off the ticket. The term is the one
the field uses: Zendesk ships the feature under that name; Freshworks calls its
equivalent a _forward thread_ and anchors each one to a message in the ticket, which is
the idea borrowed here as `side_conversations.anchor_message_id`.

```
/inbox/<number>              the thread appears as a card in the timeline, in
                             chronological order among the messages
/admin/locations             the hubs and warehouses the picker offers
/admin/recipients            the teams and vendors it offers alongside them
```

- **The recipient comes from a directory**, not a text box. `hub-downton@shipblu.com`
  is a live domain somebody else could own, and the mail carries a customer's name,
  address and complaint. A free-text address is still allowed, and every address is
  checked against the requester's own identities and our support mailbox before it is
  accepted — in the server action, not only in the composer.
- **The picker reads two registers and keeps them apart.** Hubs and warehouses are
  `locations` rows; Finance and a courier partner are `internal_recipients`. An agent
  sees one list with three group headings and never has to know which table a name
  lives in. `side_conversations` carries a `location_id` **or** a `recipient_id`, never
  both, and the chosen row's address is re-read server-side rather than trusted from a
  form field — otherwise the picker is a text box wearing a dropdown.
- **Replies thread on an `s`-prefixed token**, `support+s4.<sig>@`, resolved _before_
  `resolveContact` in `lib/tickets/ingest.ts`. That ordering is the guarantee a hub
  employee never lands in `contacts`. The HMAC is domain-separated — the signed input
  is `side:4`, never `4` — so a customer holding their own ticket's reply address
  cannot reach an internal thread by editing one character.
- **Nothing downstream of a ticket fires.** No SLA clock, no automation, no CSAT. The
  only column touched on `conversations` is `last_message_at`, so the ticket floats
  back up the inbox when the answer lands; `last_customer_message_at` and
  `last_agent_message_at` drive the messaging windows and the SLA and are left alone.
- **The SLA is not paused.** Starting a thread offers to set the ticket to Pending and
  otherwise does nothing, because a clock stopped behind a thread the customer cannot
  see makes the report stop describing what the customer experienced.

## The customer portal

A customer who has ever emailed or messaged support already exists in `contacts` and
`contact_identities`. Registering does not create them — it attaches a password to the
identity they already have, which is why their existing tickets are there the first time
they sign in.

```
/ar                        help centre home (the bare domain redirects here)
/ar/account/login          one form: agents go to /inbox, customers to /ar/portal
/ar/account/register       sets a pending password, emails a 24-hour confirmation link
/ar/account/forgot         emails a one-hour, single-use reset link
/ar/portal                 the customer's tickets, across every channel
/ar/portal/t/<number>      the thread, and a reply box
/ar/portal/new             opens a ticket on the `portal` channel
```

A portal reply is recorded as an **inbound** message whatever channel the ticket arrived
on: the customer said it, so it reopens a resolved ticket and moves the SLA clock exactly
as an emailed reply would. Agents still answer over the ticket's own channel.

Private notes are excluded in the query rather than filtered in the renderer, and every
portal query is scoped by the contact id from the session cookie — a ticket number is
guessable, so the number is never looked up on its own.

Verification and reset links are sent by the `send_notification_email` job, which is the
only outbound mail in the system that does not belong to a conversation.

`logged_in` and `selected_companies` knowledge base articles are still not served: the
public KB queries do not yet take the viewer into account, and an unevaluated visibility
rule is treated as deny.

## Deployment

`render.yaml` is a Render Blueprint defining the web service, worker, staging service and
four cron jobs. Secrets are marked `sync: false` and set in the Render dashboard — they
are deliberately not committed.

Migrations run automatically via `preDeployCommand` before traffic shifts.
