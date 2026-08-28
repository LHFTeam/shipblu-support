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
| `instagram_basic`                  | the Instagram profile read, on the Page token              | **Keep**   |
| `instagram_manage_messages`        | `sendDirectMessage` for Instagram DMs                      | **Keep**   |
| `pages_user_locale`                | `fetchProfile` extended → `contact_identities`             | **Keep**   |
| `pages_user_gender`                | `fetchProfile` extended → `contacts.gender`                | **Keep**   |
| `pages_manage_metadata`            | receiving Page webhooks                                    | **Keep**¹  |
| Page Public Content Access         | nothing                                                    | **Remove** |
| `whatsapp_business_manage_events`  | nothing                                                    | **Remove** |
| `public_profile` (renewal)         | nothing — mandatory for every app, cannot be removed       | Keep       |
| `email` (renewal)                  | nothing — agent auth is a password, `lib/auth/password.ts` | **Remove** |

¹ Keep the permission; the screencast is the problem — nothing in the app
performs a page-level subscribe, so the demo is the dashboard flow.

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

## Three permissions the product needs and the list does not have

This is the larger problem, and the move back to the Page changes which name to
ask for.

- **`instagram_manage_comments`.** PR #87 shipped Instagram comment management:
  public reply, private reply, hide, unhide, delete, behind
  `ticket.moderate_comment`. On the Page-connected setup this is the name — not
  `instagram_business_manage_comments`, which is the Instagram Login family's.
  It gates the **private reply** as well as hide and delete, so a comment ticket
  does not work without it even if nobody ever hides anything.
- **`pages_manage_engagement`.** The same four verbs on Facebook.
  `lib/meta/comments.ts` builds the Facebook shape for every one of them
  (`{comment-id}/comments`, `{comment-id}/private_replies`, `is_hidden`, DELETE),
  and `lib/meta/errors.ts` names `pages_manage_engagement` in the failure an
  agent reads.
- **`pages_read_engagement`.** Reading the Page's own posts and the comments on
  them — the `feed` webhook path in `REQUIRED_PAGE_FIELDS`, which
  `lib/meta/parse.ts` filters down to comments.

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

This section moved. The blockers are live-infrastructure state, they changed
twice while this file was being written, and keeping a second copy of them here
is how a stale one gets believed. `docs/PROJECT-STATE.md` §5.2 is the record:
the profile refusals and the role-holder exemption that produces the footage,
the Instagram move back to the Page, and the fact that **no comment webhook has
ever arrived** on either object — which is what a comment screencast needs
first.

## The order to work in

1. Drop **Page Public Content Access** and **`whatsapp_business_manage_events`**
   from the submission; neither has a call site to film.
2. Add **`instagram_manage_comments`**, **`pages_manage_engagement`** and
   **`pages_read_engagement`** — the comment feature is merged and none of its
   permissions is requested.
3. Subscribe `comments` on `instagram` and `feed` on `page`; no comment webhook
   has ever arrived, so there is no comment ticket to demonstrate against.
4. Get the profile footage through the role-holder exemption
   (`docs/PROJECT-STATE.md` §5.2) rather than waiting on approval.
5. Record.

Steps 1–4 are configuration and dashboard work. None of them is code, and the
code is inert without them.
