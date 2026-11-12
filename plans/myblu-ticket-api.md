# A ticket API for the myBlu app, and the SDK that speaks it

myBlu is the recipient app: a person signs in with the phone number a
shipment's text message went to, and today has no way to reach support from
inside it. This plan gives the app tickets of its own — open one about a
parcel, read the answer, reply, attach a photo, be told when an agent answers,
rate the resolution — through an HTTP API under `/api/v1`, and gives the app's
developers a contract and an SDK so that none of them has to learn this
codebase to use it.

`plans/csat.md` named this file as one "to be written with whoever owns myBlu's
backend". It is written without them, so every question that is theirs is
listed under _Decisions_ with a default the work can start on.

## Context

Nothing exists. Production on 2026-11-12, read with `execute_sql` and live
requests, all read-only; the three counts of traffic moved during the day and
are as of 14:40 UTC:

| Figure                                                        | Value        |
| ------------------------------------------------------------- | ------------ |
| Conversations on the `api` channel, ever                      | 0            |
| `channels` rows of type `api`                                 | 0            |
| Routes under `/api/v1`                                        | none         |
| `MYBLU_*` variables in `lib/env.ts` or `render.yaml`          | none         |
| WhatsApp identities, almost all recipients writing to the bot | about 99,400 |
| Conversations on `whatsapp_bot`                               | about 97,200 |
| Web chat conversations, ever                                  | 31           |
| Postgres `max_connections`                                    | 60           |

Rows five to seven are the size of the audience: myBlu's users are the bot's
population, not web chat's. The last is what a stream would spend.

What the code does with `api` today, and why each is a defect once a ticket
exists:

1. **An agent's reply on an `api` ticket is queued as an email.**
   `carrierFor('api')` answers `send_email` (`lib/tickets/outbound.ts`). A
   contact with no address never gets it, and one with an address gets a mail
   about a conversation they had in an app.
2. **Nothing can create one.** The only `createTicket` hard-codes
   `channel: 'portal'` (`lib/portal/tickets.ts`), and it never routes.
3. **A phone on the `api` channel is not the same person's phone on
   WhatsApp.** `normaliseIdentifier` strips to digits for `whatsapp` only, and
   `resolveContactIn` sets `primary_phone` for `whatsapp` only
   (`lib/auth/normalise.ts`, `lib/tickets/contacts.ts`). Resolved the obvious
   way, every myBlu user is a second, phoneless contact that never surfaces as
   a phone match.
4. **Every call would be redirected to `/login`.** `/api/v1` is not in
   `PUBLIC_PREFIXES` (`proxy.ts`). On the help-centre host `/api` passes as
   itself, so the fault shows only on the others.
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
- **Shipment data.** No response contains anything about a parcel but the
  tracking number the same user opened the ticket with. That number is "the
  only credential guarding the recipient's name, address, phone and COD
  amount" (AGENTS.md, _The delivery platform_), and the app has its own source
  for the rest.
- **A category, a form or a priority chosen by the app.** Jev files; a person
  corrects.
- **A browser client.** No CORS header and no `OPTIONS` handler. A web caller
  is a different token-storage problem and its own decision.
- **An integrations table and an admin page for one.** One caller, named in
  code. `plans/csat.md` said "a table when there is a second caller" until
  this plan replaced that paragraph; it is still when.
- **A prebuilt chat screen in the SDK.** The app owns its screens
  (`plans/csat.md`, _myBlu_). The SDK is headless and ships a sample app.
- **`ticket.status_changed` as a webhook event.** Status rides on every poll
  and on the next `message.created`; its writers do not share a transaction
  shape, and nothing waits on it.
- **The survey's email fallback.** `api_email_fallback` in `plans/csat.md` is
  not built: the address on an `api` ticket's contact is whatever that contact
  holds, which after the phone join can be a previous holder's.

## Decisions to take with the person who asked for it

Each has a default below so the work can start; each changes something a
customer or the app's developers see.

For whoever owns myBlu's backend and the app:

- **What is the app written in, and who writes a native port?** It decides
  which SDK is written first, and nothing else here. Default: the contract is
  language-neutral; the reference SDK is TypeScript, which runs in React
  Native as it stands and is the executable reference a Swift, Kotlin or Dart
  port is checked against; a port is written by this team in the SDK's
  repository.
- **Is there an account id that is stable for a person and never reused,
  separate from the phone?** The identity is keyed on it (`externalUserId`).
  Default: required. If accounts are keyed by phone today, the backend mints a
  UUID when an account is created.
- **When a number is re-registered by somebody new, do they get a new account
  or the old one?** This side cannot tell a person from a number's next
  holder; it can act when told. Default: a new account. If it is the old one,
  the backend sends a revoke with `number_released` when it learns of it, and
  until it can, a recycled number reads the previous holder's myBlu tickets
  here as it reads their parcels there. Whoever signs off the launch is told.
- **Can the backend make one HTTPS call to this system when the app asks for
  support, holding a secret?** That call is how a session is minted. Default:
  yes. If it cannot call out, the alternative is a short signed assertion the
  app carries here itself — a second accepted form beside the first, never a
  replacement, with a public key held here rather than a shared secret.
- **Can one account be signed in on two devices?** It decides whether a
  sign-out on one ends support on the other. Default: yes, so the backend
  revokes on account deletion, a changed number and "sign out everywhere", and
  one device's sign-out ends only its own session.
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
- **Minimum OS versions, and must a send survive the app being suspended?**
  Default: iOS 15 and Android 8; yes, which is why the SDK builds a multipart
  body in a file.
- **Does the app embed Freshchat or link to Freshdesk today?** This repo
  cannot see the binary; `plans/freshdesk-disconnection.md` records only the
  App Store listing's support URL. Default: the app team audits it.

For the support lead and the repo's owner:

- **Join a verified myBlu phone to the existing WhatsApp contact for that
  number?** Default: yes, for the agent only — one customer, one history — and
  the API still shows the app nothing but the tickets its own identity opened.
  Two of the three places this repo refuses to adopt a contact by phone refuse
  an _unproven_ one; a phone the backend vouched for after an SMS code is the
  proof WhatsApp itself rests on. The third (`lib/shipments/sync.ts`) refuses
  for shared household numbers, which a verified phone does not answer, and
  which is why nothing here links a shipment to the contact.
- **Which group, and which routing mode?** Default: Customer Care,
  `default_group`; `category_shadow` for a week before `category`.
- **Should the out-of-hours acknowledgement reach myBlu tickets?** A rule with
  no channel already matches `api`; today its reply is skipped for a contact
  with no address and mailed to one that has it, and after stage 1 it is
  delivered in the app. Default: yes, after reading the wording once as an app
  message. Production has no active rule today.
- **Is the agent's name shown?** Default: no name in v1, only `from: agent`.
  The portal shows the full name; this audience is two orders of magnitude
  larger, and `agents` has one `name` column that cannot be cut to a first
  name safely («عبد الله أحمد»).
- **How many tickets may one user open?** Default: ten open or pending at
  once and ten new ones an hour. Nothing caps tickets per contact anywhere
  today.
- **How long does `/api/v1` live once there is a `/api/v2`?** Default: twelve
  months, with `Deprecation` and `Sunset` headers six months ahead on any
  operation being retired.
- **Where do the app's developers test?** Default: a mock served from the
  committed OpenAPI document from the day stage 0b merges into `dev`, then
  staging resumed for named windows with its own secrets and two console seats
  for them. A staging app pointed at production would put production's minting
  secret in a staging backend.

## The model

### Two planes, and a webhook back

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
already handed to another team is written down wrongly
(`docs/embedding-the-widget.md` says an account id is normalised to "digits
and letters only" where the code keeps `-` and `_`), and a backend that
follows the document would get a 401.

### The session

- **Opaque, and stored as its hash.** `sbu_` and then `generateToken()`,
  hashed whole with `hashToken()` (`lib/auth/tokens.ts`). A dump of the table
  authenticates nobody, which is the whole of the argument AGENTS.md asks for
  before a second table holds anything credential-shaped: it holds what
  `sessions` and `contact_sessions` hold.
- **A table of its own, `api_sessions`,** not `contact_sessions` with a
  discriminator. The schema's reason for keeping agents and customers apart
  applies again: "one missed `where` clause turns a customer's cookie into an
  agent's" (`db/schema/customers.ts`). `/api/v1` never reads a cookie, and a
  test holds that a valid console cookie with no bearer is a 401.
- **What a row holds, and for how long.** `token_hash` (primary key),
  `identity_id` (cascade), the phone vouched for at this mint as digits,
  `platform`, `app_version`, the minting request's address, `created_at`,
  `expires_at`, `revoked_at`, `revoke_reason`. `contact_identities` has no
  column for a phone, so this row is where the one the backend vouched for is
  kept. The contact is read through the identity on every request and never
  stored, so a merge moves a live session with its identity; the lookup is not
  cached, so a revoke or a block is the next request's answer. Revoking stamps
  the row and does not delete it. `cleanup` deletes a row thirty days after
  `expires_at`; until then these rows are the only record of who was vouched
  for, with which phone, when.
- **Twenty-four hours from minting, fixed, with no refresh token.** A sliding
  expiry is a write on the request path of an API that is polled, behind an
  admission gate of eight (`db/client.ts`). With a fixed life a request writes
  nothing. A new token costs the app one call to its own backend, which is
  also the moment that backend knows whether the user is still signed in — and
  a sign-out that never reached us (the merchant dashboard's `clear()` did not,
  `docs/PROJECT-STATE.md` §6.112) leaks for a day at most.
- **Ending one.** `DELETE /session` ends the presented token and nothing else.
  `POST /sessions/revoke` ends every session of that `externalUserId` on every
  device; its `reason` is one of `signed_out`, `phone_changed`,
  `account_deleted`, `number_released`, `other`, recorded on the rows. With
  `account_deleted` or `number_released` it also deletes that identity's
  ownership rows (below), so the tickets stay on the contact for agents and
  leave the app for good.
- **A blocked or deleted contact is refused on every request,** as
  `getSessionCustomer` refuses one.
- **The server plane's bearer** is compared with `safeEqual` against the
  current value and `_PREVIOUS`. A value under 32 characters counts as unset,
  checked at first use and never in `lib/env.ts`, where a format rule turns
  one mistyped key into a console that does not load.
- **Unset is inert, on both planes.** While `MYBLU_API_TOKEN` is unset the
  server plane answers `503 not_configured`, and so does the client plane,
  before it reads a session. That is what lets every stage deploy before
  anybody at myBlu holds a value, and it is the way back for stages 3 to 8:
  unsetting it stops the whole API as soon as the web service restarts, not a
  day later.

### Identity

- The identity row is `('api', 'myblu:<externalUserId>')`, `is_verified = true`.
  `externalUserId` is 1 to 128 characters of `[A-Za-z0-9._:-]`: it becomes an
  index key and a limiter key, and `normaliseIdentifier` only trims it. The
  column comment on `is_verified` widens from "clicked a verification link" to
  "or vouched for by a backend that verified it". It grants nothing by itself:
  every portal lookup is by `channel = 'email'`.
- The phone is strict E.164 with its plus, `^\+[1-9]\d{7,14}$`, refused
  otherwise and never guessed: `normalisePhone` only strips non-digits, so
  `01001234567` would become a different person from `201001234567`, silently.
  It is stored as digits without the plus, the form every phone in production
  is in.
- **Resolution, in a new function in `lib/tickets/contacts.ts`** — the comment
  in `pendingContact` warns against a second copy of the lookup — reads before
  its transaction and inserts inside it, as `pendingContact` and
  `resolveContactIn` do. In order: the existing `api` identity, whose contact
  it keeps even when the phone has changed (an agent merges if the new
  number's contact is the same person); else the contact owning
  `('whatsapp', <digits>)`, when no other `api` identity already hangs off it;
  else a new contact.
- **That join is decided under the contact's row lock,** taken first in the
  transaction, with its `api` identities re-read in the next statement — a
  lock and then a read, never a join under the lock — so two sessions minted
  at once for one phone under two ids cannot both find it free.
- **A second `externalUserId` on a number gets a contact of its own, with no
  `primary_phone`.** The two are known to be different accounts.
  `mergeCandidates` matches a phone by equality, so writing it there would
  raise, on the contact page, the one merge suggestion the console must not
  make. A new contact for a number nobody holds does get `primary_phone`, so a
  later WhatsApp contact can be suggested against it.
- No `whatsapp` identity is ever written from a session. Holding a SIM today
  says nothing about a WhatsApp account.
- A contact's name is never overwritten by the name the backend sends, and the
  out-of-hours reply on an `api` ticket leaves `{{customer_name}}` blank as
  the comment path does (`lib/auto-response/index.ts`, the one place a name is
  interpolated): the stored name can be a previous holder's.

### What the app can read

**A ticket belongs to the identity that opened it.**
`api_tickets (conversation_id primary key, identity_id, tracking_number,
created_at)`, both ids cascading and `identity_id` indexed, is written in the
transaction that creates the ticket and never updated. Every statement the API
runs about a ticket carries, in the same `WHERE` as the id:

```
exists (select 1 from api_tickets t
        where t.conversation_id = conversations.id
          and t.identity_id = <the session's identity>)
and requester_contact_id = <the session's contact>
and channel = 'api'
and deleted_at is null and is_spam = false and merged_into_id is null
```

"looking the ticket up first and comparing afterwards is the same bug written
more slowly" (`lib/portal/tickets.ts`). It is built in one place,
`ownedTicket(caller)` in `lib/api/scope.ts`, and every function in
`lib/api/tickets.ts` takes the caller as a required first argument — the
device `readableByRole(role)` uses, so a new read cannot forget it and still
compile. Not yours, not found, deleted, merged away and not-`api` are one
`404` from one query. The attachment route reaches a ticket through its
message and then through the same predicate; the read marker and the survey
resolve their ticket in the statement that acts.

Each half closes something the others leave open:

- **The identity** is what a contact cannot give. A contact merge re-points
  identities, two identities can land on one contact, and a backend can send a
  wrong phone; each changes what an agent sees and, with this row, never what
  another app user reads. The row is immutable, which is the join AGENTS.md
  calls safe under a lock, and it is where the webhook reads whom to name.
- **`requester_contact_id`** is the second lock: `mergeContacts` moves it with
  the identity, and nothing else writes it on this channel.
- **`channel = 'api'`** keeps a user's WhatsApp history, which the join put on
  the same contact, out of the app.

For the same reason **the portal stops reaching `api` tickets** in the stage
that creates the first one. `listTickets`, `getTicket` and `appendReply` each
scope by contact and exclude the read-only channels; all three exclude `api`
too, through one list so they cannot drift. The list alone is not enough: the
other two take a ticket's number, which is guessable, and `appendReply` would
write a previous holder's words into the new holder's myBlu ticket as the
customer's.

Messages are read with `kind = 'reply'` and `notReaction()` _in the query_,
"so they are not in the payload to leak": never a note, a `system` row, a
forward. Only `body_text`; never `body_html`, `raw_body`, `meta` or an address.
A ticket is a named field list built fresh, as `publicTracking()` is, and it
has no assignee, group, priority, category, tag, custom field, SLA date or
event in it.

**`text` is words somebody wrote and never a label of ours.** A message sent
as files with no words is stored with an English stand-in (`[image]`,
`[2 attachments]`) for the inbox card and search, as the widget stores one,
with the files recorded in `meta.webchatFiles`, the list `isMediaStandIn`
rebuilds the stand-in from. The API answers `""` for it, as the widget's
`standsIn` does. `subject` goes through `subjectWords()`: a ticket opened with
a photo answers `subject: null` and the app draws its own title.

`status` is the status's category, four words today; a client draws one it
does not know as it would `open`. `statusLabel` is
`ticket_statuses.customer_label` where `visible_to_customer`, else null: one
string an admin typed, in one language, shown as written. The SDK ships the
portal's words for the four.

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
  needs no change the day the support lead sets it to `category`. Order: the
  pool's reads (idempotency pre-check, the channel row, `planRouting`); one
  `now`; one transaction (the conversation, the message, the `api_tickets`
  row, the `opened_from_app` event, `startRouting`); then, after the commit,
  `afterMessageStored` and `afterInboundMessage`, which run the on-create
  rules, `applySlaOnCreate`, `beginRouting`, assignment and the out-of-hours
  reply in the order every other path does. AGENTS.md's list of paths that
  route gains "and the customer API".
- **A `channels` row of type `api`** supplies the default group, the hours and
  the routing mode, read by `apiChannel()` — the oldest active row, the rule
  `portalChannel` and `webchatChannel` follow, selecting what `planRouting`
  takes. An admin creates it on `/admin/channels`, since which group is the
  support lead's call and no seed can know it. **No active row, and
  `POST /tickets` answers `503 not_configured`** while reads and replies on
  existing tickets go on working; `GET /config` says so beforehand
  (`tickets.canCreate`), so the app hides the button rather than failing a
  send. Switching the row off stops new work without cutting a customer off
  mid-conversation.
- **Provenance is an event.** `opened_from_app`, written in the creating
  transaction so the on-create rules and the header see it:
  `{ app: 'myblu', platform, appVersion, sdkVersion, identityId }`. Nothing
  draws `meta.pageUrl`, which is why web chat's page is on every message and
  on no screen. `messages.meta` carries `{ locale, client }`, and
  `webchatFiles` on a message sent with files; `requesterLocale` gains an
  `api` arm beside web chat's so a photo with no caption is still answered in
  the app's language.
- **`requester_kind` is left null on the insert,** as on every channel.
  `requesterKindFrom()` writes it from the contact's records, and only where
  it is null, so a value stamped here would hold a merchant who also uses
  myBlu at `recipient` for good.
- **The number a ticket was opened with is a claim, and is given back to the
  user who sent it.** It must pass `detectShipmentRefs` before it is linked,
  or any string becomes a `shipments` row; it is linked as a number the
  customer typed (`linkSource: 'detected'`), never `platform`; it writes
  neither `shipments.recipient_contact_id` nor `contact_shipping_accounts`.
  It is stored on the ownership row, returned as `ticket.trackingNumber`, and
  `GET /tickets?trackingNumber=` filters on it, so a shipment screen finds its
  ticket after a reinstall. It is never read from `conversation_shipments`,
  which also holds numbers an agent typed in a note.

### Idempotency

`Idempotency-Key`, a UUID the SDK makes before its first attempt and reuses on
every retry, is required on the two requests that write a message. It is
checked with `isUuid` and stored as
`messages.channel_message_id = 'api:<identityId>:<key>'`.

- Namespaced because that column's unique index covers the whole table: a bare
  client UUID would share a keyspace with every wamid and Message-ID. By
  identity, taken from the session, so one user can neither collide with nor
  probe another's key.
- It covers creation, since a ticket is created by its first message, so no
  second table and no use of `conversations.external_id`.
- Pre-checked on the pool as every ingest path does; the index is the
  backstop, and a 23505 rolls the conversation back with its `settle_routing`
  key and answers what the first request stored, read through `ownedTicket`.
  A replay is `200` with `Idempotent-Replayed: true`; the first time is `201`.
  A key replayed against another ticket or route is `409 key_reused`.
- Every message the user wrote carries the key back as `clientId` on every
  read, not only in the POST's answer. That closes the case chat clients get
  wrong first: the answer is lost, the next poll returns the message, and the
  outbox still holds it.

### Reading without a stream

- `GET /tickets/{id}/messages` with no cursor returns the **newest** page.
  Both existing read models are `orderBy(asc).limit(200)`, which silently
  stops showing a long conversation's new replies.
- `messages` is ascending by `(createdAt, id)` whichever way was asked;
  `limit` defaults to 30 and is at most 100. `?before=<olderCursor>` returns
  the page before it, and `olderCursor` is null at the start of the thread.
  `?after=<newerCursor>` returns what is newer; `newerCursor` is never null
  and comes back unchanged when nothing is new, so a poll always has a cursor
  to send, and a full page means ask again at once. Both together is
  `400 invalid_request`.
- `GET /tickets` is ordered by `(lastMessageAt, id)` descending and pages back
  with `?before=<olderCursor>`. It has no `after`: a ticket that gets a
  message moves to the top, so the list is polled by re-reading its first page
  and merging by `id`.
- A cursor is opaque base64url of Postgres's own timestamp text and the row
  id, the inbox's form (`lib/tickets/inbox-filters.ts`): a JS `Date` holds
  milliseconds where `timestamptz` holds microseconds, and a round trip skips
  or repeats a row. A cursor this server did not mint is `400 invalid_cursor`,
  never a first page.
- **`created_at` is not commit order,** so `after` re-reads a few seconds
  before its cursor and a page may repeat rows the client holds. The one rule
  an SDK needs is "merge by `id`".
- **Every answer to a poll carries `pollAfterSeconds`, and the SDK obeys it.**
  An app release takes days to reach users and old builds live for months;
  load is shed by a change here, not by a release there. Five seconds on an
  open thread to start, thirty on the list, nothing in the background.
- A poll is the session lookup and one statement over
  `messages_conversation_idx`, with no write and no session connection at any
  number of users. Its plan is read with `EXPLAIN ANALYZE` in stage 5; the
  load is first seen in the pilot.

### Read receipts

`POST /tickets/{id}/read` with the newest message on screen sets `read_at` and
`delivery_status = 'read'` on the outbound replies up to it, and answers the
ticket and the new `unreadTotal`. Both columns exist, nothing else writes them
on a channel without a provider, and the console's bubble already draws a
`read` receipt from the row. So the agent sees "Read" and the app's unread
count is `direction = 'outbound' and kind = 'reply' and read_at is null` —
`kind`, because a note is an outbound row too — with no new column, the same
answer on two devices and after a reinstall.

`upTo` is the id of any message this API returned on this ticket, the
customer's own included. An id that is not a reply on this ticket is
`400 invalid_request` and marks nothing. Marking twice, or backwards, changes
nothing. `unreadTotal` also rides on `GET /tickets/{id}/messages`, so a badge
is right while a thread is open.

### An agent's reply

- **The row is the delivery.** One predicate beside `sendsByEmail`,
  `rowIsDelivery(channel)`, true for `webchat` and `api`, replaces the five
  tests that name web chat for that reason: the delivery status in
  `writeAutomatedReply`, the early return in `enqueueAutomatedDelivery` and
  the exclusion in `sendsByEmail` (`lib/tickets/outbound.ts`), the enqueue in
  `storeAgentReply` (`lib/tickets/agent-reply.ts`) and the delivery status in
  `sendReply` (`app/(console)/reply-actions.ts`). Written `delivered`, meaning
  "stored where the customer's client reads it".
- **`carrierFor('api')` keeps answering `send_email`,** as web chat's does,
  because its return type has no fourth answer. So `writeAutomatedReply`'s
  `isEmail`, which asks the carrier, asks `sendsByEmail` instead, or an
  automated message on an `api` ticket is stored with an HTML part and the
  contact's address — and stage 1's test would still pass.
- **A failed push never marks a reply failed.** The reply is in the app on its
  next poll. That differs from every carrier and is said in AGENTS.md.
- **The trap this springs:** once `api` stops being email, `decideSurvey`
  falls to its last line and answers `widget_card` for a widget that does not
  exist. The same change makes `channelSwitch('api')` answer null until
  stage 8, so the decision and `surveyAvailability` give one answer, and the
  toggle's hint on `/admin/csat` says the app will pull its survey later.
- An agent can send plain text, a canned response and a note, which is never
  returned. No HTML, no file. `sendReply` copies the customer's key into the
  reply's `in_reply_to`, which is harmless.

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

{ "version": 1,
  "id": "message.created:6f1c…", "type": "message.created",
  "occurredAt": "2026-11-12T09:41:07.004Z",
  "user": { "externalId": "u_83412" },
  "ticket": { "id": "8a1f…", "number": 4812, "status": "open" },
  "message": { "id": "6f1c…", "from": "agent" } }
```

- **Ids only, in the job and in the body.** A dead job's payload is kept for
  good; the body is rebuilt from the rows when it is sent; text purged before
  a retry lands is never sent late. The payload is
  `z.strictObject({ event: 'message.created', messageId })`, a discriminated
  union so stage 8's `survey.created` is a second arm and not a changed shape
  a strict schema sends to `dead`.
- `user.externalId` is read from the ticket's ownership row, never from the
  contact, which after a merge has two; and never the phone, which stays out
  of a third system's request log.
- HMAC over the raw bytes is the scheme every Meta integrator already
  verifies, with the timestamp Meta's lacks inside the signed text. The
  timestamp is the attempt's, so a retry is not refused by the receiver's
  clock rule. While `MYBLU_WEBHOOK_SECRET_PREVIOUS` is set the header is
  `v1=<hex>,v1=<hex>` and the receiver accepts either.
- The handler re-reads the message and requires an outbound `reply` on an
  `api` ticket not deleted, spam or merged, so a hand-made payload cannot
  carry a note out. A row gone is `subjectGone()`. A refusal by the receiver
  is a plain error and the queue's retry, never `PermanentJobError`. The call
  has a deadline (`lib/http/deadline.ts`) and `redirect: 'error'`. A URL that
  is not `https`, or carries userinfo or a query string, is refused at first
  use, never in the schema. A URL with no secret sends nothing.
- `dedupeKey: notify_myblu:message:<messageId>` — once ever for a message,
  the argument `send:<messageId>` makes. It joins `messageJobTypes` in
  `lib/admin/purge-jobs.ts`, which matches a job through its message.
- Receiver's rules, in the contract: verify over the raw body; refuse a
  timestamp more than five minutes off; dedupe on the event id for a day,
  because the worker runs a job at least once; answer 2xx and do the work
  after; push only to devices signed in as that user; treat the webhook as a
  hint and `GET …/messages` as the truth.
- myBlu's backend holds the push credentials and the device tokens. This
  system holds neither, so there is no device-registration endpoint.

The backend forwards each event to the device as a data payload with exactly
these keys, every value a string: `sb_v` (`"1"`), `sb_type`, `sb_event_id`,
`sb_user` (`user.externalId`), `sb_ticket_id`, `sb_ticket_number`, and
`sb_message_id` or `sb_survey_id` when the event has one. The visible title
and body are the app's.

### Files

- `multipart/form-data` on the two message POSTs, from stage 7; before it a
  multipart body is `400 invalid_request`. Parts: `text`, `locale` and, on
  `POST /tickets`, `trackingNumber`, named as the JSON fields are — the
  widget's own text part is `body`; here it is `text` in both encodings — and
  `files`, repeated, one part per file in the order to show them. `text` may
  be empty when there is a file.
- The widget's own functions: `checkWidgetFiles`, `sniffWidgetFile`,
  `readVisitorUploads`, `cleanFilename`, and `storeVisitorFiles` exported
  rather than copied. Five files, 25 MB each and in total, 5,000 characters,
  all published by `GET /config` because they move with
  `proxyClientMaxBodySize`.
- **A file is admitted on its label and stored by its bytes.** `declaredKind`
  refuses a `Content-Type` outside the list whatever the bytes are, and admits
  a part with no type, or `application/octet-stream`, only by its filename's
  extension. So an SDK takes the type from the platform's own reading and
  gives a nameless file a name with an extension; a voice recording must be
  labelled as audio, or its MP4 container is stored as a video.
- **`Content-Length` is required** on a multipart body, `411` without one.
  That is new here: the widget lets a body with none through. The proxy
  truncates an oversized body rather than refusing it, and the header is the
  only guard.
- No upload endpoint and no presigned upload: bytes before a message is
  "storage with nothing to explain it", and a presigned upload skips the
  sniff that decides `attachments.content_type`.
- **Download by bearer.** `GET /attachments/{id}` answers
  `{ url, expiresInSeconds }`, a five-minute Storage link, used at once and
  never logged or stored; expiry is not revocation, and a `403` from Storage
  means ask again. JSON and not a redirect, so no HTTP library has to decide
  whether to forward `Authorization` to another host.

### Limits

In memory and per instance (`lib/http/rate-limit.ts`), so abuse control and
not a quota, and keyed on the identity rather than the address: "carrier-grade
NAT puts a large number of unrelated people behind one address"
(`lib/auth/throttle.ts`). A refusal is `429` with `Retry-After`. No row per
refusal.

| Bucket                    | Key              | Limit                                      |
| ------------------------- | ---------------- | ------------------------------------------ |
| Client plane, before auth | address          | 1,200 a minute                             |
| Bad bearer                | address          | 120 a minute                               |
| Server plane, all calls   | the plane        | 600 a minute                               |
| Minting                   | `externalUserId` | 10 in ten minutes                          |
| Reads                     | identity         | 240 a minute                               |
| Sends                     | identity         | 20 a minute                                |
| New tickets               | identity         | 10 an hour, and 10 open or pending at once |
| Uploaded megabytes        | identity         | 100 an hour                                |

Three properties of that module are designed for, not discovered. `allow()`
answers a boolean and keeps `resetAt` to itself, so stage 3 adds a variant
beside it that also returns the seconds until the bucket resets. A refused
request is still spent, so a client polling past its limit stays refused until
the window turns. And the map holds 20,000 buckets for every public endpoint
together, dropping live ones past that, so the per-identity buckets stop being
a limit at about ten thousand users polling at once; the pilot is far below
it, and the launch's number decides whether the map grows.

The per-user minting bucket bounds an honest app's loop and nothing else,
since the caller chooses its key; the server plane's own bucket is what caps
minting.

## The API

Base: `https://support.shipblu.com/api/v1`, kept in the app's remote config.
That host answered from this app on 2026-11-12, with the console still served
on it, so `KB_PUBLIC_HOST` does not name it yet. The API does not wait for
that: `/api` is served as itself on the help-centre host and, from stage 0b,
is public on every other.

JSON, UTF-8, ISO-8601 UTC, UUID ids. No credential in a URL on any route.
Every client-plane request carries
`ShipBlu-Client: sdk-ts/0.3.0 app/5.4.1 ios/18.1`, built from the SDK's
configuration; it is what `426` is decided on, and it is stored as
`messages.meta.client`. Every answer carries `ShipBlu-Request-Id`, repeated in
an error's body, so an app developer's bug report names a log line, and
`Cache-Control: no-store`. The API reads no `Accept-Language`: `locale` on a
write, exactly `ar` or `en`, is the only language it is told, and it returns
no translated text but a survey's.

It changes by addition: new fields and new enum values appear without notice
and a client ignores what it does not know. The wire contract of an operation
is fixed from the release that ships it. A breaking change is `/api/v2` beside
`/api/v1`.

| Plane  | Method and path                    | Body                                                                 | Answers                                                                         | Stage |
| ------ | ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----- |
| none   | `GET /openapi.json`                |                                                                      | the contract; no credential, behind the address bucket                          | 0b    |
| Server | `POST /sessions`                   | `{ externalUserId, phone, name?, client: { platform, appVersion } }` | `201 { token, expiresAt, expiresInSeconds }`                                    | 3     |
| Server | `POST /sessions/revoke`            | `{ externalUserId, reason }`                                         | `204`, whether or not the user is known                                         | 3     |
| Client | `DELETE /session`                  |                                                                      | `204`                                                                           | 3     |
| Client | `GET /config`                      |                                                                      | below                                                                           | 3     |
| Client | `POST /tickets`                    | `{ text, locale, trackingNumber? }`; multipart from stage 7          | `201 { ticket, message }`                                                       | 4     |
| Client | `GET /tickets/{id}`                |                                                                      | `{ ticket }`                                                                    | 4     |
| Client | `GET /tickets/{id}/messages`       | `?after=` or `?before=`, `?limit=`                                   | `{ messages, olderCursor, newerCursor, ticket, unreadTotal, pollAfterSeconds }` | 4     |
| Client | `POST /tickets/{id}/messages`      | `{ text, locale }`; multipart from stage 7                           | `201 { message, ticket }`                                                       | 4     |
| Client | `GET /tickets`                     | `?before=`, `?limit=`, `?trackingNumber=`                            | `{ tickets, olderCursor, unreadTotal, pollAfterSeconds }`                       | 5     |
| Client | `POST /tickets/{id}/read`          | `{ upTo: <messageId> }`                                              | `200 { ticket, unreadTotal }`                                                   | 5     |
| Client | `GET /attachments/{id}`            |                                                                      | `{ url, expiresInSeconds }`                                                     | 7     |
| Client | `GET`, `POST /tickets/{id}/survey` | `POST`: `{ rating, comment? }`                                       | `200 { survey }`; `GET` is `404` while there is none                            | 8     |

```json
{
  "user": { "id": "<the identity's id>", "externalId": "u_83412" },
  "tickets": { "canCreate": true, "maxOpen": 10 },
  "limits": {
    "messageMaxChars": 5000,
    "maxFiles": 5,
    "maxFileBytes": 26214400,
    "maxTotalBytes": 26214400,
    "contentTypes": ["image/jpeg", "…"],
    "extensions": ["jpg", "…"]
  },
  "support": { "online": false, "opensAt": "2026-11-13T07:00:00.000Z", "timezone": "Africa/Cairo" },
  "polling": { "threadSeconds": 5, "listSeconds": 30 }
}
```

`GET /config`. `user.id` is the identity's id, which a contact merge does not
change; a contact's id here would wipe an app's store whenever an agent merged
a duplicate. `support` arrives in stage 5; `opensAt` and `timezone` are null
when the row's group has no hours. `polling` is what a screen starts on before
its first answer.

```json
{
  "id": "8a1f…",
  "number": 4812,
  "subject": "My parcel was left with a neighbour",
  "trackingNumber": "1755021358719",
  "status": "open",
  "statusLabel": null,
  "canReply": true,
  "createdAt": "2026-11-12T09:29:58.123Z",
  "lastMessageAt": "2026-11-12T09:41:07.004Z",
  "unreadCount": 1,
  "preview": { "from": "agent", "text": "We have asked the courier…", "hasAttachments": false },
  "survey": null
}
```

`preview` is the newest reply that is not a reaction, its first 140
characters. `survey` is null or `{ status }`, so a list can prompt without a
call per ticket.

```json
{
  "id": "6f1c…",
  "from": "customer",
  "text": "",
  "createdAt": "2026-11-12T09:30:02.871Z",
  "clientId": "0b7e9c2a-…",
  "attachments": [
    { "id": "…", "filename": "IMG_0412.heic", "contentType": "image/heic", "sizeBytes": 2203114 }
  ]
}
```

`from` is `customer` for an inbound row, `agent` for an outbound one a person
wrote, `system` for an outbound one nobody did — the acknowledgement, a rule's
reply. It is the widget's mapping, with `customer` for its `visitor`.

`survey` is `{ id, status, rating, comment, locale, intro, question,
labels[5], commentPrompt, button, thanks, expiresAt }`, worded on the server
in the survey's locale, which can differ from the app's. `POST` answers the
row as it stands afterwards: the first rating wins whichever door it came
through, so the app draws what came back. The rating is posted when it is
tapped; a comment is a second `POST` carrying the same rating.

One error shape, new to this repo, where the widget's routes answer five:

```json
{
  "error": {
    "code": "ticket_closed",
    "message": "English, for a developer's log",
    "requestId": "…"
  }
}
```

| HTTP | `code`                               | Also in `error`                                                                           | The SDK                                                          |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 400  | `invalid_request`                    | `field`                                                                                   | fails the call. A text over the limit is this; never truncated   |
| 400  | `invalid_cursor`                     |                                                                                           | drops the cursor and loads the newest page                       |
| 400  | `idempotency_key_required`           |                                                                                           | an SDK bug; never retried                                        |
| 400  | `empty_message`                      |                                                                                           | fails the send. Neither words nor files                          |
| 400  | `file_refused`                       | `reason`: `too_many`, `too_large`, `too_large_total`, `type`, `empty`; `filename` or null | fails the send and names the file                                |
| 401  | `unauthenticated`, `session_expired` |                                                                                           | one refresh, one replay                                          |
| 403  | `blocked`                            |                                                                                           | stops; no refresh, no retry                                      |
| 404  | `not_found`                          |                                                                                           | drops the ticket from its store and fails its outbox entries     |
| 409  | `ticket_closed`                      |                                                                                           | fails the send; the app offers a new ticket                      |
| 409  | `too_many_open`                      |                                                                                           | fails the create; never retried                                  |
| 409  | `key_reused`                         |                                                                                           | an SDK bug                                                       |
| 411  | `length_required`                    |                                                                                           | an SDK bug                                                       |
| 413  | `too_large`                          |                                                                                           | fails the send                                                   |
| 426  | `client_upgrade_required`            |                                                                                           | stops every call; tells the app once                             |
| 429  | `rate_limited`                       | `Retry-After` header                                                                      | waits that long, then retries                                    |
| 500  | `internal`                           |                                                                                           | backs off: five attempts for a read; a send until its entry ages |
| 502  | `upload_failed`                      |                                                                                           | nothing was stored; retries the whole send under the same key    |
| 503  | `not_configured`                     |                                                                                           | on `POST /tickets`: fails the create, not retried                |

`unauthenticated` is no bearer, a malformed one, or a token this server holds
no live row for: unknown, swept or revoked. `session_expired` is a row that
exists and is past its `expires_at`. A client treats the two alike, because
the server often cannot tell them apart. An unknown `code` is classified by
its status.

The exact shapes live in `lib/api/schemas.ts`, which the routes validate with,
and are published from there. The tables above are the plan; the schemas are
the contract.

## The SDK

"An SDK" is three things, and they live in two places.

| Deliverable                            | Where                                                                     | Who               | When                    |
| -------------------------------------- | ------------------------------------------------------------------------- | ----------------- | ----------------------- |
| Contract, guide, conformance scenarios | this repository                                                           | this team         | stage 0b                |
| Mock                                   | the committed document under any OpenAPI mock server; the guide names one | the app team runs | stage 0b                |
| Changelog                              | `docs/myblu-api-changelog.md`, one dated line per contract change         | this team         | from stage 0b           |
| TypeScript SDK                         | the SDK's repository, published from tags                                 | this team         | 0.1 after stage 4       |
| Sample app                             | `example/` there: list, thread, composer with a photo, push hand-off      | this team         | with 0.2                |
| Swift and Kotlin, or Dart              | the same repository                                                       | a decision, above | once the stack is known |

### In this repository: the contract

| Piece                        | Where                                                                                                           | Held by                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Request and response schemas | `lib/api/schemas.ts`                                                                                            | the routes parse with them                                                       |
| OpenAPI 3.1 document         | built by `lib/api/openapi.ts`, committed as `docs/myblu-api.openapi.json`, served at `GET /api/v1/openapi.json` | `lib/api/openapi.test.ts` fails when the committed file and the schemas disagree |
| The guide                    | `docs/myblu-api.md`                                                                                             | review; it is `docs/embedding-the-widget.md`'s twin for this API                 |
| Test vectors                 | in the guide and in the tests that check them                                                                   | one webhook signature under a throwaway secret                                   |
| Conformance scenarios        | in the guide, numbered, as below                                                                                | every SDK runs them                                                              |

zod 4.4.3 ships `z.toJSONSchema`, so the document needs no new dependency for
`knip` to gate. Tried on 2026-11-12: it emits draft 2020-12, which OpenAPI 3.1
takes as it stands; it throws on `z.date()` and on a transform, so the
published shapes are strings and plain objects; and by default every object is
`additionalProperties: false` and every `z.enum` a closed list, which a
generated client reads as "refuse what you do not know". So response shapes
are `z.looseObject`, each enum's description says values are added, and the
test fails on a closed response component as well as on drift. The committed
file is written by a script and formatted by Prettier, so the test compares
parsed documents, not bytes. Serving the document makes its builder a live
export, and lets the app's developers fetch the contract of the server they
are talking to.

The guide opens with its audience, gives the base URL per environment, the
backend's two snippets (mint a session; verify a webhook) in the languages the
backend team names, the field tables, the error table, what is not in the
contract, the backend's rules — never log or store a session token; revoke on
account deletion and a changed number — and a "moving off Freshchat" mapping
if the audit finds one in the app.

### In a repository of its own: the code

SDK source does not live here, and this is not a preference. `package.json`
has no workspaces; `dead-exports` fails every export nothing here imports,
which is what an SDK's public surface is; `knip` reports a nested package's
imports as unlisted; `tsc`, ESLint and Prettier sweep every tracked file; and
Render builds the whole repo on every deploy. AGENTS.md says to change a rule
rather than exempt a call site, and "exempt a published package" buys the
helpdesk nothing.

It goes in a new repository — the owner creates it; `shipblu-support-sdk` is
the default name — released from tags to a private registry (npm for
TypeScript; a Swift package by tag and Maven, or pub, for a port), cut from
the OpenAPI document. An SDK below 1.0 may change its own names, never what it
sends.

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
models, and Arabic and English sentences for every error code a user can meet
and for the four status words. The same names in every language:

```ts
const support = ShipBluSupport.configure({
  baseUrl, // from remote config
  user: () => myApp.currentUserId(), // the externalUserId signed in now, or null
  tokenProvider: (userId) => myBackend.supportSession(userId), // { token, expiresInSeconds }
  locale: () => 'ar' | 'en',
  client: { platform, appVersion },
  secureStore, // adapter: the token only. Keychain or a Keystore-backed store
  storage, // adapter: key-value and a directory, for the cache and the outbox
  connectivity, // adapter: isOnline and onChange
});

support.config.get()
support.tickets.list({ trackingNumber?, cursor? })
support.tickets.get(id)
support.tickets.create({ text, trackingNumber?, files? }) // a PendingSend
support.tickets.markRead(id, upToMessageId)
support.messages.send(ticketId, { text, files? })         // a PendingSend
support.messages.retry(clientId) / support.messages.discard(clientId)
support.thread(ticketId)      // start(), stop(), loadOlder(), observe(cb)
support.attachments.url(attachmentId)
support.unread.observe(cb)
support.survey.get(ticketId) / support.survey.answer(ticketId, { rating, comment? })
support.push.handle(payload)  // resolves null for a payload that is not ours
support.reset()               // sign-out
```

`PendingSend` is `{ clientId, state: 'queued' | 'sending' | 'sent' | 'failed',
progress, error?, result }`, observable. A thread's state is `{ ticket,
messages, canReply, isLoadingOlder, reachedStart }`, with pending sends after
the server's messages in the order they were queued; the device's clock orders
nothing.

The behaviours a generated client does not give, which the guide states as
rules and the conformance scenarios check:

1. **Who is reading is the app's statement, never the stored token's.** The
   SDK stores each token beside the `externalUserId` it asked the provider
   for. On start, on every foreground and before every send from the outbox it
   compares that with `user()`: a stored token for another user, or any stored
   token while `user()` is null, is thrown away without being sent anywhere,
   and the store and outbox, namespaced by that id, are wiped before anything
   is drawn. After a refresh it reads `GET /config`, whose `user.externalId`
   must be the user it asked for, or the token is discarded. This is `judge()`
   from `lib/widget/person.ts` for a native client: there the host page states
   who is reading and the stored token is judged against it, because a token
   asked whom it belongs to always agrees with itself — and a Keychain item
   outlives a sign-out that never arrived, and on iOS a reinstall.
2. **The token provider.** `tokenProvider(userId)` resolves a token minted by
   that call; a backend that caches one hands back the token that was just
   refused. The SDK calls it when it holds no token, on a `401`, and when
   under five minutes remain, measured on a monotonic clock from the moment
   the provider answered and never against `expiresAt` and the device's date:
   two machines' clocks need not agree, and a phone a day ahead would refresh
   on every request. It always checks before a multipart send. One call in
   flight at a time. A rejection means the user is not signed in: sends stay
   in the outbox and reads fail until the next foreground.
3. **One refresh, one replay.** On any `401`, of either code, discard the
   token, ask the provider once and replay the request once. A second `401`
   surfaces; it never loops. `403 blocked` is never refreshed.
4. **A key per send, made before the first attempt** and kept in a persisted
   outbox with the text and the files' local paths, first in, first out per
   ticket; a send on a ticket whose create has not come back waits for it. A
   send whose answer was lost is retried with the same key. A permanent
   refusal is failed and shown, with `retry` and `discard`. An entry a day old
   is failed, not sent: a complaint that sends itself after the parcel arrived
   is worse than one the user is asked about.
5. **Merge by `id`, and match the user's own messages on `clientId`.** A page
   may repeat rows.
6. **Poll only in the foreground, at the server's `pollAfterSeconds`.** Back
   off with jitter on `429` and `5xx`, honouring `Retry-After`. On `426` stop,
   and tell the app once.
7. **`reset()`** calls `DELETE /session` with a five-second deadline, then
   wipes the token, the store and the outbox whether or not it landed.
8. **The token lives in the Keychain or a Keystore-backed store,** excluded
   from backups, and never in a log, a crash report or analytics. The SDK
   refuses a base URL that is not `https` unless it is configured with
   `allowInsecureBaseUrl`, which exists for a local mock and which a release
   build never sets.
9. **Always send `Content-Length`** on a multipart body, which means building
   it in a file first; images are scaled to 2,048 pixels on the long edge
   before upload, and a file over a limit from `GET /config` is refused
   locally.
10. **`push.handle(payload)`** resolves null, making no request, for a payload
    without `sb_v`, for an `sb_event_id` it has already handled, and for an
    `sb_user` that is not the user it holds a session for. Otherwise it
    fetches that ticket's new messages, updates the unread total and resolves
    `{ type, ticketId, ticketNumber, messageId }` for the app to route to.
11. **Ignore unknown fields and unknown enum values.**

The conformance scenarios, numbered in the guide as here:

1. A send whose answer is dropped, retried: one message,
   `Idempotent-Replayed: true`.
2. The answer dropped and a poll returns the message before the retry: one
   bubble.
3. `after` returns a row already held: no duplicate.
4. A `401` of either code mid-send: one refresh, one replay, one message.
5. Two concurrent `401`s: one call to the provider.
6. `429` with `Retry-After: 7`: no request for seven seconds.
7. `pollAfterSeconds` moves from 5 to 60: the next poll is 60 seconds later.
8. `409 ticket_closed` on a queued send: failed, not retried.
9. `503 not_configured` on a create: failed, not retried.
10. An unknown field and an unknown `status`: decoded.
11. `user()` names another user at start: the stored token is never sent, and
    the store and outbox are empty before any callback.
12. A push without `sb_v`, or for another `sb_user`: null and no request.
13. A 30 MB file: refused locally.
14. `426`: polling stops, the app is told once.
15. An outbox entry 25 hours old: failed, never sent.
16. A send queued behind an unsent create goes out after it, on its ticket.

## The console

No new page. `CHANNEL_LABELS.api` becomes "myBlu app", so the badge, the
reports, the views and the condition builder all say it; the channel gets a
handset glyph on the neutral tone our own channels keep; the CSAT admin page
reads the shared label instead of a private "API"; the contact page prints the
label and not `api`. Those ship in stage 1.

It joins `FILTERABLE_CHANNELS`, the rule and SLA-policy channel options and
the auto-response channel list in stage 4, the stage that writes the first
`api` ticket, as the comment channels joined theirs: each of those lists is
also what an action accepts, and offered earlier, a rule or a view naming
`api` is a stored row a revert does not undo.

The channel row is created, edited and switched on `/admin/channels`. The
switch is an action of its own, `setApiChannelActive`, behind a
`ConfirmSubmit`, as web chat's is: `saveChannel` carries no `isActive`, and
`switchWebchatRow` refuses every other type. Unlike the widget's it lets the
last active row go off, which is what it is for.

The ticket header carries "myBlu · phone vouched for by the app · iOS 3.2.1",
read off the `opened_from_app` event as the unverified-submitter badge is read
off its own. It says who vouched and not "verified", and it sits apart from
any linked parcel: the tracking number is still a claim.

What needs nothing, read and not assumed: the inbox's "all" query, the live
topics, SLA, assignment, Hand to, the classifiers, the rollup's channel slice
and the live board carry any channel; the reply box refuses only what
`refuseIfReadOnly` and `refuseIfNoConsoleReply` name, and neither names `api`.

## Stages

Each is one pull request into `dev`, verified before the next starts. "Ships"
means the `dev` → `main` release that carries it: all six production services
deploy at once and only the web service migrates. New files are staged before
`repo-rules.mjs` is run, or it cannot see them.

**0. Preconditions, no code.** This plan, and the passages of `plans/csat.md`
that pointed at it. The answers under _Decisions_. The repository for the SDK
created. Nothing is set in Render, `KB_PUBLIC_HOST` included: setting it stays
the last step of `plans/freshdesk-disconnection.md`'s checklist, on the web
service and the worker together, and the API answers on `support.shipblu.com`
whichever way it stands.

**0b. The contract.** No table, no variable, no ticket. `lib/api/schemas.ts`
for every operation in the table and for the error body with its codes;
`lib/api/openapi.ts`, which imports every one of them, so none is a dead
export before its route exists; the script that writes
`docs/myblu-api.openapi.json`, committed with one worked example per operation
and per error code; its drift test; `GET /api/v1/openapi.json`, the one route;
`/api/v1` in `PUBLIC_PREFIXES` with a `proxy.test.ts` case per host;
`docs/myblu-api.md` with the header list, the error table and the conformance
scenarios; the changelog. Verified by the drift test, and by serving the
committed file from a mock server and driving the scenarios against it. Way
back: revert. **The app team and the SDK start here.** Stages 3 to 8 fill in
routes whose shapes are already published; a shape that has to change before
its route ships changes in this file first.

**1. `api` stops being email.** No schema, no variable, no job.
`rowIsDelivery()` at its five sites and `isEmail`; `channelSwitch('api')`
null, and the toggle's hint; `UNNAMED_SUBJECT`; the blank `{{customer_name}}`
on `api` and its hint in `PLACEHOLDERS`; the label, the glyph, and the CSAT
and contact pages reading the label; the comments in `outbound.ts` and
`channel-policy.ts` that say `api` goes out by email. Verified by the
`outbound` and `decision` tests changed, and a `*.db.test.ts`: an agent's
reply and an automated one on an `api` ticket are stored `delivered`, with no
`body_html` and no `to_addresses`, and queue no job. On production beforehand,
read-only: `api` conversations are still 0, so no stored ticket changes
behaviour. Way back: revert; nothing stored differs.

**2. The channel row.** `api` in the channel types an admin can add, with its
own empty config arm in `saveChannel`; `apiChannel()` in `lib/api/channel.ts`,
which only its test imports until stage 3 reads it; `setApiChannelActive`. The
header of `channel-types.ts`, which says `api` rows are the product's and not
an admin's, is reversed and says why; the Channels entry in
`admin/sections.ts` gains `myblu`, `app` and `api` among its keywords.
Verified by a `*.db.test.ts` (the oldest active row; none; the switch) and the
form in a browser. After it ships, a person creates "myBlu app" with its group
in the console — the first thing here that waits for `main`. Way back: switch
the row off.

**3. Sessions.** `api_sessions`, generated and additive. `MYBLU_API_TOKEN` and
`MYBLU_API_TOKEN_PREVIOUS` in `lib/env.ts` and `render.yaml` in one commit,
plain optional strings, listed as comments in the production and staging
groups. `lib/api/auth.ts`, `sessions.ts`, `errors.ts`; the phone-keyed
resolver in `lib/tickets/contacts.ts`; the limiter's variant that answers the
seconds to reset; the four routes; the sweep in `cleanup`; the backend's
minting snippet in the guide. Verified by a `*.db.test.ts`: a new contact for
an unheld number gets `primary_phone`; a phone with a WhatsApp contact joins
it; a second `externalUserId` on that phone gets a contact of its own with no
`primary_phone`; two mints racing on one phone under two ids end on two
contacts; a blocked contact, an expired token, a revoked one and a
`contact_sessions` token are each refused; a national-format phone is a 400;
a short `MYBLU_API_TOKEN` counts as unset. On production after it ships, with
the token unset: `POST /api/v1/sessions` and `GET /api/v1/config` both answer
`503`, asked on `shipblu-support.onrender.com` as well, where a redirect to
`/login` would show a missing prefix. Way back: unset the token, which stops
both planes; and where sessions were minted that should not have been,
`update api_sessions set revoked_at = now() where revoked_at is null`, which
costs every app one silent refresh.

**4. Tickets.** `api_tickets`, generated and additive. `lib/api/scope.ts`,
`lib/api/tickets.ts`, the four routes, the cursor, `opened_from_app` with its
label and the header line, the `api` arm in `requesterLocale`, the portal's
exclusion of `api` from its list, its ticket page and its reply, and `api` in
the three lists under _The console_. Verified by `tickets.db.test.ts`: one key
twice is one ticket; two creates racing on a key answer the same ids; another
identity's ticket, **a second identity's on the same contact**, the same
contact's WhatsApp ticket and a merged one are each 404; a note is never
returned; a files-only message answers `text: ""` and `subject: null`;
`after` returns a row stamped earlier and committed later; a reply reopens
`resolved` and is refused on `closed`; a row in `category` mode gets its
window, its `routing_decisions` row and one `settle_routing` job; no bare
`Date` survives in `toSQL().params`; and a case each in the portal's tests.
Then on production, by the owner, with the token set and a test phone no
WhatsApp contact holds: mint, create, see "myBlu app" and the header line in
the inbox, answer from the console, read the answer back, then purge the
ticket and the contact. The pull request says plainly that this writes to
production and what removes it. **The SDK's 0.1 is cut from here.**

**5. History and unread.** No schema. The list with its filter, the read
marker, hours on `GET /config`. Verified by tests (the list is scoped and
stable under a tie; `read` is idempotent, touches only outbound replies and
refuses a note's id; a fresh session for the same user lists the same
tickets) and by `EXPLAIN ANALYZE` of the poll and the list on production,
read-only, which shows the index is used and nothing about load. Way back:
revert; `read_at` on a reply is drawn by the build before it. **A pilot can
run from here.**

**6. Push.** `MYBLU_WEBHOOK_URL`, `MYBLU_WEBHOOK_SECRET` and
`MYBLU_WEBHOOK_SECRET_PREVIOUS`, declared as stage 3's are. `notify_myblu` in
`JobType`, `JOB_PAYLOADS`, its handler and registration, `purge-jobs`, and in
`scripts/ci/db-jobs.txt` as a `skip:` line naming the `*.db.test.ts` that runs
its SQL. Verified by the signature vector in the guide, and that test: a reply
queues one job and a second call none; a note, a web chat reply and an unset
URL queue none; the handler refuses a note's id. On production: the URL set to
a request bin the owner controls, one reply to a test ticket, the delivery
verified by hand; then the URL is myBlu's. Way back: unset the URL. **The
launch waits for this.**

**7. Files.** No schema. Multipart on the two POSTs, the download route, `api`
in the chat channels that draw media inline. Verified by tests (the attachment
rows are in the message's transaction; a failed one removes the objects;
another identity's file, a note's and a web chat file are refused) and with
`curl` and files taken from a phone — a HEIC, a video near the ceiling, a PDF,
a sixth file — then from the SDK's sample at a pre-release tag. Way back:
revert; the attachment rows and their objects stay on their messages, and the
console goes on drawing them.

**8. The survey — `plans/csat.md` stage 6.** `api_pull` and the `api` answer
source, generated, with nothing in a migration using either value;
`channelSwitch('api')` answering again and `decideSurvey` choosing `api_pull`;
the two routes, authenticated by this plan's session and scoped by
`ownedTicket`; `survey.created`, a second arm of the job's payload, queued
only while `survey_api` is on, its body the webhook's with
`survey: { id, expiresAt }`. `api_email_fallback` is not built. The two
comments in `db/schema/enums.ts` that say the myBlu values join later change
with it. Verified by a `*.db.test.ts` (a pulled survey writes no message; an
answer through the route reaches `recordAnswer(…, 'api')` and comes back as
stored; another identity's ticket is a 404; `survey.created` queues once), and
with the app's staging build against staging, resumed for the window. Way
back: `survey_api` off.

The SDK follows the API: 0.1 after stage 4 (text and polling), 0.2 after 5
(history, unread, the sample app), 0.3 after 6 (push), 0.4 after 7 (files),
1.0 after 8.

Documentation moves in the pull request that makes it stale. AGENTS.md gains
`app/api/v1/` under _Layout_, a paragraph of the rules below, `rowIsDelivery`
in the automated-sender paragraph, `notify_myblu` and the multipart upload
under _Background work_, the API among the in-memory rate limits under
_Security_, and "the customer API" among the paths that route; `README.md`
the API surface; `docs/PROJECT-STATE.md` the row, the variables and what is
live; the comments in `lib/routing/start.ts` and `lib/routing/filing.ts` that
list the paths and rows that file by type.

One thing is stale already and is not this plan's to fix: AGENTS.md,
`docs/PROJECT-STATE.md`, `docs/embedding-the-widget.md` and
`plans/freshdesk-disconnection.md` still say `support.shipblu.com` serves
Freshdesk. On 2026-11-12 it answered from this app. They are corrected in
their own change, with the widget document's wrong sentence about account ids.

The rules AGENTS.md gains, as they would be written:

- Every `/api/v1` read and write is scoped by the identity that opened the
  ticket, the session's contact and `channel = 'api'`, in the same `WHERE` as
  the id.
- `kind = 'reply'` is in the query, never a filter over rows already read.
- No credential in a URL, and no stream: a cursor to poll.
- A request body naming a phone, a contact or a ticket's owner is a claim.
  Only the session says who is asking, and only the server plane says who a
  session is.
- An `/api/v1` log line carries the identity's uuid and the route, never a
  token, a phone, an `externalUserId` or a body.
- The API changes by addition. What `docs/myblu-api.md` says a field means is
  fixed once an app build depends on it.

## Risks and what is deliberately not solved

- **myBlu's backend is the root of trust.** A bug there that mints the wrong
  user is that user, and nothing here can tell. Bounded by a day's session,
  the revoke call, and thirty days of session rows that say who was vouched
  for, with which phone.
- **`MYBLU_API_TOKEN` mints any user, and rotating it ends nothing already
  minted.** Whoever holds it can open a session as any `externalUserId` it can
  name and read that user's myBlu tickets, and can mint a new id against any
  phone, which files tickets on that number's WhatsApp contact under "phone
  vouched for by the app" for an agent to believe. On a suspected leak:
  replace the value — the leaked one never goes in `_PREVIOUS` — revoke every
  live row, then read the kept rows for what was minted in the window. The
  signed-assertion form with a public key here is the upgrade if that is
  judged too much.
- **A recycled number that keeps its old account** reads the previous holder's
  myBlu tickets. Closed only by the backend, with a new account or a
  `number_released` revoke; it is the second question under _Decisions_.
- **A new holder joined to a previous holder's contact** inherits it on the
  agent's side: the WhatsApp history, and a block if that contact was blocked,
  which refuses them for good. This is what WhatsApp does today on a recycled
  number, now reachable by a second door.
- **A stolen session token works for up to a day.** Proof of possession on
  every request is not built.
- **Polling load is estimated.** Five hundred open threads at five seconds is
  a hundred requests a second on one instance behind a gate of eight.
  `pollAfterSeconds` is the valve, and the pilot is the first measurement.
- **The reply and its webhook are not one transaction.** A process dying
  between them leaves a reply with no push, as it leaves any carrier's reply
  unsent today — and here the reply is already readable.
- **Limits are per instance, forgotten on a deploy, and share one map** with
  every public endpoint.
- **Customer text goes to TypeSafe,** as on every channel the team answers.
  myBlu's privacy notice should know.
- **A test ticket on production is a real ticket.** It starts clocks and is
  counted, which is why stages 4 and 6 say so and remove what they made.
- **If a ticket merge is ever built,** an `api` ticket merged into another
  leaves the app. Nothing writes `merged_into_id` today.
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
  `WHERE`. Its `getTicket` and `appendReply` carry no `merged_into_id` filter,
  so `ownedTicket` is not lifted from them.
- `lib/widget/`: files, sniffing and the limits; `person.ts` for who is
  reading.
- `lib/routing/start.ts`: the three halves an insert path owes.
- `docs/PROJECT-STATE.md` §6.91 (the pool), §6.112 (a sign-out that never
  arrived).
- zod 4.4.3's `z.toJSONSchema`, run in this repository on 2026-11-12.
