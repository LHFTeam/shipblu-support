# The `pages_read_engagement` App Review submission

Sibling of `docs/app-review-instagram-manage-comments.md`, and it has to be
read differently. That one describes a feature the product has and a reviewer
can watch working. This one is a **dependency**: Meta requires it for the
permission we actually want, and the app's own use of it is one call that no
screen has ever shown the result of.

Written 2026-09-09 against production.

## Before you paste any of this

**Why it is on the submission at all.** Meta's permission reference lists
`pages_read_engagement` as a dependency of `instagram_manage_comments`,
alongside `instagram_basic` and `pages_show_list`. It is named a second time in
the prerequisites for the Instagram `comments` webhook field itself —
`instagram_manage_comments` + `pages_manage_metadata` + one of
`pages_read_engagement` / `pages_show_list` (`docs/PROJECT-STATE.md` §5.2). So
it is not optional and it is not padding: without it the comment permission
cannot be granted, and Meta's own guidance for a dependency is to submit it and
name the main permission in the use-case description.

**It is already granted.** 2026-09-02 at 10:43:05 UTC, one second before
`instagram_manage_comments` in the same `permissions` webhook batch. As with
that one, this submission is for Advanced Access rather than for the grant.

**The app has made one kind of `pages_read_engagement` call, and there is no
evidence it has ever run.** The only call site in the repository is
`latestPagePostId()` in `lib/meta/client.ts` — `GET me/published_posts?limit=1&fields=id`
— and the only thing that reaches it is the `test_comment_permission` job,
which exists to unlock `pages_manage_engagement`'s Advanced Access button
(§6.42). That job logs `[meta:test]` unconditionally on every run, and **no
such line exists in thirty days of Render logs on either service.** Nothing
else in the codebase reads a Page post, a follower list or Page metadata.

**So the screencast Meta asks for cannot be recorded today.** The requirement
is three beats:

> 1. "Demonstrate the complete Facebook login process on your app platform,
>    showing how your app user grants your app this permission."
> 2. "Demonstrate how your app user accesses a post's content on their Facebook
>    Page on your app platform"
> 3. "Showcase that the post content is successfully displayed on your app
>    platform"

Beat 1 is the same unfilmable beat as the comment submission — this app has no
Facebook Login, and section C of that file has the sentence to give Meta
instead. **Beats 2 and 3 are worse than unfilmable: there is nothing to point a
camera at.** A comment ticket knows which post it belongs to —
`ingestMetaComment` stores `postId` on the message's `meta` and on the
`comment_thread_opened` event — and **nothing renders it**. There is not one
`facebook.com` or `instagram.com` link anywhere in the ticket view. The agent
sees the comment, a "public comment" badge, and the commenter; they do not see
the post the comment is on.

Two honest ways forward, and they are not equal:

- **Submit it as the dependency it is** (what section A does). Legitimate, it
  is Meta's documented route for a dependency, and it costs nothing. The risk
  is a reviewer who works the screencast checklist literally and rejects the
  whole submission — including `instagram_manage_comments`, which is approved
  or rejected with it.
- **Build the post-context panel first.** Show the post a comment was left on,
  on the ticket: its text, its permalink, and the reply count. That makes beats
  2 and 3 filmable exactly as written, and it is worth doing on its own merits —
  an agent currently answers "أسوأ شركه شحن ومندوبينكم يلعبو بيا" (#13798)
  without being able to see what it was posted under. `postId` is already
  stored, so this is a Graph read and a panel, not a data-model change.

**Recommendation: submit as a dependency now.** The panel is the right product
change and the wrong thing to block a submission on, and if this comes back
rejected on the screencast then it is the fix — and the rejection will have
told you that the literal reading is the one being applied, which is worth
knowing before building to it.

## A. Use case description

```text
ShipBlu Support is the in-house helpdesk that ShipBlu, a last-mile delivery
company operating in Egypt, uses to answer its own customers. It is a
single-tenant application: the only Facebook Page and Instagram professional
account it is connected to are ShipBlu's own, which we own and administer. It
does not onboard other businesses and it never reads a Page belonging to
anyone else.

We are requesting pages_read_engagement as a dependency of
instagram_manage_comments, which is the permission this submission is really
about and which is submitted alongside it.

Our customers ask delivery questions in the comments on our own Facebook and
Instagram posts. instagram_manage_comments is what lets those comments reach
our support queue as tickets, and lets our agents answer, hide and delete them
from the same console they answer email and WhatsApp in. Meta's permission
reference lists pages_read_engagement as a dependency of that permission, and
Meta's prerequisites for receiving the Instagram "comments" webhook field name
it again. We cannot receive or act on a comment on our own posts without it.

The app's own direct use of the permission is narrow and we would rather state
it plainly than overstate it: we read our Page's most recent published post
(GET /me/published_posts) to identify the post to run an API permission check
against. We do not read follower lists, we do not read Page insights, and we do
not read any Page other than our own.

All access is to content published by our own Page, on behalf of our own
business, by our own support agents.
```

## B. Step-by-step instructions for the reviewer

The honest instruction set for a dependency is short, and it should send the
reviewer to the thing the dependency is for rather than invent a flow that does
not exist. Paste this after the `instagram_manage_comments` instructions, or
reference them if the two are submitted together.

```text
Test account
  URL:      https://<console-host>/login
  Email:    <reviewer agent email>
  Password: <supplied in this form>

pages_read_engagement is requested as a dependency of
instagram_manage_comments. Its effect is visible in that permission's flow
rather than in a screen of its own, so these steps are the same ones:

1. Open the URL above and sign in.

2. Leave a comment from your own account on any post published by our Facebook
   Page or by @shipblu on Instagram.

3. In the console, open Inbox. A ticket appears within a few seconds carrying
   your comment, your name, and a "public comment" badge.

4. Open the ticket, type an answer and send it. Refresh the post: the answer is
   now a public reply to your comment.

5. Use Hide and then Delete on the customer's comment in the ticket, and
   refresh the post after each to see the effect.

Our application does not render Page post content on a screen of its own. It
reads our own Page's most recent published post only to select a post for an
API permission check, which is a maintenance operation rather than a user-
facing feature. We have described that plainly in the use case rather than
building a screen in order to demonstrate a permission we need as a
dependency.
```

## C. What to say about the screencast

There is no recording that satisfies beats 2 and 3, so the notes have to say
so rather than submit footage of something else and hope it passes for the
same thing. Put this in the submission notes:

```text
Two notes on the screencast requirements for this permission.

First, this app has no Facebook Login flow to demonstrate. It is single-tenant:
it serves only ShipBlu's own Page and Instagram account, which we own and
administer, and they were connected once through the App Dashboard rather than
by any app user granting a permission. Our support agents authenticate with a
password against our own system.

Second, we do not display Facebook Page post content in our application, so
there is no screen on which a post's content is accessed and shown. We are
requesting pages_read_engagement because Meta lists it as a required dependency
of instagram_manage_comments, which is submitted alongside it and which our
application does use fully — receiving comment notifications, replying
publicly, hiding, unhiding and deleting. The screencast accompanying this
submission demonstrates that permission end to end.
```

If the panel gets built first, replace the second paragraph and record the two
beats properly: open a comment ticket, show the post text and permalink beside
the comment, and show that the content came from the Page.

## D. What the claims above rest on

| Claim                                             | Checked how                                                                     | Answer on 2026-09-09                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The permission is granted                         | `permissions` webhooks in `webhook_events` — the §5.2 query                     | granted 2026-09-02 10:43:05 UTC, once                                   |
| It is a dependency of `instagram_manage_comments` | Meta's permission reference; `docs/PROJECT-STATE.md` §5.2 for the webhook's own | dependency there, and named in the `comments` field prerequisites       |
| The app's only call site                          | every `graph(` call in `lib/meta/`                                              | one — `latestPagePostId()`, `GET me/published_posts`                    |
| What reaches that call site                       | callers of `latestPagePostId`                                                   | `worker/handlers/test-comment-permission.ts`, nothing else              |
| Whether that job has ever run                     | Render logs on web and worker, text `meta:test` and `test_comment_permission`   | **no line in 30 days on either service**                                |
| Whether any screen shows post content             | `postId` and `facebook.com` / `instagram.com` across `app/(console)/inbox/`     | `postId` stored on the message and the event; rendered nowhere, no link |

A successful GET leaves no log line — `graph()` in `lib/meta/client.ts` warns
only on failure — so the fifth row rests on `test_comment_permission`'s own
unconditional `[meta:test]` output, not on the absence of the Graph call. A run
from somebody's laptop against production credentials would leave no trace
here either way.

## E. Before pressing submit

- [ ] **`pages_show_list` is on the submission too.** It is this permission's
      own dependency and `instagram_manage_comments`'s, and it has **never
      appeared in a `permissions` webhook** — so it may not be on the token at
      all. `npm run job -- check_meta_permissions` from a Render shell on
      `shipblu-support-worker` reads `granular_scopes` and settles it.
- [ ] **This is submitted with `instagram_manage_comments`, not on its own.**
      A dependency submitted alone has no use case to describe.
- [ ] **Make one successful call against it before submitting**, so the App
      Dashboard's "Request advanced access" button is live.
      `npm run job -- test_comment_permission` calls `GET me/published_posts`
      first, then exercises `pages_manage_engagement` in both directions. It
      writes a comment to the live Page and deletes it in the same run. Meta
      logs the call within about two days and wants it inside the 30 days
      before submission, so do this immediately before submitting.
- [ ] **The decision from the top of this file is made** — dependency framing,
      or build the post-context panel first.
