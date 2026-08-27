# Meta App Review — permission justifications

Paste-ready answers for the App Review question:

> Provide a detailed description of how your app uses the permission or feature
> requested, how it adds value for a person using your app, and why it's
> necessary for app functionality.

One section per requested item. Each **Answer** block is the text to paste,
written to stand alone — a reviewer reads them one at a time and in no
particular order, so each repeats the minimum context it needs rather than
referring to another answer.

`user_messenger_contact` has been **dropped from this submission** and has no
section here; see [Dropped](#dropped-from-this-submission) for why, so nobody
adds it back next cycle. `instagram_business_manage_messages` is very likely to
follow it — its section carries the check that decides.

§ [Before you submit](#before-you-submit) is not for pasting. It lists two
remaining requested items that the code does not currently back, and four
permissions the built features need but the list omits. Read it first: the
fastest way to fail this review is to describe behaviour a reviewer cannot see
in the screencast.

---

## The app, in one paragraph

Everything below assumes this description, which is worth putting in the app's
own "App Details" and verification notes too:

> ShipBlu Support is ShipBlu's in-house customer support helpdesk. ShipBlu is a
> last-mile delivery company in Egypt; the people who write in are merchants who
> ship parcels with us and the recipients waiting for them, and what they write
> in about is a specific parcel. The app is not sold or offered to other
> businesses: it serves ShipBlu's own Facebook Page, Instagram professional
> account and WhatsApp Business Account, and its users are ShipBlu's own support
> agents, who sign in to an internal console. It replaces Freshdesk and
> Freshchat, which the team used for the same purpose. One conversation per
> customer per channel becomes one ticket, and every channel a customer might
> use — email, WhatsApp, Messenger, Instagram, our website's chat widget — lands
> in one queue so that whoever picks it up can see the parcel, the account and
> everything the customer has said before.

---

## pages_messaging

**Answer**

> ShipBlu operates a Facebook Page as one of its public customer support
> channels. `pages_messaging` is what makes that channel work in both
> directions, and the app does nothing with it that is not customer support.
>
> Inbound: the app subscribes to the Page's `messages` webhook field. When a
> customer sends the Page a direct message, our webhook endpoint verifies
> Meta's `X-Hub-Signature-256`, stores the payload and returns 200 immediately;
> a background worker then turns it into a ticket. All of a customer's
> Messenger messages thread onto one open ticket rather than opening a new one
> per message, so an agent reads a conversation rather than a pile of
> fragments. Attachments a customer sends — nearly always a photo of a parcel,
> a damaged box or a delivery address — are downloaded and stored against the
> ticket so the agent can actually see the problem being described. We ignore
> `is_echo` messages so that our own outbound replies are not filed as if the
> customer had written them.
>
> Outbound: when an agent types a reply in our console and hits send, the app
> calls `POST /{page-id}/messages` to deliver it to that customer's
> page-scoped ID. Every send is a human agent answering a customer who wrote to
> us first. The app sends no marketing, no broadcasts and no automated
> promotional content on this channel. We also use the Page's one-time private
> reply on a public comment (`POST /{comment-id}/private_replies`) when a
> customer's comment contains something that should not be discussed in public
> — an address, a phone number, an order reference — so we can move that person
> into a private thread once and answer them properly.
>
> Value to the person: they get an answer about their parcel in the place they
> chose to ask, from a named person rather than a bot, with the full history of
> what they have already told us. Without this permission the Page's inbox is
> invisible to the team that answers it — messages would arrive nowhere, and
> nothing an agent writes could be delivered. There is no fallback: Messenger is
> the only way to reach a person who contacted us on Messenger.

---

## pages_manage_metadata

**Answer**

> `pages_manage_metadata` is what lets the app receive anything from the Page at
> all. It is used for exactly one thing: subscribing our app to the ShipBlu
> Page's webhooks, and keeping that subscription correct.
>
> Concretely, the app installs itself on the Page
> (`POST /{page-id}/subscribed_apps`) for the fields our support pipeline
> consumes — `messages` for customer direct messages, `messaging_postbacks` and
> the delivery/read receipts that tell an agent whether their reply landed, and
> `feed` for public comments on Page posts. It also reads the current
> subscription back so that a configuration change adds a field rather than
> replacing the list: Meta's subscription write replaces the whole field list,
> so a careless call would silently unsubscribe inbound messages while
> reporting success. Our subscription job reads the live field list, merges,
> and refuses to write a list that drops anything already subscribed. This runs
> as an operator-run maintenance job, not on customer traffic.
>
> Value to the person: it is the reason a message they send the Page reaches a
> human. Everything else in the Facebook channel — ticket creation, routing to
> the right team, SLA timers, the agent's reply — is downstream of a webhook
> being delivered. Without this permission we cannot subscribe, no webhook
> arrives, and a customer messaging our Page gets silence. The app does not use
> this permission to change any Page setting a person would notice: it does not
> post, rename, restyle or reconfigure the Page.

---

## instagram_manage_messages

**Answer**

> ShipBlu's Instagram professional account is a customer support channel in
> exactly the way the Facebook Page is, and a large share of Egyptian consumers
> reach a delivery company there first. `instagram_manage_messages` is what
> lets our support team read and answer that Direct inbox from the same console
> they answer everything else in.
>
> The Instagram account is linked to the ShipBlu Facebook Page, and the app
> addresses it through the Page token: inbound Direct messages arrive on the
> same webhook endpoint as Messenger, distinguished by the `object` field, and
> replies go to `POST /{ig-account-id}/messages`. Inbound messages become
> tickets and thread onto one live ticket per person, the same as every other
> channel. Media a customer sends is downloaded and attached to the ticket —
> on Instagram this is very often a story reply or a photo of a parcel, and
> without it the agent is reading "look at this" with nothing to look at. Our
> own echoed messages are discarded rather than filed as customer messages.
> Outbound is always an agent's typed reply to a person who messaged us first;
> the app sends no bulk or promotional Direct messages.
>
> Value to the person: their Instagram DM about a late parcel is answered by the
> same team, with the same history and the same service levels, as if they had
> emailed. It also means they are not asked to go and repeat themselves
> somewhere else. Without this permission the Instagram inbox cannot be read or
> replied to programmatically, which in practice means it goes back to being
> answered by hand on a phone, out of sight of the ticketing system, its
> reporting and its SLA clocks — which is the situation this app exists to end.

---

## instagram_business_manage_messages

> ⚠️ **Probably drop this — decide before you submit.** The draft answer below
> justified requesting it _alongside_ `instagram_manage_messages`, on the
> reasoning that the two are the same capability under two authorisation paths
> and holding both keeps the inbox alive through a re-link. `plans/instagram-comment-management.md`
> on `main` establishes that this reasoning is wrong, for the comment pair and
> equally for this messaging pair: an Instagram account is connected **one way at
> a time** — one host, one token, one signing secret — so the app can only ever
> exercise the set matching the live connection. App Review wants a screencast
> per permission, and a submission is approved or rejected **as a whole**, so the
> unusable half of the pair is a permission with nothing to demonstrate dragging
> down the half that works.
>
> So apply for the one that matches how ShipBlu's account is actually connected:
>
> | Connected through | Apply for                                                        |
> | ----------------- | ---------------------------------------------------------------- |
> | its Facebook Page | `instagram_basic`, `instagram_manage_messages`, `pages_*`        |
> | Instagram Login   | `instagram_business_basic`, `instagram_business_manage_messages` |
>
> Today the app sends through the Page token against `graph.facebook.com`, and
> `INSTAGRAM_ACCESS_TOKEN` / `META_INSTAGRAM_APP_SECRET` are an optional pair
> that no deployment had set before that PR — so unless someone has since moved
> the account onto Instagram Login, **the Page-connected row is the live one** and
> this permission is the one to drop. Confirm which is set in the production
> environment group before deciding; that check is the whole decision.

**Answer** — only if the account is on Instagram Login

> ShipBlu operates one Instagram professional account as a customer support
> channel, connected through Instagram Login. Inbound Direct messages are
> delivered to our webhook endpoint, stored, and turned into support tickets in
> the agent console; each person's messages thread onto one live ticket so an
> agent reads a conversation rather than disconnected fragments, and any photo or
> story reply they send is attached to that ticket so the agent can see the
> parcel being described. When an agent types a reply, the app sends it to that
> customer through the messaging API. Every outbound message is a person
> answering a person who contacted us first — no broadcasts, no promotional
> sends, no automated marketing on this channel.
>
> Value to the person: a customer who asks about their delivery on Instagram
> gets an answer from a human, in their own language, with their history and
> their parcel already in front of the agent. Without message access there is no
> way to read the inbox into the helpdesk or deliver a reply out of it.

---

## whatsapp_business_messaging

**Answer**

> WhatsApp is the highest-volume support channel ShipBlu has — in Egypt it is
> where customers expect to reach a business — and `whatsapp_business_messaging`
> is the permission the whole channel rests on.
>
> Inbound: the app subscribes to the `messages` field on our WhatsApp Business
> Account. Every customer message, and every delivery/read status for messages
> we sent, arrives at our webhook, is signature-verified, persisted and turned
> into a ticket by a background worker. A customer's messages thread onto one
> live ticket. Media is retrieved through the media endpoints and attached to
> the ticket — customers photograph parcels, waybills and damage constantly, and
> a support conversation without them is guesswork. Shared locations are kept as
> coordinates and rendered as a map pin, because "the courier can't find me" is
> answered by a location, not a paragraph.
>
> Outbound: an agent's reply is delivered to that customer's number. Inside the
> 24-hour customer service window we send free-form text. Outside it we can only
> use a template approved for our WhatsApp Business Account, and the app
> enforces that in the composer rather than discovering it at send time — it
> tracks each conversation's window, tells the agent which state they are in,
> and offers only templates whose parameter count matches. We also use this
> permission to read our approved template list and our business profile.
>
> Value to the person: an answer on WhatsApp about their own parcel, from the
> support team, with everything they have already sent us visible to the agent.
> Delivery statuses mean an agent knows whether their answer actually arrived
> rather than assuming it. Without this permission nothing can be received from
> or sent to a WhatsApp customer, and the channel does not exist.

---

## Human Agent (feature)

**Answer**

> The Human Agent feature is what makes ShipBlu Support viable as a support tool
> on Messenger and Instagram, because the thing it permits — a real person
> answering more than 24 hours after the customer wrote — is the normal case in
> parcel support, not an edge case.
>
> A customer messages our Page at 9pm asking where their delivery is. Answering
> that honestly often means waiting on something outside the support team: the
> courier's next scan, the hub's reply about what happened to the parcel, a
> merchant confirming an address change. Our agents open a side conversation
> with the hub and come back to the customer when there is an actual answer.
> That is frequently the following day, which puts the reply outside the
> standard 24-hour messaging window even though a human being is writing it in
> response to a question the customer asked.
>
> The app is built for exactly the case the feature describes. It tracks each
> Messenger and Instagram thread's window state from the customer's last
> message. Inside 24 hours a reply goes out as `RESPONSE`. Between 24 hours and
> 7 days it goes out tagged `HUMAN_AGENT`, and the console shows the agent how
> long they have left. After 7 days the app refuses to send at all and tells the
> agent why, rather than attempting a send Meta would reject. The tag is applied
> only to messages an authenticated support agent typed and sent by hand — it is
> never used by any automation, auto-responder, template or bulk send. There is
> no code path in this app that can attach `HUMAN_AGENT` to a message a person
> did not write.
>
> Value to the person: they get a real, researched answer to the question they
> asked, instead of either being abandoned or being sent a hollow reply inside
> 24 hours purely to keep a window open. Without this feature every follow-up
> that took a day to establish fails to deliver, which on a support channel is
> most of them.

---

## Business Asset User Profile Access (feature)

**Answer** — for "How will this app use Business Asset User Profile Access?"

> This feature is what puts a customer's name on their support ticket.
>
> When a person messages ShipBlu's Facebook Page or Instagram account, the
> webhook gives us a page-scoped ID and nothing else. The app calls the Graph
> API for that one person's profile — their name, their Instagram username where
> they have one, and their profile picture — the first time they write in, and
> stores it on the contact record their ticket hangs off. We do not request
> `ids_for_business`, and we request nothing at all about people who have not
> messaged us.
>
> Three concrete things depend on it. An agent opening the inbox sees "Mona
> Hassan" rather than "Facebook user 8123729301…", which is the difference
> between a queue you can read and a wall of identifiers. An agent can greet the
> customer by name, which in Arabic support is not a nicety — an unnamed
> greeting reads as automated. And the name is what lets us recognise that the
> person messaging on Instagram is the same person who emailed last week about
> the same parcel: our contact records merge identities across channels, and a
> name is usually the only signal available for a social identity that carries
> no email or phone number. Without it the same customer is three unconnected
> strangers, and each agent starts from zero.
>
> The lookup is best-effort and the ticket is created either way, so a customer
> whose profile we cannot read is still served. Value to the person: they are
> addressed as themselves, and they do not have to re-explain their situation to
> each agent who picks up a channel.

**Answer** — for "Review the policies for Business Asset User Profile Access and
tell us how you intend to use it"

> We have reviewed the Business Asset User Profile Access reference, the Meta
> Platform Terms and the Developer Policies. Our use sits inside the documented
> allowed usage — reading User Fields for people engaging with our own business
> assets, within a business app experience — and we have deliberately scoped it
> narrower than the feature permits.
>
> **Whose data, and which fields.** The only business assets involved are
> ShipBlu's own Facebook Page and Instagram professional account; ShipBlu
> Support is our in-house helpdesk and is not offered to any other business. We
> read a profile only for a person who has sent one of those assets a message,
> and only at the point that message becomes a support ticket. We read their
> name, their Instagram username where they have one, and their profile
> picture. We do not request `ids_for_business`, and we make no profile call for
> anyone who has not contacted us.
>
> **What we use it for.** One purpose: identifying the customer to the support
> agent handling their ticket, so the agent can see who they are talking to,
> address them by name, and recognise them as the same person if they come back
> on another channel about the same parcel. The picture serves that same
> purpose and nothing else — it is the avatar beside their name in the inbox,
> which is how an agent working several conversations at once keeps them apart.
>
> **What we will not do with it.** We do not use this data for advertising,
> targeting, audience building, lookalikes or measurement. We do not sell,
> licence, rent, transfer or otherwise disclose it to any third party, and no
> third party processes it on our behalf for any purpose beyond hosting. We do
> not use it to build any profile of a person beyond the support record their
> tickets hang off, we run no analytics on it, and we hold no aggregated
> derivative that could be re-identified. It is not combined with data from any
> outside source.
>
> **Storage, access and retention.** The name is stored on the contact record in
> our own Postgres database in the EU (eu-central-1), and the picture is copied
> into our own private object store in the same region rather than being
> hot-linked from Meta's CDN — served to agents through short-lived signed URLs.
> Both are reachable only by authenticated ShipBlu support agents through a
> role-based permission system; the console is not public and there is no
> external API that exposes either. Raw webhook payloads, which contain the
> original Meta identifiers, are deleted automatically 30 days after
> processing. We retain the name for as long as the
> person is an active support contact, and we delete a person's stored profile
> data on request.

---

## pages_user_locale

**Answer**

> ShipBlu serves an Arabic-first customer base in Egypt, and a meaningful
> minority of merchants prefer English. `pages_user_locale` is how the app
> learns which, for a person who reaches us on Messenger, so that everything we
> send them is in the language they actually read.
>
> Our contact records carry a `locale` field that drives outbound language
> choices across the product: which language a CSAT survey is sent in after a
> ticket is resolved, which language an out-of-hours automatic acknowledgement
> uses, and which of the two versions of a knowledge base article an agent is
> offered when they want to send the customer a how-to link. For customers who
> reach us on Messenger, the locale on the Page-connected profile is the only
> reliable signal we have — a page-scoped ID carries no other hint of language,
> and the alternative in use today is guessing from the script of whatever the
> customer last typed, which fails on a one-word message, on transliterated
> Arabic written in Latin letters (extremely common here), and on the first
> contact before they have typed anything substantial.
>
> The app reads the locale once, at the point a Messenger conversation becomes a
> ticket, stores it against that contact, and uses it only to choose the
> language and the date and number formatting of what we send that same person.
> It is not used for targeting, segmentation, advertising or analytics.
>
> Value to the person: they are answered, surveyed and acknowledged in their own
> language. The failure this fixes is real and currently live in our system —
> every contact sits at the default, so an Arabic-speaking customer receives an
> English satisfaction survey after an Arabic conversation, which reads as
> though nobody was paying attention.

---

## pages_user_gender

> ⚠️ **Do not paste this yet.** Nothing in the codebase reads or stores gender
> today, so a reviewer watching the screencast will not see this behaviour. See
> [Before you submit](#before-you-submit) — either drop this permission from the
> submission, or build the Arabic gendered-language support described below
> first. The answer assumes it is built.

**Answer**

> Arabic is the language most of ShipBlu's customers are served in, and Arabic
> grammar is gendered in a way English is not. Verbs, adjectives and the second
> person all inflect: "your parcel has been delivered" is
> «تم تسليم شحنتك» either way, but "did you receive it?" is «هل استلمتها؟» to a
> man and «هل استلمتيها؟» to a woman, and a greeting is either «أهلاً بك» or
> «أهلاً بكِ». There is no neutral form in ordinary use. Every automatic message
> ShipBlu Support sends in Arabic — the out-of-hours acknowledgement, the
> satisfaction survey after a ticket is resolved, the notification that a ticket
> has been updated — must therefore pick a form, and picking the wrong one is
> conspicuous to a native reader in the way a misspelled name is.
>
> The app reads the gender field on the Page-connected profile once, when a
> Messenger conversation first becomes a support ticket, stores it on that
> contact record alongside their language, and uses it for exactly one purpose:
> selecting the correctly inflected Arabic wording in messages we send to that
> same person. Where it is absent or unspecified, the app falls back to the
> impersonal phrasings our templates carry for that case — which work, but read
> as stiff and institutional, which is precisely the tone a support channel
> should avoid.
>
> It is never used for targeting, segmentation, advertising, analytics,
> reporting or routing, and it is not displayed to agents as a profile
> attribute. Value to the person: automated messages in their own language that
> are addressed to them correctly, rather than in a register that signals a
> machine wrote it without knowing who it was writing to.

---

## whatsapp_business_manage_events

> ⚠️ **Do not paste this.** This permission covers logging conversion events to
> Meta for ads targeting, optimisation and reporting. ShipBlu Support is a
> helpdesk: it runs no ads, logs no conversion events, and contains no code that
> would. There is no honest answer to write here. Remove it from the submission
> unless ShipBlu's marketing team is adding click-to-WhatsApp ad attribution, in
> which case it belongs in that submission, described by whoever builds it. See
> [Before you submit](#before-you-submit).

---

## public_profile

**Answer**

> `public_profile` is the base permission behind the Facebook Login for Business
> flow that a ShipBlu administrator uses to connect our own business assets to
> this app.
>
> The people who go through that flow are ShipBlu staff with admin rights on our
> Facebook Page, our Instagram professional account and our WhatsApp Business
> Account — not our customers. When one of them connects or reconnects an asset
> (a token rotation, a newly added WhatsApp number, an Instagram account being
> relinked), the app reads their name and ID from the default public profile
> fields so that the connection screen can confirm which Facebook account is
> being used and record who authorised it. That last part matters
> operationally: our access tokens are long-lived credentials with reach over
> the company's public channels, and "which administrator granted this, and
> when" is the first question asked whenever a token needs rotating or revoking.
>
> The app does not read the public profile of customers through this permission,
> does not build an audience or profile from it, and does not use it for
> advertising or analytics of any kind.
>
> Value to the person: an administrator can see at a glance that they authorised
> the connection with the right Facebook account — easy to get wrong when
> someone is signed into a personal account and a work account in the same
> browser — and the team can later tell who to ask about a credential rather
> than guessing.

---

## email

**Answer**

> `email` is requested for the same administrator flow as `public_profile`, and
> for the same small set of people: ShipBlu staff who connect our own Facebook
> Page, Instagram account and WhatsApp Business Account to this app through
> Facebook Login for Business.
>
> The app reads the email address on the authorising Facebook account and stores
> it against the connection record, for two operational reasons. First,
> identification: it is how we match the person who authorised a connection to a
> real colleague and their account in our own agent directory, so that a
> connection cannot be attributed to an ambiguous display name. Second,
> notification: access tokens expire, get revoked, or start failing, and when
> that happens the Facebook, Instagram or WhatsApp channel stops delivering
> customer messages. The app watches for that failure and needs to be able to
> tell the specific administrator whose authorisation lapsed, so they can
> reconnect it. Without a contact address the alternative is that a support
> channel goes silent and the team discovers it from the complaints.
>
> The address is used for those two purposes only. It is not used for marketing,
> is never shared with a third party, and the app does not read the email
> address of any customer through this permission — customers reach us on
> Messenger, Instagram and WhatsApp, and nothing in that path touches it.
>
> Value to the person: the administrator is told directly when a connection they
> own needs their attention, instead of a customer-facing channel failing
> quietly.

---

## Before you submit

### Two requested items the code does not back

Meta reviews the screencast against the description. A permission whose
described behaviour is not visible in the recording is the most common cause of
rejection, and a rejection on one item delays the whole submission.

| Item                              | The problem                                                                                                                                                                                                     | Options                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_business_manage_events` | It covers logging conversion events to Meta **for ads targeting, optimisation and reporting**. This is a helpdesk. There is no ad account in the loop, no conversion event, and no code that could produce one. | **Drop it.** It belongs to a marketing submission, if ShipBlu ever runs click-to-WhatsApp ads. Nothing in the support product is blocked by not having it.                                                                                                                                                    |
| `pages_user_gender`               | Nothing in the codebase reads, stores or displays gender. `contacts` has no column for it.                                                                                                                      | Either drop it, or build it first. The Arabic-inflection case is genuinely strong and it is a small change — a nullable `gender` column on `contacts`, written by the same profile lookup that already writes the name, read by the Arabic message templates. Then the answer above is true and demonstrable. |

Dropping a permission now costs nothing: it can be requested in a later
submission once the feature exists, and a smaller submission that passes beats a
larger one that comes back.

### Built, on `main`, by another session

**Business Asset User Profile Access** — this was written up here as unbacked,
and it was, but the fix landed independently while this document was being
prepared: PRs #82 and #85, `Actually call Meta's User Profile API, and put the
name on the contact` and `Fix the profile lookup's recovery paths and bound its
downloads`. What is on `main` is more thorough than what this document first
described, and the answers above have been rewritten to match it rather than the
other way round.

How it actually works, for whoever records the screencast:

- The lookup is a **queued job**, `fetch_meta_profile`, not an inline call on the
  ingest path. `ingestMetaMessage` asks `needsChannelProfile()` and enqueues; the
  job's own retry and dead-letter handling applies, and a slow or refusing Graph
  cannot delay a ticket being created.
- Whether to ask is gated on `contact_identities.profile_fetched_at` rather than
  on the contact being new, so a customer whose profile failed the first time is
  asked again and one already on file is not re-read.
- `fetchProfile` **throws** rather than swallowing failures, so
  `lib/meta/errors.ts` can separate "this app is not approved for the feature" —
  a dashboard problem affecting every customer — from "this person has no name to
  give", which is normal and final. This is the distinction the earlier
  swallow-everything version could not make.
- It fetches the **profile picture** as well as the name, and copies it into our
  own bucket rather than storing Meta's URL. Both BAUPA answers above have been
  corrected accordingly — the earlier drafts said we do not request the picture,
  which would have been a false statement to Meta.
- Existing contacts **are** backfilled: `npm run job -- backfill_meta_profiles`
  enqueues one job per contact through the same handler the live path uses.

One consequence for the recording is unchanged: use a Facebook customer whose
profile has **never been fetched**, since an identity already stamped
`profile_fetched_at` is skipped. A brand-new test account is the simplest way to
guarantee that.

### Dropped from this submission

**`user_messenger_contact`** — decided 2026-08-26, and recorded here because the
reasoning is not obvious from the permission's name and will otherwise be
re-litigated.

It covers a Page sending someone a **first** message — Meta's wording is
"contact a person via Messenger upon their approval," for "an initial message,
post-purchase updates and account updates." Nothing in this app can do that.
Every Meta send needs a `conversationId` that exists only because a customer
messaged us first: the two enqueue sites are `app/(console)/actions.ts` (an
agent hitting send on a ticket) and `lib/tickets/outbound.ts`, whose only
automated callers — `lib/auto-response` and `lib/automations` — also fire inside
a customer-initiated ticket. `send-meta.ts` handles three kinds, `dm`,
`comment_reply` and `private_reply`, and all three are replies.

So there was no screencast to record: a reviewer watching for a message arriving
in a thread the person did not open would not find one, and a persuasive answer
to something the recording cannot show risks the honest permissions sitting in
the same submission.

Requesting it later costs nothing. What it would take first: an opt-in captured
at the moment a recipient chooses Messenger for updates about a specific parcel,
a sender for the handful of events that actually matter to them (out for
delivery, attempt failed, window changed, ready for collection), and an
unsubscribe reachable from inside the conversation rather than from a settings
page. The first of those cannot live in this repo — the tracking and
post-purchase surfaces belong to the shipping platform, and this app only reads
shipment data (§5.4 of `docs/PROJECT-STATE.md` notes even that read API is
designed rather than built). It is a cross-team build, not an afternoon, and the
recording has to be planned around it rather than the other way round.

### Four permissions the built features need, and the list omits

The app already replies publicly to Facebook and Instagram comments and creates
tickets from them — `replyToComment`, `privateReplyToComment`, the `feed`
webhook field, and a comment threading model that gives each post's reply chain
its own ticket. Those calls need permissions that are not in this list, and
without them the comment half of the social channels fails after approval:

- **`pages_manage_engagement`** — publishing our reply under a customer's
  comment on a Page post. This is the whole public-comment workflow.
- **`pages_read_engagement`** — reading the Page's own posts and comment
  content, which is what a comment ticket is built from.
- **`instagram_manage_comments`** — the same for Instagram comments, and note
  that it gates the **private reply** too, not only hide and delete. The
  composer has offered private replies since the channel landed, so this is not
  optional for a comment ticket even if nobody ever hides anything.
- **`instagram_basic`** — reading the Instagram professional account's own
  metadata; effectively a prerequisite for the Instagram permissions above.

The Instagram pair here follows the same rule as the messaging pair: apply for
`instagram_manage_comments` on a Page-connected account and
`instagram_business_manage_comments` on Instagram Login, **never both**.
`plans/instagram-comment-management.md` works this through in full and is the
reference — it is where the reasoning lives, not here.

That plan also settles the access level, which is worth knowing before somebody
argues for Standard Access on single-tenant grounds: Standard Access only covers
app users holding a role on the app, and this is a support inbox whose entire
traffic is members of the public who hold none. An Instagram private reply needs
Advanced Access, the Human Agent feature and business verification regardless —
so all of it belongs in this one submission rather than being deferred.

If the plan is deliberately to launch with DMs only and add comments later, that
is a reasonable call — but then also confirm the app is not subscribed to the
`feed` webhook field on launch, so no comment ticket is created that no agent
can answer.

Two more to check against how the admin connection flow is actually built:
**`pages_show_list`** (offering an administrator the list of Pages they manage)
and **`business_management`** (reading assets through Business Manager). The
current build reads its Page ID and token from configuration rather than from a
picker, so neither is needed today; both become necessary the moment a
connect-your-Page screen exists.

### Screencast checklist

The recording has to show a reviewer the described behaviour on real screens.
For each channel, one continuous take covering:

1. A customer sending a message to the Page / Instagram account / WhatsApp
   number from a real account.
2. That message appearing in the agent console as a ticket — showing the
   customer's **real name** on it, which is what evidences Business Asset User
   Profile Access, along with their picture as the avatar beside it. Record a
   Facebook DM specifically, not just Instagram: Instagram's webhook supplies a
   username on its own, so an Instagram-only take does not evidence the feature.
   It must also be someone whose profile has **never been fetched** — the lookup
   is gated on `contact_identities.profile_fetched_at`, so an identity already
   stamped is skipped and shows whatever name it was filed under. A brand-new
   test account is the simplest way to guarantee that. The lookup is a queued
   job, so allow a beat for it to land rather than cutting the moment the ticket
   appears.
3. An agent typing and sending a reply, and the customer's device receiving it.
4. For **Human Agent**: a thread whose last customer message is more than 24
   hours old, showing the console's own window indicator and a reply going out
   and arriving. This one needs a conversation set up a day in advance —
   arrange it before the recording session, not during it.
5. For **`pages_manage_metadata`**: the webhook subscription screen or the
   subscription job's output, showing the field list being read and written.
6. For **`public_profile`** / **`email`**: an administrator going through the
   Facebook Login for Business flow and the connection screen showing the
   authorising account.

### One gap behind the deletion commitment

The Business Asset User Profile Access policy answer commits to deleting a
person's stored profile data on request. That commitment is honest but it is
currently a manual database operation: `contact.delete` exists in `PERMISSIONS`
in `lib/auth/permissions.ts` and is **enforced nowhere**, so no screen deletes a
contact. (The `delete(contacts)` in `lib/tickets/contacts.ts` is race cleanup for
two webhooks creating the same contact at once, not a deletion feature.) Fine to
submit — the commitment is about what we will do, not about which button does it
— but somebody has to be able to actually carry it out, so either build the
screen or write down the runbook.

### One thing to check in the Meta dashboard first

Our Human Agent tag has never been confirmed as approved for this app. On
2026-08-20 a Facebook reply sent outside the 24-hour window failed eight times
and died in the job queue, with Graph reporting only "An unknown error has
occurred." — a real customer reply that was never delivered. The missing Human
Agent approval is the leading hypothesis and has never been verified against the
App Review status page. Check it before the channels go live, since if it is
unapproved then most FB/IG replies fail, and that is the same submission this
document is preparing.
