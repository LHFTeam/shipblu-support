# Meta endpoints — what this system calls, from where, and why

Every HTTP request this codebase makes to Meta, and every request Meta makes to
it. One file because the surface is spread across six clients that share a
host and nothing else: a question like "what does the Page token actually do
here?" otherwise takes a grep across `lib/meta/`, `lib/whatsapp/`, the worker's
handlers, two server actions and two route handlers.

**Scope.** This describes the _code_: the call, its route, its caller and the
reason it exists. It deliberately says nothing about whether a given call
currently succeeds in production — that is `docs/PROJECT-STATE.md`'s job (§5.2
for the live-provider gaps, §6 for the traps), and a second copy of it here
would be stale within the week. Where a call is known to be refused by a gate
rather than by a bug, §8 names the gate and cites the file that holds the
evidence.

Every Graph path below addresses **v23.0**, declared once in
`lib/meta/graph.ts` beside the two hosts it is addressed on. The six clients —
`lib/meta/client.ts`, `lib/meta/subscriptions.ts`, `lib/whatsapp/client.ts`,
`lib/meta/debug-token.ts` (shared by `check_meta_permissions`, the WhatsApp
onboarding and the Unified Login callback) and the two bare `fetch`es that
exchange a code, `lib/whatsapp/onboarding.ts` for a signup code and
`lib/meta/unified-login.ts` for a login code — stay separate, each with its own
credential and error handling, and import the address from there, so a version
bump is one edit and cannot land on some of them only.

## Contents

1. [The routes: two hosts, five credentials](#1-the-routes-two-hosts-five-credentials)
2. [Messenger and Instagram — `lib/meta/client.ts`](#2-messenger-and-instagram--libmetaclientts)
3. [Webhook subscriptions — `lib/meta/subscriptions.ts`](#3-webhook-subscriptions--libmetasubscriptionsts)
4. [Diagnostics — `check_meta_permissions`](#4-diagnostics--check_meta_permissions)
5. [WhatsApp Cloud API — `lib/whatsapp/client.ts`](#5-whatsapp-cloud-api--libwhatsappclientts)
6. [Inbound: the endpoints Meta calls](#6-inbound-the-endpoints-meta-calls)
7. [Endpoints deliberately not used](#7-endpoints-deliberately-not-used)
8. [What each call needs, and what currently gates one](#8-what-each-call-needs-and-what-currently-gates-one)

## 1. The routes: two hosts, five credentials

One Meta app serves four products, the Instagram account can be connected to it
**three ways** — and has been connected two of them at once since 2026-08-30 —
and a WhatsApp number on the WhatsApp Business app brings a credential of its
own. Which host and which credential a call goes out with is a property of the
_connection_, not of the platform — `lib/meta/connection.ts` is the only place
that decides, and `metaConnection()` decides it from configuration alone so
that "can this ticket be answered?" cannot depend on which webhook delivery
reached the worker first.

| Connection           | Host                  | Credential                                           | Signs webhooks with    | Permission vocabulary                                                       |
| -------------------- | --------------------- | ---------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| Facebook Page        | `graph.facebook.com`  | `META_PAGE_ACCESS_TOKEN`                             | `META_APP_SECRET`      | `pages_*`, `instagram_basic`, `instagram_manage_*`                          |
| Instagram Login      | `graph.instagram.com` | `INSTAGRAM_ACCESS_TOKEN`                             | `INSTAGRAM_APP_SECRET` | `instagram_business_*`                                                      |
| Unified Login        | `graph.facebook.com`  | `INSTAGRAM_UNIFIED_LOGIN_TOKEN`, a system-user token | `META_APP_SECRET`      | `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments` |
| App-level (webhooks) | `graph.facebook.com`  | `{META_APP_ID}\|{META_APP_SECRET}`                   | n/a                    | none — an app token carries no scopes                                       |
| Embedded Signup      | `graph.facebook.com`  | a business token, stored sealed                      | `META_APP_SECRET`      | `whatsapp_business_management`, `whatsapp_business_messaging`               |

Facebook is always the Page connection; there is no second way to reach a Page.
Instagram takes **Unified Login whenever `INSTAGRAM_UNIFIED_LOGIN_TOKEN` is
set, then the direct connection whenever `INSTAGRAM_ACCESS_TOKEN` is, and the
Page connection otherwise** — so unsetting either token silently reroutes every
call in §2 to the next connection down, which for the direct one is a different
host with a different token. The account-level subscription writes in §3 are
the one thing that does not fall back: each refuses outright without its own
connection's token, because a Page token addressed to `graph.instagram.com` is
refused with a sentence naming neither credential.

**Unified Login is the Page's host with a credential of its own.** The token is
a Business Integration System User token, minted by Meta when an admin of the
business portfolio finishes the login the "Connect Instagram" control on
`/admin/channels` opens (§2.9), set to never expire by the Facebook Login for
Business configuration it was minted through, and set on Render by hand — the
callback page shows it once and nothing stores it. It is addressed to
`INSTAGRAM_ACCOUNT_ID` like the Page token, never to `/me`, which on that token
is the system user and not the account. Its webhooks are signed with
`META_APP_SECRET`, so a delivery it sent is labelled `facebook_page` at the
endpoint (§6), and its permissions are the Page's `instagram_*` spelling — the
pair App Review granted at Advanced Access on 2026-09-19 — without the
`pages_*` names, because no Page is involved. `plans/instagram-unified-login.md`
has the dashboard steps, the activation order and what the first live send has
still to prove.

**The fifth credential is the one the database holds.** A number that lives on
the WhatsApp Business app is connected through Meta's Embedded Signup, which
hands the browser a one-use code; `lib/whatsapp/onboarding.ts` exchanges it for
a business token Meta mints for that WABA, proves the token reads the WABA, and
stores it sealed in `whatsapp_account_credentials`, one row per WABA (AGENTS.md,
"The stored WhatsApp credential"). Only the worker ever opens one:
`tokenForAccount` in `lib/whatsapp/accounts.ts` resolves **stored →
`WHATSAPP_TOKEN_*` → `META_PAGE_ACCESS_TOKEN`**, a stored credential that will
not open throws rather than falling through, and CI confines the resolvers to
`worker/` (`credential-confinement`). The WABA is under this app by
construction — the popup is opened as it — so its deliveries verify with
`META_APP_SECRET` like every other WhatsApp delivery.

**Where the credential travels.** `lib/meta/client.ts` puts it in the query
string (`?access_token=`); the other clients put it in an
`Authorization: Bearer` header. That is not an oversight in the second group: an
app access token contains the app secret verbatim, and a URL is the part of a
request that reaches logs and error messages. Three requests cannot keep a
secret out of the URL — the two code exchanges take the app secret and the code
as query parameters, and `debug_token` takes the token it inspects as
`input_token` — so each goes out with a `fetch` of its own rather than through a
client that would put the request into its error messages, and every sentence
they build names host and path, never the URL (`lib/whatsapp/onboarding.ts`,
`lib/meta/unified-login.ts`, `lib/meta/debug-token.ts`).

## 2. Messenger and Instagram — `lib/meta/client.ts`

Eight Graph calls and one plain download. The eight route through the single
`graph()` helper at `lib/meta/client.ts:170`, which chooses the host and token
via `endpoint()` (`lib/meta/client.ts:108`) and normalises failures into
`MetaApiError`; the ninth (§2.8) is a bare `fetch` of a URL Meta already handed
us.

| #   | Graph request                                             | What it does                        | Called from                                                                                    |
| --- | --------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `POST /{account-id}/messages`                             | Send a direct message               | `worker/handlers/send-meta.ts:217`                                                             |
| 2   | `POST /{page-id}/take_thread_control`                     | Take a thread back from another app | `app/(console)/meta-actions.ts:260`                                                            |
| 3   | `POST /{comment-id}/comments` (FB) · `/replies` (IG)      | Public reply under a comment        | `worker/handlers/send-meta.ts:152`, `worker/handlers/test-comment-permission.ts:64`            |
| 4   | `POST /{account-id}/messages` with `recipient.comment_id` | Private reply to a commenter        | `worker/handlers/send-meta.ts:164`                                                             |
| 5   | `POST /{comment-id}?is_hidden=` (FB) · `?hide=` (IG)      | Hide / unhide a comment             | `worker/handlers/moderate-meta-comment.ts:87`                                                  |
| 6   | `DELETE /{comment-id}`                                    | Delete a comment                    | `worker/handlers/moderate-meta-comment.ts:85`, `worker/handlers/test-comment-permission.ts:91` |
| 7   | `GET /me/published_posts?limit=1&fields=id`               | The Page's newest own post          | `worker/handlers/test-comment-permission.ts:110`                                               |
| 8   | `GET /{user-id}?fields=…`                                 | Customer's name, handle, picture    | `lib/meta/profile-refresh.ts:115`                                                              |
| 9   | `GET <CDN url>` (no credential)                           | Download an attachment or avatar    | `lib/meta/profile-refresh.ts:216`, `worker/handlers/download-media.ts:184`                     |

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

Over Unified Login the request is addressed the same way, on the same host as
the Page's — `POST graph.facebook.com/{ig-account-id}/messages` with
`INSTAGRAM_UNIFIED_LOGIN_TOKEN` where the Page token would be. The account id
is `INSTAGRAM_ACCOUNT_ID` on every connection; it is never `/me`, which on a
system-user token is the system user and not the account. The worker's log
line says which route carried a send: `[send_meta] … on instagram via
unified_login`.

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

#### The satisfaction survey's two bodies

The same `POST /{account-id}/messages`, with a body built and tested beside
`send.ts` rather than by `directMessageRequest()`, and sent through
`sendMessageRequest()`. `send_meta` reads which from the message row's
`sendKind`, written by `send_csat` (`lib/csat/meta-survey.ts`):

- **`feedback_template`** — Messenger's customer feedback card
  (`lib/meta/feedback-template.ts`): one `csat` question, five stars answered
  `"1"`–`"5"`, a free-form follow-up, `business_privacy.url` (required; the
  admin page holds it) and `expires_in_days` 1–7. The question id is
  `csat_<survey uuid without hyphens>`, because Meta refuses a hyphen in one, and
  it is how the answer finds its row. Inside 24 hours it goes as `RESPONSE`;
  past them, up to seven days after the customer's last message, with
  `messaging_type: MESSAGE_TAG` and `tag: CUSTOMER_FEEDBACK` — a tag valid on
  this card and nothing else, so `feedbackTemplateTag()` is a function of its
  own beside `messagingTag()`. Messenger only. Meta marks the card "in
  development"; a refusal of the card — a permanent one at once, code 1
  (`isUnknownError`) on the queue's last try, and never one about the
  customer, such as `551` or another app holding the thread
  (`isRecipientRefusal`) — is kept on `csat_settings` for the admin page and,
  inside 24 hours, the survey goes as the next body instead. A card that goes
  out clears it; until then, and for a day at most, a survey due past the 24
  hours is skipped `card_refused` rather than sent to fail.
- **`quick_reply_survey`** — the question with five `quick_replies`
  (`lib/meta/quick-reply-survey.ts`), titles at most 20 characters, payload
  `csat:<survey uuid>:<1-5>`, on `directMessageRequest()`'s in-window body.
  Instagram's survey on both connections, and Facebook's fallback and its
  survey while no privacy link is set. Inside 24
  hours only: no tag carries a quick reply past them. Meta does not draw quick
  replies on desktop.

The answers come back on §6's webhook: the card's as a `messaging_feedback`
event (§3's Page field list carries it), a tap as a `messages` event whose
`message.quick_reply.payload` is ours — which `parseMetaWebhook` files as an
answer and never as a message (`recordMetaFeedback`, `lib/csat/meta-feedback.ts`).

### 2.2 Take thread control

`POST /{page-id}/take_thread_control`, body from `takeThreadControlRequest()`.

**Facebook Page only.** Handover is a property of the Page connection — an
Instagram account reached through Instagram Login is not installed on anything
and has no primary receiver to take control from, and Meta's migration guide
lists the protocol as not supported on Unified Login — so `takeThreadControl()`
asserts the connection before calling, rather than sending a request to an edge
that does not exist on `graph.instagram.com` or means nothing for a
system-user token.

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
cannot be retried. It is addressed to one of the requester's own comments rather
than the thread root: the one the agent picks, defaulting to their newest
because that buys the most time. Never simply the newest comment on the ticket:
anybody may reply under the customer's comment, ingest files that reply on the
customer's ticket, and a private reply is delivered to whoever wrote the comment
it names (`lib/tickets/reply-comment.ts`).

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

Not Graph. `downloadAttachment()` (`lib/meta/client.ts:694`) fetches a URL Meta
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

### 2.9 Connecting the account through Unified Login — `lib/meta/unified-login.ts`

Not through `graph()`, and not a job: the login hands the browser a code that is
single-use and short-lived, and the admin is waiting on the one sentence the
exchange answers, the same two reasons `lib/whatsapp/onboarding.ts` gives for
the signup exchange. `GET /api/meta/unified-login/start` sets a `state` cookie
and opens Meta's dialog on `www.facebook.com/{version}/dialog/oauth` with the
configuration's `config_id` in place of `scope` and `response_type=code`;
`GET /api/meta/unified-login/callback` checks the state, makes the three calls
below, and renders the token once — in a page sent `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`, behind `admin.channels.connect` — for the
admin to set as `INSTAGRAM_UNIFIED_LOGIN_TOKEN` on Render. Nothing stores it.

| Graph request                                                       | Credential                        | What it does                                                                                                      | Called from                                                                      |
| ------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /oauth/access_token?client_id&client_secret&redirect_uri&code` | `META_APP_ID` + `META_APP_SECRET` | Exchange the login code for the system-user token                                                                 | `lib/meta/unified-login.ts` (`exchangeCode`, own `fetch`) via the callback route |
| `GET /debug_token?input_token=`                                     | app token (header)                | Type, validity, expiry and scopes of the new token; refused if invalid or minted for another app                  | `lib/meta/debug-token.ts` (`inspectToken`) via the callback route                |
| `GET /me/assigned_instagram_accounts?fields=id,username`            | the new token                     | **The proof** the token reaches an Instagram account, and a warning when `INSTAGRAM_ACCOUNT_ID` is not among them | `lib/meta/unified-login.ts` (`connectedAccounts`, through `readGraph`)           |
| `GET /me?fields=client_business_id`                                 | the new token                     | The business portfolio, as metadata — never a reason to fail                                                      | `lib/meta/unified-login.ts` (`clientBusinessId`, through `readGraph`)            |

The exchange is a `GET` with the app secret and the code in the query string
because that is the only shape Meta documents, so `tokenExchangeUrl` builds the
URL and nothing else, the route sends it with its own `fetch`, and anything Meta
or the network says back has the code and the secret cut out before it is
repeated. `redirect_uri` must match the dialog's byte for byte, and both are
built from `APP_URL` — which is why the callback path, and not the site root,
is the URL registered on the configuration. `/me/assigned_instagram_accounts`
is the proof rather than `debug_token`, as the WABA read is for a business token
(§5.1): `granular_scopes` need list no target, and the account read says what
the token can actually address.

## 3. Webhook subscriptions — `lib/meta/subscriptions.ts`

Configuration, not traffic: run by hand as `npm run job --
subscribe_meta_webhooks object=<object>` and from nowhere else, which is why
nothing here retries — a person is watching, and a failure they can read beats a
retry that hides which half of a two-step change landed.

**A webhook has two subscriptions, not one.** Meta's own sentence is that "only
fields with subscriptions at both the page and app levels will get Webhooks", so
there is an app-level write _and_ an account-level one — and because the account
level is where the Instagram connections part company, there are four writes
rather than two:

| Level           | Graph request                                             | Credential                          | Helper                                                               |
| --------------- | --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| App             | `GET`/`POST graph.facebook.com/{app-id}/subscriptions`    | app token, `{app-id}\|{app-secret}` | `readSubscription` / `applyFieldSubscription`                        |
| Facebook Page   | `GET`/`POST graph.facebook.com/{page-id}/subscribed_apps` | `META_PAGE_ACCESS_TOKEN`            | `readPageSubscription` / `applyPageSubscription`                     |
| Instagram Login | `GET`/`POST graph.instagram.com/{ig-id}/subscribed_apps`  | `INSTAGRAM_ACCESS_TOKEN`            | `readInstagramLoginSubscription` / `applyInstagramLoginSubscription` |
| Unified Login   | `GET`/`POST graph.facebook.com/{ig-id}/subscribed_apps`   | `INSTAGRAM_UNIFIED_LOGIN_TOKEN`     | `readUnifiedLoginSubscription` / `applyUnifiedLoginSubscription`     |
| WhatsApp WABA   | `POST`/`GET graph.facebook.com/{waba-id}/subscribed_apps` | the stored business token           | `subscribeAppRequest` / `subscribedAppsRequest`                      |

The app level is shared — one app, one `instagram` object subscription serving
every Instagram connection. Each connection then owns its account-level half:
the direct connection's on its own host with its own credential, Unified
Login's on the Page's host with its own token and the `instagram` object's own
field list, and the Page's with a different field vocabulary again. The Unified
Login write is `subscribed_fields=<comma list>` with the token in the header,
answered `{"success": true}`, and `GET` on the same edge reads it back; without
it the connection is authorised and silent, which is why it is a step of the
activation in `plans/instagram-unified-login.md` and not an afterthought.

The fifth row is the account-level half for a WABA connected through Embedded
Signup, and it is the one write in this table that is not hand-run: it is the
`subscribe` step of `complete_coexistence_onboarding`
(`lib/whatsapp/onboarding-complete.ts`, shapes in
`lib/whatsapp/onboarding-requests.ts`), because the WABA was handed to this app
seconds earlier and nothing else can subscribe it. It carries no field list — a
body-less POST subscribes the app, and would clear a WABA-level callback
override this app never sets — and the GET afterwards is the proof, since a 200
on the POST is not: the step is retried until `META_APP_ID` is listed. The
app-level half it cannot write for itself the job reads back instead:
`readSubscription(WHATSAPP_OBJECT)` must list every name in
`COEXISTENCE_WHATSAPP_FIELDS`, and a missing one is recorded as a warning on the
step, naming `npm run job -- subscribe_meta_webhooks`, because without it the
number connects and every phone-typed reply and every chunk of history falls on
the floor.

**Every one of these writes replaces the field list rather than adding to it.**
A request naming only `account_alerts` silently unsubscribes `messages`, and
Meta reports that as success. So `mergeFields()` is the safety-critical part of
the job, is shared by every level, and throws rather than producing a list
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

| Object                      | Fields                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `whatsapp_business_account` | `messages`, `history`, `smb_app_state_sync`, `smb_message_echoes`, `account_update`                         |
| `instagram`                 | `messages`, `comments`, `messaging_postbacks`, `messaging_referral`, `message_reactions`                    |
| `page`                      | `messages`, `feed`, `messaging_postbacks`, `messaging_referrals`, `message_reactions`, `messaging_feedback` |

Two differences in that table are load-bearing. Facebook has **no comments
field** — `feed` carries comments, likes, shares and post edits together,
discriminated by `value.item`, and `lib/meta/parse.ts` keeps the comments and
drops the rest. And the referral field is spelled `messaging_referral` on
Instagram and `messaging_referrals` on the Page: one character, and Graph
rejects the whole write rather than the one bad name, so the two lists cannot be
folded together however similar they look.

The four WhatsApp names after `messages` are `COEXISTENCE_WHATSAPP_FIELDS` —
what a number on the WhatsApp Business app sends beyond customer messages; §6
says where each lands. `smb_message_echoes` is proven on this app by having been
subscribed throughout; the other three are spelled as the webhooks overview's
field table spells them, and the first run after the list grew is on staging for
that reason, since one bad name fails the whole write.

## 4. Diagnostics — `check_meta_permissions`

Read-only, `npm run job -- check_meta_permissions`, safe against production.
Four calls across the three connections, each made only while its connection's
token is set:

| Graph request                                                              | Credential                      | What it settles                                             |
| -------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------- |
| `GET graph.facebook.com/debug_token?input_token={page-token}`              | app token (header)              | token `type`, `scopes`, `granular_scopes`, validity, expiry |
| `GET graph.instagram.com/me?fields=user_id,username`                       | `INSTAGRAM_ACCESS_TOKEN`        | whether the token works, and which account it belongs to    |
| `GET graph.facebook.com/debug_token?input_token={unified-token}`           | app token (header)              | the same as the Page's, for the Unified Login token         |
| `GET graph.facebook.com/me/assigned_instagram_accounts?fields=id,username` | `INSTAGRAM_UNIFIED_LOGIN_TOKEN` | whether the token reaches `INSTAGRAM_ACCOUNT_ID`            |

`debug_token` rather than `/me/permissions`: the latter needs a _user_ token and
this deployment sends with a Page one, where `/me` is the Page and the edge does
not exist. It takes any token, is authorised with the same app token
§3 builds, and returns `granular_scopes`, which says per asset who a
permission was granted for — the thing that matters when one app administers
more than one Page. The call is `inspectToken` in `lib/meta/debug-token.ts`,
lifted out of the job so that it and the WhatsApp onboarding — which stores what
`debug_token` says beside the sealed token — ask Meta one question through one
function, the `profile-refresh.ts` lesson. The job also prints a section per
stored WhatsApp credential: it resolves each through `credentialsForAccount`,
as only a worker may, and prints the key id, Meta's `type`, validity, expiry and
whether the two required scopes reach the WABA — never the token. It prints and
writes nothing back, so it is not what fills in a credential whose expiry was
unknown when it was stored; only storing one records an inspection (§5.1).

The Instagram half can say much less, and says so. `debug_token` is a
`graph.facebook.com` endpoint and an Instagram Login token is issued by the
Instagram side of the app, which publishes no scope list — so this asks the only
question that host will answer. That is still worth asking: both Instagram
outages this system has had were a credential in the wrong place, and the
account-id mismatch check here would have named either in one line.

The Unified Login half answers fully, because its token is a
`graph.facebook.com` token like the Page's: `debug_token` reports its type,
validity, expiry (`expires_at: 0`, never, when the configuration was set up as
the plan asks) and scopes, and the capabilities under `unified_login` in
`lib/meta/capabilities.ts` are diagnosed against them. `/me` on that token is
the business integration system user, not the account, so the question the
direct connection asks of `/me` is asked here of `/me/assigned_instagram_accounts`
instead: the account every send is addressed to must be in the list, or every
reply fails with a token Meta calls valid.

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
  (`lib/whatsapp/accounts.ts`). It is the middle of three sources: a credential
  stored by Embedded Signup wins over it, and it wins over
  `META_PAGE_ACCESS_TOKEN`; a stored one that will not open throws rather than
  falling through.

### 5.1 Connecting a number on the WhatsApp Business app

Eight calls, written down in `lib/whatsapp/onboarding-requests.ts` and asserted
there against Meta's references, because the documentation for this flow is
split across two generations of pages that do not agree and a wrong shape is
invisible in the response. The first phase runs in a server action, inside the
thirty seconds the signup code lives (`lib/whatsapp/onboarding.ts`); the rest is
the `complete_coexistence_onboarding` job (`lib/whatsapp/onboarding-complete.ts`),
with the stored credential.

| Graph request                                                                         | Credential                        | What it does                                                   | Called from                                                |
| ------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /oauth/access_token?client_id&client_secret&code`                                | `META_APP_ID` + `META_APP_SECRET` | Exchange the signup code for a business token                  | `lib/whatsapp/onboarding.ts` (`exchangeCode`, own `fetch`) |
| `GET /debug_token?input_token=`                                                       | app token (header)                | Type, validity, expiry, scopes of the new token                | `lib/whatsapp/onboarding.ts` via `lib/meta/debug-token.ts` |
| `GET /{waba-id}?fields=id,name`                                                       | the new token                     | **The proof** the token reaches the WABA the browser named     | `lib/whatsapp/onboarding.ts`                               |
| `GET /{waba-id}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100` | the new token, then stored        | The number, when the finish event named none; then its details | `lib/whatsapp/onboarding.ts`, `onboarding-complete.ts`     |
| `GET /me?fields=client_business_id`                                                   | the new token                     | The business portfolio, as metadata — never a reason to fail   | `lib/whatsapp/onboarding.ts`                               |
| `GET /{phone-number-id}?fields=is_on_biz_app,platform_type`                           | stored                            | The coexistence guide's optional "is it on the app?" check     | `lib/whatsapp/onboarding-complete.ts` (`numberStep`)       |
| `POST /{waba-id}/subscribed_apps` (no body), then `GET` it                            | stored                            | Subscribe this app to the WABA, and prove it (§3)              | `lib/whatsapp/onboarding-complete.ts` (`subscribeStep`)    |
| `POST /{phone-number-id}/smb_app_data` `{messaging_product, sync_type}`               | stored                            | Ask the phone for its contacts or its chat history             | `lib/whatsapp/onboarding-complete.ts` (`syncStep`)         |

Three things about the table are decided rather than copied:

- **The exchange is a `GET` with query parameters**, because that is the shape
  Meta documents for a Tech Provider and the only one it documents. It puts the
  app secret and the code in a URL, so `tokenExchangeUrl` builds the URL and
  nothing else, the action sends it with its own `fetch` outside every Graph
  client, and anything Meta or the network says back has both secrets cut out
  before it is repeated. Nothing is written before it succeeds. The calls after
  it are held to the same rule, since nothing in Graph's contract promises it
  never echoes what it was sent: the action repeats what the `debug_token`,
  WABA, `phone_numbers` and `/me` reads say with the token, the code and the
  app secret cut out (`redact`), and the job sends every call through
  `askGraph`, which cuts the stored token and the app secret out of the error
  before a step, the attempt's `error`, `last_transient_error` or the worker
  log repeats it — and the app-token subscription read, which `askGraph` does
  not see, by hand.
- **The WABA read is the proof, not `debug_token`.** `granular_scopes` may list
  no targets for a business token, so the inspection refuses only what Meta
  actually said — the wrong app, a missing scope, a target list that excludes
  the WABA — and an inspection that did not answer is a warning on the notice.
  The metadata then stays null, and the account's badge reads `expiry unknown`,
  until a Reconnect stores a token Meta's inspection answered for:
  `check_meta_permissions` prints the expiry without storing it, and nothing
  else asks. The read asks for `id,name` and no more: neither reference lists
  `owner_business_info`, which an earlier draft wanted.
- **The copy is once per onboarding, inside 24 hours, with the app open on the
  phone.** Meta's 2593107 (already asked) and 2593108 (window passed) both mean
  "reconnect" and are worded so; a business declining on the phone does not
  land here at all — Meta accepts the request and says so later, in a `history`
  delivery carrying 2593109. A reconnect does not ask again for what an
  earlier connection finished copying (`copiedSoFar`); a copy that was only
  requested — refused, stalled, never delivered, declined on the phone — is
  asked for again.

## 6. Inbound: the endpoints Meta calls

Two routes, both following the same discipline — verify the signature, persist
the raw payload, enqueue, return 200. Nothing in either parses a message,
touches storage or calls Graph: Meta expects a 200 within seconds, retries the
entire batch on anything else, and eventually disables a subscription that keeps
failing.

| Route                    | Objects delivered           | Signature checked against                                                                                                                                  |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/webhooks/meta`     | `page`                      | `META_APP_SECRET`                                                                                                                                          |
| `/api/webhooks/meta`     | `instagram`                 | `INSTAGRAM_APP_SECRET`, its legacy name, then `META_APP_SECRET` — first match wins; `META_APP_SECRET` signs both the Page's and Unified Login's deliveries |
| `/api/webhooks/whatsapp` | `whatsapp_business_account` | `META_APP_SECRET`                                                                                                                                          |

`GET` on each answers Meta's subscription handshake with the bare challenge
string (not JSON), checked against `META_VERIFY_TOKEN`. `POST` reads the body as
**text, not `json()`** — the X-Hub-Signature-256 signature covers the exact bytes
Meta sent, and re-serialising a parsed object produces a different string.

One endpoint serves both Meta objects because Meta delivers them through one app
subscription and distinguishes them only by `object`. One endpoint does not mean
one credential, though: an Instagram account connected more than one way signs
byte-identical bodies with two different app secrets, so `lib/meta/signing.ts`
decides which secrets _could_ have signed a delivery from the object in the
body, and **which one actually did is the only thing that says which connection
the delivery came in on**. It is recorded on the row because it is knowable
there and nowhere downstream. It cannot separate the Page's deliveries from
Unified Login's, which are signed with the same `META_APP_SECRET`, so both are
labelled `facebook_page`; nothing downstream needs more, since the one reader
of the label (`lib/meta/thread.ts`) asks only whether a `standby` should stop a
send, and Unified Login has no handover protocol for one to be about. The
envelope — `messaging` or `standby` — is what tells the two apart in the table,
and the plan's verification queries read it off the payload.
`INSTAGRAM_APP_SECRET` is also read under its older name
`META_INSTAGRAM_APP_SECRET`, and neither app secret can be removed while the
direct connection is live — unsetting one resumes 403s for that half of the
traffic (`docs/PROJECT-STATE.md` §6.26, §6.29); the plan's activation order
disconnects it in the dashboard first and unsets the variables last.

A number connected through coexistence adds four fields to the WhatsApp route,
parsed by `lib/whatsapp/parse.ts` and handed out by
`worker/handlers/process-whatsapp-webhook.ts`:

| Field                | Carries                                                                                                                                                                  | Ingested by                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `history`            | Chunks of the phone's past chats, per phase, each with the whole copy's `progress` (100 is complete); a decline (2593109, inside a chunk's `errors`); media placeholders | `ingestWhatsAppHistoryChunk`, `attachHistoryMedia` (`lib/tickets/ingest-whatsapp-history.ts`)       |
| `smb_app_state_sync` | Entries from the phone's address book, `add` or `remove`                                                                                                                 | `applyWhatsAppContactSync` (same module)                                                            |
| `smb_message_echoes` | A reply the business typed on the phone                                                                                                                                  | `ingestWhatsAppEcho` (`lib/tickets/ingest-whatsapp.ts`) — the team's reply on a coexistence channel |
| `account_update`     | `PARTNER_REMOVED` (with who started it, `initiated_by`, which the channel's badge turns into a sentence), `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`                    | `applyWhatsAppAccountUpdate` (`lib/whatsapp/coexistence-state.ts`)                                  |

Each delivery's idempotency key comes from `lib/whatsapp/delivery-id.ts`:
`hm:<wamid>` per history message — distinct from `m:`, because the file behind
a placeholder arrives later under the same wamid — and
`c:<phone>:<action>:<timestamp>` per contact. A list that is not one, or an
element that is not an object, adds nothing to the key rather than throwing: the
key is read in the route before the row is written, so a throw there was a 500
with nothing stored, and Meta redelivering the same bytes met the same throw.
**Nothing for `account_update`**:
the index behind the key is spent for good, and a number disconnected,
reconnected and disconnected again sends the same body twice, so its handler is
idempotent instead — and applies an event only when it is at least as new as
the connection and as the last one applied (`coexistence.accountEventAt`), so
an older event processed late changes nothing. History is a record rather than
traffic — no window, no clocks, no automations, no media download — and the
echo on a plain support number is still our own send coming back and still
ignored; AGENTS.md carries the rules.

## 7. Endpoints deliberately not used

Recorded so the next reader does not have to re-derive the reason, or "fix"
something by adding one back.

| Not used                                    | Why                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /me/permissions`                       | Needs a _user_ token; this deployment sends with a Page one, where `/me` is the Page and the edge does not exist       |
| `POST /{comment-id}/private_replies`        | Removed after Graph API v3.2; the app addresses v23.0, so it can only ever be refused                                  |
| `POST /{page-id}/request_thread_control`    | The secondary receiver's call, answered by whoever runs the _other_ tool rather than by Meta                           |
| `live_comments`, `mentions` webhook fields  | Nothing ingests them, and an unread field is a `webhook_events` row and a job per event, forever                       |
| `message_echoes` (WhatsApp)                 | Discontinued by Meta: absent from the v23.0 reference and refused on write, so requiring it failed every subscribe run |
| `messaging_type` on a tagged Instagram send | Absent from both Instagram send references; see §2.1 for why only the tagged half drops it                             |
| `pages_user_timezone` / `timezone` field    | A third permission to justify to App Review for a column no screen shows                                               |
| The Facebook SDK                            | A handful of endpoints do not justify the SDK's surface or its transitive dependencies (`lib/whatsapp/client.ts`)      |
| Read receipts (`status: read`)              | Never wired up; the unused `markRead` helper has since been deleted from `lib/whatsapp/client.ts`                      |

One row left this table on 2026-10-08. `smb_message_echoes` was listed beside
the discontinued `message_echoes` as not worth reaching for, because 0 of
395,391 deliveries carried it — which proved only that no number was operated
from the WhatsApp Business app, and a number connected through coexistence is
exactly that. It is required and ingested now (§3, §6);
`docs/PROJECT-STATE.md` §6.87 has the correction, so the next reader does not
drop it from `REQUIRED_WHATSAPP_FIELDS` as dead.

## 8. What each call needs, and what currently gates one

Credentials, all optional in the schema (`lib/env.ts`) and declared in
`render.yaml` in the same commit:

| Variable                                                    | Used by                                                                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_PAGE_ACCESS_TOKEN`                                    | §2 over the Page connection, the Page subscription write, `debug_token`'s input, and the WhatsApp default token                                                              |
| `META_APP_ID` + `META_APP_SECRET`                           | The app token for `/{app-id}/subscriptions` and `debug_token`'s authorisation                                                                                                |
| `META_APP_SECRET`                                           | Also verifies X-Hub-Signature-256 on `page` and WhatsApp deliveries                                                                                                          |
| `META_VERIFY_TOKEN`                                         | Answers the subscription handshake, on both webhook routes and on every write                                                                                                |
| `FACEBOOK_PAGE_ID` / `INSTAGRAM_ACCOUNT_ID`                 | The node every send, private reply and subscription write is addressed to                                                                                                    |
| `INSTAGRAM_ACCESS_TOKEN`                                    | Everything in §2 and §3 routed over the direct Instagram connection                                                                                                          |
| `INSTAGRAM_APP_SECRET` (a.k.a. `META_INSTAGRAM_APP_SECRET`) | Verifies deliveries signed by the Instagram Login connection                                                                                                                 |
| `INSTAGRAM_UNIFIED_LOGIN_TOKEN`                             | Everything in §2 and §3 routed over Unified Login, ahead of the two connections above while it is set; a system-user token the callback page (§2.9) shows once               |
| `INSTAGRAM_UNIFIED_LOGIN_CONFIG_ID`                         | The Facebook Login for Business configuration "Connect Instagram" opens Meta's login with — created under Instagram → API setup with Unified login; an id, per environment   |
| `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_WABA_ID`             | The default send number and the template listing                                                                                                                             |
| `WHATSAPP_TOKEN_*`                                          | A second business account's own token, named by a database row — after a stored credential, before the shared                                                                |
| `META_EMBEDDED_SIGNUP_CONFIG_ID`                            | The Facebook Login for Business configuration the browser opens Embedded Signup with; an id, but per environment, and a v4 one (products selected): v2 and v3 end 2026-10-15 |
| `WHATSAPP_CREDENTIAL_KEY`                                   | Seals and opens the stored business tokens (§1): its own value per environment, never derived from `APP_SECRET`                                                              |
| `WHATSAPP_CREDENTIAL_KEY_PREVIOUS`                          | The key being retired, set only while `rotate_whatsapp_credentials` runs                                                                                                     |

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

A fourth gate is unknown rather than closed. Embedded Signup is refused unless
the app is a **Tech Provider** (or Solution Partner), which needs business
verification first, and whether either Meta app is one has not been checked —
nothing in §5.1 has run live. And from 2026-10-15 the configuration
`META_EMBEDDED_SIGNUP_CONFIG_ID` names must be a v4 one, which nothing here can
read back. `docs/PROJECT-STATE.md` §5.2 lists that with the
rest of what the first live onboarding waits on.

---

**Keeping this current.** Add a row when you add a call, and put the reasoning
next to the code rather than only here — `lib/meta/send.ts`,
`lib/meta/comments.ts`, `lib/meta/handover.ts`,
`lib/whatsapp/onboarding-requests.ts` and `lib/meta/unified-login.ts` are the
request shapes, and their headers are the evidence. When adding or changing a Graph request, read
the node reference **for v23.0 specifically**: an edge missing from it is a
finding rather than an omission by the doc, and removal notices sit on a
separate legacy page that a search for the working endpoint will not surface
(§6.43).
