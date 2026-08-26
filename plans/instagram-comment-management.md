# Instagram comment management

The App Review item is `instagram_business_manage_comments`. This is what had to
be true before there was anything to submit.

## Context

The Instagram channel has been merged since phase 2, and comments have been part
of it from the start: `lib/meta/parse.ts` reads a `comments` change,
`ingestMetaComment` opens a ticket keyed on the root comment id, the composer
offers a public reply or a one-time private reply, and the timeline badges which
of the two an agent sent. All of it passes its tests.

None of it has ever run. Four things were wrong, and each hid the next:

1. **No comment webhook has ever arrived.** Of 2,854 Meta deliveries stored
   since 19 August — 2,341 Instagram, 513 Facebook — **not one carries a
   `changes` entry**. `comments` is not among the subscribed fields on the
   `instagram` object, and `feed` is not among the Page's. `ingestMetaComment`
   has never been called in production, and `conversations` holds zero comment
   threads.
2. **Every comment call was Facebook-shaped, on both platforms.** Instagram gives
   a comment a `replies` edge, not a `comments` one; spells the hide parameter
   `hide`, not `is_hidden`; and has no private-reply edge at all — a private reply
   there is a _message_ addressed to a comment id. `replyToComment`,
   `hideComment` and `privateReplyToComment` each took a comment id and no
   platform, so the difference could not be expressed. No Instagram comment reply
   this system sent could ever have been delivered.
3. **The console could not moderate anything.** `hideComment` has sat in
   `lib/meta/client.ts` since the channel landed and **nothing ever imported
   it**; there was no delete at all. The two verbs the permission is named for
   were the two the product did not have — the same shape of dead scaffolding as
   `agents.presence` and `conversations.custom_fields` before them.
4. **Instagram's webhooks stopped verifying.** On 2026-08-26 at 07:37 UTC every
   Instagram delivery began failing X-Hub-Signature-256 — 2,309 of them in
   thirteen hours, answered 403 and filed unverified — while Facebook's 111
   deliveries over the same hours kept verifying against the same unchanged
   secret. The account had been moved onto **Instagram Login**, which signs with
   its own Instagram app secret. Real customers' messages were dropped; the last
   one before this was written is a question in Arabic about how the service
   works.

## The two Instagram setups

This is the fact underneath both (2) and (4), and it was not written down
anywhere in the repo.

An Instagram professional account can be reached two ways, and the App Review
permission names are the clearest way to tell which one an app is on:

|                | Through the Facebook Page   | Through Instagram Login              |
| -------------- | --------------------------- | ------------------------------------ |
| Host           | `graph.facebook.com`        | `graph.instagram.com`                |
| Credential     | Page access token           | Instagram access token               |
| Webhook signed | app secret                  | **Instagram app secret**             |
| Comments       | `instagram_manage_comments` | `instagram_business_manage_comments` |

`README.md` and `lib/env.ts` both said one Meta app means one credential, which
was true of WhatsApp, Messenger and a Page-connected Instagram account, and is
the assumption that cost thirteen hours of Instagram traffic.

So `META_INSTAGRAM_APP_SECRET` and `INSTAGRAM_ACCESS_TOKEN` are added as an
optional pair. Unset — which is every deployment before this — behaves exactly as
before: the Page token, `graph.facebook.com`, the app secret. Set, and Instagram
alone moves.

Two candidate secrets are _tried_ for an `instagram` delivery rather than one
being chosen, most-specific first. Both are ours, so accepting either is not a
weakening, and it means an account can be moved between the two setups without a
deploy timed to the minute. Nothing but the `instagram` object is ever offered
the Instagram secret: the WhatsApp path carries 152,000 deliveries and does not
need a second HMAC per request.

## What the console does now

Under an inbound comment, for an agent holding `ticket.moderate_comment`:
**Hide** / **Unhide**, and **Delete** behind a second click. The state — hidden,
deleted, or an action in flight — renders for every agent, because somebody
without the permission still needs to know that the comment they are answering is
already invisible to the public.

Three decisions worth keeping:

**The Graph call is a job, not part of the action.** It is external and
rate-limited, like every other Graph call in this system, so a blip should delay
a moderation rather than lose it. What that costs is a second or two where the
agent has asked and Meta has not answered — and showing the comment as hidden
during it would be a claim about what the public can see, made before anybody
knew. So the state carries `pending`, the strip says "Hiding at Meta…", and the
handler's `UPDATE` on `messages` fires the same `notify_change` trigger a
customer's reply does, which puts the settled state on screen over the stream
that already exists.

**A refusal never writes the outcome that was asked for.** A failed hide has not
hidden anything. `failed()` clears `pending` and leaves `hidden` and `deleted`
exactly as they were, because a console that shows a comment as hidden while it
is still on the post is worse than one that shows the error.

**Enqueued without a `dedupeKey`.** Hide and unhide are each other's opposite and
both are legitimately repeatable; a key on the comment id would be spent
permanently by the first hide (`jobs_dedupe_idx` is a plain unique index over the
whole table) and every later request would silently do nothing. The guard is
`moderationRefusal` in the action, before anything is enqueued, plus a handler
that skips a job whose message is no longer pending. The UI does not offer a
control that would be refused, which is a nicety rather than the guard.

**The permission is its own key.** `ticket.moderate_comment`, from supervisor up.
Replying authorises writing back to somebody who wrote to us; this authorises
changing what everybody else can see on the brand's post, and one of its two
verbs cannot be undone by anyone. It is a plain permission, so a front-line agent
who moderates all day can be given it without being promoted.

## Where the reply goes

Instagram comment threads are one level deep: every reply hangs off the top-level
comment, and `replies` is an edge of that comment alone. Once a customer has
answered inside a thread the newest inbound comment _is_ a reply, so replying to
what they just wrote means posting to an edge that does not exist there.

`commentReplyTarget` resolves an Instagram public reply to the thread's root,
read back out of the ticket's `external_id` — which `ingestMetaComment` already
keys on — and leaves Facebook answering directly under the customer's own
comment, which is what an agent means by "reply" and which Facebook accepts.

A **private** reply keeps the specific comment either way: the seven days it is
allowed within are counted from the comment it names, so naming the newest one
buys the most time.

## Order of operations

Nothing below is code, and the code is inert without it.

1. Set `META_INSTAGRAM_APP_SECRET` (and `INSTAGRAM_ACCESS_TOKEN`, if the account
   is on Instagram Login) in `shipblu-support-production`, from the Meta app's
   Instagram → API setup with Instagram login. Instagram deliveries verify again
   from the next one; check with
   `select count(*) filter (where signature_verified) from webhook_events where channel = 'instagram' and received_at > now() - interval '10 minutes'`.
2. `npm run job -- subscribe_meta_webhooks object=instagram` from a Render shell
   on the worker. It reads the current field list, merges `comments` in, writes
   it back and reads it back again — the merge is the point, because the Graph
   write _replaces_ the list and a hand-typed one would unsubscribe `messages`.
3. Comment on the account's own post from another Instagram account. A ticket
   should open within seconds, badged `public comment`.
4. Reply publicly from the console, then hide the comment, then unhide it. Each
   of the three is a separate App Review screencast beat, and each is now
   visible in `conversation_events` as `comment_hidden` / `comment_unhidden` /
   `comment_deleted`.
5. Only then submit. A screencast is the submission, and until step 3 works there
   is nothing to record.

## What is still not known

- **Whether the app is approved for comment management at all.** Graph refuses an
  unapproved POST with `100/33 "Unsupported post request"`, the same sentence it
  uses for a comment that no longer exists. `explainMetaModerationError` names the
  permission in the failure rather than leaving the next person to guess, which is
  the lesson from Human Agent (`docs/PROJECT-STATE.md` §5.2) and Business Asset User Profile Access.
- **The 2,309 rejected deliveries cannot be recovered.** Only the parsed payload
  is stored, not the raw bytes, so their signatures can never be re-checked
  against the correct secret — and processing them unverified would mean trusting
  2,309 payloads on the strength of a hypothesis about why they failed. Meta's own
  retries are long expired. Whether to replay them anyway is a decision for a
  person, and it is the argument for keeping raw bytes on an unverified delivery
  in future.
- **Whether Facebook's `feed` field is worth subscribing.** `object=page` is
  supported by the same job, and the parser already discards the likes, shares
  and post edits that arrive with it. Nobody has asked for Facebook comment
  tickets, so it stays unsubscribed until somebody does.
