# ShipBlu Support

A self-hosted replacement for Freshdesk + Freshchat: email ticketing, WhatsApp,
Facebook and Instagram, a web chat widget, and a bilingual knowledge base.

**Status: phases 0–4 complete.** Foundation and job queue; email ticketing; WhatsApp;
the agent console; the bilingual knowledge base, Freshdesk import and chat widget; SLA
policies, automation rules, CSAT and reporting; and Facebook and Instagram — direct
messages and public comments — with admin screens for every piece of configuration.

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
  request. Only a SHA-256 of each token is stored.
- **One condition language for SLA policies and automation rules.** Both store the same
  `conditions` jsonb and go through `lib/rules`, so a condition written for one reads the
  same in the other. A malformed condition never matches, so a corrupt policy cannot
  become the one that applies to everything.
- **SLA clocks are measured in working time**, not wall-clock, and a status flagged
  `stops_sla_clock` pauses them — recorded as a conversation event, so the timeline
  explains why a due date moved. Breaches are found by a five-minute sweep that re-reads
  current due dates rather than by a timer per ticket, because due dates move.
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

## Deployment

`render.yaml` is a Render Blueprint defining the web service, worker, staging service and
four cron jobs. Secrets are marked `sync: false` and set in the Render dashboard — they
are deliberately not committed.

Migrations run automatically via `preDeployCommand` before traffic shifts.
