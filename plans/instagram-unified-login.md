# Instagram through Meta's API with Unified Login

> I want to set up the app to use Meta's new API setup with Unified login for
> Instagram. Carefully walk me through the Meta side setup, and then prepare the
> code to activate this.

That is the request. The day before it was made, the credential Instagram has
answered with since 2026-08-30 ran out: the Instagram Login token
(`INSTAGRAM_ACCESS_TOKEN`, an Instagram User token, sixty days) expired at
15:25:38 UTC on 2026-10-29, and every `graph.instagram.com` call has failed
with code 190, "Session has expired", since (`docs/PROJECT-STATE.md`, the
header). Renewing it buys another sixty days and the same expiry again. This
plan is the way out that does not.

Two things come out of it:

1. **A third `MetaConnection`, `unified_login`**, which takes every Instagram
   call ahead of the other two while its token is set, and changes nothing
   while it is not.
2. **A "Connect Instagram" button on `/admin/channels`** that opens Meta's
   login, exchanges the code it hands back and shows an admin the token once,
   to set on Render — the Meta side of the work is otherwise a dashboard
   walkthrough, and it is written out below in the dashboard's own words.

## What production held

Read on 2026-11-04, from the repository and `docs/PROJECT-STATE.md`; nothing
was written.

- The Instagram account (`17841448759001625`) is connected to the production
  Meta app **twice**: through the Facebook Page it is linked to, and directly
  through Instagram → "API setup with Instagram login" (§6.36). Both deliver
  every event. The Page's copies arrive in the handover protocol's `standby`
  array, because Freshworks is still the Page's primary receiver (§5.1, §6.29);
  the direct connection's arrive in `messaging`, signed with
  `INSTAGRAM_APP_SECRET`.
- `metaConnection('instagram')` answered `instagram_login` while
  `INSTAGRAM_ACCESS_TOKEN` was set, so sends, profile reads and comment actions
  went out over `graph.instagram.com` with a token that has now expired. The
  first casualty was a profile read at 17:07:43 UTC on 2026-10-29, whose
  `fetch_meta_profile` job went `dead` after five attempts. No reply had been
  sent since, so none had failed yet.
- The 2026-09-19 App Review granted `instagram_basic` and
  `instagram_manage_messages` at Advanced Access, and refused
  `instagram_manage_comments` (`plans/meta-app-review-submission.md`). Those
  are the **Page vocabulary** — the names Unified Login uses too.
- The Human Agent feature is not approved (§5.2, confirmed 2026-09-06), so a
  reply between 24 hours and 7 days after the customer wrote is refused on
  every connection.
- The App Dashboard's Instagram product shows a new tab, **"API setup with
  Unified login"**, whose first section, "1. Configure your app", reads "No
  compatible configurations found" and previews what a configuration would
  hold: Login variation General; Access token System-user access token (SUAT);
  Expiration Never (system-user token); Business assets Instagram account
  (required), Ad account (optional); Permissions `ads_management`, `ads_read`,
  `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`,
  `instagram_content_publish`. Its "Redirect URL" select offers
  `https://shipblu-support.onrender.com/`, the root, which no route of ours
  answers for a login.

## What Unified Login is, in this codebase's terms

Meta's "Instagram API with Unified Login" is the setup it now recommends for new
integrations and releases new Instagram features for. Read against the two
connections this app already has (`lib/meta/connection.ts` carries the same
table beside the code):

|                    | `facebook_page`                                    | `instagram_login`                                 | `unified_login`                                                             |
| ------------------ | -------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Meta's name        | Instagram API with Facebook Login                  | Instagram API with Instagram Login                | Instagram API with Unified Login                                            |
| host               | `graph.facebook.com`                               | `graph.instagram.com`                             | `graph.facebook.com`                                                        |
| credential         | `META_PAGE_ACCESS_TOKEN`, a Page token             | `INSTAGRAM_ACCESS_TOKEN`, an Instagram User token | `INSTAGRAM_UNIFIED_LOGIN_TOKEN`, a Business Integration System User token   |
| expiry             | long-lived                                         | 60 days — ran out 2026-10-29                      | never, as the configuration sets it                                         |
| signs webhooks     | `META_APP_SECRET`                                  | `INSTAGRAM_APP_SECRET`                            | `META_APP_SECRET` — the same as the Page's                                  |
| permissions        | `instagram_basic`, `instagram_manage_*`, `pages_*` | `instagram_business_*`                            | `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments` |
| handover protocol  | yes — `standby` while another app owns the thread  | no                                                | no — "not yet supported" in Meta's migration guide                          |
| `/me` on the token | the Page                                           | the Instagram account                             | the business integration system user — **never** the account                |

Three facts carry the design:

- **The ids do not change.** The account id and the IGSIDs are the Page's
  (Unified Login's payloads follow the Facebook Login format, and
  `/me/assigned_instagram_accounts` is expected to list the same
  `17841448759001625` — the callback page checks exactly that, and §5.2 of
  `docs/PROJECT-STATE.md` records it once a token has been minted), so a
  contact, a ticket and a 24-hour window mean the same thing on every
  connection and this is a routing change, not a data migration — the same
  property §6.29 verified from traffic for the first two. Meta does say the
  **message ids** differ in format from Instagram Login's, which is why the
  first live hour below watches for a duplicated timeline.
- **Its deliveries cannot be told from the Page's.** Both are signed with
  `META_APP_SECRET`, so `lib/meta/signing.ts` labels a Unified Login delivery
  `facebook_page`, and `webhook_events.connection` never says `unified_login`.
  The one thing that reads a delivery's connection, `lib/meta/thread.ts`, asks
  whether a `standby` recorded on the Page's connection should stop a send, and
  it never stops one going out over Unified Login, which has no handover
  protocol for a `standby` to be about. So the label costs nothing today;
  the envelope — `messaging` or `standby` — is what separates the two in the
  table, and the verification queries below read it off the payload.
- **The token is the flag.** `metaConnection('instagram')` answers
  `unified_login` when `INSTAGRAM_UNIFIED_LOGIN_TOKEN` is set, `instagram_login`
  when `INSTAGRAM_ACCESS_TOKEN` is, else `facebook_page` — the device
  `instagramLoginConfigured()` already used, so there is no mode variable to
  disagree with the credential behind it, and unsetting the token is the whole
  rollback.

## Decisions, with reasons

1. **Unified Login goes first in `metaConnection`'s order, ahead of the direct
   connection.** It wins on every axis that matters: the token never expires,
   where the direct connection's ran out and took the channel with it; it is
   not subject to another app's thread control, where the Page has received
   `standby` and nothing else since 27 August; and its permissions are the
   `instagram_*` pair App Review granted at Advanced Access on 2026-09-19, so
   nothing is resubmitted for messaging. The direct connection keeps second
   place for the reason it had first — it is the route around the Page's
   handover — so an environment that never sets the new token behaves exactly
   as it did.
2. **The token goes to the browser once, and to Render by hand; nothing stores
   it.** The repository stores exactly one credential, the WhatsApp business
   token Embedded Signup mints, and AGENTS.md says a second table holding a
   secret is its own change with its own argument. This token does not earn
   one: it is one per environment, it never expires, so the step is once, and
   Meta's own dashboard hands the same token to an admin's browser the same way
   ("Generate token … shown only once"). What the browser path costs is
   mitigated by name in `lib/meta/unified-login.ts`: the routes are behind
   `admin.channels.connect`; the `state` is bound to the admin's browser in a
   cookie scoped to the login's path; the code Meta hands back is single-use
   and short-lived; the page is `Cache-Control: no-store` and
   `Referrer-Policy: no-referrer`; and the token is never in a URL and never
   logged. An environment-group change on Render redeploys every service, so
   the worker that sends and the web service that answers the webhook switch
   together.
3. **The exchange runs in the route, not a job.** The code lives minutes and is
   spent once, and the admin is waiting on the one sentence the exchange
   answers — the two exceptions AGENTS.md already allows (`beginCoexistenceOnboarding`,
   a control an agent presses and waits on). It is a `GET` with the app secret
   and the code as query parameters because that is the only shape Meta
   documents, so `tokenExchangeUrl` builds the URL and nothing else, the route
   sends it with its own `fetch` outside every Graph client, and every sentence
   repeated to the admin has the code and the secret cut out — the
   `lib/whatsapp/onboarding.ts` rule, applied a second time.
4. **The redirect URL is the callback route, not the site root.** Meta compares
   `redirect_uri` byte for byte between the dialog and the exchange, and the
   root URL already registered would land the admin on the help centre with
   the code in its address bar. `${APP_URL}/api/meta/unified-login/callback`
   is registered instead, and the start route refuses to open the dialog until
   `APP_URL`, `META_APP_ID`, `META_APP_SECRET` and
   `INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID` are all set (`unifiedLoginReadiness`,
   the shape of `coexistenceReadiness`).
5. **Fewer permissions in the configuration, not more.** The preview's set
   includes `ads_management`, `ads_read` and `instagram_content_publish`, none
   of which this system calls; each is one more thing to justify in App Review
   and one more thing a token can do if it leaks. The configuration keeps
   `instagram_basic`, `instagram_manage_messages` and
   `instagram_manage_comments` — the last still at Standard Access, which
   reaches a role holder on the account and nobody else, exactly as the Page
   connection's does today.
6. **`INSTAGRAM_ACCOUNT_ID` stays the address of every send.** `/me` on a
   Business Integration System User token is the system user, not the
   account, so the client never addresses `/me` on this connection, and the
   callback page refuses nothing but warns plainly when the token's
   `assigned_instagram_accounts` do not include the configured id: a token
   that cannot address the account is a token every reply fails with.
7. **The account-level webhook subscription is a fourth write in
   `subscribe_meta_webhooks`**, not a change to the three it has. The app-level
   `instagram` subscription is shared, but the account-level half is per
   connection — host, token and edge — and Unified Login's is
   `POST graph.facebook.com/{ig-id}/subscribed_apps` with the Unified token and
   the `instagram` object's own field list. Without it the connection is
   authorised and silent.

## Shape

| Piece                                                         | Where                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The connection, its label, host and precedence                | `lib/meta/connection.ts` — `MetaConnection`, `metaConnection`, `unifiedLoginConfigured`         |
| The two variables                                             | `lib/env.ts`, `render.yaml` (both environment groups, dashboard-owned)                          |
| The host and token a call goes out with                       | `endpoint()` in `lib/meta/client.ts`                                                            |
| `standby` never blocking a Unified Login send                 | `metaThreadState` in `lib/meta/thread.ts`                                                       |
| The permissions and features the connection depends on        | `CAPABILITIES`, `FEATURES`, `requiredScopes('unified_login')` in `lib/meta/capabilities.ts`     |
| The login: readiness, dialog URL, exchange, the one-time page | `lib/meta/unified-login.ts`                                                                     |
| The two routes                                                | `app/api/meta/unified-login/start/route.ts`, `…/callback/route.ts`                              |
| The card on Settings → Channels                               | `app/(console)/admin/channels/unified-login-card.tsx`                                           |
| The account-level subscription                                | `readUnifiedLoginSubscription` / `applyUnifiedLoginSubscription` in `lib/meta/subscriptions.ts` |
| The diagnostic                                                | `worker/handlers/check-meta-permissions.ts`, through `inspectToken` and `readGraph`             |
| Every endpoint, in one table                                  | `docs/meta-endpoints.md` §1–§4, §6, §8                                                          |

## The Meta side, in order

Everything here is in the App Dashboard for the **production** Meta app (§2 of
`docs/PROJECT-STATE.md` has the ids; staging has its own app and gets the same
steps against its own URL). Labels are quoted as the dashboard shows them on
2026-11-04. Nothing in this section touches Render or the database.

### 0. Preconditions

- **The app is owned by a business portfolio.** The "API setup with Unified
  login" tab appears only on an app a business portfolio owns; if the tab is
  missing, that is the reason. App settings → Basic → "Business portfolio"
  names it. Business verification is a prerequisite of the September
  approvals and so should already be in place, but `docs/PROJECT-STATE.md`
  §5.2 records it as never checked for either app: Business settings →
  Security Centre says, and a missing tab is the first place it would show.
- **Facebook Login for Business is a product on the app.** Unified Login's
  configurations are Facebook Login for Business configurations; the WhatsApp
  Embedded Signup one (`META_EMBEDDED_SIGNUP_CONFIG_ID`) lives in the same
  list, so the product is already there.
- **The Instagram account is a professional account (business or creator),
  in the portfolio, with "Allow access to messages" on in the Instagram app**
  (Settings → Messages and story replies → Message controls → Connected
  tools). Both are already true, since the account answers through the Page
  today; they are the first two troubleshooting strings below.
- **Whoever runs the login is an admin of ShipBlu's business portfolio and has
  a role on the app.** The login asks them to pick the portfolio and the
  account, and Standard Access covers them; the token it mints is the
  business's, not theirs.

### 1. Create the configuration

Instagram → **"API setup with Unified login"** → **"1. Configure your app"**.

1. **"Create new configuration"**. The preview on the tab is what the dialog
   opens with: Login variation **General**; Access token **System-user access
   token (SUAT)**; Expiration **Never (system-user token)**; Business assets
   **Instagram account (required)**, **Ad account (optional)**.
2. Edit the permissions. Keep `instagram_basic`,
   `instagram_manage_messages` and `instagram_manage_comments`. Remove
   `ads_management`, `ads_read` and `instagram_content_publish` (decision 5).
   Under business assets keep the Instagram account and drop the ad account.
3. Keep the access token as **System-user access token** and the expiration
   as **Never**. The never-expiring token is the whole point; a configuration
   set to a user token reproduces the 60-day problem under a new name.
4. Save, then **"Use this configuration"**. The preview now shows its
   **`config_id`**, a numeric id — and once the redirect URL below is saved,
   the generated Login URL carries the same value as `config_id=`, which is
   the surest place to read it from. That is `INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID`.
   It is an id, not a secret, but it belongs to this app, so staging's is a
   different one.

An existing configuration shows an **"Instagram Login Compatible"** label when
it meets the tab's requirements (a General login variation with the Instagram
account as a required asset); one without the label is not offered. Creating
one from this tab gets the label by construction.

### 2. Register the redirect URL

Still on the tab, under **"Redirect URL"**: the select lists what the app
already has — `https://shipblu-support.onrender.com/` today, which is not
usable (decision 4). **"Register a new redirect URL"** →
`https://shipblu-support.onrender.com/api/meta/unified-login/callback` →
**Save**. The value must match what the dialog is opened with character for
character, and `unifiedLoginReadiness` builds ours as
`new URL('/api/meta/unified-login/callback', APP_URL)`, so `APP_URL` has to be
the console's origin with no path. Staging registers its own on its own app.

The same URL also has to be accepted under Facebook Login for Business →
Settings → **"Valid OAuth Redirect URIs"**. Registering it on the tab is
expected to put it there — Meta's manual-flow page names that list as the one
the dialog checks — and it is the list to look at if the dialog answers "URL
blocked" after step 1.

### 3. The login URL

Under **"Login URL"** the tab now generates the dialog for the configuration
and redirect URL above. It is what `loginDialogUrl()` builds, and reading the
two side by side is the check that the configuration and the redirect are the
ones the code expects:

```
https://www.facebook.com/v23.0/dialog/oauth
  ?client_id=<META_APP_ID>
  &config_id=<INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID>
  &redirect_uri=https://shipblu-support.onrender.com/api/meta/unified-login/callback
  &response_type=code
  &override_default_response_type=true
  &state=<random>
```

`config_id` stands where `scope` would on an ordinary login; `response_type`
is `code` because a system-user token is minted only through the
authorisation-code grant; `state` is the console's own, set in a cookie by the
start route and compared on the way back. The dashboard's generated URL is
not expected to carry a `state` — it is a link for a test by hand, not for the
console — and if it does, ours still generates its own. Do not add
`prompt=login` by default: it shows both login options even to somebody already
signed in to Facebook, which is a second screen for every admin for the sake of
the rare one signed in as the wrong person.

### 4. Access levels and App Review

- **Standard Access** covers people with a role on the app and the assets they
  administer. It is enough for the whole activation below, because the test DM
  is sent from a role holder's account.
- **Advanced Access** reaches the public, and needs an approved App Review
  submission plus the app in Live mode. Meta's permissions page for Unified
  Login says Advanced Access already held for `instagram_*` permissions
  carries over, so **`instagram_basic` and `instagram_manage_messages`,
  approved on 2026-09-19, need no new submission**. `check_meta_permissions`
  says what the token holds; the dashboard's App Review → Permissions and
  Features page says at which level.
- **`instagram_manage_comments` is still Standard Access**, refused in the
  September review; the resubmission is in
  `plans/meta-app-review-submission.md` and is unchanged by this plan.
  Until it is approved, Instagram comment webhooks and moderation reach a role
  holder's own comments and nobody else's, on this connection as on the Page's.
- **Human Agent is a feature, not a permission**, is not approved (§5.2), and
  nothing about this connection changes that: every reply between 24 hours and
  7 days is refused until the feature is granted, and `FEATURES` in
  `lib/meta/capabilities.ts` lists it under `unified_login` so the diagnostic
  names what it did not check.

### 5. Webhooks

The app-level subscription on the `instagram` object already exists and is
shared by every connection (`docs/meta-endpoints.md` §3). The account-level
half for Unified Login is what the job writes in the activation below:
`POST graph.facebook.com/v23.0/{ig-account-id}/subscribed_apps` with
`subscribed_fields=messages,comments,messaging_postbacks,messaging_referral,message_reactions`
and the Unified token, answered `{"success": true}`; `GET` on the same edge
reads it back. Deliveries arrive at the same `/api/webhooks/meta` callback,
object `instagram`, signed with `META_APP_SECRET`, in the Facebook Login
format the parser already reads. While the account is connected more than one
way the same message is delivered more than once; ingest keys on the `mid`,
so it is one ticket.

## The Render side

Both variables go in the **environment group**, never on a service, and in
exactly one group each: `shipblu-support-production` for production,
`shipblu-support-staging` for staging. `render.yaml` already lists both as
dashboard-owned comments in each group; no value ever appears in the file.

| Variable                            | Value                                  | When                                    |
| ----------------------------------- | -------------------------------------- | --------------------------------------- |
| `INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID` | the `config_id` from step 1            | before anybody presses Connect          |
| `INSTAGRAM_UNIFIED_LOGIN_TOKEN`     | the token the callback page shows once | after the login, as the activation step |

A change to a group redeploys every service linked to it — web, worker and the
four crons — which is wanted: the worker that sends and the web service that
answers the webhook switch to the new route together. Set the config id first
and alone, so the card on `/admin/channels` reads "ready" before anybody
presses it, and the token second, once the login has produced it.

## Activation, in order

`INSTAGRAM_ACCESS_TOKEN` expired on 2026-10-29, so every Instagram call fails
today whatever this plan does, and there is no working state to protect on the
outbound side. The inbound side is different: the account is still delivering
webhooks over **both** the Page connection (in `standby`) and Instagram Login
(signed with `INSTAGRAM_APP_SECRET`), and §6.29's 844 dropped deliveries were
the cost of unsetting a secret before the connection it signed for was
disconnected. So the order is: add the new connection, prove it, and only then
take the old one away — in the dashboard first, the variable last.

1. **Set `INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID`** in the production group (above).
   When the redeploy finishes, Settings → Channels shows the "Instagram —
   Unified Login" card as ready, or lists what is still missing.
2. **Connect.** An admin holding `admin.channels.connect` presses **Connect
   Instagram**. Meta's login opens; they pick ShipBlu's business portfolio and
   the Instagram account and accept the three permissions. The callback page
   shows, once: the accounts the token reaches (the username and id must
   include `17841448759001625`, and the page warns if it does not), the
   token's type and expiry ("never expires"), the scopes against
   `requiredScopes('unified_login')`, the client business id, and the token in
   a read-only box with a Copy button. The log line is
   `[meta:unified_login] token issued agent_id=… account_ids=… usernames=…
token_type=… expires_at=…`, never the token. The page is answered to the
   browser that pressed Connect and no other: the `state` cookie that binds
   the two is `SameSite=Lax`, scoped to the login's path and lives ten
   minutes, so Meta's dialog has to be finished in the same browser profile
   within that time, or the callback says the link was not opened from the
   console and nothing is exchanged.
3. **Set `INSTAGRAM_UNIFIED_LOGIN_TOKEN`** to it in the production group. The
   redeploy that follows is the switch: from its first request,
   `metaConnection('instagram')` answers `unified_login`.
4. **Subscribe the account.** `npm run job -- subscribe_meta_webhooks
object=instagram` — on the worker, through Render's shell — writes the
   account-level half with the Unified token and reads it back; the log says
   `unified login account 17841448759001625 subscribed now: …` (or warns that
   the account has no subscription on this connection yet, which is the
   expected first answer) and ends with `unified-login-level done — subscribed:
messages, comments, …`. The app-level half it reads first and writes only when
   one of the five fields is missing from it, which the September runs already
   put right.
5. **Check the token.** `npm run job -- check_meta_permissions` inspects the
   Unified token with `debug_token` — which answers fully, because it is a
   `graph.facebook.com` token — and reads `/me/assigned_instagram_accounts`.
   Expected: `is_valid`, `expires_at` 0 (never), `instagram_basic` and
   `instagram_manage_messages` granted, `instagram_manage_comments` present,
   the account id listed. Note what it prints for `type`: see **Not known
   yet**.
6. **One reply, from a role holder's own DM.** Somebody with a role on the app
   writes to the account from their own Instagram, and an agent answers from
   the console inside 24 hours. The worker log must show
   `[send_meta] <message id> sent as dm on instagram via unified_login`,
   and the reply must arrive on the phone. A `(#10)`, `(#200)` or 190 here is
   one of the troubleshooting strings below, and the token is reconnected
   rather than retried.
7. **Watch for an hour.** The customer's next message is now delivered up to
   three times — Page (`standby`), Instagram Login (`messaging`,
   `INSTAGRAM_APP_SECRET`) and Unified Login (`messaging`, `META_APP_SECRET`).
   The endpoint stores all three — the Page's and Unified Login's copies
   share the `facebook_page` label, so `lib/meta/delivery.ts` keys them apart
   by envelope — and ingest dedupes on the `mid`. Meta says Unified Login's
   message ids differ in format from Instagram Login's, so this is the hour
   that proves a message is one timeline line and not two. The queries are
   below; a ticket showing the same words twice, seconds apart, stops the
   plan here.
8. **Disconnect Instagram Login — in the dashboard first.** Instagram → "API
   setup with Instagram login" → disconnect the account. This is the step that
   stops `INSTAGRAM_APP_SECRET` signing anything. Then wait until
   `webhook_events` shows no `instagram_login` delivery for an hour (the first
   query below). The web log's
   `instagram messaging deliveries are verifying with INSTAGRAM_APP_SECRET` line
   prints once per process, so its silence proves nothing; the query is the
   reading.
9. **Unset `INSTAGRAM_ACCESS_TOKEN`.** It is expired and second in line, so
   this changes no routing; it is removed so the card and the diagnostic stop
   describing a connection that no longer exists.
10. **Unset `INSTAGRAM_APP_SECRET` and `META_INSTAGRAM_APP_SECRET` — last.**
    Only after step 8's hour. Unsetting them while the direct connection still
    delivers is §6.29 reproduced: every one of its deliveries answered 403 and
    dropped. Each costs one HMAC per Instagram delivery while it lingers, which
    is not a reason to hurry.

The Page connection stays as it is. It is the fallback the order falls to if
the Unified token is ever unset, and Facebook has no other route.

### Verification queries

Read-only, against production, each in one `execute_sql` call.

Which connections are delivering now, by the label the endpoint gives them
(Unified Login's rows read `facebook_page`; see the second query):

```sql
select connection, signature_verified, count(*)
from webhook_events
where provider = 'meta' and channel = 'instagram'
  and received_at > now() - interval '1 hour'
group by 1, 2 order by 1, 2;
```

The same hour by envelope, which is what tells a Unified Login delivery
(`messaging`, verified with `META_APP_SECRET`) from the Page's (`standby`):

```sql
select connection,
       case when payload->'entry'->0 ? 'standby' then 'standby' else 'messaging' end as envelope,
       count(*)
from webhook_events
where provider = 'meta' and channel = 'instagram'
  and received_at > now() - interval '1 hour'
group by 1, 2 order by 1, 2;
```

A duplicated timeline after step 6 — the same customer, the same words, two
rows:

```sql
select conversation_id, body_text, count(*), min(created_at), max(created_at)
from messages
where direction = 'inbound' and created_at > now() - interval '1 hour'
  and conversation_id in (select id from conversations where channel = 'instagram')
group by 1, 2 having count(*) > 1;
```

Whether the reply went out over the new route — the worker's log, filtered on
`[send_meta]`, carries `via unified_login`; and in the database the message row
the agent sent has a null `delivery_error` and a `channel_message_id` Meta
assigned.

### Rollback

Unset `INSTAGRAM_UNIFIED_LOGIN_TOKEN` in the environment group. The redeploy
puts `metaConnection('instagram')` back to the direct connection if
`INSTAGRAM_ACCESS_TOKEN` is set, else the Page. Nothing in the database changes
at any step: no table, no row, no migration — the connection is configuration,
and `webhook_events.connection` never learned the new name. The account-level
subscription written in step 4 stays on Meta's side and is harmless; a
disconnected account under "API setup with Unified login" removes it. A token
that must be revoked: Meta's eligibility page says removing the app from the
business portfolio stops it working, and Business settings → Integrations →
Connected apps is where Facebook Login for Business says a client does that;
whether the System users page offers a narrower revocation is not confirmed.

## Not known yet

Each of these is a reading to take on the first live run and record in
`docs/PROJECT-STATE.md` §5.2, not something to assume in code:

- **What `debug_token` reports as `type` for a Business Integration System
  User token.** `SYSTEM_USER` is the guess; `refuseInspection` warns on
  anything else and refuses on nothing but `is_valid: false` or a foreign
  `app_id`, so the first run is what settles it.
- **Whether a Unified Login delivery ever arrives in `standby`.** Meta's
  migration guide lists the handover protocol as not supported, so none is
  expected, and `lib/meta/thread.ts` never blocks a Unified send on one; but a
  `standby` on an `instagram` delivery is labelled `facebook_page` whichever
  of the two sent it, so a count of `standby` rows cannot answer this alone —
  the Page's own copies are `standby` today. It is answered by the Page's
  copies stopping once Freshworks is swapped out (§5.1) while `standby` rows
  continue, or not.
- **Whether `messaging_type: RESPONSE` is accepted on the Unified send.** The
  in-window Instagram body carries it and the send goes to the Page's host,
  where the parameter is documented for every send, so yes is expected; the
  asymmetry in `lib/meta/send.ts` is not touched until a live round trip says
  it should be.
- **Whether a profile read on this route needs the Business Asset User Profile
  Access feature.** It is granted (2026-09-19), so the read should succeed for
  everybody; if it is refused with `(#3)` for a customer and not for a role
  holder, the feature is being applied per connection and §5.2's Business
  Asset entry gets a new paragraph.
- **Whether Meta ever delivers an `instagram` event to both the Page and
  Unified Login with different `mid`s.** Meta's note is about Instagram Login's
  ids differing; the Page's and Unified Login's are both Facebook Login format.
  Step 7 is the reading.

## Open questions for Meta's docs

Checked on 2026-11-04 and not answered there; ask through the developer
community or support if the first run does not settle them.

- The exact `type` string `debug_token` returns for a BISU token (the Facebook
  Login for Business page says "system-user access token" in prose and nothing
  about `debug_token`'s vocabulary).
- Whether `/me/assigned_instagram_accounts` is paginated for a portfolio with
  many accounts; the code reads the first page, which is the whole list for
  one account.
- Whether a token's `assigned_instagram_accounts` changes when the account is
  moved to another portfolio, or the token simply stops working (the
  eligibility page says it stops; reconnect either way).
- Whether the "Instagram Login Compatible" label is required for a
  configuration to be offered on the tab, or merely for the `instagram_*`
  permissions to appear in it.
- Whether the Human Agent feature, once approved, applies per app (expected)
  or per configuration.

## Troubleshooting strings

From Meta's eligibility and troubleshooting page for Unified Login, so a
search on the sentence lands here:

| Graph says                                                                                             | Means                                                                                                             | Do                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `(#10) Access is denied because the instagram account type is not business or creator.`                | The account picked in the login is a personal account                                                             | Convert it to a professional account in the Instagram app, then connect again                                       |
| `(#200) The account owner has disabled access to Instagram Direct Messaging Outside of Instagram App.` | "Allow access to messages" is off for connected tools                                                             | Instagram app → Settings → Messages and story replies → Message controls → Connected tools → allow, then send again |
| `(#10) App is missing the instagram_manage_messages permission to access Instagram user information.`  | The configuration or the grant lacks the permission, or it was unticked in the login                              | Check the configuration's permissions and `check_meta_permissions`; connect again accepting all three               |
| `190 Session has expired` / `Error validating access token`                                            | The client removed the app from the portfolio, moved the account to another portfolio, or revoked the system user | Connect again; the old token is gone for good                                                                       |
| The "API setup with Unified login" tab is missing                                                      | The app is not owned by a business portfolio                                                                      | App settings → Basic → assign a business portfolio                                                                  |
| The dialog answers "URL blocked" or "redirect_uri is not allowed"                                      | The callback is not registered, or `APP_URL` differs from the registered origin                                   | Step 2 above; compare the generated Login URL with `loginDialogUrl()`'s                                             |
| The callback page says the token reaches no Instagram account                                          | The login skipped the account, or the portfolio picked holds none                                                 | Connect again and tick the account under business assets                                                            |
| The callback page warns `INSTAGRAM_ACCOUNT_ID` is not among the accounts                               | The wrong account or portfolio was picked, or the variable names another account                                  | Compare the id shown with `INSTAGRAM_ACCOUNT_ID`; do not set the token until they agree                             |
| The callback page says the link was not opened from the console, or expired (HTTP 400)                 | No `state` cookie matched: a different browser profile, more than ten minutes in the dialog, or a reused link     | Back to Channels, press Connect Instagram again, finish in the same browser                                         |
| The callback page says Meta refused the login code (HTTP 502)                                          | The code was spent or expired, or the redirect URL on the configuration differs from the callback's               | Step 2 above, then connect again; a code is single-use                                                              |
| The callback page says the token was minted for another app (HTTP 409)                                 | `INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID` names a configuration on a different Meta app than `META_APP_ID`              | Set the config id from this app's tab, redeploy, connect again                                                      |

## Alternatives rejected

- **Renewing `INSTAGRAM_ACCESS_TOKEN`.** Sixty more days, the same outage on
  day sixty-one, and a route Meta is no longer building on.
- **Storing the Unified token in the database, sealed like the WhatsApp
  credential.** It is one value per environment that never expires; a table,
  a key and a confinement rule for a one-time paste is the second place to
  look that AGENTS.md says needs its own argument.
- **A mode variable (`INSTAGRAM_CONNECTION=unified`).** A flag that can
  disagree with the credential behind it is the §6.26 shape; presence of the
  token is the flag, as it is for the direct connection.
- **Deciding the route from the connection the message arrived on.** A Unified
  delivery is labelled `facebook_page`, so it would route every Instagram
  reply to the Page; and which delivery reached the worker first is a coin
  toss restarted on every retry (`metaConnection`'s header).
- **Recording `unified_login` on `webhook_events.connection`.** The signature
  cannot tell it from the Page's; a label the endpoint cannot justify is worse
  than one it can.
- **Registering the site root as the redirect URL, as the tab offered.** The
  code would land on the help centre, in a URL, with nothing to exchange it.
- **Keeping the ads permissions in the configuration because they were
  pre-filled.** Nothing calls them, and every permission is a review item and
  a capability a leaked token has.
- **Unsetting `INSTAGRAM_APP_SECRET` with the token.** §6.29, exactly.

## Not done, deliberately

- Any production write. The steps are above and in `docs/PROJECT-STATE.md`
  §5.1; the dashboard and Render steps are a person's.
- Token management through Meta's API (`POST
/<client_business_id>/system_user_access_tokens`) — it needs
  `business_management`, which the configuration does not ask for, and a
  never-expiring token needs no refresh.
- Telling a Unified Login delivery from the Page's at the endpoint. Nothing
  reads the difference today; the envelope answers the one question asked.
- Resubmitting `instagram_manage_comments` or Human Agent: unchanged, in
  `plans/meta-app-review-submission.md`.
- Touching `messaging_type` on the Instagram send body (AGENTS.md: not without
  a live round trip).
