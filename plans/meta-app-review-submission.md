# The Meta App Review submission — what to ask for, and what has to work first

An audit of the permission list staged in App Review against what this codebase
actually calls. Two questions: which requests have no code behind them, and
which of the ones worth keeping cannot be screencast today.

_Updated 2026-08-27, against the list as it now stands and after the Instagram
account was moved back onto its Facebook Page (`docs/PROJECT-STATE.md` §6.28).
The first version of this file recommended the `instagram_business_*` family;
that move reverses it, and the list below is the one that matches the live
connection._

## The list as it stands

Eleven new requests, two renewals:

| Requested                          | Called by                                                  | Verdict    |
| ---------------------------------- | ---------------------------------------------------------- | ---------- |
| Human Agent                        | `lib/meta/window.ts`, `sendDirectMessage`                  | **Keep**   |
| Business Asset User Profile Access | `fetchProfile`, `lib/meta/profile-refresh.ts`              | **Keep**   |
| `pages_messaging`                  | `sendDirectMessage`, the `page` webhook                    | **Keep**   |
| `whatsapp_business_messaging`      | `lib/whatsapp/client.ts` — five endpoints                  | **Keep**   |
| `instagram_basic`                  | nothing today — see the drafted copy below                 | **Keep**   |
| `instagram_manage_messages`        | `sendDirectMessage` for Instagram DMs — but see below²     | **Keep**   |
| `pages_user_locale`                | `fetchProfile` extended → `contact_identities`             | **Keep**   |
| `pages_user_gender`                | `fetchProfile` extended → `contacts.gender`                | **Keep**   |
| `pages_manage_metadata`            | receiving Page webhooks                                    | **Keep**¹  |
| Page Public Content Access         | nothing                                                    | **Remove** |
| `whatsapp_business_manage_events`  | nothing                                                    | **Remove** |
| `public_profile` (renewal)         | nothing — mandatory for every app, cannot be removed       | Keep       |
| `email` (renewal)                  | nothing — agent auth is a password, `lib/auth/password.ts` | **Remove** |

² The routing correction under the drafted copy below applies to this row as
well: while `INSTAGRAM_ACCESS_TOKEN` is set, that send goes out over the direct
Instagram connection, where the permission is `instagram_business_manage_messages`.

¹ The app performs this one now: `subscribe_meta_webhooks object=page` writes
`POST /{page-id}/subscribed_apps` as well as the app-level subscription, so
there is a real call to point at rather than a dashboard action.

The Instagram pair is now right. `instagram_basic` and `instagram_manage_messages`
are the **Page-connected** family, and the account is back on that setup, so
they match the live connection and `instagram_business_manage_messages` — which
an earlier version of this file argued for — correctly came off the list.
`user_messenger_contact` coming off is also right: every send in this system
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
endpoints — send text, send template, mark read, media lookup, media download —
and none of them is an event log.

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

`instagram_manage_comments` is the right name now that the account is back on
its Facebook Page; `instagram_business_manage_comments` is the Instagram Login
family's and would be the wrong one to ask for.

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

## The `instagram_basic` copy, drafted

Written down here rather than typed straight into the dashboard. The submission
is the one artefact of this work that cannot be reviewed afterwards — the App
Dashboard keeps no history of what was sent — and a rejection arrives quoting a
sentence back at you.

**First, a correction to the row at the top of this file.** It said
`instagram_basic` was exercised by "the Instagram profile read, on the Page
token". That was true when it was written on 27 August and is not true now.
`INSTAGRAM_ACCESS_TOKEN` is set, so `metaConnection()` sends **every** Instagram
call — the profile read included — over the direct Instagram connection to
`graph.instagram.com`, whose permission family is `instagram_business_*`. Read
out of the worker log rather than reasoned about:

```
2026-09-06 20:02:49  [send_meta] … sent as dm on instagram via instagram_login
2026-09-06 10:31:32  [meta] instagram via instagram_login POST
                     graph.instagram.com/…/messages failed with 403
2026-09-02 11:54:56  [send_meta] … sent as comment_reply on instagram via instagram_login
```

So **no Graph call this app makes today consumes `instagram_basic`.** That is
not an argument for dropping it — §6.36 is explicit that both connections are
live on purpose and that both permission families are needed — but it decides
what the description may honestly say, and it makes the account-resolution call
in the unlock table the only thing that will put a number against this
permission before the submission goes in.

### Use-case description

> ShipBlu Support is the in-house helpdesk of ShipBlu, a parcel delivery company
> in Egypt. It is single-tenant: it serves one business — ours — and the only
> Facebook Page and Instagram professional account it is connected to are
> ShipBlu's own. Its users are our support agents, who sign in with a company
> account. It has no third-party users and is not distributed.
>
> We use `instagram_basic` to identify the Instagram professional account linked
> to our Facebook Page. Our Page is subscribed to Instagram messaging and
> comment webhooks, and a delivery names the account only by id. The app
> resolves that id against the Page (`GET /{page-id}?fields=instagram_business_account`)
> and reads the account's basic profile, so that an incoming customer message is
> matched to our own account before it is shown to an agent or answered. Nothing
> is trusted on the strength of an identifier arriving in a webhook body.
>
> `instagram_basic` is also the dependency Meta names for
> `instagram_manage_messages` and `instagram_manage_comments`, both requested
> alongside it, which are what let an agent answer the customer's message or
> comment.
>
> What is read under this permission is our own account's profile. It is used
> inside the agent console for routing and display, is not shown to anyone
> outside our company, and is not sold or shared with any third party.

**One sentence in that is not true yet**, and it is the one a reviewer can
check: the app makes no `instagram_business_account` call. Either make it —
Graph API Explorer, per the unlock table, which is also what ungreys **Request
advanced access** — or write it into the ingest path so the claim describes
running code. Submitting the paragraph before one of those is describing
something Meta cannot see, which is the failure mode this whole file exists to
avoid.

### Reviewer note

> **This app has no Facebook Login flow, because it has no third-party users.**
>
> The screencast instructions for this permission open by asking us to
> demonstrate the login process by which an app user grants it. ShipBlu Support
> is a single-tenant internal helpdesk. The only Page and Instagram account it
> will ever be connected to are our own, and that connection was made once, by
> an administrator, in the App Dashboard. Our support agents sign in with a
> company password in order to read tickets; they are never asked to grant a
> Facebook permission, and there is no consent screen to record because no user
> of this app is ever asked to consent to anything. The recording therefore
> begins where the granted permission is used.
>
> The recording shows a customer sending our Instagram account a message, the
> message arriving as a ticket in our agent console, an agent answering it from
> the console, and the answer arriving back in Instagram. The account
> identification this permission covers happens server-side, between the second
> and third of those, and has no screen of its own.

**The Facebook-login beat is the same sentence on several permissions already
submitted**, so settle the wording once and reuse it rather than writing four
variants a reviewer can compare.

**Whether to volunteer the two-connection arrangement is a judgement call, and
it should be made deliberately rather than discovered in the edit.** Saying that
this account is connected both through our Page and through Instagram Login is
true and pre-empts a reviewer's confusion at seeing two identities; it also
points at the fact that the Instagram traffic they are about to watch is served
by the _other_ family. Not saying it risks nothing today, because a reviewer
sees granted usage rather than a routing table. The recommendation is to leave
it out of the note and let the permission list say it: `instagram_basic` and
`instagram_manage_*` describe the Page connection, and if the
`instagram_business_*` family is ever submitted it is a separate use case with
its own description.

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
4. Drop **Page Public Content Access** and **`whatsapp_business_manage_events`**;
   neither has a call site to film.
5. Settle the Facebook-login beat in the reviewer notes before recording. The
   drafted `instagram_basic` copy above carries a wording for it that is meant
   to be reused on every permission whose instructions open with it.
6. With `feed` and `comments` finally subscribed (step 1's last row does the
   Page half), have a role-holder comment on one of the account's own posts and
   work the resulting ticket in the console — reply, hide, unhide, delete. That
   is the footage, and it is also the first time this feature will have run.

Steps 1–5 are dashboard work. Step 6 is the first end-to-end exercise of code
that has been merged since #87 and has never executed in production.
