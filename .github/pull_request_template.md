<!--
Keep this short. The diff already says what changed; this says why, and what you
did to believe it works. Delete any section that does not apply — an empty
heading is worse than no heading.
-->

## What and why

<!--
One or two sentences on the problem, then the approach. If a reviewer would ask
"why not the obvious way?", answer it here: the trade-off taken and what the
naive alternative would have broken. That reasoning is what this repo keeps.
-->

## How it was verified

<!--
Not "tests pass" — what you actually exercised, and against what. A query you
ran, a log line, a round trip you watched, the local Postgres you drove it
against. Say plainly what you could NOT verify (a live provider, a real
forwarding list, an origin that is not localhost).
-->

- [ ] `npm run typecheck && npm run lint && npm run test && npm run build`
- [ ] A test covers this where the bug would actually hide, or there is nothing
      to test and the description says why

## Deploy and rollback

<!-- Delete this whole section if the change is code only: no migration, no
`db/sql/`, no env var, no Render or Supabase config. -->

- [ ] Migration is safe against the version currently running — it applies in
      `preDeployCommand`, before traffic shifts, so the old code meets the new schema
- [ ] `db/sql/` additions are idempotent, take no lock in the steady state, and
      use no `CREATE INDEX CONCURRENTLY`
- [ ] New tables end up with RLS enabled by the loop in `db/sql/`, never `FORCE`
- [ ] New env vars are in `lib/env.ts` **and** `render.yaml` in this PR, values
      only in Render — `shipblu-support-production` / `shipblu-support-staging` if the value differs by
      environment or can reach a customer, `shipblu-support-shared` if it genuinely does
      not, per-service only as a deliberate exception
- [ ] Rollback: <!-- what undoes this if the deploy goes wrong -->

## Risk

- [ ] No secrets, tokens or connection strings in the diff or the description
- [ ] Attacker-controlled HTML (email, imported KB) is sanitised on write
- [ ] Nothing here widens what an unauthenticated or unauthorised caller can reach

## Alongside other agents

- [ ] Rebased on current `origin/main`, and `git log --oneline -30 origin/main`
      shows nobody else has already fixed this
- [ ] `AGENTS.md` / `docs/PROJECT-STATE.md` updated if this changed a convention,
      a command, or added a trap worth warning the next session about

## Left out

<!-- Anything deliberately not done here, and where it is recorded. "Nothing" is
a fine answer; a follow-up nobody wrote down is not. -->
