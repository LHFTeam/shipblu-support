# Meta endpoints — what this system calls, from where, and why

Every HTTP request this codebase makes to Meta, and every request Meta makes to
it. One file because the surface is spread across four clients that share a
host and nothing else: a question like "what does the Page token actually do
here?" otherwise takes a grep across `lib/meta/`, `lib/whatsapp/`, one worker
handler and a server action.

**Scope.** This describes the _code_: the call, its route, its caller and the
reason it exists. It deliberately says nothing about whether a given call
currently succeeds in production — that is `docs/PROJECT-STATE.md`'s job (§5.2
for the live-provider gaps, §6 for the traps), and a second copy of it here
would be stale within the week. Where a call is known to be refused by a gate
rather than by a bug, §8 names the gate and cites the file that holds the
evidence.

Every Graph path below addresses **v23.0**. The version is declared four times
— `lib/meta/client.ts`, `lib/meta/subscriptions.ts`, `lib/whatsapp/client.ts`
and `worker/handlers/check-meta-permissions.ts` — because each is a separate
client with its own credential and error handling; they are not a shared
constant today, so a version bump is four edits.

## Contents

1. [The routes: two hosts, three credentials](#1-the-routes-two-hosts-three-credentials)
2. [Messenger and Instagram — `lib/meta/client.ts`](#2-messenger-and-instagram--libmetaclientts)
3. [Webhook subscriptions — `lib/meta/subscriptions.ts`](#3-webhook-subscriptions--libmetasubscriptionsts)
4. [Diagnostics — `check_meta_permissions`](#4-diagnostics--check_meta_permissions)
5. [WhatsApp Cloud API — `lib/whatsapp/client.ts`](#5-whatsapp-cloud-api--libwhatsappclientts)
6. [Inbound: the endpoints Meta calls](#6-inbound-the-endpoints-meta-calls)
7. [Endpoints deliberately not used](#7-endpoints-deliberately-not-used)
8. [What each call needs, and what currently gates one](#8-what-each-call-needs-and-what-currently-gates-one)

## 1. The routes: two hosts, three credentials

One Meta app serves four products, and the Instagram account is connected to it
**twice**. Which host and which credential a call goes out with is a property of
the _connection_, not of the platform — `lib/meta/connection.ts` is the only
place that decides, and `metaConnection()` decides it from configuration alone
so that "can this ticket be answered?" cannot depend on which webhook delivery
reached the worker first.

| Connection           | Host                  | Credential                         | Signs webhooks with    | Permission vocabulary                              |
| -------------------- | --------------------- | ---------------------------------- | ---------------------- | -------------------------------------------------- |
| Facebook Page        | `graph.facebook.com`  | `META_PAGE_ACCESS_TOKEN`           | `META_APP_SECRET`      | `pages_*`, `instagram_basic`, `instagram_manage_*` |
| Instagram Login      | `graph.instagram.com` | `INSTAGRAM_ACCESS_TOKEN`           | `INSTAGRAM_APP_SECRET` | `instagram_business_*`                             |
| App-level (webhooks) | `graph.facebook.com`  | `{META_APP_ID}\|{META_APP_SECRET}` | n/a                    | none — an app token carries no scopes              |

Facebook is always the Page connection; there is no second way to reach a Page.
Instagram takes the direct connection whenever `INSTAGRAM_ACCESS_TOKEN` is set,
and falls back to the Page connection when it is not — so unsetting that
variable silently reroutes every call in §2 to a different host with a different
token. The third subscription write in §3 is the one thing that does not fall
back: it refuses outright, because a Page token addressed to
`graph.instagram.com` is refused with a sentence naming neither credential.

**Where the credential travels.** `lib/meta/client.ts` puts it in the query
string (`?access_token=`); the other three clients put it in an
`Authorization: Bearer` header. That is not an oversight in the second group: an
app access token contains the app secret verbatim, and a URL is the part of a
request that reaches logs and error messages.

## 2. Messenger and Instagram — `lib/meta/client.ts`

Eight Graph calls and one plain download. The eight route through the single
`graph()` helper at `lib/meta/client.ts:172`, which chooses the host and token
via `endpoint()` (`lib/meta/client.ts:110`) and normalises failures into
`MetaApiError`; the ninth (§2.8) is a bare `fetch` of a URL Meta already handed
us.

| #   | Graph request                                             | What it does                        | Called from                                                                         |
| --- | --------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `POST /{account-id}/messages`                             | Send a direct message               | `worker/handlers/send-meta.ts:217`                                                  |
| 2   | `POST /{page-id}/take_thread_control`                     | Take a thread back from another app | `app/(console)/actions.ts:706`                                                      |
| 3   | `POST /{comment-id}/comments` (FB) · `/replies` (IG)      | Public reply under a comment        | `worker/handlers/send-meta.ts:152`, `worker/handlers/test-comment-permission.ts:64` |
| 4   | `POST /{account-id}/messages` with `recipient.comment_id` | Private reply to a commenter        | `worker/handlers/send-meta.ts:164`                                                  |
| 5   | `POST /{comment-id}?is_hidden=` (FB) · `?hide=` (IG)      | Hide / unhide a comment             | `worker/handlers/moderate-meta-comment.ts:87`                                       |
| 6   | `DELETE /{comment-id}`                                    | Delete a comment                    | `worker/handlers/moderate-meta-comment.ts:85`, `test-comment-permission.ts:91`      |
| 7   | `GET /me/published_posts?limit=1&fields=id`               | The Page's newest own post          | `worker/handlers/test-comment-permission.ts:110`                                    |
| 8   | `GET /{user-id}?fields=…`                                 | Customer's name, handle, picture    | `lib/meta/profile-refresh.ts:115`                                                   |
| 9   | `GET <CDN url>` (no credential)                           | Download an attachment or avatar    | `lib/meta/profile-refresh.ts:216`, `worker/handlers/download-media.ts:184`          |

The request _shapes_ for 1–6 are not built inline. They live in three pure
modules — `lib/meta/send.ts`, `lib/meta/comments.ts`, `lib/meta/handover.ts` —
and are asserted there against Meta's reference in unit tests, because **a wrong
shape is invisible in the response**: Graph refuses a nonexistent edge with
`100 "Unsupported post request … does not exist, cannot be loaded due to missing
permissions, or does not support this operation"`, which is word for word what
it says about a comment the customer deleted. Nothing local can call Graph, so a
doc page read carefully is the only check available.

### 2.1 Send a direct message

`POST /{account-id}/messages` — the Page id for Facebook, the Instagram
professional account id for Instagram. Body from `directMessageRequest()`
(`lib/meta/send.ts`).

This is the channel's whole outbound path: an agent's reply, an automation's
canned reply, the out-of-hours acknowledgement and the CSAT survey all end up
here through `send_meta`.

Two things about the body are decided rather than copied:

- **`tag: HUMAN_AGENT`** is what keeps a reply legal between 24 hours and 7 days
  after the customer wrote. It is a claim that a person wrote the message, so
  `messagingTag(state, author)` takes the author as a required argument and
  `send_meta` derives it from `messages.author_agent_id` — the column recording
  the person is the only thing that can substantiate the claim.
- **`messaging_type` splits on the platform, not the connection.** Messenger
  documents it; neither Instagram send reference has it, on either host. So the
  tagged Instagram body drops it and the in-window one keeps it. That asymmetry
  is deliberate and is a statement about evidence: the tagged path has never
  succeeded, so moving it toward the docs costs nothing, while the in-window
  path is live traffic that works today with `messaging_type: RESPONSE`. The
  reasoning is in `lib/meta/send.ts`; do not tidy the halves into consistency
  without a live round trip.

### 2.2 Take thread control

`POST /{page-id}/take_thread_control`, body from `takeThreadControlRequest()`.

**Facebook Page only.** Handover is a property of the Page connection — an
Instagram account reached through Instagram Login is not installed on anything
and has no primary receiver to take control from — so `takeThreadControl()`
asserts the connection before calling, rather than sending a request to an edge
that does not exist on `graph.instagram.com`.

It exists because a customer's message arriving in the webhook's `standby` array
means another app owns that inbox and Meta will refuse a send from this one. An
approval, a token or a retry all leave that exactly where it was; this is the
one lever the protocol exposes. Only the _primary receiver_ may make the call,
which is why its failure is not necessarily a bug —
`describeTakeControlFailure` in `lib/meta/errors.ts` turns that into a sentence
an agent can act on.

The response is read, not just the status: Graph returns `{"success": true}` and
the client insists on it, because a 200 with anything else would have the
console tell an agent the thread is theirs and leave the next reply to fail.
`metadata` names this system rather than the agent — the string goes into a
third party's logs.

### 2.3 Public comment reply

`POST /{comment-id}/comments` on Facebook, `POST /{comment-id}/replies` on
Instagram. **Instagram's comment node has a `replies` edge and no `comments`
one**, and every one of these calls was previously issued in the Facebook shape
on both platforms — so no Instagram comment reply this system sent could ever
have been delivered. That is the reason `lib/meta/comments.ts` exists as data
rather than as branches inside the client.

Which comment id to address is `commentReplyTarget()`, not "the last one":
Instagram threads are one level deep, so every reply hangs off the top-level
comment and posting to a reply's `replies` edge is a request for an edge that is
not there. Facebook keeps the specific comment, where answering directly under
what the customer wrote is what an agent means by "reply".

### 2.4 Private reply

`POST /{account-id}/messages` with a **comment id where a recipient id would
go** — the same endpoint as a DM, and the only comment operation not addressed
to the comment. That shape is what makes the send legal without the customer
having written in first.

Facebook once had `{comment-id}/private_replies`; **that edge was removed after
Graph API v3.2** and this app addresses v23.0, so every Facebook private reply
asked for an edge that does not exist — refused with the generic sentence above
and rendered on the ticket as "the comment is gone, or you have already replied
to it". Writing the shapes down from the doc page is what caught it; the
responses never could.

Meta allows exactly one private reply per comment, ever, and only within seven
days of _that_ comment — so this is the one send in the product that genuinely
cannot be retried, and it is addressed to the newest comment rather than the
thread root, because naming the newest buys the most time.

### 2.5 Hide, unhide, delete

`POST /{comment-id}` with `is_hidden` (Facebook) or `hide` (Instagram) as a
**query parameter** rather than a JSON body — Graph accepts either, and these
are the only calls in the module whose entire content is one boolean, which is
far easier to read in a log and to reproduce with curl as part of the URL.
Delete is `DELETE /{comment-id}`, identical on both platforms and the only
comment operation that is.

Both run as the `moderate_meta_comment` job rather than inside the server
action: the calls are external, retryable and rate-limited, and the console
marks the comment `pending` in the meantime so the timeline never claims
something about what the public can see before Meta has answered
(`lib/meta/moderation.ts`).

### 2.6 The Page's latest post

`GET /me/published_posts?limit=1&fields=id`, Page token, `me` being the Page
under it.

Exists only for `test_comment_permission`, which needs somewhere harmless to put
a comment and must not guess at one. `published_posts` rather than `feed`
because `feed` includes posts _other people_ made on the Page, and commenting on
a stranger's post exercises a different permission that is refused differently.

That job makes one successful `pages_manage_engagement` write and deletes it
again, because the App Dashboard gates the "Request advanced access" button
behind a successful test call and no agent-reachable path can make one today.

### 2.7 Customer profile

`GET /{user-id}?fields=…`. Messenger and Instagram webhooks identify a sender by
a scoped id and nothing else — unlike WhatsApp, which puts the profile name in
the payload — so this call is the only way the console ever learns who wrote in.

The field list is per platform and per attempt (`profileFields()`):

| Platform  | Asked first                                           | Fallback                                |
| --------- | ----------------------------------------------------- | --------------------------------------- |
| Facebook  | `first_name,last_name,name,profile_pic,locale,gender` | `first_name,last_name,name,profile_pic` |
| Instagram | `name,username,profile_pic`                           | none — one request only                 |

**Asking for a field the app is not approved for fails the whole request**,
taking the name and the picture with it, which is why `locale` and `gender` are
a second list and why the fallback is keyed on any final refusal rather than on
a permission-shaped one. Instagram has no extended list at all: its User Profile
API offers neither field, and `pages_user_*` are Page permissions, so asking
`graph.instagram.com` for `locale` is a _malformed_ request rather than an
unapproved one — it would fail forever instead of starting to work on approval.

Three callers share `refreshChannelProfile()` in `lib/meta/profile-refresh.ts`:
the `fetch_meta_profile` job enqueued when somebody writes in, the
`backfill_meta_profiles` job, and the console's manual retry button
(`refreshRequesterProfile`, the one server action in the codebase allowed to
call a provider inline, because an agent is pressing it and waiting on the
answer). One implementation so the three cannot answer differently for the same
person.

A refusal is consumed **without** stamping `profile_fetched_at`: recording "we
asked and got nothing" is true today and wrong the moment the feature is
approved, and would leave every customer already in the archive anonymous
forever.

### 2.8 Attachment and avatar downloads

Not Graph. `downloadAttachment()` (`lib/meta/client.ts:696`) fetches a URL Meta
already handed us in the webhook payload (`lib/meta/parse.ts:258`) or in a
profile's `profile_pic`, with **no credential** — the link is signed and
short-lived, which is why media is copied by a job rather than lazily when an
agent opens the ticket.

`maxBytes` is enforced _while reading_, not after: checking the length of an
already-materialised Buffer is not a guard against anything, since the memory it
exists to bound has been allocated by the time the check runs. The declared
`Content-Length` is rejected up front where there is one, and the stream is
aborted mid-read where there is not. The avatar path passes a 2 MB ceiling; the
message-attachment path passes none.

## 3. Webhook subscriptions — `lib/meta/subscriptions.ts`

Configuration, not traffic: run by hand as `npm run job --
subscribe_meta_webhooks object=<object>` and from nowhere else, which is why
nothing here retries — a person is watching, and a failure they can read beats a
retry that hides which half of a two-step change landed.

**A webhook has two subscriptions, not one.** Meta's own sentence is that "only
fields with subscriptions at both the page and app levels will get Webhooks", so
there is an app-level write _and_ an account-level one — and because the account
level is where the two Instagram connections part company, there are three
writes rather than two:

| Level           | Graph request                                             | Credential                          | Helper                                                               |
| --------------- | --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| App             | `GET`/`POST graph.facebook.com/{app-id}/subscriptions`    | app token, `{app-id}\|{app-secret}` | `readSubscription` / `applyFieldSubscription`                        |
| Facebook Page   | `GET`/`POST graph.facebook.com/{page-id}/subscribed_apps` | `META_PAGE_ACCESS_TOKEN`            | `readPageSubscription` / `applyPageSubscription`                     |
| Instagram Login | `GET`/`POST graph.instagram.com/{ig-id}/subscribed_apps`  | `INSTAGRAM_ACCESS_TOKEN`            | `readInstagramLoginSubscription` / `applyInstagramLoginSubscription` |

The app level is shared — one app, one `instagram` object subscription serving
both connections. Each connection then owns its account-level half, on a
different host, with a different credential and, for the Page, a different field
vocabulary.

**Every one of these writes replaces the field list rather than adding to it.**
A request naming only `message_echoes` silently unsubscribes `messages`, and
Meta reports that as success. So `mergeFields()` is the safety-critical part of
the job, is shared by all three levels, and throws rather than producing a list
that drops a field. The Page and Instagram POSTs are not _documented_ as
replacing; writing the merged list is correct under either reading, and assuming
"adds" is the assumption that costs a channel.

`callback_url` on the app-level write is echoed back from the read, never
rebuilt from `APP_URL`: a webhook override can point an account somewhere other
than the app's default, and reconstructing it would quietly retarget the
subscription while appearing only to add a field. `include_values=true` is sent
because without it Graph subscribes to the _names_ of changed fields and sends
no `value` object, which every parser here reads. `verify_token` is required
because Graph re-runs the subscription handshake against the callback URL on
every write.

The field lists are properties of this codebase rather than something typed at a
shell prompt against production:

| Object                      | Fields                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `whatsapp_business_account` | `messages`, `message_echoes`                                                             |
| `instagram`                 | `messages`, `comments`, `messaging_postbacks`, `messaging_referral`, `message_reactions` |
| `page`                      | `messages`, `feed`, `messaging_postbacks`, `messaging_referrals`, `message_reactions`    |

Two differences in that table are load-bearing. Facebook has **no comments
field** — `feed` carries comments, likes, shares and post edits together,
discriminated by `value.item`, and `lib/meta/parse.ts` keeps the comments and
drops the rest. And the referral field is spelled `messaging_referral` on
Instagram and `messaging_referrals` on the Page: one character, and Graph
rejects the whole write rather than the one bad name, so the two lists cannot be
folded together however similar they look.

## 4. Diagnostics — `check_meta_permissions`

Read-only, `npm run job -- check_meta_permissions`, safe against production.
Two calls, one per connection:

| Graph request                                                 | Credential               | What it settles                                             |
| ------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `GET graph.facebook.com/debug_token?input_token={page-token}` | app token (header)       | token `type`, `scopes`, `granular_scopes`, validity, expiry |
| `GET graph.instagram.com/me?fields=user_id,username`          | `INSTAGRAM_ACCESS_TOKEN` | whether the token works, and which account it belongs to    |

`debug_token` rather than `/me/permissions`: the latter needs a _user_ token and
this deployment sends with a Page one, where `/me` is the Page and the edge does
not exist. It takes any token, is authorised with the same app token
§3 builds, and returns `granular_scopes`, which says per asset who a
permission was granted for — the thing that matters when one app administers
more than one Page.

The Instagram half can say much less, and says so. `debug_token` is a
`graph.facebook.com` endpoint and an Instagram Login token is issued by the
Instagram side of the app, which publishes no scope list — so this asks the only
question that host will answer. That is still worth asking: both Instagram
outages this system has had were a credential in the wrong place, and the
account-id mismatch check here would have named either in one line.

The job then prints the App Review **features** it could not check (`FEATURES`
in `lib/meta/capabilities.ts`). A feature is granted to the app, appears in no
token's scopes, and is not covered by a role on the app the way a permission is
at Standard Access — so a clean `debug_token` run says nothing about one, and
silence there is what let a Human Agent refusal sit behind "every capability is
granted" for two weeks.

## 5. WhatsApp Cloud API — `lib/whatsapp/client.ts`

Same Meta app and the same host, kept a separate client because the endpoints,
the id types and the failure modes have nothing in common with Messenger's;
folding them together would produce a client whose every function takes a "which
product is this?" flag.

| Graph request                                         | What it does                           | Called from                                      |
| ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `POST /{phone-number-id}/messages` (`type: text`)     | Free-form reply, inside the 24h window | `worker/handlers/send-whatsapp.ts:86`            |
| `POST /{phone-number-id}/messages` (`type: template`) | The only thing that sends outside it   | `worker/handlers/send-whatsapp.ts:157`           |
| `POST /{phone-number-id}/messages` (`status: read`)   | Mark the customer's message read       | **no caller today** — `markRead` is unused       |
| `GET /{media-id}`                                     | Resolve a media id to a download URL   | `worker/handlers/download-media.ts:86`           |
| `GET <media url>` (bearer token required)             | Download the bytes                     | `worker/handlers/download-media.ts:87`           |
| `GET /{waba-id}/message_templates?limit=100`          | List a business account's templates    | `worker/handlers/sync-whatsapp-templates.ts:113` |

Details worth keeping:

- **Sends are addressed to the number the conversation arrived on**, not to the
  configured default. The 24-hour window belongs to a _pair_ — one business
  number and one customer — so replying from a different number is a
  re-engagement message to somebody who never engaged, rejected with 131047 on a
  later status webhook, which nothing upstream can catch.
- **The media URL is valid for about five minutes**, which is why media is
  downloaded by a job rather than when an agent opens the ticket, and why the
  download itself carries the access token — the CDN requires it on the transfer
  and not just on the lookup. Media ids are scoped to the business account that
  received them, so the download uses that account's token.
- **Template listing follows Meta's cursor pagination**, bounded at 20 pages
  rather than `while (next)`: a paging bug on either side must not turn an
  hourly cron into an unbounded loop against Meta's API.
- **A second WhatsApp account's token comes from `process.env` directly.** Its
  variable's _name_ is a database value, so it cannot be in the Zod schema — and
  must therefore start `WHATSAPP_TOKEN_`, or an admin typing a variable name
  would be choosing which secret gets sent to Meta as a bearer token
  (`lib/whatsapp/accounts.ts`).

## 6. Inbound: the endpoints Meta calls

Two routes, both following the same discipline — verify the signature, persist
the raw payload, enqueue, return 200. Nothing in either parses a message,
touches storage or calls Graph: Meta expects a 200 within seconds, retries the
entire batch on anything else, and eventually disables a subscription that keeps
failing.

| Route                    | Objects delivered           | Signature checked against                                                          |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------- |
| `/api/webhooks/meta`     | `page`                      | `META_APP_SECRET`                                                                  |
| `/api/webhooks/meta`     | `instagram`                 | `INSTAGRAM_APP_SECRET`, its legacy name, then `META_APP_SECRET` — first match wins |
| `/api/webhooks/whatsapp` | `whatsapp_business_account` | `META_APP_SECRET`                                                                  |

`GET` on each answers Meta's subscription handshake with the bare challenge
string (not JSON), checked against `META_VERIFY_TOKEN`. `POST` reads the body as
**text, not `json()`** — the X-Hub-Signature-256 signature covers the exact bytes
Meta sent, and re-serialising a parsed object produces a different string.

One endpoint serves both Meta objects because Meta delivers them through one app
subscription and distinguishes them only by `object`. One endpoint does not mean
one credential, though: the twice-connected Instagram account signs
byte-identical bodies with two different app secrets, so `lib/meta/signing.ts`
decides which secrets _could_ have signed a delivery from the object in the
body, and **which one actually did is the only thing that says which connection
the delivery came in on**. It is recorded on the row because it is knowable
there and nowhere downstream. `INSTAGRAM_APP_SECRET` is also read under its
older name `META_INSTAGRAM_APP_SECRET`, and neither app secret can be removed
while both connections are live — unsetting one resumes 403s for that half of
the traffic (`docs/PROJECT-STATE.md` §6.26, §6.29).

## 7. Endpoints deliberately not used

Recorded so the next reader does not have to re-derive the reason, or "fix"
something by adding one back.

| Not used                                    | Why                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/permissions`                       | Needs a _user_ token; this deployment sends with a Page one, where `/me` is the Page and the edge does not exist                    |
| `POST /{comment-id}/private_replies`        | Removed after Graph API v3.2; the app addresses v23.0, so it can only ever be refused                                               |
| `POST /{page-id}/request_thread_control`    | The secondary receiver's call, answered by whoever runs the _other_ tool rather than by Meta                                        |
| `live_comments`, `mentions` webhook fields  | Nothing ingests them, and an unread field is a `webhook_events` row and a job per event, forever                                    |
| `smb_message_echoes`                        | Looks like `message_echoes` and is not — it covers replies from the WhatsApp Business app, which is not how this number is operated |
| `messaging_type` on a tagged Instagram send | Absent from both Instagram send references; see §2.1 for why only the tagged half drops it                                          |
| `pages_user_timezone` / `timezone` field    | A third permission to justify to App Review for a column no screen shows                                                            |
| The Facebook SDK                            | A handful of endpoints do not justify the SDK's surface or its transitive dependencies (`lib/whatsapp/client.ts`)                   |
| `markRead` (`lib/whatsapp/client.ts:239`)   | Written and exported, imported by nothing — read receipts are not wired up                                                          |

## 8. What each call needs, and what currently gates one

Credentials, all optional in the schema (`lib/env.ts`) and declared in
`render.yaml` in the same commit:

| Variable                                                    | Used by                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `META_PAGE_ACCESS_TOKEN`                                    | §2 over the Page connection, the Page subscription write, `debug_token`'s input, and the WhatsApp default token |
| `META_APP_ID` + `META_APP_SECRET`                           | The app token for `/{app-id}/subscriptions` and `debug_token`'s authorisation                                   |
| `META_APP_SECRET`                                           | Also verifies X-Hub-Signature-256 on `page` and WhatsApp deliveries                                             |
| `META_VERIFY_TOKEN`                                         | Answers the subscription handshake, on both webhook routes and on every write                                   |
| `FACEBOOK_PAGE_ID` / `INSTAGRAM_ACCOUNT_ID`                 | The node every send, private reply and subscription write is addressed to                                       |
| `INSTAGRAM_ACCESS_TOKEN`                                    | Everything in §2 and §3 routed over the direct Instagram connection                                             |
| `INSTAGRAM_APP_SECRET` (a.k.a. `META_INSTAGRAM_APP_SECRET`) | Verifies deliveries signed by the Instagram Login connection                                                    |
| `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_WABA_ID`             | The default send number and the template listing                                                                |
| `WHATSAPP_TOKEN_*`                                          | A second business account's own token, named by a database row                                                  |

Three gates are known to be closed as of 2026-09-07, and each stops a call
above for a reason no code change fixes. `FEATURES` in
`lib/meta/capabilities.ts` carries the first two so `check_meta_permissions` can
name what it did not check; `docs/PROJECT-STATE.md` carries the evidence and is
the file to re-read rather than this one:

- **Human Agent** (a _feature_, not a permission) — every send in §2.1 tagged
  `HUMAN_AGENT`, i.e. every reply between 24 hours and 7 days after the customer
  wrote. Refused `code 10, HTTP 403` naming the feature, observed 2026-09-06 via
  `graph.instagram.com` (§5.2). Replies inside 24 hours still send.
- **Business Asset User Profile Access** — the profile read in §2.7. Refused
  `(#3) Application does not have the capability to make this API call.`
- **Advanced Access for the Instagram `comments` webhook** — not a call here but
  the reason one never arrives: Meta requires an approved App Review submission
  to deliver `comments` at all, and Standard Access does not cover it even for
  an app admin on their own public post, which is why regenerating the token
  changes nothing.

---

**Keeping this current.** Add a row when you add a call, and put the reasoning
next to the code rather than only here — `lib/meta/send.ts`,
`lib/meta/comments.ts` and `lib/meta/handover.ts` are the request shapes, and
their headers are the evidence. When adding or changing a Graph request, read
the node reference **for v23.0 specifically**: an edge missing from it is a
finding rather than an omission by the doc, and removal notices sit on a
separate legacy page that a search for the working endpoint will not surface
(§6.43).
