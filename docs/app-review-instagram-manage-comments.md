# The `instagram_manage_comments` App Review submission

The text to paste into Meta's form, the instructions the reviewer follows, and
the evidence behind every claim either of them makes.

`plans/meta-app-review-submission.md` is the reasoning — which permissions to
ask for and why. This is the submission itself. Where the two disagree, this
file is newer: it was written on 2026-09-09 against production, and the plan
predates the grant.

## Before you paste any of this

**The permission is already granted, and it is already doing something.** It
arrived on 2026-09-02 at 10:43 UTC, along with `pages_manage_engagement`,
`pages_manage_posts` and `pages_read_engagement`, and the effect showed up in
the webhook table 71 minutes later: the **Page-borne copy** of the Instagram
`comments` webhook started arriving and has been arriving since. Across the
whole life of the table before that grant, not one real Instagram comment had
ever reached the endpoint (`docs/PROJECT-STATE.md` §6.34 is the afternoon that
cost). So the submission is for **Advanced Access**, not for the grant — say so
in the form if there is anywhere to say it, because the two are the thing this
codebase most often confuses.

**But the app is not currently acting under this permission**, and that is the
one fact that can sink the screencast. `INSTAGRAM_ACCESS_TOKEN` is set in
production, so `metaConnection()` in `lib/meta/connection.ts` routes every
outbound Instagram call over the **direct Instagram connection** — a different
host, a different token, and `instagram_business_manage_comments` rather than
this permission. Every Instagram send in the last two weeks went that way, with
no exceptions:

```
[send_meta] b80f2b71 sent as comment_reply on instagram via instagram_login   2026-09-09 17:00:50
[send_meta] 41583577 sent as dm on instagram via instagram_login              2026-09-06 19:11:14
[send_meta] 72584c00 sent as private_reply on instagram via instagram_login   2026-09-02 11:55:46
[send_meta] c76e92d4 sent as comment_reply on instagram via instagram_login   2026-09-02 11:54:56
```

So the two halves of the permission are on different connections right now:
**receiving** is Page-borne and is this permission's; **replying, hiding and
deleting** go out over the other one. A recording made today would show the app
receiving under `instagram_manage_comments` and then acting under a permission
this submission does not name — which is precisely the "demonstrating the wrong
half" that `plans/instagram-comment-management.md` warns about.

**The fix is one environment variable, not a deploy.** `metaConnection()` keys
on `INSTAGRAM_ACCESS_TOKEN` being present, so unsetting it on
`shipblu-support` and `shipblu-support-worker` puts Instagram back on the Page
route for the recording, and setting it again restores today's behaviour. Two
things to know before doing it:

- **It moves Instagram DMs too**, not only comments — the variable is per
  connection, not per feature.
- **No Instagram send has ever succeeded over the Page connection in
  production.** Not a comment reply, not a DM. The sends that were tried under
  the old arrangement were refused while Freshworks held thread control
  (`docs/PROJECT-STATE.md` §5.1), and everything since has gone via
  `instagram_login`. Messenger sends do work now — 8 Facebook DMs and 22
  Facebook comment replies in the last ten days — so the Page token is not the
  problem, but the Instagram-over-Page path specifically is unproven. **Send one
  test comment reply immediately after unsetting it and before you start
  filming.** A recording of a reply Graph refuses is a rejected submission.

If you would rather not move the routing, the other honest submission is
`instagram_business_manage_comments` — the permission the app actually exercises
today, on the connection it actually uses. That is a different form and a
different use-case description; this file is not it.

## A. Use case description

Meta's field asks how the app uses the permission. Paste this.

```text
ShipBlu Support is the in-house helpdesk that ShipBlu, a last-mile delivery
company operating in Egypt, uses to answer its own customers. It is a
single-tenant application: the only Instagram professional account it is
connected to is @shipblu, which ShipBlu owns and administers. It does not
onboard other businesses, and it never accesses an Instagram account belonging
to anyone else.

Our customers ask delivery questions in the comments on our own Instagram
posts — where a parcel has got to, what shipping to a given governorate costs,
and complaints about a specific delivery. Those are support requests, and until
now they have been answered in the Instagram app, separately from every other
channel and with no record. This application brings them into the same queue as
our email, WhatsApp and web-chat tickets, so a comment gets an owner, a
response-time target and an auditable history.

We use instagram_manage_comments for four things, all of them on media owned by
our own account:

1. Receiving comment notifications. We subscribe to the "comments" webhook
   field. Each new comment opens a support ticket in our agent console, or
   joins the existing ticket for that comment thread, so it reaches the agent
   on duty rather than sitting unread.

2. Replying publicly. The agent writes an answer on the ticket and we post it
   as a public reply to the customer's comment. The answer stays in the thread
   where the question was asked, so the next person with the same question
   reads it there.

3. Hiding and unhiding a comment. Comments on a delivery company's posts
   routinely contain the customer's own phone number, home address or order
   reference, posted publicly in the hope of a faster answer. Hiding takes that
   out of public view while keeping it on the ticket so the agent can still act
   on it. Unhiding reverses a hide that was applied in error.

4. Deleting a comment. Reserved for content our community guidelines do not
   allow to remain: a third party's personal data, and abuse or spam repeated
   across many posts. Deletion is irreversible at Meta, so the console asks the
   agent to confirm and records who performed it.

Every one of these actions is taken by a named human support agent, from a
ticket, and is written to that ticket's timeline with the agent's identity and
a timestamp. The application does not reply to, hide or delete any comment on
its own initiative; there is no automation on this path.

We store the comment text, the commenter's Instagram-scoped ID and username,
and the media ID, on the support ticket. They are used to answer that support
request and to audit what our agents did, and for nothing else.

Without this permission we receive no comment notification at all, so a
customer who comments on our post reaches no support queue and goes unanswered,
and our agents cannot reply to or moderate their own account's comments from
the tool they work in.
```

## B. Step-by-step instructions for the reviewer

Meta asks for instructions precise enough to reproduce the usage. Paste this,
with the two placeholders filled in.

**Do not write the credentials into this file or anywhere else in the
repository.** Create an agent account for the reviewer in Settings → Agents and
type the password only into Meta's form. It needs
`ticket.moderate_comment`, or steps 5 and 6 render no buttons at all and the
recording stops after the reply: the permission sits at Supervisor and above,
but it is a plain permission, so granting it to an Agent account works just as
well as promoting one.

```text
Test account
  URL:      https://<console-host>/login
  Email:    <reviewer agent email>
  Password: <supplied in this form>

The account is a support agent with permission to reply to and moderate
comments. It is not a Facebook or Instagram login: our agents authenticate with
a password against our own system, and the Instagram account is connected once
at the organisation level rather than per agent (see the note on the login
screencast below).

1. Open the URL above and sign in with the credentials.

2. On any Instagram post published by @shipblu, leave a comment from your own
   Instagram account.

3. In the console, open Inbox. A new ticket appears within a few seconds,
   on the Instagram channel, carrying your comment, your username and a link
   back to the comment. This is the "comments" webhook arriving.

4. Open the ticket and type an answer in the reply box, then send it. Refresh
   the Instagram post: the answer is now a public reply to your comment. The
   ticket timeline shows it as sent, with the agent's name.

5. On your comment in the ticket, press Hide. The ticket marks it pending and
   then hidden. Refresh the Instagram post from an account that is not
   @shipblu: the comment is no longer publicly visible. Press Unhide and
   refresh again: it is visible once more.

6. Press Delete and confirm. Refresh the Instagram post: the comment is gone.
   The ticket keeps the text so the support record survives the deletion, and
   records which agent deleted it.

Steps 3 and 4 use the permission to receive and to reply. Steps 5 and 6 use it
to hide, unhide and delete. All of them act on comments on our own account's
media.
```

**Step 2 is the step that can fail through no fault of the app, and it is worth
understanding before a reviewer reports it as a bug.** Every real Instagram
comment this system has received came from an account holding a role on the app
— which is exactly what Standard Access covers. Whether a stranger's comment is
delivered before Advanced Access is granted is the circularity §6.34 describes:
the notification the footage needs is the thing the submission is asking for. So

- **film with a comment from a role holder** (an app admin, developer or
  tester), which is the case known to work here; and
- **add the reviewer's own Instagram account as a tester** on the app if they
  are going to comment themselves, and say in the notes that you have done so —
  otherwise their comment may produce no ticket and the demo stalls at step 3
  on the very gate being applied for.

## C. The screencast

One recording covering steps 2–6 above, in that order, showing both the console
and the public Instagram post — a side-by-side or an alternating cut, so the
reviewer can see the public effect of each action rather than only our UI
claiming it.

**Meta's first required beat cannot be filmed, and the submission has to say so
rather than skip it.** The requirement reads:

> "Demonstrate the complete Facebook login process on your app platform,
> showing how your app user grants your app this permission."

This app has no Facebook Login. Agents sign in with a password
(`lib/auth/password.ts`), there is no OAuth flow anywhere in `app/(auth)/`, and
the Page and Instagram account were connected once by us in the App Dashboard.
A single-tenant app serving only its owner's assets has no third-party user to
consent, so there is no such flow to record. Say that in the notes, in these
words or near them:

```text
This app has no Facebook Login flow to demonstrate. It is single-tenant: it
serves only ShipBlu's own Instagram account, which we own and administer, and
it was connected once through the App Dashboard rather than by any app user
granting a permission. Our support agents authenticate with a password against
our own system. In place of that step the screencast opens on the App Dashboard
(Instagram → API setup) showing the connected @shipblu account and the granted
permissions, so the origin of the grant is visible.
```

Then open the recording on that dashboard screen for a few seconds before
step 2. It is not the beat Meta asked for, and it is the nearest true thing.

## D. What the claims above rest on

Everything in section A is a statement about running software. Each row is how
to re-check it rather than take this file's word for it — re-run them before
submitting, because several were false a week before this was written.

| Claim                                               | Checked how                                                                                           | Answer on 2026-09-09                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The permission is granted                           | `permissions` webhooks in `webhook_events` — the §5.2 query                                           | `instagram_manage_comments` granted 2026-09-02 10:43:06 UTC, once                          |
| Comment notifications arrive over the Page          | `webhook_events` where `object='instagram'` and a change field is `comments`, grouped by `connection` | 4 on `facebook_page` (first 2026-09-02 11:54), 7 on `instagram_login`, 5 before the column |
| A comment opens a ticket                            | `conversations` where `external_id like '%:comment:%'`                                                | #13817 opened 2026-09-09 17:00:35 from @ali.nasser47, "Can i get shipping prices?"         |
| A public reply reaches the post                     | the reply's own echo arriving back as a `comments` webhook from `shipblu`                             | 17:00:53, "Yes, we are happy to help you any time."                                        |
| Hide, unhide and delete work from the console       | `messages.meta->'moderation'` on comment rows                                                         | deletes confirmed on #13769, #13772, #13814 — `deleted: true, error: null`                 |
| Which connection outbound Instagram calls go out on | `send_meta` lines in the worker log                                                                   | `via instagram_login`, every one, 2026-08-25 → 2026-09-09                                  |
| Whether the Page route can send Instagram at all    | the same log, searched for `on instagram via facebook_page`                                           | **no such line has ever been written**                                                     |

The console-side code behind section A, if a reviewer question needs answering
precisely: `lib/meta/comments.ts` holds the Graph request shapes,
`app/(console)/actions.ts#moderateComment` is the action behind Hide and
Delete, `worker/handlers/moderate-meta-comment.ts` makes the call, and
`lib/tickets/ingest-meta.ts#ingestMetaComment` is what turns a delivery into a
ticket.

## E. Before pressing submit

- [ ] **The dependencies are on the same submission.** Meta lists
      `instagram_basic`, `pages_read_engagement` and `pages_show_list` as
      prerequisites of this permission. The first two have been granted
      (2026-08-29 and 2026-09-02); **`pages_show_list` has never appeared in a
      `permissions` webhook** and may be absent from the token. Settle it with
      `npm run job -- check_meta_permissions` from a Render shell on
      `shipblu-support-worker` — it reads `granular_scopes`, which also says
      whether a scope was granted for this Page or another one.
- [ ] **The routing decision is made**, per the section at the top: either
      `INSTAGRAM_ACCESS_TOKEN` is unset for the recording and one test reply has
      already succeeded over the Page, or you are submitting for
      `instagram_business_manage_comments` instead and this file is the wrong
      one.
- [ ] **The business is verified.** Meta requires it for comment webhook
      delivery at Advanced Access, alongside this permission.
- [ ] **The reviewer's agent account exists** and holds Supervisor or above, and
      its password went into Meta's form rather than into a file.
- [ ] **The recording shows public effect**, not just console state, for each of
      reply, hide, unhide and delete.
- [ ] Put `INSTAGRAM_ACCESS_TOKEN` back afterwards if you unset it, and confirm
      one Instagram reply goes out `via instagram_login` again.
