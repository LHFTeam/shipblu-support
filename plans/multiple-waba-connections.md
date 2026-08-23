# More than one WhatsApp Business Account

## Context

WhatsApp was wired up as a singleton. `WHATSAPP_WABA_ID` named the one business
account, `WHATSAPP_PHONE_NUMBER_ID` the one number to fall back to, and
`META_PAGE_ACCESS_TOKEN` the one credential that reached both. Connecting a
second WABA — a second country, a second brand, a number that belongs to another
business entity — meant running a second copy of the whole app.

The `channels` table was already most of the way to multi-number: inbound events
have always been routed to a channel by `phone_number_id`, and
`resolveWhatsAppChannel` reads that from the table rather than from a constant.
What was missing is everything _above_ the number. Meta scopes three things to
the business account, not to the number and not to the app:

- **the access token** — a system-user token reaches the WABAs its app is
  installed on, and nothing else;
- **message templates** — approved per WABA, so the same `shipment_update` can
  exist on two accounts with different text and be approved on one and rejected
  on the other;
- **media ids** — exchangeable only with a credential that reaches the account
  whose number received them.

So the unit this adds is a **connection**: one row per WABA, holding ids and the
_name_ of the variable its token lives in.

## What is deliberately not in scope

**A WABA under a different Meta app.** `META_APP_SECRET` verifies
`X-Hub-Signature-256` on every inbound webhook and `META_VERIFY_TOKEN` answers
every subscription handshake, and both belong to the app rather than to the
business account. A WABA on a second app would have its messages stored
unverified and answered 403 — which reads, in the log, exactly like a forgery.

That limit is stated on the admin screen and in `lib/whatsapp/accounts.ts`
rather than being papered over, because the alternative is worse: making the app
secret per-account means trying each configured secret against every inbound
signature, which turns "this matches or it is a forgery" into a search.

The case this is built for is the one people actually have — one Meta app
installed on several WABAs in the same Business Manager, one webhook, and either
one system-user token for all of them or a separate token per account.

## The shape

```
whatsapp_accounts  ──1:N──  channels (whatsapp | whatsapp_bot)   one row per number
        │
        └──────────1:N──── whatsapp_templates                    scoped, not global
```

`whatsapp_accounts` holds `name`, `waba_id`, `token_env_var`, `is_default`,
`is_active`, and the outcome of the last template sync.

**The token is named, never stored.** `token_env_var` holds the _name_ of an
environment variable — the same rule the channels table already follows, so a
database dump still contains no usable credential. Null means the shared
`META_PAGE_ACCESS_TOKEN`, which is the right answer whenever the accounts sit
under one app.

The name is constrained to `WHATSAPP_TOKEN_*` by `parseTokenEnvVar`, and that
constraint is load-bearing rather than tidy: the value is sent to Meta as a
bearer token, so an admin free to type any name could put `DATABASE_URL` in the
box and have it posted to graph.facebook.com — and they never see the value, so
nothing on screen would look wrong afterwards.

## Resolution, in one place

Every WABA-scoped decision goes through `lib/whatsapp/accounts.ts`:

```
phone number id  →  channels row  →  whatsapp_account  →  token, waba id
                                      ↓ falls back to
                                     the default account
                                      ↓ falls back to
                                     the environment
```

`resolveAccount` is pure and tested, because the order is the part worth being
sure about. One case in it is counter-intuitive: **a number linked to an account
keeps using that account even when the account is switched off.** Falling
through to the default would send the reply from a business account the customer
has never messaged, and Meta rejects that asynchronously, on a status webhook,
after the send API has already returned a message id. "Nothing went out" is a
failure somebody sees. "It went out from the wrong WABA" is not.

`lib/whatsapp/conversation.ts` holds `sendingNumberFor`, shared by the console
and the worker on purpose. The console decides which templates an agent may
pick; the worker decides which credential the send goes out with. If those two
resolved the number differently the disagreement would be invisible until Meta
rejected the message.

## Templates are per account

`whatsapp_templates` gains `whatsapp_account_id`, and the unique key becomes
`(account, name, language)` — the triple a send actually references. Two things
fall out of that:

- The sync's "mark what I did not refresh as DELETED" filter has to be scoped to
  the account just synced. Unscoped, syncing the second account marks every
  template of the first as deleted, because they were not refreshed by _that_
  call.
- The console's picker and `sendTemplateReply` both scope to the ticket's
  account. The action re-checks server-side, because the template id arrives in
  a `FormData` field.

The column is nullable, for rows written before accounts existed, and the
constraint is `NULLS NOT DISTINCT`. Without that, postgres treats every legacy
row as unique, the upsert's conflict target matches nothing, and each hourly
sync inserts a fresh duplicate of every template.

## The upgrade path

`ensureEnvironmentAccount()` runs at the top of the hourly template sync. On its
first run it turns `WHATSAPP_WABA_ID` into a row and adopts the numbers and
templates that already exist — every one of which belonged to that WABA by
definition, because there was no other one to belong to.

Adoption happens only when the row is _created_. Re-running it later would sweep
up rows an admin deliberately left unassigned; instead, `saveChannel` requires a
business account on a WhatsApp channel once any account exists, so an unset link
means "configured before there were accounts" and nothing else.

The admin screen offers the environment's WABA id as a starting value when no
row uses it yet, so the same thing can happen an hour sooner without anyone
retyping an id the system is already configured with.

## Verified

Against a local Postgres 16, with the migration applied by `npm run db:migrate`:

- a legacy null-account template upserts onto itself rather than duplicating
  (the `NULLS NOT DISTINCT` case);
- two accounts each hold their own `shipment_update` with independent statuses;
- marking one account's templates stale leaves the other's untouched;
- `phone number → account` resolves through `channels`, with the default account
  as the fallback for an unknown number;
- disconnecting an account cascades its templates and detaches its numbers,
  leaving the channel rows — and the ticket history anchored to them — intact;
- `ensureEnvironmentAccount` adopts an existing single-WABA install, links its
  numbers and templates, and is idempotent;
- RLS is enabled and not forced on the new table.
