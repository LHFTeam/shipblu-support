# A ticket API for the myBlu app, and the SDK that speaks it

myBlu is the recipient app: a person signs in with the phone number a
shipment's text message went to, and today has no way to reach support from
inside it. This plan gives the app tickets of its own — open one about a
parcel, read the answer, reply, attach a photo, be told when an agent answers,
rate the resolution — through an HTTP API under `/api/v1`, and gives the app's
developers a contract and an SDK so that none of them has to learn this
codebase to use it.

`plans/csat.md` named this file "to be written with whoever owns myBlu's
backend". It is written without them, so every question that is theirs is
listed under _Decisions_ with a default the work can start on.

## Context

Nothing exists. Production on 2026-11-12, read with `execute_sql` and live
requests, all read-only:

| Figure                                                        | Value  |
| ------------------------------------------------------------- | ------ |
| Conversations on the `api` channel, ever                      | 0      |
| `channels` rows of type `api`                                 | 0      |
| Routes under `/api/v1`                                        | none   |
| `MYBLU_*` variables in `lib/env.ts` or `render.yaml`          | none   |
| WhatsApp identities, almost all recipients writing to the bot | 99,439 |
| Conversations on `whatsapp_bot`                               | 97,155 |
| Web chat conversations, ever                                  | 31     |
| Postgres connections a stream can hold, of                    | 60     |

The last four rows are the size of the audience: myBlu's users are the bot's
population, not web chat's.

What the code does with `api` today, and why each is a defect once a ticket
exists:

1. **An agent's reply on an `api` ticket is queued as an email.**
   `carrierFor('api')` answers `send_email` (`lib/tickets/outbound.ts`), and a
   contact known by a phone has no address. The reply would sit failed on the
   timeline and the customer would never see it.
2. **Nothing can create one.** The only `createTicket` hard-codes
   `channel: 'portal'` (`lib/portal/tickets.ts`), and it never routes.
3. **A phone on the `api` channel is not the same person's phone on
   WhatsApp.** `normaliseIdentifier` strips to digits for `whatsapp` only, and
   `resolveContactIn` sets `primary_phone` for `whatsapp` only
   (`lib/auth/normalise.ts`, `lib/tickets/contacts.ts`). Resolved the obvious
   way, every myBlu user is a second, phoneless contact that does not even
   surface as a merge suggestion.
4. **Every call would be redirected to `/login`.** `/api/v1` is not in
   `PUBLIC_PREFIXES` (`proxy.ts`).
5. **The console calls it "API"**, grey, and it is not a filter in the inbox
   (`lib/tickets/channel-labels.ts`, `lib/tickets/channel-policy.ts`), so an
   agent could not tell a myBlu ticket from any future caller's, nor find them.
6. **There is no inbound credential of any kind** for a caller that is not a
   browser with a cookie, a provider's webhook or the widget's visitor token.

The web chat widget is not the answer for a native app, though it is what
exists. It was measured against this use on 2026-11-12: its signature covers a
merchant account id and an email and so cannot vouch for a phone; its token
lives in the WebView's storage, so a reinstall is an empty chat and a second
contact; nothing tells a closed app that an agent replied; and each open chat
holds one direct Postgres connection out of sixty. A WebView on the widget
remains the app's pilot path while this is built.

## Scope

In: a session for one myBlu user, vouched for by myBlu's backend; tickets on
the `api` channel, many per user; text and files from the customer; the agent's
text back; history that survives a reinstall; unread counts and read receipts;
a signed webhook to myBlu's backend so it can push; the survey endpoints
`plans/csat.md` stage 6 needs; the console changes that let an agent recognise
and answer a myBlu ticket; the contract, the OpenAPI document and a reference
SDK.

Out, and deliberately:

- **A stream.** No SSE and no WebSocket on this API, ever. `sessionSql()` is
  one direct backend per listener (`db/client.ts`), and sixty of them is the
  whole database. The app polls a cursor and is woken by push.
- **A server-to-server ticket API.** myBlu's backend mints and ends sessions
  and receives webhooks. It never creates a ticket or reads a message: a user
  named in a request body is a claim that one bug in somebody's proxy gets
  wrong for everybody at once.
- **Files from the agent.** No reply path on any channel uploads one today.
  The read model carries `attachments` on every message, so the day the
  console can, no app changes.
- **Shipment data.** No response ever contains anything about a parcel. The
  tracking number is "the only credential guarding the recipient's name,
  address, phone and COD amount" (AGENTS.md, _The delivery platform_), and the
  app has its own source for it.
- **A category, a form or a priority chosen by the app.** Jev files; a person
  corrects.
- **A browser client.** No CORS header and no `OPTIONS` handler. A web caller
  is a different token-storage problem and its own decision.
- **An integrations table and an admin page for one.** One caller, named in
  code; `plans/csat.md` already said "a table when there is a second caller".
- **A prebuilt chat screen in the SDK.** The app owns its screens
  (`plans/csat.md`, _myBlu_). The SDK is headless and ships a sample.
- **`ticket.status_changed` as a webhook event.** Status rides on every poll
  and on the next `message.created`; its writers do not share a transaction
  shape, and nothing waits on it.

## Decisions to take with the person who asked for it

Each has a default below so the work can start; each changes something a
customer or the app's developers see.

For whoever owns myBlu's backend and the app:

- **What is the app written in?** It decides which SDK is written first, and
  nothing else in this plan. Default: the contract is language-neutral, and the
  reference SDK is TypeScript, which runs in React Native as it stands and is
  the executable reference a Swift, Kotlin or Dart port is checked against.
- **Is there an account id that is stable for a person and never reused,
  separate from the phone?** The identity is keyed on it (`externalUserId`),
  so a recycled number is a new person. Default: required. If accounts are
  keyed by phone today, the backend mints a UUID when an account is created.
- **Can the backend make one HTTPS call to this system when the app asks for
  support, holding a secret?** That call is how a session is minted. Default:
  yes. If it cannot call out, the alternative is a short signed assertion the
  app carries here itself — a second accepted form beside the first, never a
  replacement, with a public key held here rather than a shared secret.
- **Can the backend host an HTTPS receiver and send APNs and FCM from it?**
  Without one the app works by polling and nobody is told about a reply while
  it is closed. Default: yes, and launch waits for it.
- **What does the push say?** Default: a fixed sentence of the app's own, and
  the app fetches the text. The webhook carries ids and no message text; a
  preview field is additive later and puts a customer's words through a third
  system and onto a lock screen.
- **A list of tickets, or one conversation?** Default: a list, one ticket per
  problem, opened from a shipment. It is what the survey resource in
  `plans/csat.md` already assumes.
- **Does the app embed Freshchat or link to Freshdesk today?** This repo
  cannot see the binary; `plans/freshdesk-disconnection.md` records only the
  App Store listing's support URL. Default: the app team audits it.

For the support lead and the repo's owner:

- **Join a verified myBlu phone to the existing WhatsApp contact for that
  number?** Default: yes, for the agent only — one customer, one history — and
  the API still shows the app nothing but its own `api` tickets. The three
  places this repo refuses to adopt a contact by phone all refuse an
  _unproven_ one; a phone the backend vouched for after an SMS code is the
  same proof WhatsApp itself rests on.
- **Which group, and which routing mode?** Default: Customer Care,
  `default_group`; `category_shadow` for a week before `category`.
- **Should the out-of-hours acknowledgement reach myBlu tickets?** A rule with
  no channel already matches `api`, and after stage 1 it is delivered in the
  app instead of failing. Default: yes, after reading the wording once as an
  app message.
- **Is the agent's name shown?** Default: first name only. The portal shows
  the full name; this audience is two orders of magnitude larger.
- **How many tickets may one user open?** Default: ten open at once and ten new
  ones an hour. Nothing caps tickets per contact anywhere today.
- **Where do the app's developers test?** Default: a mock from the OpenAPI
  document from day one, then staging resumed for named windows with its own
  secrets and two console seats for them. A staging app pointed at production
  would put production's minting secret in a staging backend.

## The model

### Two planes

|              | Who calls                | Credential                                 | May do                                  |
| ------------ | ------------------------ | ------------------------------------------ | --------------------------------------- |
| Server plane | myBlu's backend          | `Authorization: Bearer <MYBLU_API_TOKEN>`  | mint a session for a user; end sessions |
| Client plane | the app, through the SDK | `Authorization: Bearer <session token>`    | everything else, as that one user       |
| Webhook      | this system's worker     | HMAC over the body, `MYBLU_WEBHOOK_SECRET` | tell the backend something happened     |

`plans/csat.md` sketched one bearer, `MYBLU_API_TOKEN`, for the whole
integration. That cannot ship in an app binary: a value compiled into one is
extractable, and whoever extracts it is every recipient. Kept on the backend
and used for everything, it names no user, collapses every rate limit to one
bucket and makes the SDK an SDK for somebody else's server. So the token keeps
its name and loses its reach: it mints and revokes, and nothing else accepts
it.

The session is minted server to server rather than by an assertion the device
carries here, because both end in the same row and the first has nothing for
two teams to build byte for byte. The one signing contract this repo has
already handed to another team was written down wrongly
(`docs/embedding-the-widget.md` says an account id is normalised to "digits
and letters only" where the code keeps `-` and `_`), and a backend that
followed the document got a 401.

### The session

- **Opaque, and stored as its hash.** `generateToken()` and `hashToken()`
  (`lib/auth/tokens.ts`), with the prefix `sbu_` so a scanner and a log
  scrubber can recognise one. A dump of the table authenticates nobody, which
  is the whole of the argument AGENTS.md asks for before a second table holds
  anything credential-shaped: it holds what `sessions` and `contact_sessions`
  hold.
- **A table of its own, `api_sessions`,** not `contact_sessions` with a
  discriminator. The schema's reason for keeping agents and customers apart
  applies again: "one missed `where` clause turns a customer's cookie into an
  agent's" (`db/schema/customers.ts`). `/api/v1` never reads a cookie, and a
  test holds that a valid console cookie with no bearer is a 401.
- **Twenty-four hours from minting, fixed, with no refresh token.** A sliding
  expiry is a write on the request path of an API that is polled, behind an
  admission gate of eight (`db/client.ts`). With a fixed life a request writes
  nothing. A new token costs the app one call to its own backend, which is
  also the moment that backend knows whether the user is still signed in — and
  a sign-out that never reached us (the merchant dashboard's `clear()` did not,
  `docs/PROJECT-STATE.md` §6.112) leaks for a day at most.
- **A blocked or deleted contact is refused on every request,** as
  `getSessionCustomer` refuses one.
- **Unset is inert.** While `MYBLU_API_TOKEN` is unset the server plane answers
  `503 not_configured` and nothing can mint. That is what lets every stage
  deploy before anybody at myBlu holds a value.

### Identity

- The identity row is `('api', 'myblu:<externalUserId>')`, `is_verified = true`,
  with the phone the backend vouched for held beside it. The column comment on
  `is_verified` widens from "clicked a verification link" to "or vouched for
  by a backend that verified it".
- The phone is strict E.164 with its plus, `^\+[1-9]\d{7,14}$`, refused
  otherwise and never guessed: `normalisePhone` only strips non-digits, so
  `01001234567` would become a different person from `201001234567`, silently.
- **Resolution, in a new function in `lib/tickets/contacts.ts`** — that
  module's header warns against a second copy of the lookup — reads before its
  transaction and inserts inside it, as `pendingContact` and
  `resolveContactIn` do. In order: the existing `api` identity; else the
  contact owning `('whatsapp', <digits>)`, _when no other `api` identity
  already hangs off it_; else a new contact with `primary_phone` set, so a
  merge suggestion can still find it.
- **One `api` identity per contact at resolution** is what keeps a recycled
  number honest without a column on `conversations`. The new holder is a new
  `externalUserId`; the previous holder's contact already carries an `api`
  identity; so the new holder gets a contact of their own and reads nothing of
  the old one's. Where the previous holder never used myBlu, the new one joins
  that WhatsApp contact — which is what WhatsApp itself does today on a
  recycled number — and the app still sees nothing, because there are no `api`
  tickets on it.
- No `whatsapp` identity is ever written from a session. Holding a SIM today
  says nothing about a WhatsApp account.
- A contact's name is never overwritten by the name the backend sends, and an
  automated reply on an `api` ticket leaves `{{customer_name}}` blank as the
  comment path does: the stored name can be a previous holder's.

### What the app can read

Every statement the API runs about a ticket carries, in the same `WHERE` as
the id:

```
requester_contact_id = <the session's contact>
and channel = 'api'
and deleted_at is null and is_spam = false and merged_into_id is null
```

"Looking the ticket up first and comparing afterwards is the same bug written
more slowly" (`lib/portal/tickets.ts`). It is built in one place,
`ownedTicket(caller)` in `lib/api/scope.ts`, and every function in
`lib/api/tickets.ts` takes the caller as a required first argument — the
device `readableByRole(role)` uses, so a new read cannot forget it and still
compile. Not yours, not found, deleted, merged away and not-`api` are one
`404` from one query.

`channel = 'api'` is the half that is easy to drop. The portal lists every
ticket of the contact; copied here, a myBlu user whose contact is the one their
WhatsApp history hangs off would read that history in the app, and so would
whoever holds the number next. For the same reason **the portal stops listing
`api` tickets** in the stage that creates the first one.

Messages are read with `kind = 'reply'` and `notReaction()` _in the query_,
"so they are not in the payload to leak": never a note, a `system` row, a
forward. Only `body_text`; never `body_html`, `raw_body`, `meta` or an address.
A ticket is a named field list built fresh, as `publicTracking()` is, and it
has no assignee, group, priority, category, tag, custom field, SLA date or
event in it. `status` is the status's category, four stable words;
`statusLabel` is `ticket_statuses.customer_label` where `visible_to_customer`,
else null.

### Tickets

- **Many, one per problem.** `POST /tickets` creates; a reply to a `resolved`
  ticket reopens it through `reopenResolved`; a reply to a `closed` one is
  `409 ticket_closed` and the app offers a new ticket. One endless thread per
  user would pile unrelated parcels into one category, one assignee and one
  survey, and needs `ThreadKey` widened.
- **Its own insert path, `createApiTicket` in `lib/api/tickets.ts`,** shaped
  like an ingest path and not a second parameter on `createTicket`, which is
  the forms' function. It carries the three routing halves from the first day
  (`planRouting` before the transaction, `routingWindowValues` in the insert,
  `startRouting` on `tx`), so the row costs nothing on `default_group` and
  needs no change the day the support lead sets it to `category`. Order:
  the pool's reads (idempotency pre-check, the channel row, `planRouting`);
  one `now`; one transaction (the conversation, the message, the
  `opened_from_app` event, `startRouting`); then, after the commit,
  `afterMessageStored` and `afterInboundMessage`, which run the on-create
  rules, `applySlaOnCreate`, `beginRouting`, assignment and the out-of-hours
  reply in the order every other path does. AGENTS.md's list of paths that
  route gains "and the customer API".
- **A `channels` row of type `api`** supplies the default group, the hours and
  the routing mode, read by `apiChannel()` — the oldest active row, the rule
  `portalChannel` and `webchatChannel` follow. An admin creates it on
  `/admin/channels`, since which group is the support lead's call and no seed
  can know it. **No active row, and `POST /tickets` answers
  `503 not_configured`** while reads and replies on existing tickets go on
  working: deactivating the row stops new work without cutting a customer off
  mid-conversation, and it is the way back for every stage from 4 on.
- **The subject is the opening message's first line,** as on every chat
  channel. No title field in v1.
- **Provenance is an event, not a column.** `opened_from_app`, written in the
  creating transaction so the on-create rules and the header see it:
  `{ client: 'myblu', platform, appVersion, identityId }`. The console draws
  events and never message meta, which is why web chat's `pageUrl` is on every
  message and on no screen. `requester_kind` is `recipient`.
  `messages.meta` carries `{ locale, client }`, and `requesterLocale` gains an
  `api` arm beside web chat's so a photo with no caption is still answered in
  the app's language.
- **A tracking number the app sends is a claim.** It is linked as a number the
  customer typed (`linkSource: 'detected'`), never `platform`; it writes
  neither `shipments.recipient_contact_id` nor `contact_shipping_accounts`.

### Idempotency

`Idempotency-Key`, a UUID the SDK makes before its first attempt and reuses on
every retry, is required on the two requests that write a message. It is
stored as `messages.channel_message_id = 'api:<identityId>:<key>'`.

- Namespaced because that column's unique index covers the whole table: a bare
  client UUID would share a keyspace with every wamid and Message-ID. By
  identity and not by contact, because a merge re-points identities and the
  key must still be the same string.
- It covers creation, since a ticket is created by its first message, so no
  second table and no use of `conversations.external_id`.
- Pre-checked on the pool as every ingest path does; the index is the
  backstop, and a 23505 rolls the conversation back with its `settle_routing`
  key and answers what the first request stored. A replay is `200` with
  `Idempotent-Replayed: true`; the first time is `201`.
- Every message the user wrote carries the key back as `clientId` on every
  read, not only in the POST's answer. That closes the case chat clients get
  wrong first: the answer is lost, the next poll returns the message, and the
  outbox still holds it.

### Reading without a stream

- `GET /tickets/{id}/messages` with no cursor returns the **newest** page.
  `before` pages back to the start; `after` returns what is newer. Both
  existing read models are `orderBy(asc).limit(200)`, which silently stops
  showing a long conversation's new replies.
- A cursor is opaque base64url of Postgres's own timestamp text and the row
  id, the inbox's form (`lib/tickets/inbox-filters.ts`): a JS `Date` holds
  milliseconds where `timestamptz` holds microseconds, and a round trip skips
  or repeats a row. A cursor this server did not mint is `400 invalid_cursor`,
  never a first page.
- **`created_at` is not commit order,** so `after` re-reads a few seconds
  before its cursor and a page may repeat rows the client holds. The one rule
  an SDK needs is "merge by `id`".
- **Every answer carries `pollAfterSeconds`, and the SDK obeys it.** An app
  release takes days to reach users and old builds live for months; load is
  shed by a change here, not by a release there. Five seconds on an open
  thread to start, thirty on the list, nothing in the background.
- A poll is the session lookup and one statement over
  `messages_conversation_idx`, with no write and no session connection at any
  number of users. Its cost is measured with `EXPLAIN ANALYZE` on production
  in stage 5, before five seconds is called final.

### Read receipts

`POST /tickets/{id}/read` with the newest message on screen sets `read_at` and
`delivery_status = 'read'` on the agent's replies up to it. Both columns
exist, nothing else writes them on a channel without a provider, and the
console's bubble already draws a `read` receipt from the row. So the agent
sees "Read" and the app's unread count is `read_at is null`, with no new
column, the same answer on two devices and after a reinstall.

### An agent's reply

- **The row is the delivery.** One predicate beside `sendsByEmail`,
  `rowIsDelivery(channel)`, true for `webchat` and `api`, replaces the tests
  that name web chat for that reason in `lib/tickets/outbound.ts`,
  `lib/tickets/agent-reply.ts` and `app/(console)/reply-actions.ts`. Written
  `delivered`, meaning "stored where the customer's client reads it".
- **A failed push never marks a reply failed.** The reply is in the app on its
  next poll. That differs from every carrier and is said in AGENTS.md.
- **The trap this springs:** once `api` stops being email, `decideSurvey`
  falls to its last line and answers `widget_card` for a widget that does not
  exist. The same change gives `api` an explicit arm,
  `skip: channel_unsupported`, until stage 8 turns it into `api_pull`.
- An agent can send plain text, a canned response and a note, which is never
  returned. No HTML, no file.

### The webhook

One `notify_myblu` job per event, enqueued from the two doors every outbound
reply passes (`storeAgentReply`, `enqueueAutomatedDelivery`) and only while
`MYBLU_WEBHOOK_URL` is set — the `instagramLoginConfigured()` device, and the
deploy rule that a new job type is queued only behind a switch.

```
POST <MYBLU_WEBHOOK_URL>
Content-Type: application/json; charset=utf-8
X-ShipBlu-Event: message.created
X-ShipBlu-Event-Id: message.created:6f1c…
X-ShipBlu-Timestamp: 1794477002
X-ShipBlu-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>

{ "id": "message.created:6f1c…", "type": "message.created",
  "occurredAt": "2026-11-12T09:41:07.004Z",
  "user": { "externalId": "u_83412" },
  "ticket": { "id": "8a1f…", "number": 4812, "status": "open" },
  "message": { "id": "6f1c…", "from": "agent" } }
```

- **Ids only, in the job and in the body.** A dead job's payload is kept for
  good; the body is rebuilt from the rows when it is sent; text purged before
  a retry lands is never sent late.
- `user.externalId`, never the phone: it is the receiver's own key, and it
  keeps a number out of a third system's request log.
- HMAC over the raw bytes is the scheme every Meta integrator already
  verifies, with the timestamp Meta's lacks inside the signed text. While
  `MYBLU_WEBHOOK_SECRET_PREVIOUS` is set the header carries two `v1=` values
  and the receiver accepts either.
- The handler re-reads the message and requires an outbound `reply` on an
  `api` ticket not deleted, spam or merged, so a hand-made payload cannot
  carry a note out. A row gone is `subjectGone()`. A refusal by the receiver
  is a plain error and the queue's retry, never `PermanentJobError`. The call
  has a deadline (`lib/http/deadline.ts`) and `redirect: 'error'`. A URL that
  is not `https`, or carries userinfo or a query string, is refused. A URL
  with no secret sends nothing.
- `dedupeKey: notify_myblu:message:<messageId>` — once ever for a message,
  the argument `send:<messageId>` makes. Conversation-scoped in `purge-jobs`.
- Receiver's rules, in the contract: verify over the raw body; refuse a
  timestamp more than five minutes off; dedupe on the event id for a day,
  because the worker runs a job at least once; answer 2xx and do the work
  after; treat the webhook as a hint and `GET …/messages` as the truth.
- myBlu's backend holds the push credentials and the device tokens. This
  system holds neither, so there is no device-registration endpoint.

### Files

- `multipart/form-data` on the two message POSTs, the widget's shape, with
  the widget's own functions: `checkWidgetFiles`, `sniffWidgetFile`,
  `readVisitorUploads`, `cleanFilename`, and `storeVisitorFiles` exported
  rather than copied. Five files, 25 MB each and in total, 5,000 characters;
  the type is read from the bytes. The numbers are published by
  `GET /config`, not compiled into an SDK, because they move with
  `proxyClientMaxBodySize`.
- **`Content-Length` is required.** The proxy truncates an oversized body
  rather than refusing it, and the header is the only guard.
- No upload endpoint and no presigned upload: bytes before a message is
  "storage with nothing to explain it", and a presigned upload skips the
  sniff that decides `attachments.content_type`.
- **Download by bearer.** `GET /attachments/{id}` answers
  `{ url, expiresAt }`, a five-minute Storage link. JSON and not a redirect,
  so no HTTP library has to decide whether to forward `Authorization` to
  another host. The widget signs a link of its own only because an `<img>`
  cannot send a header.

### Limits

In memory and per instance (`lib/http/rate-limit.ts`), so abuse control and
not a quota, and keyed on the identity rather than the address: "carrier-grade
NAT puts a large number of unrelated people behind one address"
(`lib/auth/throttle.ts`). A refusal is `429` with `Retry-After`. No row per
refusal.

| Bucket                   | Key              | Limit                           |
| ------------------------ | ---------------- | ------------------------------- |
| Any request, before auth | address          | 1,200 a minute                  |
| Bad bearer               | address          | 120 a minute                    |
| Minting                  | `externalUserId` | 10 in ten minutes               |
| Reads                    | identity         | 240 a minute                    |
| Sends                    | identity         | 20 a minute                     |
| New tickets              | identity         | 10 an hour, and 10 open at once |
| Uploaded megabytes       | identity         | 100 an hour                     |

## The API

Base: `https://support.shipblu.com/api/v1`, kept in the app's remote config.
That host answered from this app on 2026-11-12; `KB_PUBLIC_HOST` had not been
moved to it, which stage 0 settles. JSON, UTF-8, ISO-8601 UTC, UUID ids. No
credential in a URL on any route.

It changes by addition: new fields and new enum values appear without notice
and a client ignores what it does not know. A breaking change is `/api/v2`
beside `/api/v1`. `426 client_upgrade_required` exists from the first day, so
a broken SDK build can be told to update rather than left failing.

One error shape, new to this repo, where the widget's routes answer five:

```json
{ "error": { "code": "ticket_closed", "message": "English, for a developer's log" } }
```

The app translates from `code`: `invalid_request`, `invalid_cursor`,
`idempotency_key_required`, `empty_message`, `file_refused`, `unauthenticated`,
`session_expired`, `blocked`, `not_found`, `ticket_closed`, `too_many_open`,
`too_large`, `rate_limited`, `upload_failed`, `not_configured`,
`client_upgrade_required`.

| Plane  | Method and path                    | Body                                                                 | Answers                                                                              | Stage |
| ------ | ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- |
| Server | `POST /sessions`                   | `{ externalUserId, phone, name?, client: { platform, appVersion } }` | `201 { token, expiresAt }`                                                           | 3     |
| Server | `POST /sessions/revoke`            | `{ externalUserId, reason }`                                         | `204`, whether or not the user is known                                              | 3     |
| Client | `DELETE /session`                  |                                                                      | `204`                                                                                | 3     |
| Client | `GET /config`                      |                                                                      | `{ user: { id }, limits, support: { online, opensAt, timezone }, pollAfterSeconds }` | 3     |
| Client | `POST /tickets`                    | `{ text, locale, trackingNumber? }`, or multipart                    | `201 { ticket, message }`                                                            | 4     |
| Client | `GET /tickets/{id}`                |                                                                      | `{ ticket }`                                                                         | 4     |
| Client | `GET /tickets/{id}/messages`       | `?after=` `?before=` `?limit=`                                       | `{ messages, nextCursor, prevCursor, ticket, pollAfterSeconds }`                     | 4     |
| Client | `POST /tickets/{id}/messages`      | `{ text, locale }`, or multipart                                     | `201 { message, ticket }`                                                            | 4     |
| Client | `GET /tickets`                     | `?before=` `?limit=`                                                 | `{ tickets, nextCursor, unreadTotal, pollAfterSeconds }`                             | 5     |
| Client | `POST /tickets/{id}/read`          | `{ upTo: <messageId> }`                                              | `204`                                                                                | 5     |
| Client | `GET /attachments/{id}`            |                                                                      | `{ url, expiresAt }`                                                                 | 7     |
| Client | `GET`, `POST /tickets/{id}/survey` | as `plans/csat.md` gives them                                        | as `plans/csat.md` gives them                                                        | 8     |

```json
{
  "id": "8a1f…",
  "number": 4812,
  "subject": "My parcel was left with a neighbour",
  "status": "open",
  "statusLabel": null,
  "canReply": true,
  "createdAt": "2026-11-12T09:29:58.123Z",
  "lastMessageAt": "2026-11-12T09:41:07.004Z",
  "unreadCount": 1,
  "preview": { "from": "agent", "text": "We have asked the courier…" }
}
```

```json
{
  "id": "6f1c…",
  "from": "agent",
  "authorName": "Sara",
  "text": "We have asked the courier to redeliver tomorrow.",
  "createdAt": "2026-11-12T09:41:07.004Z",
  "clientId": null,
  "attachments": [
    { "id": "…", "filename": "IMG_0412.heic", "contentType": "image/heic", "sizeBytes": 2203114 }
  ]
}
```

`from` is `customer` for an inbound row, `agent` for an outbound one a person
wrote, `system` for an outbound one nobody did — the acknowledgement, a rule's
reply — which is the widget's mapping.

The exact shapes live in `lib/api/schemas.ts`, which the routes validate with,
and are published from there (below). The tables above are the plan; the
schemas are the contract.

## The SDK

"An SDK" is three things, and they live in two places.

### In this repository: the contract

| Piece                        | Where                                                                                                           | Held by                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Request and response schemas | `lib/api/schemas.ts`                                                                                            | the routes parse with them                                                       |
| OpenAPI 3.1 document         | built by `lib/api/openapi.ts`, committed as `docs/myblu-api.openapi.json`, served at `GET /api/v1/openapi.json` | `lib/api/openapi.test.ts` fails when the committed file and the schemas disagree |
| The guide                    | `docs/myblu-api.md`                                                                                             | review; it is `docs/embedding-the-widget.md`'s twin for this API                 |
| Test vectors                 | in the guide and in the tests that check them                                                                   | one webhook signature under a throwaway secret                                   |
| Conformance scenarios        | in the guide                                                                                                    | every SDK runs them                                                              |

zod 4 ships a JSON Schema converter, so the document needs no new dependency
for `knip` to gate; whether `z.toJSONSchema` gives what the drift test needs is
the first thing stage 4 finds out, and if it does not, the components are
written by hand and the test parses the guide's examples with the schemas
instead. Serving the document makes its builder a live export, and lets the
app's developers fetch the contract of the server they are talking to.

The guide opens with its audience, gives the base URL per environment, the
backend's two snippets (mint a session; verify a webhook) in the languages the
backend team names, the field tables, what is not in the contract, and a
"moving off Freshchat" mapping if the audit finds one in the app.

### In a repository of its own: the code

SDK source does not live here, and this is not a preference. `package.json`
has no workspaces; `dead-exports` fails every export nothing here imports,
which is what an SDK's public surface is; `knip` reports a nested package's
imports as unlisted; `tsc`, ESLint and Prettier sweep every tracked file; and
Render builds the whole repo on every deploy. AGENTS.md says to change a rule
rather than exempt a call site, and "exempt a published package" buys the
helpdesk nothing.

It goes in a new repository — the owner creates it; `shipblu-support-sdk` is
the default name — released from tags, cut from the OpenAPI document.

| The app is     | Reference SDK                        | Made of                                                           |
| -------------- | ------------------------------------ | ----------------------------------------------------------------- |
| React Native   | a TypeScript package                 | hand-written throughout; storage and connectivity behind adapters |
| Flutter        | a Dart package                       | generated transport, hand-written core                            |
| Swift + Kotlin | a Swift package and a Kotlin library | generated transport, hand-written core, twice                     |

**Until the stack is known, TypeScript is written first.** This team writes
it, it is the whole SDK if the app is React Native, and for the other two it
is the reference the port is checked against, running the conformance
scenarios in its own CI.

### What every SDK does

Headless: transport, token refresh, an outbox, sync, the push hand-off, typed
models, and Arabic and English sentences for every error code a user can meet.
The same names in every language:

```ts
const support = ShipBluSupport.configure({
  baseUrl, // from remote config
  tokenProvider: () => myBackend.supportSession(), // { token, expiresAt }
  locale: () => 'ar' | 'en',
  client: { platform, appVersion },
  storage, // an adapter: the platform's secure store
});

support.tickets.list({ cursor? })
support.tickets.get(id)
support.tickets.create({ text, trackingNumber?, files? }) // a PendingSend
support.messages.send(ticketId, { text, files? })         // a PendingSend
support.thread(ticketId)      // start(), stop(), loadOlder(), observe(cb)
support.tickets.markRead(id, upToMessageId)
support.unread.observe(cb)
support.survey.get(ticketId) / support.survey.answer(ticketId, { rating, comment? })
support.push.handle(payload)  // null for a payload that is not ours
support.reset()               // sign-out
```

The behaviours a generated client does not give, which the guide states as
rules and the conformance scenarios check:

1. **One refresh at a time.** On `401 session_expired`, ask the token provider
   once and replay the request once. Concurrent callers share the refresh. A
   second 401 surfaces; it never loops.
2. **A key per send, made before the first attempt** and kept in a persisted
   outbox with the text and the files' local paths. A send whose answer was
   lost is retried with the same key. An entry a day old is failed and shown,
   not sent: a complaint that sends itself after the parcel arrived is worse
   than one the user is asked about.
3. **Merge by `id`, and match the user's own messages on `clientId`.** A page
   may repeat rows.
4. **Poll only in the foreground, at the server's `pollAfterSeconds`.** Back
   off with jitter on `429` and `5xx`, honouring `Retry-After`. On `426` stop,
   and tell the app once.
5. **Who is reading.** The local store and the outbox are namespaced by
   `config.user.id`. On start and after every refresh the SDK reads
   `GET /config`; a different user, and the store is wiped before anything is
   drawn or sent. This is `judge()` from `lib/widget/person.ts` restated for a
   native client, for the reason it exists there: a sign-out that never
   arrived.
6. **The token lives in the Keychain or a Keystore-backed store,** excluded
   from backups, and never in a log, a crash report or analytics. The SDK
   refuses a base URL that is not `https`.
7. **Always send `Content-Length`** on a multipart body, which means building
   it in a file first; images are scaled to 2,048 pixels on the long edge
   before upload.
8. **Ignore unknown fields and unknown enum values.**

The push payload the SDK recognises is the webhook's ids as string keys
prefixed `sb_`, forwarded by myBlu's backend; `push.handle` fetches the
ticket's new messages and returns the ticket to open.

## The console

No new page. `CHANNEL_LABELS.api` becomes "myBlu app", so the badge, the
reports, the views and the condition builder all say it; the channel gets a
handset glyph on the neutral tone our own channels keep; it joins
`FILTERABLE_CHANNELS`, the rule and SLA-policy channel options and the
auto-response channel list; the CSAT admin page reads the shared label instead
of a private "API"; the contact page prints the label and not `api`. The
channel row can be created and edited on `/admin/channels`. The ticket header
carries "Phone verified by myBlu · iOS 3.2.1", read off the `opened_from_app`
event as the unverified-submitter badge is read off its own.

What needs nothing, read and not assumed: the inbox's "all" query, the live
topics, SLA, assignment, Hand to, the classifiers, the rollup's channel slice
and the live board carry any channel; the reply box refuses only what
`refuseIfReadOnly` and `refuseIfNoConsoleReply` name, and neither names `api`.

## Stages

Each is one pull request into `dev`, verified before the next starts. "Ships"
means the `dev` → `main` release that carries it: all six production services
deploy at once and only the web service migrates. New files are staged before
`repo-rules.mjs` is run, or it cannot see them.

**0. Preconditions, no code.** This plan, and the lines of `plans/csat.md`
that pointed at it. The answers under _Decisions_. The lasting hostname named,
and `KB_PUBLIC_HOST` set to it. The repository for the SDK created. Nothing is
set in Render.

**1. `api` stops being email.** No schema, no variable, no job.
`rowIsDelivery()`; `decideSurvey`'s explicit arm; `UNNAMED_SUBJECT`; every
label and list under _The console_ but the row editor and the badge.
Verified by the `outbound` and `decision` tests changed, and a
`*.db.test.ts`: an agent's reply and an automated one on an `api` ticket are
stored `delivered` and queue no job. On production beforehand, read-only:
`api` conversations are still 0, so no stored ticket changes behaviour. Way
back: revert; nothing stored differs.

**2. The channel row.** `api` in the channel types an admin can add;
`apiChannel()`. Verified by a `*.db.test.ts` (the oldest active row; none) and
the form in a browser. After it ships, a person creates "myBlu app" with its
group in the console — the first thing here that waits for `main`. Way back:
deactivate the row.

**3. Sessions.** `api_sessions`, generated and additive. `MYBLU_API_TOKEN` and
`MYBLU_API_TOKEN_PREVIOUS` in `lib/env.ts` and `render.yaml` in one commit,
plain optional strings, listed as comments in the production and staging
groups. `lib/api/auth.ts`, `sessions.ts`, `scope.ts`, `errors.ts`,
`schemas.ts`; the phone-keyed resolver in `lib/tickets/contacts.ts`; the four
routes; `/api/v1` in `PUBLIC_PREFIXES` with a case in `proxy.test.ts`; the
sweep in `cleanup`; `docs/myblu-api.md` born with the backend's minting
snippet. Verified by a `*.db.test.ts`: a new contact gets `primary_phone`; a
phone with a WhatsApp contact joins it; a second `externalUserId` on that
phone does not; a blocked contact, an expired token, a revoked one and a
`contact_sessions` token are each refused; a national-format phone is a 400.
On production after it ships, with the token unset: `POST /api/v1/sessions`
answers `503`, and `GET /api/v1/config` a `401` and not a redirect. Way back:
unset the token.

**4. Tickets.** No schema. `lib/api/tickets.ts`, the four routes, the cursor,
`opened_from_app` with its label and badge, the `api` arm in
`requesterLocale`, the portal's exclusion of `api`, the OpenAPI document and
its drift test. Verified by `tickets.db.test.ts`: one key twice is one ticket;
two creates racing on a key answer the same ids; another contact's ticket, the
same contact's WhatsApp ticket and a merged one are each 404; a note is never
returned; `after` returns a row stamped earlier and committed later; a reply
reopens `resolved` and is refused on `closed`; a row in `category` mode gets
its window, its `routing_decisions` row and one `settle_routing` job; no bare
`Date` survives in `toSQL().params`. Then on production, by the owner, with
the token set and a named test phone: mint, create, see "myBlu app" and the
badge in the inbox, answer from the console, read the answer back, delete the
ticket. The pull request says plainly that this writes to production and what
removes it. **The SDK's 0.1 is cut from here.**

**5. History and unread.** No schema. The list, the read marker, hours on
`GET /config`. Verified by tests (the list is scoped and stable under a tie;
`read` is idempotent and touches only the agent's replies; a fresh session
for the same user lists the same tickets) and by `EXPLAIN ANALYZE` of the
poll and the list on production, read-only. **A pilot can run from here.**

**6. Push.** `MYBLU_WEBHOOK_URL`, `MYBLU_WEBHOOK_SECRET`,
`MYBLU_WEBHOOK_SECRET_PREVIOUS`. `notify_myblu` in `JobType`, `JOB_PAYLOADS`,
its handler and registration, `scripts/ci/db-jobs.txt` and `purge-jobs`.
Verified by the signature vector in the guide, and a `*.db.test.ts`: a reply
queues one job and a second call none; a note, a web chat reply and an unset
URL queue none; the handler refuses a note's id. On production: the URL set to
a request bin the owner controls, one reply to a test ticket, the delivery
verified by hand; then the URL is myBlu's. Way back: unset the URL. **The
launch waits for this.**

**7. Files.** No schema. Multipart on the two POSTs, the download route,
`api` in the chat channels that draw media inline. Verified by tests (the
attachment rows are in the message's transaction; a failed one removes the
objects; another contact's file, a note's and a web chat file are refused) and
on a phone with a HEIC, a video near the ceiling, a PDF and a sixth file.

**8. The survey — `plans/csat.md` stage 6.** `api_pull` and the `api` answer
source, generated, with nothing in a migration using either value; the two
routes, authenticated by this plan's session; the `survey.created` event. Way
back: `survey_api` off.

The SDK follows the API: 0.1 after stage 4 (text and polling), 0.2 after 5
(history, unread), 0.3 after 6 (push), 0.4 after 7 (files), 1.0 after 8.

Documentation moves in the pull request that makes it stale: AGENTS.md gains
`app/api/v1/` under _Layout_, a paragraph of the rules below, `rowIsDelivery`
in the automated-sender paragraph, `notify_myblu` under _Background work_ and
"the customer API" among the paths that route; `README.md` the API surface;
`docs/PROJECT-STATE.md` the row, the variables and what is live.

The rules AGENTS.md gains, as they would be written:

- Every `/api/v1` read and write is scoped by the session's contact and
  `channel = 'api'` in the same `WHERE` as the id.
- `kind = 'reply'` is in the query, never a filter over rows already read.
- No credential in a URL, and no stream: a cursor to poll.
- A request body naming a phone, a contact or a ticket's owner is a claim.
  Only the session says who is asking, and only the server plane says who a
  session is.
- The API changes by addition. What `docs/myblu-api.md` says a field means is
  fixed once an app build depends on it.

## Risks and what is deliberately not solved

- **myBlu's backend is the root of trust.** A bug there that mints the wrong
  user is that user, and nothing here can tell. Bounded by a day's session,
  the revoke call, and session rows that say who was vouched for.
- **`MYBLU_API_TOKEN` mints any user.** It is per environment, rotates with
  `_PREVIOUS`, and is never logged; but it is a shared secret, and a leak on
  either side is every recipient's myBlu tickets until it is rotated. The
  signed-assertion form with a public key here is the upgrade if that is
  judged too much.
- **A stolen session token works for up to a day.** Proof of possession on
  every request is not built.
- **An agent's merge joins two app users' tickets.** A merge re-points
  identities, and the API scopes by contact, so two `api` identities merged
  onto one contact each read the other's myBlu tickets. Resolution never
  creates that state; a person does, by saying the two are one. The stricter
  form — a table recording which identity opened each ticket — is the change
  if the merge screen cannot carry the warning.
- **An agent merging an `api` ticket into another removes it from the app.**
  Correct for isolation, and surprising for the user.
- **Polling load is estimated.** Five hundred open threads at five seconds is
  a hundred requests a second on one instance behind a gate of eight; the
  statement is small and the number is not measured until stage 5.
  `pollAfterSeconds` is the valve.
- **The reply and its webhook are not one transaction.** A process dying
  between them leaves a reply with no push, as it leaves any carrier's reply
  unsent today — and here the reply is already readable.
- **Limits are per instance and forgotten on a deploy.**
- **Customer text goes to TypeSafe,** as on every channel the team answers.
  myBlu's privacy notice should know.
- **A test ticket on production is a real ticket.** It starts clocks and is
  counted, which is why stages 4 and 6 say so and delete what they made.
- **Not determined:** the app's stack; whether a stable user id exists; the
  format the backend holds phones in; how a 25 MB upload over mobile data
  fares against Render's request timeout; whether the worker has a fixed
  egress address for the receiver to allow.

## Sources

- `plans/csat.md`, _myBlu — the `api` channel_ and stage 6: the survey
  endpoints, `notify_myblu` and the variables' names.
- `docs/embedding-the-widget.md`: the shape of a contract handed to another
  team, and the cost of one written down wrongly.
- `lib/portal/tickets.ts`: the customer's read model, and scoping in the
  `WHERE`.
- `lib/widget/`: files, sniffing and the limits; `person.ts` for who is
  reading.
- `lib/routing/start.ts`: the three halves an insert path owes.
- `docs/PROJECT-STATE.md` §6.91 (the pool), §6.112 (a sign-out that never
  arrived).
