# ShipBlu Support

A self-hosted replacement for Freshdesk + Freshchat: email ticketing, WhatsApp, and
(in later phases) Facebook/Instagram, a web chat widget, and a bilingual knowledge base.

**Status: Phase 0 complete** — foundation, schema, auth primitives, job queue and worker.
Phase 1 (email ticketing) and Phase 2 (WhatsApp) are next.

## Architecture

One Next.js app plus a background worker, both on Render in **Frankfurt**, against a
Supabase Postgres project in **eu-central-1**. Colocation is deliberate: a console page
issues 10–30 queries, so app↔database round trips dominate page latency.

```
Meta Cloud API ──webhook──┐                    ┌──▶ Supabase Postgres
Email provider ──webhook──┼──▶ Next.js web ────┤
Agent browsers ──SSE──────┘                    └──▶ Supabase Storage
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
- **One `conversations` table** with a `channel` discriminator backs both the
  Freshdesk-style ticket list and the Freshchat-style inbox. `contact_identities` maps
  one customer across email, WhatsApp and later social IDs.

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
