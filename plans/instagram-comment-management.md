# Instagram comment management

The App Review item is comment management on Instagram. **Which of its two names
to apply under is decided by how the account is connected, not by preference** —
see "Which permission to apply for" below. The rest of this is what had to be
true before there was anything to submit under either name.

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

## Which permission to apply for

`instagram_manage_comments` and `instagram_business_manage_comments` are **not
two ways of asking for the same thing**. They are the comment permission of the
two setups above, and an account is connected one way at a time — one host, one
token, one signing secret. So the permission follows the connection:

| The account is connected through | Apply for                                                        |
| -------------------------------- | ---------------------------------------------------------------- |
| its Facebook Page                | `instagram_basic`, `instagram_manage_comments`, `pages_*`        |
| Instagram Login                  | `instagram_business_basic`, `instagram_business_manage_comments` |

**Applying for both is worse than applying for one.** App Review wants a
screencast per permission showing the app actually using it, and the app can only
exercise the set matching the live connection — so the other one is a permission
with nothing to demonstrate, on a submission that is approved or rejected as a
whole.

Being a single-tenant app changes the access _level_ argument but not the name.
Meta's own line is that "if your app only serves your Instagram professional
account or an account you manage, Standard Access is all your app needs" — but
Standard Access only covers app users **with a role on the app**, and this is a
support inbox whose entire traffic is members of the public who have none. The
messaging side settles it regardless: an Instagram private reply is documented as
needing Advanced Access, the Human Agent feature and business verification, and
the composer has offered private replies since the channel landed. So Advanced
Access and business verification are required anyway, and the comment permission
should go in that same submission rather than being deferred on the hope that
Standard Access stretches.

One useful detail from that requirement: `instagram_manage_comments` is what
gates the **private reply**, not only hide and delete. The permission is not
optional for a comment ticket even if nobody ever hides anything.

### The recommendation, and what it is waiting on

**Submit `instagram_business_manage_comments`** — that is, stay on Instagram
Login — alongside `instagram_business_basic`, `instagram_business_manage_messages`
and the **Human Agent** feature, which `docs/PROJECT-STATE.md` §5.2 has never
confirmed is approved and which is the likeliest cause of the dead Instagram send
from 20 August.

The argument is not that Instagram Login is the better design. It is that the
account is already on it, the code now handles it with one environment variable,
and reverting Instagram to the Page would be a second live migration of a
production integration on the day the first one broke it silently for thirteen
hours. "One Meta app, one credential" is not recoverable by reverting anyway:
Messenger and WhatsApp keep the Page and the app secret regardless, so the
two-credential world exists either way.

**The confirmation came back "both", which reopens the question.** Read at 02:38
UTC on the 27th: Instagram deliveries verify against `META_INSTAGRAM_APP_SECRET`
_and_ `META_APP_SECRET`, alternating within seconds, split by envelope — the
`messaging` copies of the account's traffic against one, the handover protocol's
`standby` copies against the other. §6.26 has the numbers.

So the premise of the table above — that an account is connected one way at a
time — is false for this account. Two connections are live at once, which means:

- **The permission still cannot be both**, for the reason it never could: App
  Review wants a screencast per permission, and only the setup the app actually
  calls Graph through can produce one. What has changed is that the _code_ can
  now be pointed at either, so which one gets exercised is a configuration
  choice rather than a discovered fact.
- **The choice is now a real decision, not a lookup.** It is: which of the two
  connections should this helpdesk own? Keeping the Instagram Login one means
  `instagram_business_manage_comments` and `INSTAGRAM_ACCESS_TOKEN` pointed at
  `graph.instagram.com`. Keeping the Page one means `instagram_manage_comments`
  and the Page token. The recommendation above still stands on its own reasoning
  — the account is already reachable that way and the code handles it — but it is
  now a preference to confirm rather than a fact to read off a webhook.
- **Something else holds thread control of this inbox**, which `standby` is
  Meta's way of saying. That is worth settling _before_ the submission, not
  after: a screencast of a reply Graph refuses is a rejected submission, and
  `lib/meta/thread.ts` refuses those sends locally for exactly this reason.
  §5.2's six dead `send_meta` rows may be this rather than Human Agent.

Whoever picks up the submission should decide the first bullet with somebody who
knows why both connections exist, then disconnect the one the helpdesk is not
going to own. Submitting while both are live risks demonstrating the wrong half.

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
   Instagram → API setup with Instagram login. **Done — Instagram has been
   verifying again since 2026-08-27 01:29:01 UTC**, after a first attempt that
   did not match; §6.26 has the tally and what is still unknown. Instagram
   deliveries verify again from the next one; check with
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
