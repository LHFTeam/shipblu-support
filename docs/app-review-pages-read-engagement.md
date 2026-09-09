# The `pages_read_engagement` App Review submission

Sibling of `docs/app-review-instagram-manage-comments.md`.

Written 2026-09-09 against production, and **corrected the same day**: the first
version of this file said the app's only use of this permission was one call
that had never run. That was wrong, and the App Dashboard is what said so — it
reports many calls. They are real, they are the app's busiest Graph read, and
section D now names them. What follows is the corrected account.

## What the app actually uses it for

**The customer's name and picture.** A Messenger or Instagram webhook carries a
scoped id and nothing else — no name, no handle, unlike WhatsApp, which puts
the profile name in the payload. `fetchProfile` in `lib/meta/client.ts` reads
`GET /{page-scoped-id}?fields=first_name,last_name,name,profile_pic` on
`graph.facebook.com` with the Page token, and it is the only thing that can
tell this system who wrote in. Without it the console shows a support agent a
seventeen-digit number where a customer's name belongs.

That is inside this permission's documented scope. Meta's reference for
`pages_read_engagement` lists three things it allows, and the second is the
one: _"Get names, PSIDs, and profile pictures of your Page followers."_

**The volume is not small.** 171 `fetch_meta_profile` jobs between 2026-09-02
and 2026-09-09, every one of them on `facebook`, and each job makes **two**
Graph reads rather than one — `fetchProfile` asks for the extended field list
first and retries with the base list on refusal — so roughly 340 calls in eight
days. The console's **Refresh profile** button makes more, in the action rather
than through a job. That is what the dashboard is counting.

**A second call site exists and has never run.** `latestPagePostId()` —
`GET me/published_posts?limit=1&fields=id` — is reached only by the
`test_comment_permission` job, which logs `[meta:test]` unconditionally and has
produced no such line in thirty days on either service. It is a diagnostic, not
a feature, and it is not what the dashboard is showing.

**And it is a dependency regardless.** Meta's reference lists
`pages_read_engagement` under `instagram_manage_comments`, alongside
`instagram_basic` and `pages_show_list`, and names it again in the
prerequisites for the Instagram `comments` webhook field
(`docs/PROJECT-STATE.md` §5.2). So it has to be on the submission whatever the
call counts say.

## Before you paste any of this

**Every one of those calls is being refused, and the dashboard counting them is
not evidence otherwise.** Today's log, on repeat:

```
[fetch_meta_profile] facebook 28289874257321462 refused: Unsupported get request.
  Object with ID '28289874257321462' does not exist, cannot be loaded due to
  missing permissions, or does not support this operation.
[fetch_meta_profile] this is the refusal that means the Meta app may not hold
  Business Asset User Profile Access — check App Review before treating it as a
  property of this one customer
```

In the database: **4 of 83 Facebook identities carry a display name**, and one
carries a locale. The handful that do are almost certainly named from the
`feed` webhook's own `from.name`, which comment deliveries include — not from
this endpoint, which has resolved nobody.

**That reconciles the two counters, and it is §6.61's table read from the other
side.** §5.2 records the App Dashboard reporting **0 calls against Business
Asset User Profile Access**, and explains it correctly: a call stopped at a
capability gate is never counted against the feature that stopped it. The
permission's counter is a different counter. The request reached the endpoint
`pages_read_engagement` covers, so it is counted there; the _feature_ refused
it, so it is not counted against the feature. A permission's counter moves
before the grant and a feature's cannot — which is exactly what §6.61's table
says, now observed from both ends on one call.

Two consequences for the submission:

- **The "successful call" gate is satisfied for this permission.** The App
  Dashboard's Request advanced access button unlocks on logged calls, and there
  are hundreds. No `test_comment_permission` run is needed for this one — that
  job is for `pages_manage_engagement`.
- **A screencast cannot show a resolved name today.** The endpoint refuses, so
  a reviewer following the steps sees a numeric id where a customer's name
  should be. The fix is not on this permission: it is the **Business Asset User
  Profile Access** feature, which has to be on the same submission and is what
  is actually refusing. Say so in the notes rather than filming a screen that
  shows a number.

**And there is a screencast requirement this app still cannot meet.** Meta asks
for three beats:

> 1. "Demonstrate the complete Facebook login process on your app platform,
>    showing how your app user grants your app this permission."
> 2. "Demonstrate how your app user accesses a post's content on their Facebook
>    Page on your app platform"
> 3. "Showcase that the post content is successfully displayed on your app
>    platform"

Beats 2 and 3 are about the **Page-content** half of the permission, which the
app does not use and does not display. A comment ticket knows which post it
belongs to — `ingestMetaComment` stores `postId` on the message and on the
`comment_thread_opened` event — and nothing renders it; there is not one
`facebook.com` or `instagram.com` link in the ticket view. Beat 1 is the same
unfilmable step as the comment submission; section C of that file has the
sentence to give Meta instead.

So the submission rests on the follower-identity half, which is the half the
app genuinely uses, and says plainly that it does not read Page content. If a
rejection comes back citing beats 2 and 3, the fix is to show the post beside
the comment on the ticket — worth building anyway, since an agent answering
#13798's "أسوأ شركه شحن" cannot see what it was posted under, and `postId` is
already stored.

## A. Use case description

```text
ShipBlu Support is the in-house helpdesk that ShipBlu, a last-mile delivery
company operating in Egypt, uses to answer its own customers. It is a
single-tenant application: the only Facebook Page and Instagram professional
account it is connected to are ShipBlu's own, which we own and administer. It
does not onboard other businesses and it never reads a Page belonging to anyone
else.

We use pages_read_engagement for one thing at volume, and we need it as a
dependency for a second.

1. Identifying the customer who wrote to us. A Messenger message and a comment
   on our Page arrive carrying a page-scoped ID and no name. That ID is the
   only thing our support agents would otherwise see. We call
   GET /{page-scoped-id}?fields=first_name,last_name,name,profile_pic so the
   ticket shows the person's name and profile picture, which is what lets an
   agent greet them properly, recognise a returning customer, and match the
   conversation to a delivery record. This is the "names, PSIDs, and profile
   pictures of your Page followers" that this permission covers, and it is our
   busiest Graph read: around 340 calls in the eight days before this
   submission, one pair per customer who writes in.

2. As a required dependency of instagram_manage_comments, submitted alongside
   this one. Meta's permission reference lists pages_read_engagement as a
   dependency of it, and the prerequisites for the Instagram "comments" webhook
   field name it again. That permission is what brings comments on our posts
   into our support queue and lets our agents reply to, hide and delete them.

We do not read Page insights, we do not read follower lists in bulk, and we do
not read any Page other than our own. A profile is read only for a person who
has just written to us, in response to their own message, and it is stored on
that person's contact record so the agent answering them knows who they are.

We should be straightforward about the current state: these calls are being
refused today, because our app does not yet hold the Business Asset User
Profile Access feature, which is submitted with this request. Our agents
currently see a numeric ID in place of every Facebook customer's name.
```

## B. Step-by-step instructions for the reviewer

```text
Test account
  URL:      https://<console-host>/login
  Email:    <reviewer agent email>
  Password: <supplied in this form>

1. Open the URL above and sign in.

2. From your own Facebook account, send a message to our Page, or leave a
   comment on one of its posts.

3. In the console, open Inbox. A ticket appears within a few seconds carrying
   your message. Open it.

4. The ticket header shows the customer. Where our app has been able to read
   the profile, this is the person's name and picture; where it has not, it is
   the page-scoped ID that the webhook delivered. Press "Fetch name from Meta"
   in the ticket header — this calls the User Profile API for that ID and
   writes Meta's answer, or Meta's refusal, onto the ticket's timeline where
   the agent can read it.

5. Open the contact record from the ticket to see the same name and picture
   stored against the customer, alongside the other channels they have
   contacted us on.

Note: at the time of writing, step 4 returns a refusal for customers, because
our app does not yet hold the Business Asset User Profile Access feature, which
is submitted with this request. The refusal is displayed on the ticket rather
than hidden, which is what you will see if you follow the steps before that
feature is approved. Under Meta's role exemption a lookup for a person holding
a role on our app is answered without App Review, and that is what the
screencast shows.
```

## C. What to say about the screencast

```text
Two notes on the screencast requirements for this permission.

First, this app has no Facebook Login flow to demonstrate. It is single-tenant:
it serves only ShipBlu's own Page and Instagram account, which we own and
administer, and they were connected once through the App Dashboard rather than
by any app user granting a permission. Our support agents authenticate with a
password against our own system.

Second, we do not read or display Facebook Page post content, so there is no
screen on which a post's content is accessed and shown. Our use of this
permission is the follower-identity half of it: resolving the name and profile
picture of a customer who has written to our Page, so the support agent
answering them knows who they are. The screencast demonstrates that, and the
comment handling that this permission is also a dependency of.
```

Record it with a lookup for somebody who **holds a role on the app** — admin,
developer or tester. Meta answers those without App Review, which is the one
way to film a resolved name and picture before the feature is granted; §5.2 has
the same trick written down for Business Asset User Profile Access.

## D. What the claims above rest on

| Claim                                             | Checked how                                                                 | Answer on 2026-09-09                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| The permission is granted                         | `permissions` webhooks in `webhook_events` — the §5.2 query                 | granted 2026-09-02 10:43:05 UTC, once                             |
| What generates the call volume                    | `jobs` where `type = 'fetch_meta_profile'`, grouped by platform and status  | 171 jobs, all `facebook`, 2026-09-02 → 2026-09-09                 |
| Two Graph calls per job, not one                  | `fetchProfile` in `lib/meta/client.ts` — extended attempt, then base retry  | ≈340 calls in eight days                                          |
| Every one of them refused                         | worker log, text `fetch_meta_profile`                                       | `(#100) … cannot be loaded due to missing permissions`, on repeat |
| And the refusals leave the console empty          | `contact_identities` for `facebook` and `instagram`                         | 4 of 83 Facebook identities named; 1 has a locale                 |
| The other call site has never run                 | Render logs, text `meta:test` and `test_comment_permission`                 | no line in 30 days on either service                              |
| Nothing displays Page post content                | `postId` and `facebook.com` / `instagram.com` across `app/(console)/inbox/` | stored on the message and the event; rendered nowhere, no link    |
| It is a dependency of `instagram_manage_comments` | Meta's permission reference; §5.2 for the webhook field's prerequisites     | dependency there, and named in the `comments` prerequisites       |

A successful GET leaves no log line — `graph()` warns only on failure — so the
"never run" row rests on `test_comment_permission`'s own unconditional output,
not on the absence of the Graph call.

## E. Before pressing submit

- [ ] **Business Asset User Profile Access is on the same submission.** It is
      what is actually refusing the calls this permission covers, and approving
      one without the other leaves the console showing numeric ids.
- [ ] **`pages_show_list` is on it too.** Dependency of this permission and of
      `instagram_manage_comments`, and it has **never appeared in a
      `permissions` webhook** — so it may not be on the token.
      `npm run job -- check_meta_permissions` reads `granular_scopes` and
      settles it.
- [ ] **Film the role-holder lookup**, not a customer's — a customer's is
      refused today and a recording of a refusal is a rejected submission.
      **Confirm it still resolves before filming**, with `Refresh profile` on a
      ticket from somebody holding a role. §5.2 recorded that working on
      2026-08-27, and the refusal on customers has since changed shape from
      `(#3)` to `(#100)`, which is a change nobody has explained.
- [ ] **Know what the reviewer will see** if they follow section B literally
      before the feature lands: a numeric id and a refusal on the timeline. The
      note in section B says so; keep it there rather than hoping they do not
      try it.

## Worth fixing separately

Around 340 Graph calls in eight days, every one refused, and the result
discarded each time. One subject was looked up **35 times in 24 minutes** on
2026-09-02 — 70 calls for one person, all answered the same way.

The repeats are not a dedupe bug: `AGENTS.md` is explicit that a profile
refresh must enqueue without a key and be idempotent, because a key is spent
for good and would silence the retry that approval is supposed to fix. What is
missing is a short circuit while the feature is known to be ungranted — the
handler could stop asking for a subject Graph has already refused this way,
until something changes. That would take the dashboard's usage graph from
"hundreds of refused calls" to a number that means something, and stop burning
rate limit on an answer that is currently fixed.

Not done here, because it is a behaviour change rather than a submission, and
because the refusals are also the evidence trail this file rests on.
