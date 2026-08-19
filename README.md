# ShipBlu Support

A self-hosted replacement for Freshdesk + Freshchat: email ticketing, WhatsApp,
Facebook and Instagram, a web chat widget, and a bilingual knowledge base.

**Status: phases 0–4 complete, plus the customer portal.** Foundation and job queue;
email ticketing; WhatsApp; the agent console; the bilingual knowledge base, Freshdesk
import and chat widget; SLA policies, automation rules, CSAT and reporting; Facebook and
Instagram — direct messages and public comments — with admin screens for every piece of
configuration; and a signed-in customer portal behind one sign-in shared with the
console.

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
