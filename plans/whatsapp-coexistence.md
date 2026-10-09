# Onboard a WhatsApp Business-app number (Coexistence) from Admin → Channels

## Context

Today a WhatsApp number reaches the helpdesk only as a Cloud-API-only number: an
admin types a WABA id and a phone number id into two forms
(`app/(console)/admin/channels/waba-forms.tsx`, `forms.tsx`) and nothing calls
Meta. A number that is live on the WhatsApp Business _app_ on a phone cannot be
connected that way. Meta's Coexistence mode (Embedded Signup custom flow
"WhatsApp Business App onboarding") connects such a number to Cloud API while
it keeps working on the phone, mirrors phone-sent replies to us as
`smb_message_echoes` webhooks, and allows a once-per-onboarding, 24-hour-window
request for the phone's contacts (`smb_app_state_sync`) and up to 6 months of
chat history (`history`).

Outcome: an admin presses **one button**, completes Meta's popup, and watches
the number connect itself — credential stored, events subscribed, contacts and
past chats copied — with nothing to do on Render or in Business Manager
afterwards. Phone-typed replies show on tickets and stop the SLA clocks;
console replies go out over Cloud API.

Decisions taken with the user:

- **Import both history and contacts.** Each past thread becomes one
  _resolved_ ticket (replyable later, template-only since the window is
  closed). Imported messages never trigger automations, SLA, auto-reply,
  categorisation, shipment linking, media download or the 24-hour window.
- **A phone-sent reply counts as the team's reply**: outbound, no author,
  labelled "WhatsApp Business app", moves `lastAgentMessageAt`, calls
  `onAgentReply`. Never touches `lastCustomerMessageAt`; never reopens.
- **The backend stores the business token, sealed.** The user's instruction
  ("if the coexistence mode will require a token to be stored by the backend,
  it should do it securely and properly") overrides AGENTS.md's "the token is
  named, never stored", which was written for a credential a person pastes.
  An Embedded Signup token is minted by Meta for a WABA the popup may have
  just created; no human hand holds it and no system user is on it, so the
  alternative is a Render or Business Manager step per number — the manual
  step the one-button flow exists to remove. Each property the old rule bought
  is kept by name (§ Credential): a dump carries no usable credential, an
  admin never chooses which secret is sent to Meta, and the value crosses no
  log line, client prop, job payload or webhook row.

## Preconditions outside the repo (gate the live test, not the code)

1. The production Meta app must be a **Tech Provider** (or Solution Partner);
   Embedded Signup is refused otherwise (App Dashboard → WhatsApp →
   Quickstart). Business verification is a prerequisite.
2. **Facebook Login for Business** product with a configuration for the
   Business-app onboarding product → `META_EMBEDDED_SIGNUP_CONFIG_ID`. Client
   OAuth settings: Client/Web OAuth login, Enforce HTTPS, Login with the
   JavaScript SDK = Yes; the console host (and staging's) in **Allowed Domains
   for the JavaScript SDK** and **Valid OAuth redirect URIs**.
3. `WHATSAPP_CREDENTIAL_KEY` set in both env groups (`openssl rand -base64 32`).
4. App-level webhook fields on `whatsapp_business_account`: `history`,
   `smb_app_state_sync`, `smb_message_echoes`, `account_update` — written by
   `subscribe_meta_webhooks` once the field list changes (§ Subscriptions),
   staging first.
5. The phone runs WhatsApp Business app ≥ 2.24.17 and stays open during the
   sync; onboarding unlinks companion devices; throughput is fixed at 20 mps;
   marketing templates are refused on a coexistence number.

## The credential — stored sealed, used by the worker only

Threat → control, so each design choice has its reason:

| Threat                                           | Control                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database dump, backup, `execute_sql` from a tool | ciphertext only, in its own table; key in Render's env group, never in the DB; AAD binds a ciphertext to its row and WABA                                                                                                                                            |
| Web-service compromise (internet-facing)         | the web service never decrypts a stored token: only worker handlers resolve one, CI-checked; the plaintext from the exchange lives for one request                                                                                                                   |
| Log scraping                                     | token is a local in two functions; `logger` fields are primitives; a test spies on every log call and thrown message                                                                                                                                                 |
| Browser (RSC payload)                            | the ciphertext table is reached by no page query; `CredentialStatus` has no secret field; the star-select `listWhatsAppAccounts()` + `{...account}` spread in `page.tsx:51` is why the column is **not** on `whatsapp_accounts`                                      |
| Forged `postMessage` / forged ids                | hostname origin check; the server treats `waba_id`/`phone_number_id` as claims and proves them with the token (`debug_token`, `GET /{waba}`, `GET /{waba}/phone_numbers`)                                                                                            |
| CSRF / replay                                    | Next's same-origin check on actions + `SameSite=Lax` cookie (the console host is the only `APP_URL` origin — say so in `proxy.ts`'s header so a later help-centre rewrite does not weaken it); the code is single-use and lives 30 s; `allow()` rate limit per agent |
| Insider                                          | new permission `admin.channels.connect`; every store / reseal / remove / refusal is an append-only audit row naming the agent                                                                                                                                        |
| Key loss / wrong key                             | named `CredentialKeyError`; nothing sent to Meta with garbage; recovery is one popup per number                                                                                                                                                                      |
| Key rotation                                     | key id in envelope, column and AAD; a `_PREVIOUS` slot; `rotate_whatsapp_credentials` job                                                                                                                                                                            |

**Schema** (`db/schema/config.ts`, then `npm run db:generate` → one
migration; RLS from the `db/sql/001` loop; `touch_updated_at` picks up
`updated_at`):

- `whatsapp_account_credentials` — one row per account, the only place a
  secret is written: `whatsapp_account_id` uuid PK → `whatsapp_accounts.id`
  **on delete cascade**; `envelope` text; `key_id` text; `source` text
  (`embedded_signup`); `token_type`, `app_id`, `scopes` jsonb, `business_id`;
  `issued_at`, `expires_at` (null = Meta's `0`, never), `data_access_expires_at`;
  `obtained_by_agent_id` → agents set null; `last_verified_at`,
  `last_refused_at`, `last_refusal`; timestamps.
- `whatsapp_onboardings` — one row per attempt; the progress the page polls
  and the audit of who connected what (modelled on `admin_deletions`: bare
  ids + labels, survives the things it names): `id`, `whatsapp_account_id`,
  `waba_id`, `phone_number_id`, `channel_id` (null until created), `status`
  ∈ `exchanged | connected | failed`, `steps` jsonb (`{number | subscribe |
channel | contacts | history | templates: {at, ok, detail?, warning?,
error?}}`), `attempts` int, `next_attempt_at`, `last_transient_error`
  (what the card reads during queue backoff), `error`,
  `started_by_agent_id` → agents set null, `started_by_label`, `started_at`,
  `finished_at`, timestamps; index `(phone_number_id, started_at desc)` and
  a **partial unique index `(phone_number_id) where status = 'exchanged'`**,
  which makes "already connecting" atomic instead of a read-then-insert
  race.
- `whatsapp_credential_events` — append-only: `id`, `whatsapp_account_id`,
  `waba_id`, `event` ∈ `stored | resealed | refused | removed`, `key_id`,
  `agent_id` → agents set null, `agent_label`, `detail` jsonb (type, scopes,
  expiry, Meta's sentence — never a secret), `created_at`. `refused` is
  written once per transition (when `last_refused_at` was null), not hourly.

**Envelope** — `lib/whatsapp/credential-envelope.ts` (pure, modelled on
`lib/auth/invite-token.ts` plus a key id): AES-256-GCM, 12-byte random IV,
16-byte tag; key = `hkdfSync('sha256', secret, 'whatsapp-credential', 'shipblu-support/whatsapp-credential/v1', 32)`;
`keyId` = first 8 hex of `sha256(derivedKey)`; AAD =
`v1|<keyId>|whatsapp_account_credentials|<account id>|<waba id>`; encoding
`v1.<keyId>.<iv>.<ct>.<tag>` base64url. Exports: `parseKeyring(current,
previous)`, `seal`, `unseal`, `envelopeKeyId`, `keyStateOf(keyId, keyring)` →
`current | previous | unknown | no_key` (answers on the page without
decrypting), `class CredentialKeyError { reason: 'unset' | 'malformed' |
'unknown_key' | 'undecryptable' }` — its sentence names the variable and the
key ids, never a value.

**Key** — `WHATSAPP_CREDENTIAL_KEY` (any high-entropy string ≥ 32 chars,
`openssl rand -base64 32`) and `WHATSAPP_CREDENTIAL_KEY_PREVIOUS` (rotation
only). Both are declared **plain `z.string().optional()`** in `lib/env.ts` —
never a `min()` or `regex()` there: `env()` parses the whole schema on every
page, action and connection, so one mistyped value in the dashboard would
fail the entire console rather than the WhatsApp path (the trap
`lib/env.ts:325–335` documents for `LOG_ALL_INCOMING_WEBHOOKS`). The format is
validated in `parseKeyring` at first use and reported by
`coexistenceReadiness()` before any button; `parseKeyring` also refuses a
`previous` whose bytes equal `current` (a rotation that changed nothing).
Both groups' dashboard-owned comments in `render.yaml`, `.env.example`; and
`vitest.db.config.mts` `env` gets a placeholder beside `APP_SECRET`. Not derived from `APP_SECRET` (it signs reply tokens in
customers' mailboxes and is effectively never rotated; a credential key must
rotate on its own). The names deliberately do not start `WHATSAPP_TOKEN_`:
`parseTokenEnvVar` lets an admin name any such variable as a bearer token and
`env-parity.mjs` skips the prefix — a key so named could be typed into the
"token variable" box and sent to Meta.

**The one module that touches the table** — `lib/whatsapp/credentials.ts`:
`storeBusinessToken(tx, {accountId, wabaId, token, inspection, businessId,
agent})` (upsert on the PK; writes a `stored` event with the previous
`key_id`), `storedTokenFor(account)` (**the only decrypting export**; null
when no row; throws `CredentialKeyError`), `hasStoredCredential`,
`credentialStatuses()` (named columns **excluding `envelope`** →
`Map<accountId, CredentialStatus>` with `keyState`), `recordCredentialRefusal`,
`recordCredentialVerified`, `forgetStoredCredential(accountId, agent)`,
`resealStoredCredentials({dryRun})`. `lib/whatsapp/credential-status.ts`
(pure, client-safe): `CredentialStatus`, `credentialBadges(status, now)`,
`EXPIRY_WARNING_MS = 7 days`.

**Resolution** — `lib/whatsapp/accounts.ts`: `resolveCredentialSource(account,
hasStored)` (pure, tested beside `resolveAccount`): **stored →
`WHATSAPP_TOKEN_*` → `META_PAGE_ACCESS_TOKEN`**; `tokenForAccount` becomes
async and returns `{token, source}`; a stored-but-unreadable credential
**throws and never falls through** (silently sending with another credential
is the "went out from the wrong WABA" failure the module already describes).
`credentialsForAccount` async (one caller, `sync-whatsapp-templates.ts:120`);
`WhatsAppCredentials` gains `source`. `WhatsAppAccount.hasStoredToken` comes
from an `exists()` fragment exported by `credentials.ts` (so the table name
stays in that module), and the template sync's skip guard at
`sync-whatsapp-templates.ts:87` becomes `every(a => !a.tokenEnvVar &&
!a.hasStoredToken)`. One source per account: storing clears
`tokenEnvVar`; `saveWhatsAppAccount` refuses a variable while a credential is
stored and refuses a `wabaId` change (the AAD is bound to it) — "Forget the
stored credential first"; the editor hides the variable box and renders the
WABA id read-only for such a row.

**Inspection** — `lib/meta/debug-token.ts` `inspectToken(inputToken)` →
`{type, appId, isValid, expiresAt, dataAccessExpiresAt, scopes, granularScopes}`,
lifted out of `worker/handlers/check-meta-permissions.ts:73–88` so the job and
the onboarding ask Meta one question through one function (the
`profile-refresh.ts` lesson). App token in the header, as today.

**Expiry and revocation** — detected where the token is already used:
`sync_whatsapp_templates` (hourly) → a 190 lands in `last_sync_error` via
`explainAuthError(code, message, source)` (gains `source`, so the sentence says
"press Reconnect" for a stored credential instead of blaming
`META_PAGE_ACCESS_TOKEN`), and on `source === 'stored'` the handler calls
`recordCredentialRefusal` / `recordCredentialVerified`. `send_whatsapp` and
`download_media` pass `source` into `explainDeliveryError`. Before it fails:
`credentialBadges` renders `expires in N days` within 7 days (each badge has a
stable `kind` and a label of a few words; the key id, the variable and the date
are in its explanation, one tap away). `check_meta_permissions` gains a section
per stored credential (kid, valid, type, scopes, expiry — never the token); it
prints and writes nothing back, so a credential whose expiry was unknown at
storing stays `expiry unknown` until a Reconnect stores a token Meta's
inspection answered for. `applyWhatsAppAccountUpdate` records a refusal — and so
a `refused` event — for `PARTNER_REMOVED` only. `ACCOUNT_OFFBOARDED` is Meta
re-onboarding the number after it moved phone or was registered again; the
partner keeps its access, so the credential is left alone and the badge clears
on `ACCOUNT_RECONNECTED`.

**Disconnect** — _Forget credential_ (new `DangerAction` on the WABA row):
deletes the row, appends `removed`, leaves the account and numbers. Sends and
the sync then use `META_PAGE_ACCESS_TOKEN`, not a token variable: storing the
credential cleared the variable and the save refuses one while a credential is
stored, so a row written through the console has none to fall back to. The
button's hint and its confirmation ("Forget — send with the shared token?") say
so, because they are all the admin reads — the control unmounts with the
credential on success and `DangerAction` prints only errors, so the action
answers a bare `ok()`; if the shared token cannot reach the business, Reconnect
or a `WHATSAPP_TOKEN_*` variable named with Edit afterwards. Deliberately no
`DELETE /{waba}/subscribed_apps` (it would silence inbound tickets as a side
effect of a credential decision). _Disconnect_ (`deleteWhatsAppAccount`)
cascades; the `removed` event is appended inside the same transaction. Because
the cascade removes the credential, an account holding one is disconnected only
by an `admin.channels.connect` holder — the key Forget asks for — decided under
the account row's lock (`storedCredentialRemovalRefusal`); anybody else is told
who can. Meta-side revocation is done by the business (Business Settings →
Integrations → Connected apps) or by offboarding on the phone; the console says
so beside the button.

**Rotation** — set `_PREVIOUS` = old, current = new (both services and the
crons read the group), `npm run job -- rotate_whatsapp_credentials
dryRun=true` then without; rows with `key_id ≠ current` are unsealed with
`previous`, sealed with `current`, one transaction per row with a `resealed`
event; unset `_PREVIOUS`. Payload `z.strictObject({dryRun})`; the handler
skips with a log line when no key is set, so `scripts/ci/db-jobs.txt` runs it
(`run: rotate_whatsapp_credentials dryRun=true`) and its SQL is planned on
real Postgres. Key loss = re-onboard every number, one popup each — written
into `docs/PROJECT-STATE.md`.

**Rules, and the CI that holds them** — the plaintext exists in exactly two
places: a `const` in `exchangeSignupCode` (bearer to `debug_token` and
`GET /{waba}`, then sealed) and the return of `storedTokenFor`, consumed by
`tokenForAccount`. Nothing under `app/` imports `storedTokenFor`,
`tokenForAccount`, `credentialsForAccount` or `credentialsForPhoneNumberId`
(today `channels/actions.ts:9` imports only `parseTokenEnvVar`). No
`JOB_PAYLOADS` key matches `/token|secret|envelope/i` (`payloads.test.ts`).
Meta never sends a token in a webhook; `storedHeaders` already drops
`authorization`. New rule `scripts/ci/rules/credential-confinement.mjs` +
`.test.mjs`, registered in `RULES` (the `shipment-payload` device): the
identifier `whatsappAccountCredentials` appears only in `db/schema/config.ts`,
`db/schema/index.ts`, `lib/whatsapp/credentials.ts` and its `.db.test.ts`;
no empty-column `select()` from it; `CredentialStatus` has no field named
`envelope|ciphertext|token`; no `app/**` import of the four resolver names.

Rejected: Supabase Vault / pgsodium (decrypts in SQL for every holder of the
`postgres` role — the pooled connection, every `execute_sql`, a dump of
`vault.decrypted_secrets`; CI's `database` job runs plain Postgres 17; the
plaintext would transit the pooler and `pg_stat_statements`); env-var-only
(the manual step per number, during which the 24-hour window lapses);
plaintext column; ciphertext on `whatsapp_accounts` (the star select);
`APP_SECRET`-derived key; hybrid asymmetric envelope (a private key on five
services — kept as a future `v2` of the format); an external KMS.

## The flow — one button, two phases

Everything the 30-second code forces happens in **one server action**; everything
else is **one worker job** that runs with the stored credential through
`credentialsForAccount`, so the first run, a retry and a later "copy history
again" cannot differ — and a closed tab no longer abandons a half-connected
number inside its 24-hour window.

### Before the click

- New permission **`admin.channels.connect`** in `PERMISSIONS`
  (`lib/auth/permissions.ts`, granted to `ADMIN`; comment: connecting a
  number stores a credential and imports six months of a business's chats,
  which is a different thing to hand out than renaming a channel). Guards
  `exchangeSignupCode`, `retryCoexistenceOnboarding`,
  `requestCoexistenceSyncAgain`, `forgetStoredCredential`; the page passes
  `canConnect`.
- `coexistenceReadiness()` (`lib/whatsapp/onboarding.ts`) → `{ready: true,
appId, configId} | {ready: false, missing: [{variable, group, why}]}` over
  `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`,
  `WHATSAPP_CREDENTIAL_KEY` (present and well-formed), `APP_URL` https.
- The **WhatsApp business accounts** header gets a primary button `Connect a
WhatsApp number` beside the existing by-ids form (the flow creates or reuses
  a WABA row and shows the credential it mints). Not ready → the card renders
  the checklist with the button disabled, naming each variable and why, under
  one paragraph naming the group: this environment's own
  (`shipblu-support-production` or `shipblu-support-staging`, each with its own
  value), never `shipblu-support-shared` or a service — then a deploy of the web
  service **and** the worker, because `env()` is read once per process and the
  worker opens the sealed credential with the same key.
- The card (`ConnectBusinessAppNumber`): three lines always on screen (sign in
  as an admin of the Business portfolio that owns the number; keep the
  WhatsApp Business app open on the phone until history finishes; linked
  devices are unlinked); a **Default group** `<Select>` in React state outside
  any `<form>`, preselected with the existing `whatsapp` channel's group when
  there is exactly one; one button `Continue with Meta`. The SDK is injected when the
  card opens (`app/help/chat.tsx:84` pattern), so the click is synchronous in
  the gesture; until `fbAsyncInit` fires the button reads "Loading Meta's
  sign-in…".

### The popup — a `useReducer` phase machine

| phase             | copy                                                                                                                                                                                                                                                                                                                                                                                                   | reached by                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loading_sdk`     | "Loading Meta's sign-in…"                                                                                                                                                                                                                                                                                                                                                                              | card open                                                                                                                                                                                                                      |
| `sdk_blocked`     | by cause. `error`: "Meta's sign-in script could not be loaded — usually a content blocker. Allow `connect.facebook.net` for this page and reload." `timeout`: "Meta's sign-in has not loaded after ten seconds. A content blocker on connect.facebook.net is the usual cause — allow it for this page and reload. On a slow connection, wait instead: this card carries on by itself when it arrives." | `error`: the script's `error` event. `timeout`: no `fbAsyncInit` in 10 s — a guess, so a late `fbAsyncInit` (`sdk_ready`) returns the card to `idle`                                                                           |
| `popup_open`      | "Meta's window is open. Finish the steps there — this page updates when you do." — plus, when the SDK opened nothing during the click: "No window? Your browser may have blocked it: allow pop-ups for this site, then close this card (Cancel, then Close anyway) and open it again."                                                                                                                 | after `FB.login`                                                                                                                                                                                                               |
| `popup_blocked`   | "Your browser blocked the window. Allow pop-ups for this site and press Try again." + Try again (the 1 s heuristic can read a very fast cancel as blocked; the recovery is the same either way)                                                                                                                                                                                                        | `window.open` returned null while `FB.login` ran (`watchWindowOpen` — the SDK never calls back for a refused window), or a callback with no code within 1 s (`POPUP_BLOCKED_MS`: a blocker extension closing what it let open) |
| `cancelled`       | "You closed Meta's window at the _<step>_ step. Nothing was changed." + Try again — `<step>` via `signupStepLabel(current_step)` (`PHONE_NUMBER_SETUP` → "choosing the number"; unknown printed as-is)                                                                                                                                                                                                 | `CANCEL {current_step}`                                                                                                                                                                                                        |
| `meta_error`      | "Meta reported: _<message>_. Reference `<session_id>` — quote it to Meta support." + Try again                                                                                                                                                                                                                                                                                                         | `ERROR`                                                                                                                                                                                                                        |
| `awaiting_number` | "Reading which number you chose…"                                                                                                                                                                                                                                                                                                                                                                      | the `code` arrived, `FINISH` not yet (≤ 2 s)                                                                                                                                                                                   |
| `no_number`       | "Meta signed you in but did not say which number was chosen — the flow ended without a number set up. Try again and complete the number step."                                                                                                                                                                                                                                                         | the 2 s passed                                                                                                                                                                                                                 |
| `finishing`       | "Verifying with Meta…"                                                                                                                                                                                                                                                                                                                                                                                 | `FINISH` ids (in a ref, reset per click) + the `code`; `startTransition(() => dispatch(formData))`                                                                                                                             |
| `unanswered`      | "No answer came back. The progress below shows whether the number was connected; if it was, nothing is lost." + `router.refresh()`                                                                                                                                                                                                                                                                     | the action threw or the connection dropped                                                                                                                                                                                     |

Origin filter `isFacebookOrigin` (hostname is `facebook.com` or
`*.facebook.com` — a bare `endsWith` passes `evilfacebook.com`), parser
`parseSignupMessage`; `FB.login(cb, embeddedSignupLoginOptions(configId))`
with the extras in **one constant** (`lib/whatsapp/embedded-signup.ts`).

### Phase 1 — `exchangeSignupCode(_state: AdminState, formData)` (action, inline Graph)

1. `requirePermission('admin.channels.connect')`; `allow(\`signup:${agent.id}\`, 5, 10 min)`
(`lib/http/rate-limit.ts`) → "Too many attempts; wait ten minutes."
2. `coexistenceReadiness()` re-checked server-side.
3. `code` non-empty ≤ 2 KB; `wabaId`, `phoneNumberId` match `/^\d{5,20}$/`;
   `defaultGroupId` re-read as `saveChannel` does.
4. An `exchanged` row for this number refuses ("already connecting — watch the
   progress below") **only while its job is live** — the row is younger than
   15 minutes or its job is `pending`/`processing`. Otherwise the new attempt
   supersedes it: the old row is marked `failed` with `error: 'superseded'`
   inside the same transaction as the new insert, so a worker that never ran
   or a job that died cannot lock a number out short of SQL. Past the fifteen
   minutes a queued job is the only thing keeping a row live, so that case is
   refused in its own words — a job is waiting in the queue and no worker has
   finished it; the worker service is what to check; nothing is lost — since
   "again in fifteen minutes" would be false for as long as the worker is down.
   The same choice is made wherever the partial unique index refuses instead:
   at the insert, for a window that named no number (read off the WABA after
   the code is spent, so the cheap check could not be asked), and in
   `retryOnboarding`'s catch.
5. `tokenExchangeRequest(code)` → **`POST oauth/access_token` with a form
   body** `{client_id, client_secret, code}`, own `fetch` with
   `graphTimeout('POST')`, outside `graph()` so no secret can sit in a URL it
   might log. Expired/used code → "The sign-in code expired before it reached
   the server — it lives 30 seconds. Press Connect and finish Meta's window a
   little faster." Nothing is written before this succeeds.
6. `inspectToken(token)`: when it answers, refuse `!isValid`,
   `appId !== META_APP_ID`, missing `whatsapp_business_management` /
   `whatsapp_business_messaging` (`REQUIRED_BUSINESS_TOKEN_SCOPES`), or
   `granularScopes` targets that exclude `wabaId` **when Meta populated
   them** (the field may be empty for a business token). When the inspection
   call itself fails, that is a warning on the notice and the metadata is
   stored null — step 7 is the mandatory proof, not this. Nothing fills it in
   later: `check_meta_permissions` prints the expiry without storing it, so
   the badge reads `expiry unknown` until a Reconnect stores a token Meta's
   inspection answered for. `lib/meta/debug-token.ts` error sentences name
   `host + pathname` only, never `url.href` (the token rides in the query
   string, the endpoint's only shape).
7. `readWabaRequest(wabaId)` → `GET /{waba}?fields=id,name,owner_business_info`
   with the token — **the proof** that the token reaches the WABA the browser
   named; gives the WABA's name and `business_id`. A refusal here stores
   nothing.
8. One transaction: `ensureAccountForWaba(tx, wabaId, name)` (find by
   `wabaId`; else insert with `freeName`, `tokenEnvVar: null`, `isDefault` if
   none) → clear `tokenEnvVar` → `storeBusinessToken(tx, …)` → insert
   `whatsapp_onboardings {status: 'exchanged'}`. After commit:
   `enqueue('complete_coexistence_onboarding', {onboardingId}, {priority: 10})`
   (a job is enqueued only after its row commits).
9. `refresh('/admin/channels')`; return `{...ok(), notice, onboardingId}`
   (`AdminState` gains `notice?`, `onboardingId?` in `settings-shared.ts`).
   When the WABA row already existed with a `tokenEnvVar`, the notice says it
   now sends with the stored credential instead of `WHATSAPP_TOKEN_X`, and that
   forgetting the credential falls back to `META_PAGE_ACCESS_TOKEN`, not to that
   variable — storing cleared it.
   Log `[coexistence] exchanged onboardingId=… accountId=… wabaId=… agentId=…
tokenType=… expiresAt=…` — ids only; the code is never echoed.

### Phase 2 — `complete_coexistence_onboarding` (job, stored credential)

`worker/handlers/complete-coexistence-onboarding.ts` → `completeOnboarding(onboardingId, only?)`
(`lib/whatsapp/onboarding.ts`). Payload **`z.strictObject`**
`({onboardingId: z.uuid(), steps: z.array(z.enum([...])).optional()})` — the
job is reachable through `npm run job --`, so a mistyped `steps` key must be
refused, not dropped into a full run. Row missing → `subjectGone`.
`credentialsForAccount(account)` must answer `source === 'stored'` (else
`failed`: "the credential was removed"). Steps, each recorded in `steps` and
skipped on a re-run when already `ok`:

- **number** — `GET /{waba}/phone_numbers?fields=id,display_phone_number,verified_name,platform_type`
  must list `phoneNumberId` (else `failed`: "number … is not on business
  account …"); captures display number and verified name.
- **subscribe** — `POST /{waba}/subscribed_apps`, then `GET` it back and
  assert `META_APP_ID` is listed (a 200 on the POST is not proof). Then
  `readSubscription(WHATSAPP_OBJECT)` (`lib/meta/subscriptions.ts`, app
  token): if any of `history`, `smb_app_state_sync`, `smb_message_echoes`,
  `account_update` is missing at app level, the step records a **warning**
  — "this app is not subscribed to _{fields}_; an operator runs `npm run job
-- subscribe_meta_webhooks` once per environment; until then history and
  phone replies will not arrive". The one thing the button cannot do is
  named rather than hidden.
- **channel** — upsert keyed on `config->>'phoneNumberId'` (reconnect:
  same row, `coexistence` rewritten with a fresh `onboardedAt`, syncs reset,
  `disconnected` cleared, name/group kept; new: `name = verified_name` deduped
  against `channels_name_idx`, `type: 'whatsapp'`, `whatsappAccountId`,
  `defaultGroupId`); `channel_id` written on the onboarding row.
- **contacts**, **history** — `canRequestSyncAgain` → `smbAppDataRequest`;
  outcome via `recordSyncRequest`; a refusal (declined, "already requested")
  is recorded on the step and the run continues. On a reconnect these two are
  **not** auto-run (history was copied once; re-requesting re-sends every
  chunk for nothing) — the row offers them as buttons.
- **templates** — `enqueue('sync_whatsapp_templates', {})` unless one is
  already queued, so the agent's template picker fills within a minute rather
  than at the top of the hour; the sync is also the first exercise of the
  stored credential (`last_synced_at` moves).
- Finish: `status: 'connected'`, `finished_at`. A transient `WhatsAppApiError`
  is **recorded before it is rethrown** — `attempts`, `next_attempt_at` (the
  queue's backoff) and `last_transient_error` on the row — so the card reads
  "Meta answered 5xx on _subscribe_ — retrying in 2 min" instead of a silent
  spinner; on the job's **final attempt** the handler marks the row `failed`
  with that error so it never sits `exchanged` for ever. A permanent error on
  `number`/`subscribe`/`channel` → `status: 'failed'` with `error`. Per-step
  retry from the UI is the same job with `steps: [name]`.
  `scripts/ci/db-jobs.txt`: `skip: complete_coexistence_onboarding — needs a
stored credential and calls Graph`.

### Live progress — polling, not SSE

`OnboardingProgress` runs `RefreshScheduler`
(`lib/realtime/refresh-scheduler.ts`, single-flight, visibility-aware) →
`router.refresh()` at the interval `pollIntervalMs` picks — two fixed values, so
the effect is not rebuilt on every refresh: every 3 s while the job is stepping;
every 15 s while it is only waiting — a backoff whose retry is more than 15 s
off, a stall the card has already reported, an attempt past fifteen minutes that
offers Retry — and not at all once that overdue attempt is an hour past its
start (Retry restarts the asking; a reload reads what a late worker did). Once
connected: 3 s for a minute while a "Copy again" request is out, at the
backoff's pace while a retry of it is scheduled, 15 s while the history or a
contacts copy is arriving, nothing once the attempt failed or every copy went
quiet. A "Copy again" button also re-reads every 3 s for the 60 s after it
answers, because the job records the request a claim and a Graph call later.
Every band ends at a time measured against the server's `now`, so nothing polls
for ever. Props flow into the mounted client component without resetting its
phase. While `exchanged`, the card renders each step from `steps` as it lands (◌
→ … → ✓ / ✗ with the sentence), the backoff line from `last_transient_error` /
`next_attempt_at`, and after 60 s with no step moved "No worker has picked this
up yet. The sign-in and its credential are saved, so Meta's window is not needed
again: if nothing moves within fifteen minutes of the start, Retry connection
appears on this card." — not "will continue", which holds only while a job
exists, and the page cannot see one. `/api/events` is a per-request session-mode
`LISTEN` authorised per queue channel and conversation; an admin topic would
need a NOTIFY trigger on config tables, a new authorisation branch and one more
backend-holding connection per admin tab — the class that leaked in §62 — for an
audience of one admin watching six states. Invalidation, not data, as
`LiveUpdates` states.

### Done

> **Connected.** +20 10… (ShipBlu) is live as channel "<name>" under business
> account "<WABA name>" · credential stored (never expires).
> Contacts: 412 received. History: phase 0 100% · phase 1 100% · phase 2 40%
> (17 chunks). Keep the WhatsApp Business app open on the phone until this
> reaches 100% — six months of chats can take hours.
> Replies typed on the phone appear on tickets as "WhatsApp Business app".
> Console replies go out over Cloud API. Nothing else to do.

The last line is built from the steps (`connectedFollowUps`), never fixed.
"Nothing else to do" is printed only when no step failed, no step warned of
something a person must do — the subscribe step's missing or unreadable
app-level webhook fields — and the credential is stored; otherwise **Still to
do:** lists each such step. What Meta says about the number — not on the
Business app, a platform other than `CLOUD_API`, or that it could not be asked
— is the number step's warning, printed as a plain note: nothing on the page
changes it, so it does not hold back "Nothing else to do". The phone-replies
sentence is left out whenever the number or subscribe step warned or did not
finish (`phoneRepliesUnconfirmed`).

### Failure states and recovery

| state                                                                          | shown                                                                                                                                                   | recovery                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| code expired / exchange refused                                                | the sentence above; nothing written                                                                                                                     | Connect again                                                                                                                                                                                                                               |
| readiness missing                                                              | checklist naming variable + group                                                                                                                       | set it on Render; page re-reads                                                                                                                                                                                                             |
| token refused at exchange (scopes, wrong app, not granted on this WABA)        | the specific sentence                                                                                                                                   | re-run signed in as the right Business admin / fix the login configuration                                                                                                                                                                  |
| number already connected                                                       | **Reconnected**; `coexistence` rewritten                                                                                                                | nothing; contacts/history offered as buttons                                                                                                                                                                                                |
| job failed on number/subscribe/channel                                         | `failed` with the step and Meta's sentence; _Retry connection_                                                                                          | `retryCoexistenceOnboarding` enqueues again — no popup                                                                                                                                                                                      |
| connection overdue (`exchanged` past fifteen minutes, no retry scheduled)      | "This connection has not finished in fifteen minutes and nothing is scheduled to carry it on. Press Retry connection…"; _Retry connection_              | `retryOnboarding` reopens it when its job is gone; while a job for it is still queued it refuses, naming the worker service as the thing to check                                                                                           |
| history declined on the phone (2593109)                                        | badge `history declined on the phone` + InfoTip with the phone-side path (wording confirmed on the test phone)                                          | _Reconnect_, and share the history when the phone asks: Meta asks once per connection and the declined request holds a request id, so no copy button can ask again; the reconnect asks for the history and carries the copied contacts over |
| disconnected from the phone (`account_update` `PARTNER_REMOVED`)               | badge on channel (danger) and a refusal on the account's credential                                                                                     | _Reconnect_ = the same popup (its copy warns that Meta unlinks companion devices again); the exchange overwrites the credential, the job re-subscribes                                                                                      |
| number moved phone or registered again (`account_update` `ACCOUNT_OFFBOARDED`) | badge on channel (warning) saying Meta reconnects it on its own                                                                                         | wait: Meta re-onboards it, usually within minutes, and `ACCOUNT_RECONNECTED` clears the badge; _Reconnect_ only if it stays                                                                                                                 |
| credential expiring / refused (190)                                            | account badge + `last_sync_error` sentence                                                                                                              | _Reconnect_                                                                                                                                                                                                                                 |
| credential unreadable (`keyState` unknown / no key)                            | badge `key unknown` / `key not set`, its explanation naming the key id and `WHATSAPP_CREDENTIAL_KEY`                                                    | set the key or rotate; _Reconnect_ re-stores under the current key                                                                                                                                                                          |
| copy window passed, sync never requested                                       | badge `copy window closed` + InfoTip — not for a number Meta says is not on the Business app, nor for a copy an earlier connection made (`carriedOver`) | _Reconnect_ opens a new window                                                                                                                                                                                                              |

### The rows afterwards

- **Channel row**: `ChannelBadge whatsapp` · name · `+20 10… · ShipBlu` · badges
  from `coexistenceBadges`: `WhatsApp Business app` (brand; InfoTip: connected
  on <date>; phone-typed replies count as the team's) — `connected through Meta`
  instead for a number Meta said is not on the Business app (`notOnBusinessApp`,
  written on the channel, so the row offers it no copy and no reconnect for one)
  · `copying history 2/3 · 40%` / `history stalled at 40%` / `history copied` /
  `history declined on the phone` / `history failed` · `412 contacts` ·
  `disconnected on the phone` (warning and "Meta reconnects it on its own" for
  `ACCOUNT_OFFBOARDED`, danger for anything else) ·
  `contacts and history copied before` (`carriedOver`, what an earlier
  connection copied and this one did not ask for again) · `copy window closed`;
  then `RequestSyncAgain` buttons where `canRequestSyncAgain` allows and the
  attempt the channel names has finished connecting, and _Reconnect_ where
  `needsReconnect` says (disconnected, a window that closed on something never
  copied, or history declined on the phone). `ChannelEditor`'s Edit still works;
  it shows the phone number id and the business account as text, and
  `saveChannel` leaves a connected number's `config` and account to the UPDATE
  (`whatsappEditColumns`) — a rename once wiped the connection, and a copy taken
  from a read wrote back over concurrent progress — and refuses a change of
  account.
- **WABA row** (`WhatsAppAccountEditor`): the variable line becomes
  `CredentialCard` —
  `Stored from Embedded Signup on <date> by <agent> · <type> · never expires | expires <date> · key <id>`
  — plus `credentialBadges`, _Reconnect_ and _Forget credential_; the edit form
  hides the token-variable field and says why; `saveWhatsAppAccount` never
  writes the credential. While _Reconnect_ waits on Meta's window or its answer,
  Edit, Forget and Disconnect are off — each would unmount the card, and with it
  the listener the answer arrives on; a failed attempt's progress card turns its
  _Retry connection_ off for the same reason while its new sign-in runs. That
  wait includes `meta_error` and `cancelled` until `FB.login`'s callback has
  fired (and any code it gave is spent or dropped): an ERROR or a CANCEL leaves
  Meta's window open and able to finish (`connectWaitingOn`'s `answerDue`).
- **Which attempts the page shows** (`shownOnboardings`): every number's
  latest, while it runs, for a day after it connected, and for a week after it
  failed — the stored credential outlives the attempt, so Retry stays useful.
  One failure is hidden sooner: a number step that recorded `not_on_account`
  (Meta listed the business account's numbers without this one), once a later
  attempt on the same account has connected — the wrong number picked in
  Meta's window and then the right one, whose Retry would get the same list
  back. Every other failure stays: an account can hold two Business-app numbers
  under one stored credential, so the second connecting is no answer to a
  first that gave up on a 5xx or had its token refused, and that Retry may now
  go through.

### Components and actions

`app/(console)/admin/channels/coexistence-forms.tsx` (`'use client'`; imports
only `./actions`, `../settings-shared` types, `../forms-shared`,
`components/*`, `lib/whatsapp/embedded-signup.ts`, `lib/whatsapp/coexistence.ts`,
`lib/whatsapp/credential-status.ts`, `lib/meta/graph.ts` — the `client-bundle`
rule walks it): `ConnectBusinessAppNumber({readiness, groups, mode:
'connect' | 'reconnect'})`, `OnboardingProgress({onboarding, coexistence})`,
`CoexistenceBadges({config})`, `RequestSyncAgain({channelId, type})`
(`useActionForm`, `{...form}` spread), `RetryOnboarding({onboardingId})`,
`CredentialCard({status})`, `ForgetCredential({accountId})` (`DangerAction`).
Actions in `actions.ts`: `exchangeSignupCode`, `retryCoexistenceOnboarding`
(`onboardingId` via `uuidField`), `requestCoexistenceSyncAgain` (re-reads the
row, `canRequestSyncAgain`, refuses unless the attempt the channel names is
`connected` — the job's own gate — then **enqueues** `{onboardingId, steps:
[type]}`),
`forgetStoredCredential` (`accountId` via `uuidField`). `page.tsx` also loads
`credentialStatuses()` and `listLatestOnboardings()`
(`lib/whatsapp/onboarding-reads.ts`, in `lib/` so the DB tier reaches it) and
replaces `listWhatsAppAccounts()` with a named-column `listAccountsForAdmin()`.

## Data model in `channels.config` — unchanged from the draft

```json
{
  "phoneNumberId": "1234…",
  "coexistence": {
    "onboardingId": "…",
    "onboardedAt": "…",
    "wabaId": "…",
    "displayPhoneNumber": "+20 10…",
    "verifiedName": "ShipBlu",
    "subscribedAt": "…",
    "syncs": {
      "contacts": { "requestId": "…", "requestedAt": "…", "received": 412, "lastReceivedAt": "…" },
      "history": {
        "requestId": "…",
        "requestedAt": "…",
        "chunks": 17,
        "progressByPhase": { "0": 100, "1": 100, "2": 40 },
        "declined": { "at": "…", "code": 2593109 }
      }
    },
    "disconnected": { "at": "…", "event": "PARTNER_REMOVED", "reason": "…", "initiatedBy": "USER" },
    "carriedOver": ["contacts"],
    "notOnBusinessApp": true
  }
}
```

A failed request is `{"error", "attemptedAt"}` in the same slot. `carriedOver`
is what an earlier connection copied and a reconnect did not ask for again;
`notOnBusinessApp` is written when Meta's number check says the number is not
on the Business app, so the row offers it neither a copy nor a reconnect for a
copy it could never make. Both are absent when they do not apply. Parsed by
`lib/whatsapp/coexistence.ts` (pure); written after onboarding only by
`lib/whatsapp/coexistence-state.ts` with atomic `jsonb_set` (chunks are
processed concurrently). History conversations: `source_system='import'`,
`external_id='whatsapp:history:<phoneNumberId>:<customer>'`, status resolved,
`resolved_at` **null** (no rollup counts an import as a resolution),
`last_*_message_at` null, `created_at` = earliest message. History messages:
`source_system='import'`, `external_id = channel_message_id = wamid`,
`meta.history = true`.

## Ingest, subscriptions and webhook ids — unchanged from the draft

- `lib/whatsapp/types.ts` / `parse.ts`: `value.history`, `value.state_sync`,
  `change.field === 'account_update'` → `NormalisedHistoryChunk`,
  `NormalisedContactSync`, `NormalisedAccountUpdate`; direction by comparing
  digits with `metadata.display_phone_number` (the echo branch's device at
  `parse.ts:82`); `media_placeholder` → `mediaPlaceholder: true`; declined
  when an `errors` entry carries 2593109. Unknown shapes degrade, never throw.
- NEW `lib/whatsapp/delivery-id.ts`: `deliveryId()` moved out of the route;
  `hm:<wamid>` per history message, `c:<phone>:<action>:<timestamp>` per
  state-sync item; **nothing for `account_update`** (the index is spent for
  good and a later legitimate disconnect must not be swallowed; the handler is
  idempotent).
- `lib/tickets/ingest-whatsapp.ts`: `ResolvedChannel.coexistence`; the echo
  gate at L238 → `if (!isReadOnlyChannel(channel.kind) && !channel.coexistence)
return IGNORED;`; on a coexistence channel `meta.echoSource = 'business_app'`,
  `lastAgentMessageAt` via `latest()`, `onAgentReply(conversationId, sentAt)`
  after the transaction; duplicate wamid returns before any clock moves; live
  echo media still downloads.
- NEW `lib/tickets/ingest-whatsapp-history.ts`: `ingestWhatsAppHistoryChunk`
  (skip unless `coexistence`; `requireResolvedStatusId(tx)` added beside
  `requireDefaultOpenStatusId` in `lib/tickets/statuses.ts`; conversation by
  `(import, externalId)`, a `history_imported` event; batched message insert
  with untargeted `onConflictDoNothing()`; never `download_media`,
  `afterMessageStored`, `afterInboundMessage`; then `recordHistoryProgress`)
  and `applyWhatsAppContactSync` (`add` → `resolveContact` +
  `applyChannelProfile` (`lib/tickets/contacts.ts:144`: identity name always,
  `contacts.name` only when empty); `remove` → no-op).
- `lib/whatsapp/coexistence-state.ts`: `recordSyncRequest`,
  `recordHistoryProgress`, `recordContactSync`, `findCoexistenceChannel`,
  `applyWhatsAppAccountUpdate`; every statement one `jsonb_set` update;
  instants as `toISOString()` inside the patch.
- `worker/handlers/process-whatsapp-webhook.ts`: three more loops, skips
  counted as `process-meta-webhook.ts` counts them.
- `lib/meta/subscriptions.ts`: `REQUIRED_WHATSAPP_FIELDS = ['messages',
'smb_message_echoes', 'smb_app_state_sync', 'history', 'account_update']`;
  the comment block rewritten (its "silence is the proof" argument is now
  false: a number _is_ operated from the app). Verify each name in the v23.0
  reference first — one bad name fails every run.
- Timeline (`app/(console)/inbox/[number]/timeline.tsx:106`): `meta.echo ?
(meta.echoSource === 'business_app' ? 'WhatsApp Business app' : 'Customer
bot') : …`.

## Docs and the paragraphs that change

- **AGENTS.md**: (1) the "A WhatsApp business account's access token is read
  directly from `process.env`…" paragraph gains the stored source and the
  three-way resolution; (2) Background work: "`refreshRequesterProfile` is
  the only one today" → "…and `exchangeSignupCode`, forced by the 30-second
  life of a signup code; everything after the exchange is a job"; (3) a new
  paragraph **"The stored WhatsApp credential"** — the one credential the
  database holds and why (the user's instruction; the dead-number window a
  manual step leaves open); AES-256-GCM under `WHATSAPP_CREDENTIAL_KEY` with
  the key id in envelope, column and AAD; **no code path on the web service
  decrypts a stored token** (worded as a code-path property, not "cannot" —
  the web service holds the symmetric key to seal); one source per account;
  every store / reseal / remove / refusal an audit row; the
  `credential-confinement` rule; the key names must not start
  `WHATSAPP_TOKEN_`; the key variables stay plain `z.string().optional()`;
  (4) Security: "a dump contains no usable credential **without a key the
  dump does not contain**, and `whatsapp_account_credentials` is the one place
  to look"; the "token is named, never stored" sentence becomes "named, or
  stored sealed — never plaintext".
- `db/schema/config.ts` headers of `whatsappAccounts` ("ids, never a token")
  and `channels` ("credentials stay in environment variables") rewritten;
  `page.tsx:112`'s "Access tokens … live as server environment variables"
  rewritten.
- `docs/meta-endpoints.md`: §1 three credentials → four (the stored business
  token); §3 the WABA-level `subscribed_apps`; §4 `inspectToken` shared;
  §5 rows for `oauth/access_token`, `/{waba}`, `/{waba}/phone_numbers`,
  `/{waba}/subscribed_apps` (POST + GET), `/{phone}/smb_app_data` with a
  credential column; §6 the four inbound fields; §7 drop the
  `smb_message_echoes` row; §8 the three variables.
- `plans/whatsapp-coexistence.md`: context, the credential decision (the
  instruction quoted, the threat table, the rejected alternatives), history
  semantics, the revocation runbook (Business Settings → Integrations →
  Connected apps; offboarding on the phone) — in place before the first live
  onboarding. `plans/multiple-waba-connections.md`: a dated note on the one
  exception.
- `docs/PROJECT-STATE.md`: what is live, the Tech Provider precondition, key
  loss = re-onboard every number, a §6 entry superseding "the
  `smb_message_echoes` silence is the proof".

Proportionality, judged and kept: three tables, two jobs, a permission and a
CI rule for what may be one or two numbers. The credentials and onboardings
tables are what "securely" and "smooth" respectively cost; the events table
is what "properly" costs — "who removed the credential for WABA X and when"
must survive the deletion of both the credential row and the account, and it
is ~10 lines of schema and one insert helper. `admin.channels.connect` is
granted to the same role as `admin.channels` today and exists so the two can
be separated without a migration of meaning later.

## Order of work

1. Envelope + credentials table + `credentials.ts` + `debug-token.ts` +
   accounts resolution + errors `source` + `credential-confinement` rule +
   tests (no UI yet; `sync_whatsapp_templates` already exercises it).
2. Env vars, permission, onboarding tables, `onboarding.ts` (readiness,
   exchange, complete), the two jobs, actions.
3. Parser, delivery ids, ingest (echo gate, history, contacts, account
   update), `coexistence-state.ts`, subscriptions.
4. UI: `coexistence-forms.tsx`, page, `waba-forms.tsx`, `forms.tsx`, timeline.
5. Docs, AGENTS.md, `plans/whatsapp-coexistence.md`, PROJECT-STATE.

## Idempotency

| case                                        | absorbed by                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exchange action re-posted                   | the partial unique index refuses a second `exchanged` row while the first's job is live; a stale one is superseded (`failed: 'superseded'`); a used code is refused by Meta and nothing was written |
| job dies / worker never runs                | final attempt marks `failed`; a 15-minute-old `exchanged` row no longer blocks a new attempt                                                                                                        |
| job re-run / retry                          | steps already `ok` skipped; channel upsert keyed on `phoneNumberId`; syncs refused by `canRequestSyncAgain` once a `requestId` exists                                                               |
| history chunk redelivered                   | `hm:<wamid>` → 200 at the door; `(import, wamid)` and `channel_message_id` on replay; progress via `greatest()`                                                                                     |
| echo redelivered / echo of a Cloud-API send | `messages_channel_message_idx`; `duplicate` before any clock moves                                                                                                                                  |
| contact sync redelivered                    | `c:<phone>:<action>:<ts>`; `resolveContact`/`applyChannelProfile` idempotent                                                                                                                        |
| re-onboarding (same number)                 | credential upsert on the PK (`stored` event names the previous key id); channel rewritten in place; no second ticket                                                                                |
| `ACCOUNT_RECONNECTED`                       | clears `disconnected`, nothing else (the admin re-runs the popup)                                                                                                                                   |

## Tests

- Unit: `credential-envelope.test.ts` (round trip; tampered iv/ct/tag refused;
  AAD with another account, WABA or key id refused; `previous` decrypts and
  `current` seals; unknown key id; the envelope never contains the plaintext,
  decoded bytes included; 1,000 seals → 1,000 IVs; `parseKeyring` names the
  variable, not the value); `credential-status.test.ts`;
  `embedded-signup.test.ts` (extras equal the documented object; the three
  event samples; `evilfacebook.com` refused); `coexistence.test.ts`;
  `debug-token.test.ts`; `onboarding.test.ts` (request shapes vs the v23.0
  references; mocked `fetch` order exchange → debug_token → WABA → store →
  enqueue; the token appears in no `logger` call, no thrown message, no
  returned state — spy on `lib/log`; app-id and scope refusals; a refused
  history step still leaves `connected`); `parse.test.ts` (verbatim Meta
  samples); `delivery-id.test.ts`; `subscriptions.test.ts`; `payloads.test.ts`
  (no secret-shaped key); `route.test.ts` beside "a signed delivery";
  `accounts.test.ts` (`resolveCredentialSource` order).
- DB: `credentials.db.test.ts` (store → `credentialStatuses` has no `envelope`
  key; stored / variable / shared order end-to-end through `tokenForAccount`;
  storing clears `tokenEnvVar`; the variable refusal predicate; cascade on
  account delete with the `removed` event surviving; `resealStoredCredentials`
  moves rows and writes events, `dryRun` writes nothing; wrong key →
  `CredentialKeyError`, row untouched; `parseKeyring` refuses identical
  current/previous bytes); `onboarding.db.test.ts` (the partial unique index
  refuses a second live `exchanged` row; a 15-minute-old one is superseded;
  the handler's final attempt marks `failed`; a transient error lands in
  `last_transient_error`/`next_attempt_at`); `lib/admin/settings.db.test.ts`
  (`listAccountsForAdmin()` rows carry no `envelope`/`ciphertext` key — a
  tripwire for a future join); `onboarding-reads.db.test.ts`;
  `ingest-whatsapp.db.test.ts` (coexistence echo sets `lastAgentMessageAt`,
  `firstRespondedAt`, clears `nextResponseDueAt`, leaves
  `lastCustomerMessageAt`; plain support echo still `ignored` at L347);
  `ingest-whatsapp-history.db.test.ts` (two threads → two resolved `import`
  conversations, both directions, no `jobs` rows, placeholder meta, replay
  writes nothing, a later live inbound reopens and only then sets
  `lastCustomerMessageAt`, un-onboarded number skipped, progress/declined
  recorded; contact naming rules); `coexistence-state.db.test.ts`.
- `node scripts/ci/repo-rules.mjs` clean: `credential-confinement`,
  env-parity, render-groups, dead-exports, client-bundle, server-actions,
  job-registry, db-jobs, form-reset, light-only, dom-title.

## Verification

1. `npm install && npm run typecheck && npm run lint && npm run lint:strict &&
npm run test && npm run knip && npm run build && node scripts/ci/repo-rules.mjs`;
   `npm run test:db` against a local `TEST_DATABASE_URL` (placeholder key in
   `vitest.db.config.mts`).
2. Staging first if its Meta app can run Embedded Signup; otherwise the live
   round trip is on production after deploy (user's call): set the three
   variables; Admin → Channels → Connect a WhatsApp number → complete the
   popup; watch the progress card reach **Connected**; confirm the credential
   row (`select key_id, token_type, expires_at` — never `envelope`), the
   onboarding row's steps, the channel + WABA rows, the two `request_id`s;
   with the app open on the phone, `history` deliveries in `webhook_events`
   (`LOG_ALL_INCOMING_WEBHOOKS=true` for the session, Meta's Webhook Debugger
   for field names); imported resolved tickets with both directions; a
   phone-typed reply on a ticket as "WhatsApp Business app" with the SLA clock
   stopped; a console reply delivered into the phone's chat; the hourly sync
   reading templates with the stored credential (`last_synced_at` moves,
   `last_sync_error` null).
3. Read `debug_token.expires_at` back from the first live onboarding — it
   says whether the credential never expires (custom configuration) or a
   Reconnect every 60 days is part of operating the number (template
   configuration), which is what the 7-day badge exists for.
4. `npm run job -- subscribe_meta_webhooks` on staging, read the field list
   back, then production. `npm run job -- rotate_whatsapp_credentials
dryRun=true` once on production to prove the rotation path plans.
5. Count deliveries per `phone_number_id` (§6.32): the new number verifies with
   `META_APP_SECRET` by construction — the WABA is under our app.

## Risks to settle at implementation time

- **Tech Provider status** of both Meta apps; without it the popup refuses.
- **Embedded Signup version**: v2 retires 2026-10-15; the custom-flow doc shows
  v3 extras (`featureType`, `sessionInfoVersion: '3'`) while the versions page
  says v4 selects the product in the login configuration with `extras: {}`
  and lists `whatsapp_business_app_onboarding` for v4. One constant; adopt
  what the Embedded Signup Builder generates.
- **Token lifetime** is an assumption until the first live `debug_token`;
  `granular_scopes` for a business token may not list WABA targets (the
  `GET /{waba}` read is the fallback proof and is always performed).
- **Field names in v23.0**: `history`, `smb_app_state_sync`, `account_update`
  (webhooks — one bad name fails the whole write); `owner_business_info` on
  the WABA node; `platform_type` on `phone_numbers`; whether
  `oauth/access_token` accepts a POST form (fallback: GET kept outside
  `graph()`). Scopes the login configuration requests (`business_management`?).
- **Payload shapes** from the dashboard's test payloads: `threads[].id`
  meaning, `media_placeholder` form, where 2593109 arrives, per-phase
  `progress`, `account_update` keys, `smb_message_echoes` carrying `to`;
  `normaliseIdentifier('whatsapp', '+20…')` with the leading `+`.
- **No server-side revocation**: an exfiltrated plaintext stays valid until
  the business removes the app; key rotation does not help against that. The
  runbook mitigates; a hybrid asymmetric `v2` envelope is the future answer.
- **Content blockers** on `connect.facebook.net`: the `sdk_blocked` state
  names the fix; there is no server-side fallback for the JS-SDK code flow.
- **Reconnect assumes** Embedded Signup completes for an already-onboarded
  number and returns a fresh token — confirm on staging before relying on it
  as the 190 recovery.
- **Hourly refusal detection** is only as frequent as the sync; a failed send
  is the earlier signal.
- **Reports/retention**: check `lib/reports/rollup.ts` and
  `worker/handlers/cleanup.ts` predicates against imported rows.
- **Service-level override** of `WHATSAPP_CREDENTIAL_KEY` anywhere would
  silently shadow the group (the `render.yaml` header forbids the shape; the
  `keyState` badge would read `unknown` on the next page load).

## As built — the names the code uses

The sections above are the plan as it was written; steps 1–4 shipped under
names that differ in places, and **the code wins**. Where a name above is not in
the tree, this is where it went:

- **The first phase** is `beginCoexistenceOnboarding(claim, actor)` in
  `lib/whatsapp/onboarding.ts` (not `exchangeSignupCode`), behind the
  `connectBusinessAppNumber` action in `app/(console)/admin/channels/actions.ts`.
  It answers `BeginOutcome` — `{ok: true, onboardingId, accountId, notice}` or
  `{ok: false, error}` — and never throws for anything a person could cause. The
  claim's `phoneNumberId` may be null: the coexistence guide's own finish sample
  carries only `waba_id`, so the server reads the number off the WABA when it is
  the account's only one (`onlyNumberOn`). `coexistenceReadiness()` returns
  `{ready: true, appId, configId} | {ready: false, missing: {variable, why}[]}`,
  and `LIVE_ATTEMPT_MS` (fifteen minutes, declared in
  `lib/whatsapp/onboarding-view.ts` so the card offers Retry at the moment the
  server would accept it) is what decides whether an `exchanged` attempt still
  blocks another. Retry is `retryOnboarding(onboardingId)`, which refuses a
  superseded or live attempt — a live one past fifteen minutes, kept live only
  by a queued job, with the worker-service sentence rather than "already
  being connected".
- **The exchange is `GET /oauth/access_token`** with `client_id`,
  `client_secret` and `code` as query parameters — the shape Meta documents for
  a Tech Provider and the only one it documents — not the POST form body §
  Phase 1 proposed. `tokenExchangeUrl` builds it; `exchangeCode` sends it with
  its own `fetch` and scrubs both secrets out of anything it repeats. The WABA
  read asks for `id,name` only (neither reference lists `owner_business_info`),
  and the business id comes from `GET /me?fields=client_business_id`
  (`clientBusinessRequest`) as metadata. All eight request shapes are in
  `lib/whatsapp/onboarding-requests.ts`, with `numberPlatformRequest`
  (`is_on_biz_app,platform_type`, on the number — not on `phone_numbers`,
  whose reference does not list `platform_type`) added.
- **The second phase** is `completeOnboarding(onboardingId, {only, job})` in
  `lib/whatsapp/onboarding-complete.ts`, a module of its own because it
  resolves the stored credential and so may be imported only from `worker/`
  (`RESOLVER_IMPORTERS` in `credential-confinement`); the handler is
  `worker/handlers/complete-coexistence-onboarding.ts`. The payload is
  `{onboardingId, steps?: RERUNNABLE_STEPS[]}` (`steps`, not `only`), with
  `RERUNNABLE_STEPS = contacts | history | templates` declared in
  `db/schema/config.ts` beside `ONBOARDING_STEPS` and `OnboardingStepRecord`
  (`{at, ok, outcome?, previouslyCopied?, detail?, warning?, error?}`). A
  connected number stays connected whatever a later step does; a sync refusal
  is explained by code (2593107 already asked, 2593108 window passed); a
  reconnect carries `previouslyCopied` on the channel step so it does not ask
  again for what an earlier connection copied — any earlier one, since the
  list is also written onto the channel as `coexistence.carriedOver` and read
  back by the next reconnect. A number Meta says is not on the Business app is
  written `notOnBusinessApp: true`, so the row offers it no copy.
- **`lib/whatsapp/coexistence.ts`** holds `Coexistence` (with `onboardingId`),
  `parseCoexistence`, `canRequestSync(coexistence, type, now)` (not
  `canRequestSyncAgain`; it also refuses `not_on_business_app`), `SYNC_TYPES`,
  `META_SYNC_TYPE`, `SYNC_WINDOW_MS`, `historyProgress`, `historyDone`,
  `isSyncing`, `uncopiedAfterWindow`, `needsReconnect` and `coexistenceBadges`
  — all pure, so the page draws the badges the job decides from.
  `lib/whatsapp/onboarding-view.ts` is the view model of an attempt
  (`toOnboardingView`, `STEP_LABELS`, `describeOnboarding`, `retryable`,
  `recoveryFor`, `pollIntervalMs`, `connectedFollowUps`,
  `phoneRepliesUnconfirmed`, `STALL_AFTER_MS`, `LIVE_ATTEMPT_MS`,
  `isOnboardingShown`, `shownOnboardings`, `NUMBER_NOT_ON_ACCOUNT` — the number
  step's outcome the job writes and `shownOnboardings` reads), and
  `lib/whatsapp/onboarding-reads.ts`
  (`listLatestOnboardings()`, and `copyRequestRefusal()` with the
  `runsNamedSteps` predicate the job's gate shares) the reads the page and its
  actions make, in `lib/` so the database tier reaches them.
- **The credential layer**: `lib/whatsapp/credentials.ts` exports
  `storeBusinessToken(tx, {accountId, wabaId, token, inspection, businessId,
actor})`, `storedTokenFor`, `storedCredentialExists()` (the `exists()`
  fragment behind `WhatsAppAccount.hasStoredToken`),
  `storedCredentialEditRefusal(tx, id, {wabaId, tokenEnvVar})`,
  `credentialStatuses()`, `recordCredentialRefusal`, `recordCredentialVerified`,
  `removeStoredCredential(tx, id, actor)` (used inside `deleteWhatsAppAccount`'s
  transaction, so the `removed` event is cut before the cascade),
  `storedCredentialRemovalRefusal(tx, id, mayForget)` (the same transaction,
  first: no cascade for a caller without `admin.channels.connect`),
  `forgetStoredCredential(id, actor)`, `resealStoredCredentials({dryRun})`,
  `credentialKeyProblem()` and `REQUIRED_BUSINESS_TOKEN_SCOPES`.
  `lib/whatsapp/credential-status.ts` carries `CredentialStatus` (`keyState`,
  `keyProblem`, `inspectedAt`, `storedAt`, …), `credentialBadges` (each
  `CredentialBadge` a `kind` the explanation matches on, and a short label)
  and `EXPIRY_WARNING_MS`. `explainAuthError(code, message, {source,
tokenEnvVar})` takes a `TokenOrigin`; `CredentialSource` lives in
  `lib/whatsapp/errors.ts`. `inspectToken` and `readGraph` are
  `lib/meta/debug-token.ts`.
- **Ingest**: `lib/tickets/ingest-whatsapp-history.ts` exports
  `ingestWhatsAppHistoryChunk`, `attachHistoryMedia` (the file behind a
  placeholder, which arrives later as a top-level `messages` array under
  `history`) and `applyWhatsAppContactSync`; `lib/whatsapp/coexistence-state.ts`
  adds `recordHistoryDeclined` and `writeOnboardedCoexistence(tx, …)` to the
  list above. `requireResolvedStatusId` is in `lib/tickets/statuses.ts`.
- **The UI**: `app/(console)/admin/channels/coexistence-forms.tsx` exports
  `ConnectBusinessAppNumber`, `OnboardingProgress`, `RetryOnboarding`,
  `CoexistenceBadges`, `RequestSyncAgain`, `CredentialCard` and
  `ForgetCredential`. The actions are `connectBusinessAppNumber`,
  `retryCoexistenceOnboarding`, `requestCoexistenceSync` (not
  `requestCoexistenceSyncAgain`) and `forgetStoredCredential`, all behind
  `admin.channels.connect`, the first also behind `allow('signup:' + agent.id,
5, 10 min)`. `AdminState` gained `notice` and `onboardingId`
  (`admin/settings-shared.ts`); `GRAPH_VERSION` is exported from
  `lib/meta/graph.ts`; `saveChannel` keeps a connected number's `config` and
  account through `whatsappEditColumns` in `coexistence-state.ts`, decided in
  the UPDATE, and refuses moving it to another account.
  `lib/whatsapp/embedded-signup.ts` holds the SDK URL,
  `EMBEDDED_SIGNUP_EXTRAS` (the v3 shape, one constant — adopt what the
  Embedded Signup Builder generates), `embeddedSignupLoginOptions`,
  `isFacebookOrigin`, `parseSignupMessage` and the three timings.
- **Not built, on purpose**: `SIGNUP_EVENTS.finished` reads both
  `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` and the standard `FINISH` as
  "finished", because which flow ran is the login configuration's decision;
  phone registration is skipped, as Meta's guide says to for this flow; and
  `check_meta_permissions` prints a section per stored credential rather than
  the onboarding re-checking scopes on a schedule.

## Verified

Locally, on 2026-10-08, before any live round trip:

- **Unit tier.** `npx vitest run lib/whatsapp lib/meta lib/tickets lib/queue
worker/handlers`: 68 files, 1,590 tests. The onboarding request shapes against
  the references they name; the envelope's round trip, tampering, AAD binding,
  key rotation and IV uniqueness; `resolveCredentialSource`'s order; the
  Embedded Signup extras, the three window events and the origin check
  (`evilfacebook.com` refused); `parseWebhook` on the four coexistence fields;
  the delivery ids; `canRequestSync` and the badges; the view model; the
  subscription field lists; no secret-shaped key in `JOB_PAYLOADS`.
- **Database tier.** Migrations and `db/sql/` applied to an empty Postgres 16,
  then nine `*.db.test.ts` files — `lib/whatsapp/credentials`, `onboarding`,
  `onboarding-reads`, `coexistence-state`, `lib/tickets/ingest-whatsapp`,
  `ingest-whatsapp-history`, `worker/handlers/process-whatsapp-webhook`,
  `sync-whatsapp-templates`, `lib/admin/settings` — 106 tests. What they
  establish is listed in `docs/PROJECT-STATE.md` §7.
- **Build and the repo rules.** `npm run build` and
  `node scripts/ci/repo-rules.mjs` (`credential-confinement` among them) pass
  on the branch; the full `verify` set runs on the pull request.

Waiting on the live round trip, and on nothing in the repo:

- Tech Provider status of both Meta apps; the login configuration and
  `META_EMBEDDED_SIGNUP_CONFIG_ID`; the console host in Allowed Domains for the
  JavaScript SDK; `WHATSAPP_CREDENTIAL_KEY` in both groups.
- The app-level fields through `npm run job -- subscribe_meta_webhooks`,
  staging first — three of the four names are from the webhooks overview, not
  from a subscription this app already holds.
- Everything Meta answers: whether the Builder's extras match
  `EMBEDDED_SIGNUP_EXTRAS`; the token's lifetime (`debug_token.expires_at` on
  the first onboarding decides whether a Reconnect every sixty days is part of
  operating the number); whether `granular_scopes` names WABA targets for a
  business token; the real payload shapes of `history`, `smb_app_state_sync`,
  `smb_message_echoes` and `account_update` against the parser's samples;
  whether Reconnect completes for an already-onboarded number and returns a
  fresh token; `rotate_whatsapp_credentials dryRun=true` once on production.
  `docs/PROJECT-STATE.md` §5.2 has the order to read them back in.
