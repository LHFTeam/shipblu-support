# The Meta App Review submission — what to ask for, and what has to work first

An audit of the permission list staged in App Review against what this codebase
actually calls. Two questions: which requests have no code behind them, and
which of the ones worth keeping cannot be screencast today.

_Updated 2026-08-27, against the list as it now stands and after the Instagram
account was moved back onto its Facebook Page (`docs/PROJECT-STATE.md` §6.28).
The first version of this file recommended the `instagram_business_*` family;
that move reverses it, and the list below is the one that matches the live
connection._

_Corrected 2026-09-25: the premise of that update did not survive. The account
is connected **both ways at once** — `docs/PROJECT-STATE.md` §6 settles it as
"Both sets are needed now" — and `INSTAGRAM_ACCESS_TOKEN` is set, so every
Instagram send goes out over the direct connection (the 2026-09-06 Human Agent
refusal came back `via graph.instagram.com`, §5.2). The table and the paragraph
under it are amended to match; the
[`instagram_manage_comments`](#instagram_manage_comments-written-out) section has
the full reasoning, and it applies to the messaging pair as much as to the
comment pair._

## Result of the 2026-09-19 submission

Submitted 2026-09-19 at 04:15 GMT+3. The review has come back **partly
approved**. This is the outcome as the App Dashboard shows it. Meta's written
feedback for the refusals has not been recorded here yet, and it is the first
thing to read before resubmitting.

| Outcome          | Items                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approved**     | `pages_messaging`, `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `pages_user_locale`, `pages_user_gender`, `instagram_basic`, `instagram_manage_messages`, `whatsapp_business_messaging`, `whatsapp_business_management`, Business Asset User Profile Access |
| **Not approved** | `pages_read_user_content`, `pages_manage_engagement`, `instagram_manage_comments`                                                                                                                                                                                                   |
| **Renewed**      | `public_profile`, `email`                                                                                                                                                                                                                                                           |

Four things follow from it:

- **Every refusal is a comment permission.** All three are the comment set,
  and it is the one part of the submission whose screencast has to show a write
  to a comment. As of the last check none had ever succeeded here (see the
  `pages_manage_engagement` evidence below). Everything messaging-shaped was
  approved. Why these three were refused is Meta's feedback to answer, not an
  inference to make from this table. The resubmission is the three sections
  written out below, so read the feedback against them.
- **Human Agent is not in this list, and it is being resubmitted with the three
  comment permissions.** A feature is not a permission, and it is granted to
  the app rather than to a token. The 2026-09-06 refusal (§5.2) stands until the
  dashboard says otherwise. Its section below now carries
  [the screencast plan](#human-agent--the-screencast) it lacked.
- **The approved Instagram pair is the Page connection's.** `instagram_basic`
  and `instagram_manage_messages` are granted, but replies go out over the
  direct connection while `INSTAGRAM_ACCESS_TOKEN` is set (the footnote under
  the table below). An approval for one connection does not grant the other.
  Run `npm run job -- check_meta_permissions` to see what each token now holds
  before concluding that Instagram replies are covered.
- **`email` was renewed** despite the "Remove" verdict below. It is harmless,
  and the verdict only matters for the next submission.

For `instagram_manage_comments` in particular, settle the Page-versus-direct
question in [its section](#instagram_manage_comments-written-out) before
resubmitting. Resubmitting it unchanged while the console acts over
`graph.instagram.com` means filming the other connection's permission again.

## The list as it stands

Eleven new requests, two renewals:

| Requested                            | Called by                                                  | Verdict    |
| ------------------------------------ | ---------------------------------------------------------- | ---------- |
| Human Agent                          | `lib/meta/window.ts`, `sendDirectMessage`                  | **Keep**   |
| Business Asset User Profile Access   | `fetchProfile`, `lib/meta/profile-refresh.ts`              | **Keep**   |
| `pages_messaging`                    | `sendDirectMessage`, the `page` webhook                    | **Keep**   |
| `whatsapp_business_messaging`        | `lib/whatsapp/client.ts` — five endpoints                  | **Keep**   |
| `instagram_basic`                    | the Instagram profile read, on the Page token              | **Keep**   |
| `instagram_manage_messages`          | Instagram DMs delivered over the Page connection           | **Keep**   |
| `instagram_business_basic`           | the direct connection's token, `graph.instagram.com`       | **Add**²   |
| `instagram_business_manage_messages` | `sendDirectMessage` for Instagram DMs, today               | **Add**²   |
| `pages_user_locale`                  | `fetchProfile` extended → `contact_identities`             | **Keep**   |
| `pages_user_gender`                  | `fetchProfile` extended → `contacts.gender`                | **Keep**   |
| `pages_manage_metadata`              | receiving Page webhooks                                    | **Keep**¹  |
| Page Public Content Access           | nothing                                                    | **Remove** |
| `whatsapp_business_manage_events`    | nothing                                                    | **Remove** |
| `public_profile` (renewal)           | nothing — mandatory for every app, cannot be removed       | Keep       |
| `email` (renewal)                    | nothing — agent auth is a password, `lib/auth/password.ts` | **Remove** |

¹ The app performs this one now: `subscribe_meta_webhooks object=page` writes
`POST /{page-id}/subscribed_apps` as well as the app-level subscription, so
there is a real call to point at rather than a dashboard action.

² Not on the staged list. See below.

**The Instagram rows were written for one connection, and there are two.**
`instagram_basic` and `instagram_manage_messages` are the **Page-connected**
family, and they are still needed: Instagram deliveries arrive over the Page
connection as well as the direct one (`webhook_events.connection` records which).
But `metaConnection()` in `lib/meta/connection.ts` sends every Instagram reply
over the **direct** connection whenever `INSTAGRAM_ACCESS_TOKEN` is set, and it
is set. So the permission a screencast of an agent answering an Instagram DM
actually exercises today is `instagram_business_manage_messages`. An earlier
version of this paragraph said that one "correctly came off the list". It came
off on the strength of the §6.29 reading, which §6 has since retracted. Whether
to add the direct pair or to film over the Page is the same three-way decision
the `instagram_manage_comments` section sets out, and it should be made once,
for both pairs. `check_meta_permissions` reports the two sets separately, and it
is the place to confirm what each token actually holds.

`user_messenger_contact` coming off is still right: every send in this system
answers an inbound message.

## Why the two removals

**Page Public Content Access is for other people's Pages.** It exists to read
public Page data where the app lacks `pages_read_engagement` and
`pages_read_user_content`. ShipBlu reads exactly one Page — its own — and there
is no Pages Search call, no `/posts` read and no `/feed` read anywhere in the
repo. What the Facebook comment work actually needs is `pages_read_engagement`,
which is a different request and is missing (below).

**`whatsapp_business_manage_events` has no call site.** It logs commerce events
(purchase, add-to-cart, leads) against a WhatsApp Business Account for ads
targeting and reporting. This is a helpdesk. `lib/whatsapp/client.ts` calls five
endpoints — send text, send template, media lookup, media download, template
listing — and none of them is an event log. (Mark-read was a sixth on paper; it
never had a caller and has since been deleted.)

`email` is harmless but unused: agents sign in with a password, and no Facebook
Login flow exists in `app/(auth)/`. `public_profile` is mandatory on every app
and cannot be dropped.

## Five permissions the product needs and the list does not have

This is the larger problem, and an earlier version of this file got two of the
names wrong. The comment feature merged in #87 and **not one of its permissions
is requested.** Meta's dependency graph, read from the permission reference
rather than assumed:

| Permission                  | Why it is needed                                          | Depends on                                                    |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `pages_show_list`           | dependency of nearly every Page permission below          | —                                                             |
| `pages_read_user_content`   | read _and delete_ other people's comments on Page posts   | `pages_show_list`                                             |
| `pages_manage_engagement`   | create, edit and hide comments on the Page                | `pages_read_user_content`, `pages_show_list`                  |
| `pages_read_engagement`     | read the Page's own content — and an Instagram dependency | `pages_show_list`                                             |
| `instagram_manage_comments` | the same four verbs on Instagram                          | `instagram_basic`, `pages_read_engagement`, `pages_show_list` |

Two corrections worth stating plainly, because the first version of this file
would have produced a submission that still could not moderate a comment:

- **The Facebook read permission is `pages_read_user_content`, not
  `pages_read_engagement`.** `pages_read_engagement` covers content the _Page_
  posted; a customer's comment is user-generated content, and reading or
  deleting it is `pages_read_user_content`. Both are needed here, for different
  reasons — the second only because Instagram depends on it.
- **`pages_show_list` has to be requested explicitly.** It is the dependency of
  everything else in the table and it is on no line of the current submission.
  Meta's guidance for a dependency is to submit it and name the main permission
  in the use-case description.

`instagram_manage_comments` is the Page connection's name and
`instagram_business_manage_comments` the Instagram Login family's. An earlier
version of this paragraph called the second "the wrong one to ask for", on the
premise that the account was back on its Page alone. It is on both, and
Instagram comment actions go out over the direct connection today, so read
[the section written out below](#instagram_manage_comments-written-out) before
choosing.

**And it gates receiving the webhook at all, not just acting on one — which is
the part that bites.** Meta lists it among the prerequisites for the `comments`
field, alongside Advanced Access and a verified business. Verified on
2026-08-29: the `instagram` object is subscribed to `comments` at the app level,
the Page subscription is in place, and a real Instagram comment still produces
nothing while Meta's own test payload sails through. So this is not a permission
that merely unlocks the Hide and Delete buttons — without it there is no
Instagram comment ticket to put buttons on.

## The "no API calls have ever been made" gate

**Request advanced access** stays greyed out until Meta has logged one
successful call against the permission. That reads like a deadlock — the call
needs the permission, the permission needs the call — and it is not one.

**Standard Access is automatic and needs no review.** Every Business app has it
for every permission its type allows. What it limits is _whose_ data you may
touch: only people with a role on the app (admin, developer, tester), and the
Pages they manage. Since ShipBlu owns the Page and the Instagram account, every
call below is makeable today, against real assets, with nothing approved.

This is the same exemption `docs/PROJECT-STATE.md` §5.2 already uses to get
Business Asset User Profile Access moving, restated for comments.

Meta accepts calls made **by the app or by the Graph API Explorer**, so the
fastest unlock needs no deploy. One call per permission, from a Page token held
by somebody who is both an app role-holder and a Page admin:

| Permission                  | One call that logs it                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| `pages_show_list`           | `GET /me/accounts`                                                    |
| `pages_read_user_content`   | `GET /{page-id}/posts` → `GET /{post-id}/comments`                    |
| `pages_manage_engagement`   | `POST /{comment-id}` with `is_hidden=true` (then unhide)              |
| `pages_read_engagement`     | `GET /{page-id}?fields=name,fan_count`                                |
| `instagram_basic`           | `GET /{page-id}?fields=instagram_business_account` → `/{ig-id}/media` |
| `instagram_manage_comments` | `GET /{ig-media-id}/comments` → hide or reply to one                  |
| `pages_manage_metadata`     | `POST /{page-id}/subscribed_apps` with `subscribed_fields=feed`       |

Order matters in one place only: the comment ids for the two `manage` rows come
from the two `read` rows above them, so run each pair together.

The call is logged within about two days and must fall inside the 30 days before
submission — so do this immediately before submitting, not months ahead.

**The last row is not busywork.** `POST /{page-id}/subscribed_apps` is exactly
the call that subscribes the Page to the `feed` field, which has never been
subscribed and is why **no comment webhook has ever arrived** — 0 of 4,503
`page` and `instagram` deliveries carry a `changes` entry, checked again on
2026-08-28. The app subscribes at the _app_ level in `subscribe_meta_webhooks`
(`POST /{app-id}/subscriptions`) and there is no page-level equivalent in the
codebase, so this one has to be made by hand or written.

_Both halves of that have since been overtaken, and the paragraph is kept
because the reasoning for the call still holds. `subscribe_meta_webhooks` now
does have the page-level write (`object=page`), and the "no comment webhook has
ever arrived" count is out of date: real Instagram `comments` deliveries began
arriving at 15:22 UTC on 2026-08-30, the first ever. `docs/PROJECT-STATE.md` §6
has what was actually wrong — a subscription and a signing secret, not the
permission._

## The screencast problem nobody has hit yet

Worth knowing before recording rather than after a rejection. Meta's screencast
requirement for both `pages_manage_engagement` and `instagram_manage_comments`
opens with:

> Demonstrate the complete Facebook login process on your app platform, showing
> how your app user grants your app this permission.

**This app has no Facebook Login.** Agents sign in with a password
(`lib/auth/password.ts`), there is no OAuth flow in `app/(auth)/`, and the Page
was connected through the App Dashboard. There is nothing to film for that first
beat, and the same sentence appears on several of the permissions already
submitted.

That is a question for Meta's reviewer notes rather than a thing to build: a
single-tenant app serving only its owner's Page has no third-party user to
consent, and the use-case description has to say so. Do not discover it halfway
through a recording.

## Locale and gender, now that they are wanted

Both were excluded from the profile call on purpose, and the reason is the thing
to keep hold of: **Graph rejects the whole request when any one field is
unapproved.** `profileFields()` asked for `first_name,last_name,name,profile_pic`
and nothing else precisely so that a missing `pages_user_locale` could not take
the customer's _name_ down with it.

So the fields are not simply appended to that list. `fetchProfile` now asks for
the extended list first and, on the permission refusal alone, retries with the
base list:

- **Approved** — one call, everything captured.
- **Not approved yet** — two calls, and the name and picture still arrive. One
  extra round trip per person, and none once the permissions land.
- **Neither works** — rethrown, because that is Business Asset User Profile
  Access missing rather than these two, which is a different sentence to say.

The retry fires on **any non-transient refusal**, not on the code that looks
like a missing permission. That distinction is the whole thing: `(#100) Tried
accessing nonexisting field (locale) on node type (User)` carries no subcode, so
the narrower `isProfilePermissionRefusal` — which excludes a bare 100 on
purpose, because on a node read it means a field name we got wrong — returns
false for it. Keying the fallback there meant the retry never fired for the one
case it exists to cover. Nothing has ever fetched a Meta profile in production,
so which shape Graph actually sends is unobserved, and the retry must not depend
on guessing it. Transient failures still propagate to the job's own backoff.

That fallback is also a better diagnostic than what it replaces. A bare 100/33
is ambiguous — unapproved app, or deleted person. A first call that fails and a
second that succeeds narrows it to exactly these two permissions, and
`fetch_meta_profile` logs that as its own line rather than leaving a null column
to be puzzled over.

It is not a _complete_ diagnostic, and the log line should not be read as one:
if Graph answers 200 and simply omits an ungranted field rather than refusing
the request, the result is indistinguishable from a customer who set neither.
The refusal path is evidence; silence is not.

Where the two values land:

| Value                       | Column                              | Rule                |
| --------------------------- | ----------------------------------- | ------------------- |
| `ar_AR`, `en_GB` — verbatim | `contact_identities.profile_locale` | Always, per channel |
| `male` / `female`           | `contacts.gender`                   | Only while null     |

**`contacts.locale` is deliberately not written.** That was the first version of
this and it was wrong. The column is not a record of what a channel reported, it
is the answer to "which language do we address this person in", and everything
reading it treats `'ar'` as a settled preference: `preferredLocale` returns
`'ar'` without so much as looking at what the customer wrote, and `send_csat`
and the customer portal branch on it the same way. Nothing had ever written the
column, so that short-circuit was dead code — and filling it from a profile
would have woken it up on every channel at once.

The concrete failure: a merchant whose Facebook interface is set to Arabic sends
one Messenger message, and their out-of-hours **email** auto-reply and their CSAT
survey switch to Arabic, whatever language they have actually been writing in. A
Facebook UI setting is not a support-language preference, and reading the
language off the message body — which is what happens today — is both better
evidence and reversible.

So the reported locale lives on the identity, where it is a fact about a channel
rather than an instruction, and it is displayed on the contact page beside the
identity that reported it.

`pages_user_timezone` is still **not** requested. It is a third permission to
justify for `contacts.timezone`, which no screen reads and nothing writes.

## What cannot be demonstrated today

**Instagram comments have a blocker that _is_ a permission, and it is circular.**
`instagram_manage_comments` is a prerequisite for the `comments` webhook, not
just for acting on one, so the footage cannot be recorded before approval and
the approval wants the footage. Facebook is not symmetric: `feed` needs only
`pages_manage_metadata` and `pages_show_list`, which the token already has, so a
Facebook comment ticket exists today (#10939) and can be filmed. For Instagram
the way through is the role-holder exemption under Standard Access, or Meta
support — not another subscribe job.

**The other blocker is not a permission.** Freshworks is still the
live support service and still the account's default Meta app, so it holds
thread control on both the Messenger and Instagram inboxes and every event
reaches this system as `standby` — readable, not answerable. Every screencast on
this submission that requires the app to _send_ is therefore impossible until
the cutover swaps the default app, and a recording of a reply Graph refuses is a
rejected submission. `docs/PROJECT-STATE.md` §5.1 has the arrangement; it is
deliberate and temporary, not a fault to chase.

That reorders the whole list below: the seven unlock calls and the permission
edits can be done now, and the recording cannot.

The rest of this section moved. The blockers are live-infrastructure state, they changed
twice while this file was being written, and keeping a second copy of them here
is how a stale one gets believed. `docs/PROJECT-STATE.md` §5.2 is the record:
the profile refusals and the role-holder exemption that produces the footage,
the Instagram move back to the Page, and the fact that **no comment webhook has
ever arrived** on either object — which is what a comment screencast needs
first.

## The `pages_show_list` submission, written out

Step 3 above says to add it; this is what to put in the form. It is the first
of the five to be written out because it is the one that unblocks
`pages_messaging`, which is the channel that already carries live customer
traffic.

**The dependency is Meta's, not our reading of it.** The permission reference
for `pages_messaging` lists, verbatim:

> **Dependencies** `pages_manage_metadata` `pages_show_list`

Checked 2026-09-07. `pages_show_list` itself lists `Dependencies: None`, so it
is the root of the chain — which is also why it is a dependency of
`pages_read_engagement`, `instagram_basic` and around twenty-five others. A
submission that asks for `pages_messaging` without it is asking for something
Meta will not grant.

So the use-case description below leads with that, rather than inventing a
feature. **The app makes no call that `pages_show_list` gates.** It never calls
`GET /me/accounts` and never enumerates the Pages a person manages — verified by
grep, and true by design: there is nothing to discover, because the one Page
this app serves is named by `FACEBOOK_PAGE_ID` in the deployment environment and
answered with `META_PAGE_ACCESS_TOKEN` beside it. Claiming otherwise in the
description would be a claim a reviewer can check and we would lose.

### Paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt. It is used solely by ShipBlu's
own support agents to answer ShipBlu's own customers. It is not a product we
offer to anyone else, and no other business can connect to it.

We are requesting pages_show_list as a dependency, not as a capability we
exercise directly. Meta's permission reference lists pages_show_list, together
with pages_manage_metadata, as a required dependency of pages_messaging.
pages_messaging is the permission this app genuinely needs and already uses:
customers message the ShipBlu Facebook Page about their deliveries, those
messages reach our webhook, and our support agents reply to them from our
console within Meta's messaging window. Since pages_messaging cannot be granted
without pages_show_list, we are requesting it here for that reason alone.

The app makes no call to the endpoint pages_show_list gates. It does not call
GET /me/accounts and does not list, search for, or enumerate the Pages that any
person manages, because it has no need to discover a Page. The single Page it
serves is identified by a Page ID and a Page access token that are set as
server-side configuration values in our own deployment environment and read only
by our backend. They were issued once for ShipBlu's own Page and are not
obtained from any user at runtime.

This app has no Facebook Login. Our agents sign in with an email address and a
password issued by ShipBlu. There is no OAuth flow anywhere in the application,
no "connect your Page" screen, and no code path by which a person outside
ShipBlu could grant this app access to a Page they manage. The administration
screen that configures the Facebook channel cannot accept a Page at all — it
only selects which internal support team an incoming message is routed to, and
the Page ID and token are deliberately kept out of the application database and
held in the deployment environment instead. The app is therefore single-tenant
by construction: the only Page data it can ever touch is ShipBlu's own.

Data handling: we store no list of Pages, because we never retrieve one. What we
store is only what is needed to answer a customer's message — the message
itself, and the sender's page-scoped ID, name and profile picture — in our own
database, used only to display and answer that support conversation and shown
only to ShipBlu support agents.
```

### Paste into the reviewer notes / step-by-step instructions

The first line of Meta's screencast requirement is "demonstrate the complete
Facebook login process on your app platform, showing how your app user grants
your app this permission", and there is nothing to film for it — the same beat
that blocks `pages_manage_engagement` and `instagram_manage_comments` further up
this file. Say so before the reviewer discovers it:

```
Please note that this app has no Facebook Login flow, so there is no consent
step to demonstrate. It is a single-tenant internal tool: the ShipBlu Page and
its access token were configured once, by ShipBlu, in the App Dashboard and in
our own server environment. There is no third-party user to consent, and no
screen on which a person could grant this app a permission.

pages_show_list has no user interface of its own in this app, because it is
requested as a dependency of pages_messaging rather than as a feature. What the
accompanying screencast shows is the flow it exists to support:

1. A customer sends a message to the ShipBlu Facebook Page.
2. The message is delivered to our webhook and appears as a support ticket in
   the ShipBlu Support agent console.
3. A ShipBlu support agent opens the ticket and replies to the customer.
4. The reply is delivered back to the customer in Messenger.

No step in that flow lists or selects a Page: the Page is fixed in our server
configuration.
```

### The one thing to decide before submitting

Meta's form may ask for **test credentials** so a reviewer can sign in and see
the flow. There is no good answer to hand over as-is: the production console
holds real customer conversations, and giving a reviewer an agent login is
handing a third party the archive.

The recommendation is a purpose-made demo agent on staging, with synthetic
tickets and no production data, created for the submission and disabled after —
not a production account with its permissions trimmed, because permissions are
checked per action and a trimmed account still reads real tickets. Staging is
suspended and pinned to a feature branch (`docs/PROJECT-STATE.md` §2), so
standing it up is real work and should not be discovered on submission day. If
that is more than this submission is worth, the alternative is to say in the
notes that the app is an internal tool with no public sign-up and to rest the
review on the screencast alone — which is the honest position, and one Meta does
accept for single-tenant apps, but it is a judgement call rather than something
this file can settle.

### Before you can submit: the "no API calls" unlock

**Request advanced access** stays greyed out until Meta has logged one
successful call against the permission, and the call has to fall inside the 30
days before you submit. For this permission it is one line in the Graph API
Explorer:

```
GET /me/accounts
```

**With a _user_ access token, not a Page token** — which is a correction to the
table further up this file, where all seven unlock calls are described as Page
token calls. `/me/accounts` answers "which Pages does this _person_ manage", so
under a Page token `me` is the Page itself and the call does not do what is
wanted. In the Graph API Explorer: pick the app, pick **User Token**, add
`pages_show_list` to the scope list, generate, then send the call. The person
generating it needs a role on the app and admin on the Page — Standard Access
already covers exactly that, with nothing approved.

Two different tokens are in play there and it is worth keeping them apart. The
Explorer call is made with a **user** token and exists only to put a logged call
against the permission so the dashboard button ungreys. What the app sends with
at runtime is the **Page** token in `META_PAGE_ACCESS_TOKEN`, and that one has
to carry the permission in its own right — `npm run job --
check_meta_permissions` prints its scope list, which is where to confirm the
grant landed rather than trusting the dashboard's view of it. A permission
present on the Explorer's user token and absent from the Page token is §6.28
happening again.

### What must not be said in this submission

Each of these would be checkable and false:

- That the app lists, searches or displays Pages, or lets a user pick one.
- That an agent connects a Page, or that a Page is connected through the app.
- That the app has a Facebook Login, or any OAuth flow.
- That the app is available to, or usable by, businesses other than ShipBlu.
- Anything about a screen where a person grants the permission. There is none.

One loose end this raises but does not close: `CAPABILITIES` in
`lib/meta/capabilities.ts` records the Messenger row's permissions as
`['pages_messaging']` alone, so `check_meta_permissions` would report Messenger
as fine on a token missing `pages_show_list` — which is a grant Meta requires
and the diagnostic cannot see. Adding the two dependencies to that row would
close it, at the cost of a BLOCKED line until they are granted.

## `pages_read_user_content` and `pages_manage_engagement`, written out

These two are not the `pages_show_list` case. That one is a dependency with no
call behind it, and the description has to say so. **These two have real call
sites**, they are the Facebook half of the comment feature merged in #87, and
one of them has a production refusal to point at — so the description is an
ordinary use-case description and the difficulty moves elsewhere: to the
screencast, and to one question about hiding that is worth settling before
submitting rather than after.

Meta's reference for both, checked 2026-09-07:

| Permission                | Allowed Usage, verbatim                                                                                                                                              | Dependencies                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `pages_read_user_content` | "Get user generated content on your Page", "Get posts that your Page is tagged in", "Delete comments posted by users on your Page"                                   | `pages_show_list`                            |
| `pages_manage_engagement` | "Publish a comment on a Page post", "Update your comment on a Page post", "Delete a comment on a Page post", "Like a Page post or remove your Like from a Page post" | `pages_read_user_content`, `pages_show_list` |

The split between them is **whose words are being acted on**, which is the thing
to get right in both descriptions: deleting a _customer's_ comment is
`pages_read_user_content`; publishing, editing or deleting the _Page's own_
comment is `pages_manage_engagement`. The console does both, from the same strip
of buttons, and a description that blurs them invites the reviewer to conclude
the app is asking for more than it does.

### The one thing to settle first: which permission covers hiding

`setCommentHidden` posts `is_hidden` on the comment node, and hiding is the
control an agent reaches for first — it is reversible, and the words stay on the
record for us while ceasing to be visible to everyone else. **Meta's Allowed Usage for
`pages_manage_engagement` does not enumerate hiding.** It lists publish, update,
delete and like. `CAPABILITIES` in `lib/meta/capabilities.ts` assumes this
permission covers hide and unhide, and that assumption has never been tested
against Graph — no hide has ever been issued in production.

Two readings, and they are not equally cheap to be wrong about. Either "update
your comment on a Page post" covers a field update on the comment node whoever
wrote the comment, or hiding somebody else's comment is a different grant and this
submission is missing it. Settle it with one Graph API Explorer call on a real
customer comment before recording anything:

```
POST /{comment-id}?is_hidden=true      (then is_hidden=false to put it back)
```

If it is accepted, the reading is confirmed and the call doubles as the logged
call that ungreys the button. If it is refused with a permission error naming
something else, add that permission to the submission — finding this out from a
rejected screencast costs a review cycle.

### `pages_read_user_content` — paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers. It is not offered to any other
business and no other business can connect to it.

Customers ask us about their deliveries by commenting on posts on the ShipBlu
Facebook Page. We use pages_read_user_content for those comments, which are user
generated content on our own Page, in two ways:

1. To receive them. A comment on one of our posts is delivered to our webhook
   and becomes a support ticket in our agent console, so that a support agent
   sees the customer's question alongside the same customer's messages from
   Messenger, WhatsApp and email, and can answer it. Without this the comment is
   simply never answered.

2. To delete a customer's comment when it has to be removed. Support agents
   delete a comment in two situations: when a customer has posted personal
   information in public — a delivery address or a phone number, which happens
   regularly on delivery questions and which we remove for the customer's own
   protection — and when a comment is abusive towards our staff or other
   customers. Deletion is done by an agent, on a named ticket, and is recorded
   against that agent in our system.

We do not crawl, bulk-read, export or archive Page content. We do not read posts
the Page is tagged in. We read a customer's comment when Meta delivers it to us,
because that customer is asking us a question, and we act on that one comment.

The data we store from a comment is the comment text, its ID, and the
commenter's name and page-scoped ID, in our own database, shown only to ShipBlu
support agents and used only to answer and resolve that support conversation.
```

### `pages_manage_engagement` — paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers. It is not offered to any other
business and no other business can connect to it.

When a customer comments on a post on the ShipBlu Facebook Page asking about a
delivery, the comment becomes a support ticket in our agent console. We use
pages_manage_engagement so that a ShipBlu support agent can answer that customer
publicly, by publishing a reply comment underneath theirs, and so that an agent
can hide a comment that should not stay visible.

Publishing the reply in public is the point of the feature rather than an
implementation detail: one good public answer to "where is my parcel" saves the
next twenty customers from asking, which is why we answer on the post rather
than only in a private message.

Specifically, the app:

1. Publishes a comment in reply to a customer's comment on our own Page's post,
   written by a named ShipBlu support agent in our console.
2. Hides, and later unhides, a customer's comment on our own Page's post, when
   an agent judges that it should not remain publicly visible.
3. Deletes a comment our own Page published — for example, a reply an agent sent
   in error.

The app does not like or unlike posts, does not publish standalone posts to the
Page, and does not comment anywhere except in reply to a customer who has
commented on our own Page first. Every one of these actions is taken by a signed
in ShipBlu support agent holding an internal permission for it, is attributed to
that agent in our system, and is visible on the ticket to their supervisor.
```

### Reviewer notes and the screencast

The Facebook-login beat blocks both of these exactly as it blocks
`pages_show_list` — Meta's screencast requirement for `pages_manage_engagement`
opens with "demonstrate the complete Facebook login process on your app
platform, showing how your app user grants your app this permission", and this
app has none. Reuse the `pages_show_list` reviewer note verbatim and add the
flow below.

**What is different, and it is good news: the comment screencast is not blocked
by thread control.** Every _messaging_ screencast on this submission is blocked
until the Freshworks cutover, because another app holds thread control and every
send is refused. Comments do not go through the handover protocol at all —
`deliver()` in `worker/handlers/send-meta.ts` returns on the `comment_reply`
branch before it ever consults `thread.canSend`, because a comment is answered
on the comment edge. So a Facebook comment ticket can be worked end to end as
soon as the permissions are on the token, with the cutover still pending.

Meta asks specifically to "show how your app user publishes a comment on their
Facebook Page on your app platform" and to "display the newly published comment
on the app user's page". Both halves are filmable:

```
1. A person comments on a post on the ShipBlu Facebook Page.
2. The comment appears as a new ticket in the ShipBlu Support agent console.
3. The agent types a reply and sends it. (pages_manage_engagement — publish)
4. Cut to the Facebook post: the reply is now visible under the customer's
   comment.
5. Back in the console, the agent presses Hide on the customer's comment; the
   ticket shows "hidden from the public". (pages_manage_engagement — hide)
6. Cut to the post: the comment is no longer publicly visible. Unhide, and it
   returns.
7. The agent presses Delete on the customer's comment and confirms.
   (pages_read_user_content — delete a comment posted by a user)
8. Cut to the post: the comment is gone.
```

Steps 5–8 are the strip of buttons rendered by
`app/(console)/inbox/[number]/comment-moderation.tsx`, under an inbound comment,
for an agent holding `ticket.moderate_comment`. Film with an agent who holds it,
or the buttons are not on screen. Step 7 is the only step that demonstrates
`pages_read_user_content` as a write, so do not cut it for length — and use a
comment posted by a role-holder rather than a real customer's, since it is
destroyed on camera.

### Before you can submit: the unlock calls

Same gate as before — **Request advanced access** stays greyed until Meta logs a
successful call, inside the 30 days before submitting.

| Permission                | The call that logs it                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| `pages_read_user_content` | `GET /{page-id}/posts` → `GET /{post-id}/comments`, in the Graph API Explorer |
| `pages_manage_engagement` | `npm run job -- test_comment_permission`                                      |

`test_comment_permission` exists for exactly this (§6.42): it comments on the
Page's newest published post and deletes the comment in the same run, so one
clean run exercises publish and delete in both directions against the real Page.
Read its outcome rather than just its exit — succeeding means the scope is on
the token and only the Advanced Access grant is missing; being refused with the
same `code 200` an agent gets means the scope is **not on the token at all**,
which no test call fixes and which needs the Page token re-minted with
`pages_manage_engagement` in its OAuth scope list.

Note what that job does **not** cover. It deletes a comment the app itself
published, which is `pages_manage_engagement`'s "delete a comment on a Page
post". Deleting a _customer's_ comment is `pages_read_user_content`, and nothing
in the codebase exercises that half deliberately — hence the Explorer read in
the table above, which is harmless and logs the permission without destroying
anybody's words.

The Explorer call for `pages_read_user_content` is a dashboard mechanic, not a
claim about the app: **the app never calls `GET /{page-id}/posts`**, and the
description above deliberately does not say it does. Comments reach this system
through the Page `feed` webhook subscription, and there is no `/posts` or
`/feed` read anywhere in the repo.

### The evidence that `pages_manage_engagement` is genuinely needed

Worth having to hand if a reviewer pushes back, and worth remembering is a real
observation rather than a prediction. On 2026-09-01 an agent tried to answer a
Facebook comment on ticket #13755. Graph answered:

```
POST /{page-post-id}_{comment-id}/comments
HTTP 403 — code 200, "(#200) Permissions error"
```

Across all time, `meta->>'sendKind' = 'comment_reply'` has exactly one row in
`messages` and it is that failure. **No comment reply has ever succeeded here**,
and the cause is this permission at Advanced Access. §6.42 has the full entry.

### What must not be said in either submission

- That the app reads, lists or archives Page posts. It does not; comments arrive
  by webhook.
- That the app reads posts the Page is tagged in. It does not.
- That the app likes posts, or publishes posts of its own.
- That the app moderates comments on any Page but ShipBlu's own.
- That deletion is automated. Every hide, unhide and delete is a button an agent
  presses, and delete asks a second time before it fires.
- Anything about a Facebook Login or a consent screen. There is none.

## `pages_read_engagement`, written out

A hybrid of the two cases above. It is mostly a dependency, like
`pages_show_list` — Meta's reference lists it under `instagram_manage_comments`,
which is the permission this submission actually needs it for — but unlike
`pages_show_list` it does have one real call site, so the description can name a
call rather than resting on the dependency alone.

Meta's reference, checked 2026-09-07:

> **Allowed Usage** "Get content posted by your Page." "Get names, PSIDs, and
> profile pictures of your Page followers." "Get metadata about your Page."
>
> **Dependencies** `pages_show_list`

**The app uses the first bullet and neither of the other two**, which is the
thing to be precise about: this permission's headline grant is a list of the
Page's _followers_ with their PSIDs and pictures, and asking for it while
appearing to want that is asking for far more than the console does. The one
call is `latestPagePostId()` in `lib/meta/client.ts`:

```
GET /me/published_posts?limit=1&fields=id
```

It reads one id — the Page's newest own post — and it exists for
`test_comment_permission`, which needs somewhere harmless to put its test
comment and must not guess at one. `published_posts` rather than `feed` on
purpose: `feed` includes posts other people made on the Page, and commenting on
a stranger's post is a different permission refused differently.

### Paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers. It is not offered to any other
business and no other business can connect to it.

We are requesting pages_read_engagement for two reasons.

First, it is a dependency. Meta's permission reference lists pages_read_engagement
as a required dependency of instagram_manage_comments, which is the permission
we need in order to answer customers who comment on our own Instagram posts, and
which is requested in this same submission.

Second, the app makes one call that this permission covers: it reads the ID of
the most recent post published by our own Page, so that an administrator can
verify our Facebook comment integration is working by posting and removing a
test comment on our own post. That is the only use, it reads one post ID, and it
is run by a ShipBlu administrator rather than by any customer-facing flow.

We do not use the other capabilities this permission grants. The app does not
read the list of our Page's followers, or their names, PSIDs or profile
pictures. It does not read Page metadata, insights, or any content beyond that
single post ID. It reads no Page other than ShipBlu's own, and it never reads
posts that other people have made on our Page.
```

### Reviewer notes and the unlock call

Same Facebook-login note as the others — reuse the `pages_show_list` block. For
the screencast, this permission has no user-facing surface at all: say so, and
point at the Instagram comment flow it is a dependency of.

The unlock call in the table earlier in this file is
`GET /{page-id}?fields=name,fan_count`. **Prefer the call the app actually
makes**, which logs the same permission and is honest about the usage:

```
GET /me/published_posts?limit=1&fields=id
```

— with a Page token, where `me` is the Page. Or simply
`npm run job -- test_comment_permission`, which begins by making exactly that
call before it comments.

## `instagram_manage_comments`, written out

### Read this first: it may be the wrong half of a pair

`instagram_manage_comments` is the **Facebook Page connection's** Instagram
comment permission. Its opposite number on the direct connection is
`instagram_business_manage_comments`, and this account is connected **both
ways at once** — that is settled, and `docs/PROJECT-STATE.md` §6 states the
conclusion flatly: "Both sets are needed now, and `check_meta_permissions`
reports them separately."

What decides which one a screencast would actually demonstrate is
`metaConnection()` in `lib/meta/connection.ts`, and it decides from
configuration: **for Instagram the direct connection wins whenever
`INSTAGRAM_ACCESS_TOKEN` is set.** It is set. The Human Agent refusal read out
of production on 2026-09-06 came back `via graph.instagram.com` (§5.2), and
`endpoint()` only addresses that host when the variable holds a credential.

So, today: every Instagram comment reply, hide, unhide and delete this console
issues goes to `graph.instagram.com` with the Instagram token, where the
permission that governs it is `instagram_business_manage_comments`. A screencast
of an agent hiding an Instagram comment demonstrates **that** permission, not
this one — which is precisely the "submitting while both are live risks
demonstrating the wrong half" warning in
`plans/instagram-comment-management.md`, arriving.

Three ways forward, and this file cannot pick for you:

1. **Submit `instagram_business_manage_comments` instead**, and film it as the
   console behaves today. Nothing has to change to record it.
2. **Submit `instagram_manage_comments` and film it over the Page**, which means
   unsetting `INSTAGRAM_ACCESS_TOKEN` for the recording so `metaConnection()`
   falls back to the Page. No deploy — it is one environment variable — but it
   also moves which app secret verifies inbound Instagram deliveries, so read
   §6.28's ordering rule before touching it, and put it back afterwards.
3. **Submit both**, which the older section of this file argues against on the
   grounds that App Review wants a screencast per permission and only one
   connection can be exercised at a time. That objection was written when one
   connection was believed to be live. With both live and both needed, it is
   worth re-reading rather than obeying — but each still needs its own footage,
   and (2)'s variable flip is how you get the second reel.

**The submission text below is written to serve either name**, because the
description is about what the console does rather than about a host. If you go
with the direct connection, swap the names and nothing else:

| The Page connection         | The direct connection                |
| --------------------------- | ------------------------------------ |
| `instagram_basic`           | `instagram_business_basic`           |
| `instagram_manage_comments` | `instagram_business_manage_comments` |

Meta's reference for this one, checked 2026-09-07:

> **Allowed Usage** "Read, update and delete comments of Instagram Business
> accounts."
>
> **Dependencies** `instagram_basic`, `pages_read_engagement`, `pages_show_list`

Note the same gap as on the Facebook side: "update" is doing the work for
hiding, which is not named. The Explorer check recommended above for
`POST /{comment-id}?is_hidden=true` has an Instagram twin — `?hide=true`, which
is what Instagram calls the same field — and settling both at once costs one
extra call.

### Paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers. It is not offered to any other
business and no other business can connect to it.

Customers ask us about their deliveries by commenting on posts on ShipBlu's own
Instagram professional account. We use this permission to receive those comments
and to answer them.

When a customer comments on one of our posts, the comment is delivered to our
webhook and becomes a support ticket in our agent console, so that a ShipBlu
support agent sees it alongside that same customer's messages from Instagram
Direct, Messenger, WhatsApp and email. The agent then does one of the following,
each of which is a deliberate action by a named agent on that ticket:

1. Replies publicly, underneath the customer's comment, so that the answer is
   visible to everyone reading the post. One good public answer to "where is my
   parcel" saves the next twenty customers from asking, which is why we answer
   on the post rather than only in private.

2. Replies privately, taking the conversation into Instagram Direct, when the
   answer involves the customer's own delivery details — an address, a phone
   number, a payment amount — which must not be posted in public.

3. Hides a comment, when it should not remain publicly visible. This is
   reversible and is what an agent reaches for first, because the words stay on
   the record for us while ceasing to be visible to everyone else.

4. Deletes a comment, when a customer has posted personal information such as a
   home address or phone number in public, or when a comment is abusive towards
   our staff or other customers.

We do not publish posts, stories or media to the account. We do not comment
anywhere except in reply to a customer who has commented on our own post first.
We read no Instagram account but ShipBlu's own. The data we keep from a comment
is its text, its ID, and the commenter's username and ID, in our own database,
shown only to ShipBlu support agents and used only to answer that support
conversation.
```

### The screencast, and the two things that make it harder than the Facebook one

**Meta's stated screencast requirement for this permission is about publishing a
photo post** — "demonstrate creating a new photo post and publish the post to
the business user's Instagram feed" — which this app does not do and never will.
That is a documentation inconsistency on a permission whose Allowed Usage is
about comments, and it is worth naming in the reviewer notes rather than either
obeying it or ignoring it. Film what the permission is for: receiving a comment
and answering, hiding and deleting it.

**And unlike the Facebook comment reel, this one has a real prerequisite.**
`CAPABILITIES` records it, from Meta's own webhooks reference: Advanced Access is
required to receive `comments` notifications at all, and Standard Access does not
cover it even for an app admin on their own public post. That is the circularity
the earlier section of this file describes — the approval wants footage the
approval gates.

**What has changed since that was written, and it is the important correction:
real Instagram `comments` deliveries do now arrive.** The first ones ever landed
at 15:22 UTC on 2026-08-30, and the reason none had arrived before was a
subscription and a signing secret rather than the permission (§6.28 and the
entry above it). So a comment ticket can exist today, which means the footage is
reachable — the question is only which connection's token answers it, per the
three options at the top of this section.

The shot list is the Facebook one with Instagram's own steps, plus the private
reply, which has no Facebook equivalent worth filming:

```
1. A person comments on a post on the ShipBlu Instagram account.
2. The comment appears as a new ticket in the ShipBlu Support agent console.
3. The agent replies publicly; cut to the post, showing the reply under the
   customer's comment.
4. The agent uses "Reply privately"; cut to Instagram Direct, showing the
   message arriving in the customer's inbox.
5. The agent presses Hide; cut to the post, showing the comment gone from
   public view. Unhide, and it returns.
6. The agent presses Delete and confirms; cut to the post.
```

Two mechanics that will otherwise cost a take. An Instagram public reply is
posted to the **root** of the comment thread, not to the newest reply in it —
`commentReplyTarget()` handles that, but it means step 3 filmed on a thread the
customer has already replied inside will look like it landed in the wrong place
unless you say so. And **a private reply is allowed exactly once per comment,
ever, within seven days** — so step 4 cannot be re-shot against the same
comment. Rehearse it on a different comment than the one you film.

### The unlock call

| Permission                  | The call that logs it                                            |
| --------------------------- | ---------------------------------------------------------------- |
| `instagram_manage_comments` | `GET /{ig-media-id}/comments`, then reply to or hide one of them |

Get the media id from `GET /{page-id}?fields=instagram_business_account` →
`GET /{ig-id}/media`, which is the `instagram_basic` unlock in the same table and
is worth running in the same sitting. Over the direct connection the equivalent
is addressed to `graph.instagram.com` with the Instagram token — the host is the
whole difference, and an example proves nothing until you check which host its
URL names (§6.35).

### What must not be said in this submission

- That the app publishes posts, stories, reels or media to Instagram. It does
  not, whatever the screencast requirement asks to see.
- That the app reads or moderates comments on any account but ShipBlu's own.
- That hiding or deleting is automated. Every one is an agent pressing a button,
  and delete asks a second time.
- That the app sends unsolicited private replies. A private reply answers a
  comment the customer wrote, once, within Meta's seven-day limit.
- Anything about a Facebook Login or a consent screen. There is none.

## The items already on the list, written out

The five sections above cover the permissions the list is missing. This one
covers the items it already has: the two features, `pages_messaging`,
`pages_manage_metadata`, `instagram_manage_messages`,
`whatsapp_business_messaging`, and the two profile fields. The text started in
#88, which was closed in favour of this file, and every claim in it has been
re-checked against `main`. Where #88's version said something `main` no longer
supports, the correction is stated rather than silently made, so the next
reviser does not put it back:

- **Not every Meta send is a person typing.** The out-of-hours acknowledgement,
  an automation's canned reply and the CSAT survey all send on Messenger and
  Instagram. They are held to 24 hours by `automatedReplyBlocked`
  (`lib/tickets/outbound.ts`), and only a message with an `author_agent_id` may
  carry `HUMAN_AGENT`. #88 said the app sends nothing automated on these
  channels, and a reviewer who sees one acknowledgement would catch that.
- **There is no `POST /{comment-id}/private_replies`.** That edge was removed
  after v3.2. The private reply is `POST /{account-id}/messages` with
  `recipient.comment_id` (`lib/meta/comments.ts`).
- **The Page subscription carries no delivery or read receipts.** The fields are
  `messages`, `feed`, `messaging_postbacks`, `messaging_referrals` and
  `message_reactions` (`lib/meta/subscriptions.ts`).
- **The reported locale does not choose the language we write in.** It is
  stored on `contact_identities.profile_locale` and deliberately never copied
  into `contacts.locale`. Unattended senders read the language off what the
  customer wrote, through `lib/tickets/locale.ts`. The #88 answer described the
  reverse.
- **Gender is stored and shown to agents.** It is kept on `contacts.gender` and
  displayed on the contact page. It is not used to inflect any template, and
  nothing automated reads it. #88 said the opposite on both counts.

Each block stands alone, because a reviewer reads them one at a time and in no
particular order.

### `pages_messaging` — paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers. It is not offered to any other
business and no other business can connect to it.

The ShipBlu Facebook Page is one of our customer support channels, and
pages_messaging is what makes it work in both directions.

Inbound: when a customer sends our Page a message, it is delivered to our
webhook, which verifies Meta's signature, stores the payload and returns
immediately; a background worker then turns it into a support ticket. A
customer's messages thread onto one open ticket rather than opening a new one
each time, and any photo they send - usually of a parcel, a damaged box or an
address - is stored with the ticket so the agent can see the problem. Our own
echoed replies are ignored, so they are never filed as if the customer wrote
them.

Outbound: a ShipBlu support agent types a reply in our console and the app
delivers it to that customer. Every conversation starts with the customer
messaging us; we send no marketing, broadcasts or promotional content. Two
automatic messages exist - an acknowledgement when a customer writes while our
office is closed, and a short satisfaction survey after a ticket is resolved -
and both are sent only inside the 24-hour window that follows the customer's
own message. When a customer comments publicly with something that should not
stay public, such as an address or phone number, an agent can send them one
private reply to move the conversation into Messenger.

Without this permission messages sent to our Page reach nobody, and nothing an
agent writes can be delivered.
```

### `pages_manage_metadata` — paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers.

We use pages_manage_metadata for one thing: subscribing our app to the webhooks
of ShipBlu's own Facebook Page, and keeping that subscription correct. The app
subscribes the Page to the fields our support pipeline consumes - messages,
messaging_postbacks, messaging_referrals and message_reactions for Messenger,
and feed for customers' comments on our posts.

It reads the current subscription before writing, because a subscription write
replaces the whole field list: a careless write would silently unsubscribe
customer messages while reporting success. Our job reads the live list, merges
in what is needed, and refuses to write any list that drops a field already
subscribed. It is run by a ShipBlu administrator as a maintenance task, not on
customer traffic.

Every part of the Facebook channel depends on these webhooks arriving: the
ticket, its routing to the right team, its service-level clock and the agent's
reply. The app does not use this permission to change any Page setting a person
would notice. It does not post to, rename, restyle or reconfigure the Page.
```

### `instagram_manage_messages` — paste into "How will your app use this permission?"

Read the top table's footnote first: the direct connection answers Instagram
DMs today, so a reel filmed as the console runs now demonstrates
`instagram_business_manage_messages`. The text below serves either name, the same
way the `instagram_manage_comments` text does.

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers.

ShipBlu's Instagram professional account is a support channel in exactly the way
our Facebook Page is, and many of our customers reach a delivery company there
first. We use this permission to read and answer that Direct inbox from the same
console our agents answer every other channel in.

Inbound Direct messages are delivered to our webhook and become support tickets.
Each person's messages thread onto one open ticket, and any photo or story reply
they send is stored with it, so an agent reading "look at this" has something
to look at. Our own echoed messages are discarded rather than filed as the
customer's.

Outbound, a ShipBlu support agent's reply is delivered to the person who wrote
to us. The only automatic messages are an out-of-hours acknowledgement and a
post-resolution satisfaction survey, both sent only inside the 24-hour window
after the customer's own message. We send no bulk or promotional Direct
messages.

Without this permission the Instagram inbox goes back to being answered by hand
on a phone, outside our ticketing system, its reporting and its service levels.
```

### `whatsapp_business_messaging` — paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers.

WhatsApp is where most of our customers expect to reach a business, and this
permission is what the channel rests on.

Inbound: our WhatsApp Business Account is subscribed to the messages field.
Every customer message, and every delivery status for a message we sent,
arrives at our webhook, is signature-verified, stored, and turned into a ticket
by a background worker. Photos and documents are retrieved through the media
endpoints and stored with the ticket, because customers photograph parcels,
waybills and damage constantly. A shared location is kept as coordinates, since
"the courier can't find me" is answered by a location.

Outbound: inside the 24-hour customer service window an agent's reply is sent
as free-form text. Outside it the app offers only the message templates
approved for our WhatsApp Business Account, and the console shows the agent
which of the two states the conversation is in before they write. We also read
our own approved template list so that the console can offer it.

Delivery statuses tell an agent whether their answer actually arrived. Without
this permission nothing can be received from or sent to a WhatsApp customer.
```

### Human Agent — paste into the feature's use-case field

The request stands, and it is the one item on the list with a production refusal
already on record: `code 10, HTTP 403` naming the feature, 2026-09-06, via
`graph.instagram.com` (§5.2). That refusal came over the direct connection, so
confirm in the dashboard that the feature request covers the Instagram Login
side as well as the Page. `FEATURES` in `lib/meta/capabilities.ts` lists both.

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers.

In parcel support, a real person answering more than 24 hours after the
customer wrote is the normal case, not an edge case. A customer messages us at
9pm asking where their delivery is. Answering honestly often means waiting on
something outside the support team - the courier's next scan, the hub's
account of what happened, a merchant confirming a new address - and that answer
frequently arrives the next day. The agent then writes to the customer, by
hand, in reply to the question the customer asked.

The app is built around the rule the feature describes. It tracks each
Messenger and Instagram conversation's window from the customer's last message
and shows the agent how long they have left. Inside 24 hours a reply is sent as
a normal response. Between 24 hours and 7 days it is sent with the HUMAN_AGENT
tag. After 7 days the app refuses to send and tells the agent why.

The tag is attached only to a message a signed-in support agent wrote: the app
decides it from the author recorded on the message, not from anything a job or
automation supplies. Our automatic messages - the out-of-hours acknowledgement,
automation replies and the satisfaction survey - are stopped at 24 hours on
these channels and can never carry the tag.

Without this feature, most researched follow-ups, the ones that took a day to
establish, cannot be delivered.
```

### Human Agent — the screencast

What the reviewer has to see is a person answering between 24 hours and 7 days
after the customer wrote. Three facts decide how that can be filmed, and none
of them are obvious from the dashboard:

- **Film it on Instagram, not Messenger.** Freshworks still holds thread control
  on the Page (`docs/PROJECT-STATE.md` §5.1), so every Messenger send is refused
  before the tag is even read. The direct Instagram connection is outside the
  Page's handover protocol and can send today. That is also the connection the
  09-06 refusal came back on, so it is the connection the feature request has
  to cover. Check in the dashboard that the request is filed against the
  Instagram product as well as Messenger; `FEATURES` lists one entry per
  connection because Meta treats them separately.
- **The role-holder exemption does not apply.** It covers permissions at
  Standard Access; a feature is gated before the call is counted
  (`lib/meta/capabilities.ts`, the note above `FEATURES`). So unlike the comment
  permissions there is no test call that makes a tagged send succeed before
  approval. The reel cannot end on a delivered tagged reply, and it must not
  end on a refused one either.
- **The conversation has to be over a day old before you start recording**, and
  it has to be from a real Instagram account messaging ShipBlu's. Have a
  role-holder send the message at least 25 hours before the recording, and make
  sure they send nothing else in between. A reply from us leaves the window
  where it is; another message from them restarts it, and the conversation is
  back inside 24 hours.

So the reel shows the product behaviour the feature exists for, and the
reviewer note says plainly where it has to stop:

```
1. A customer's Instagram message, received more than 24 hours ago, open in
   the ShipBlu Support console. Above the composer: "Outside the 24-hour
   window — replies go out tagged as a human agent (… left)".
2. A ShipBlu support agent, signed in under their own name, types the reply by
   hand.
3. For contrast: a conversation more than 7 days old, where the console says
   "The 7-day window has closed. Only the customer can reopen this
   conversation." and does not send.
```

And in the reviewer notes:

```
Human Agent is the feature this submission requests, so a tagged reply cannot
be delivered until it is approved: before approval the Instagram API refuses
it with "To use 'Human Agent', your use of this endpoint must be reviewed and
approved by Facebook." The screencast therefore shows everything up to the
send: the window state, a named agent writing the reply by hand, and the two
places the app refuses to send (after 7 days, and for any automated message
after 24 hours). The tag is chosen from the author recorded on the message, so
no automation, template or bulk path can attach it.
```

The two quoted lines are `describeWindow` in `lib/meta/window.ts`, word for
word. If either changes, update the shot list with it. The automated-sender cut-off at
24 hours has nothing to film, which is why it is in the note rather than the
reel.

### Business Asset User Profile Access — the two answers

For "How will this app use Business Asset User Profile Access?":

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers.

This feature puts a customer's name on their support ticket. When a person
messages ShipBlu's Facebook Page or Instagram account, the webhook gives us a
page-scoped ID and nothing else. The app then reads that one person's profile:
their name, their Instagram username where they have one, and their profile
picture. On Messenger it also reads their locale and gender, where the
separate permissions for those are granted. It does this when the person first
writes in, and an agent can ask for a refresh from the ticket. We do not
request ids_for_business, and we read nothing about anyone who has not
messaged us.

Three things depend on it. An agent sees a person's name rather than a string
of digits. An agent can greet the customer by name, which in Arabic support is
what separates a person from an automated reply. And the name helps an agent
recognise the same person across channels, when a social identity carries no
email or phone number to match on.

The lookup is best-effort: the ticket is created and answered whether or not
the profile can be read.
```

For "Review the policies … and tell us how you intend to use it":

```
We have reviewed the Business Asset User Profile Access reference, the Meta
Platform Terms and the Developer Policies. Our use is inside the documented
allowed usage - reading user fields for people engaging with our own business
assets - and deliberately narrower than it permits.

Whose data: only people who have messaged ShipBlu's own Facebook Page or
Instagram professional account, read when that message becomes a support
ticket. ShipBlu Support is our in-house helpdesk and serves no other business.

What for: one purpose, identifying the customer to the ShipBlu support agent
handling their ticket. The picture is the avatar beside their name in the
inbox; the locale and gender, where granted, are shown on their contact record.

What we will not do: we do not use this data for advertising, targeting,
audience building or measurement. We do not sell, licence or disclose it to any
third party, and no third party processes it except our hosting providers. We
do not combine it with data from outside sources.

Storage and access: stored in our own Postgres database in the EU
(Frankfurt, eu-central-1); the picture is copied into our own private storage
in the same region and served to agents only through short-lived signed links.
Both are reachable only by signed-in ShipBlu support agents; there is no public
page or external API that exposes them. Raw webhook payloads are deleted
automatically 30 days after processing. We delete a person's stored profile data
on request.
```

### `pages_user_locale` — paste into "How will your app use this permission?"

The honest use is smaller than the one #88 described, and the text says only
what the console does.

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers.

Our customers write to us in Arabic and in English, and very often in Arabic
typed in Latin letters, which says little about which language they would
rather be answered in. When a person messages our Facebook Page, the app reads
the locale on their profile once, alongside their name, and shows it on their
contact record in our console, beside the Messenger identity that reported it.
A support agent uses it as one more signal when choosing which language to
answer in.

We deliberately do not let it switch the language of any automatic message:
those follow the language the customer actually wrote in, because a Facebook
interface setting is not the same as the language someone wants support in.
It is not used for targeting, segmentation, advertising or analytics.
```

### `pages_user_gender` — paste into "How will your app use this permission?"

```
ShipBlu Support is an internal customer-support helpdesk built and operated by
ShipBlu, a last-mile delivery company in Egypt, and used solely by ShipBlu's own
support agents to answer ShipBlu's own customers.

Most of our customers are answered in Arabic, and Arabic grammar is gendered in
a way English is not: "did you receive it?" is worded differently to a man and
to a woman, and there is no neutral form in everyday use. When a person
messages our Facebook Page, the app reads the gender on their profile once,
alongside their name, stores it on their contact record, and shows it to the
support agent answering them, so that the agent can address the customer
correctly.

It is shown only to ShipBlu support agents. It is not used for targeting,
segmentation, advertising, analytics, reporting or routing, and no automatic
message reads it.
```

## The order to work in

1. Make the seven calls in the table above, with a Page token held by an app
   role-holder. Six are Graph API Explorer one-liners; the seventh is
   `npm run job -- subscribe_meta_webhooks object=page`, which is worth running
   rather than hand-writing because it merges the field list instead of
   replacing it. Nothing needs approving first; Standard Access already covers
   all of it.
2. Wait for the calls to log — up to two days — and check that **Request
   advanced access** has ungreyed on each permission.
3. Add `pages_show_list`, `pages_read_user_content`, `pages_manage_engagement`,
   `pages_read_engagement` and `instagram_manage_comments` to the submission.
   All five are written out above, form field by form field — read the Instagram
   one's first subsection before submitting it, because which of the two
   Instagram comment permissions this should be is a live question, and the same
   decision settles the messaging pair in the top table. The items already on
   the list have their answers in
   [the section after it](#the-items-already-on-the-list-written-out).
4. Drop **Page Public Content Access** and **`whatsapp_business_manage_events`**;
   neither has a call site to film.
5. Settle the Facebook-login beat in the reviewer notes before recording.
6. With `feed` and `comments` finally subscribed (step 1's last row does the
   Page half), have a role-holder comment on one of the account's own posts and
   work the resulting ticket in the console — reply, hide, unhide, delete. That
   is the footage, and it is also the first time this feature will have run.

Steps 1–5 are dashboard work. Step 6 is the first end-to-end exercise of code
that has been merged since #87 and has never executed in production.
