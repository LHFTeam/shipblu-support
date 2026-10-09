# ShipBlu Support — working brief

For an agent joining this build. The README explains what the system is and how
it is designed; **this file is about the state of the work** — what is live,
what is merely built, what is left, and the mistakes that have already cost us
time. Read both. Do not re-derive settled decisions.

Last updated: 2026-09-21, against `main` at `d5d791f`. The figures in §1 and §5
were re-measured against production on 2026-09-20; where a number here disagrees
with an older paragraph elsewhere in the file, the older one has not been
re-checked.

**Production runs `d5d791f`, deployed 2026-09-21 13:17–13:22 UTC** — the six
unsuspended services, web first for the migration. It served `510024c` for the
thirteen hours before that and `b1d911a` for eleven days before _that_, while
`main` ran ahead of it, which is the trap rather than the footnote: `autoDeploy`
is `no` on every production service (§2), so a merge changes nothing that is
running, and the gap is invisible because CI is green and the old code keeps
serving. Check `/api/health`, which reports the commit, before concluding any
change below is live.

---

## 1. Status in one paragraph

Every phase of the original plan except migration importers is **built and
merged**: email ticketing, WhatsApp, Facebook and Instagram, the agent console,
the bilingual knowledge base with its Freshdesk importer, the chat widget, SLA
policies, automation rules, CSAT and reporting, and a live dashboard for admins
at `/admin/dashboard`. Since then the **customer portal** has landed too — the
bare domain now opens the Arabic help centre, and one Sign in button
authenticates customers and agents alike.

Since then, **shipments**: tickets link to parcels and to shipping accounts,
tracking numbers and SBIDs are detected in message text as it arrives, the inbox
searches on both, and the console finally has contact, account and shipment
pages — the first screens ever to use the `contact.view` and `contact.edit`
permissions, which had been in the list and checked nowhere since the start.

And since **that**: **contact merging** and a **register of ShipBlu's
locations**. The console section is now `/contacts` rather than `/customers`,
matching the table name it has always had. A duplicate is folded into the record
an agent is looking at — identities, tickets, messages, account memberships and
parcel roles move, and the loser stays as a tombstone that redirects — behind a
new `contact.merge` permission held by supervisors and above. `locations` holds a
name, a unique code and a shared mailbox per hub, joined to nothing on purpose;
see `plans/contact-merge-and-locations.md` for why, and §5.1 for the rows
entered on 2026-10-05.

And then **side conversations**: an agent can open a thread with a hub, an
internal team or a vendor from inside a ticket, and the answer comes back onto the
ticket rather than into their personal mailbox — never onto the customer's timeline.
This is the first thing to join `locations` to anything: the picker's hubs are
its rows, which is what that table was entered for. Teams and vendors are not
locations, so they keep their own small directory at `/admin/recipients`. Built
and verified end to end against a local Postgres. Both directories now have rows
— three teams, and the hubs entered on 2026-10-05 — so the picker lists the hubs
first, and opens on _Choose…_ rather than on any of them. No thread has yet gone
to a real hub list; see §5.1 and §5.2.

And **shared locations**: a pin a customer drops is kept as coordinates rather
than flattened into prose and rendered as a card with a Maps link. **Every pin in
the archive is now readable** — the backfill ran on 2026-08-21 and recovered all
821, so all 845 open on a map. This is the first feature in the system whose case
was made entirely from production data rather than from the plan; §6.17 is the
trap found while measuring it, and §6.20 the one found while running it.

The **help centre's UI was then rebuilt on the portal's design**, so the two
halves a signed-in customer moves between stop looking like different products.

And now **ticket assignment**. Until this landed a ticket reached a group and
stopped there; a person only ever got one by picking it out of a dropdown. Each
group can now hand its tickets out by round robin or by load, optionally filtered
by skills, gated on its own business hours, with per-agent caps, opt-in
reclaiming from agents who have gone offline, and escalation of anything nobody
picks up. Three pieces of scaffolding that had been in the schema doing nothing
since the first migration are finally read: `groups.escalate_to_agent_id` /
`escalate_after_mins`, `group_members` as an actual constraint rather than a
roster to draw, and `agents.presence`, which the dashboard has rendered from day
one and **nothing had ever written** — so every agent read `offline` forever. It
is written now, by the console's lightweight presence stream and by nothing
else. Conversation invalidations use a separate inbox-only stream, so ticket
traffic cannot make presence expensive. Every group ships on `manual`, so none
of it changes behaviour until somebody opts a team in.

And now **agent productivity reporting**, at `/reports/agents` behind a new
`report.agents` permission. It answers punctuality, availability, speed and
efficacy per agent per day: first and last connection, time at the desk,
available time, adherence to their group's calendar, tickets assigned and
resolved, backlog at day end, measured handling time, occupancy, and the reopen
rate that keeps the speed columns honest.

Most of that **could not be answered before, because nothing recorded it**.
`agents.presence`, `last_seen_at` and `is_accepting_tickets` are current-state
columns with no history; `sessions` rows are deleted on logout. So this change is
mostly three new append-only capture tables — `agent_presence_intervals` written
by the presence stream's existing single writer, `agent_focus_intervals` written
by a new beat from the ticket page, and `agent_backlog_snapshots` sampled hourly
— plus `agent_metrics_daily`, rebuilt nightly by the same `rollup_metrics` job
that already owns `metrics_daily`. **The report is empty until the capture has
run for a day**, and on this database it will stay near-empty until humans work
tickets: see the paragraph below.

The focus beat also finally writes `conversation_presence`, which has existed
since the first migration for collision detection and which **nothing had ever
written** — the same shape of dead scaffolding `agents.presence` was before
assignment landed. It is worth grepping for others.

And now **custom ticket fields carry values**, which is one of those others found
by doing exactly that. An admin has been able to define a field since the first
migration, `ticketFieldOptions()` has offered it to the condition builder as
`custom.<key>`, and `lib/rules/facts.ts` has read `conversations.custom_fields`
to answer it — but **nothing had ever written that column**, so every rule
written against a custom field matched nothing and said so to nobody. Two forms
write it now: the conversation sidebar, and the portal's new-ticket form for the
fields an admin marks visible and editable by customers. The two required flags
were the same shape of dead scaffolding and are enforced as of this change. See
§5.5 for the three decisions behind it, and §6.21 for the bundle trap found while
building it.

And now the **out-of-hours reply**: when a customer writes in and their group is
outside its calendar, the helpdesk answers once, on its own initiative, for the
first time. Configured at `/admin/auto-responses` by group, by channel or by
both — the most specific rule wins, a channel beats a group — with an optional
holiday body that `{{holiday}}` fills in from the calendar. The hours are not a
new setting: it is `groupHours()` from `lib/hours/resolve.ts`, the same calendar
every SLA due date is counted against, so nothing has been added that could
disagree with the clock. See `plans/out-of-hours-auto-response.md`.

Two things in it are worth knowing before reading the code. It is **deliberately
not a first response** — like every automated reply, it does not stop the SLA
clock or move `lastAgentMessageAt`; only an agent's reply does. Otherwise a rule
acknowledging every ticket would measure itself and satisfy the team's target,
and this one would report zero minutes on every ticket arriving overnight. What
it does stamp is `conversations.first_auto_replied_at`, surfaced to rules as
`hours_since_auto_reply` and read by no report or sweep.

The re-send it exists around is worth understanding, because the first fix for
it was wrong in a way that was invisible. A time-based rule is re-evaluated
every fifteen minutes and nothing in the engine remembers it ran, so a rule
whose condition only a person can clear — `is_first_response_overdue`, the
obvious way to write a chase — sends the same message four times an hour until
somebody opens the ticket. Making that fact read the auto-reply stamp stopped
the loop and also silenced every _other_ rule sharing the condition: an
escalation that sets a priority, assigns somebody or adds a watcher sends the
customer nothing and never needed stopping, but stopped firing on every
auto-acknowledged ticket, while the sweep went on recording the breach nobody
was now told about. The guard belongs to the sender, and lives in
`alreadyReplied` in `lib/automations/index.ts`: the same rule does not reply to
the same ticket twice until the customer has written since. Keyed on the rule's
own name, so an acknowledgement on create and a chase three days later do not
silence each other. It sends **once per
closed stretch**, not per message: `conversations.auto_responded_at` is claimed
with a conditional update, so the six ingest jobs six WhatsApp messages at 23:00
produce still yield one reply. The case for it is in the archive — **11,402 of
18,417 bot-channel inbound messages arrived outside production's schedule**, Sun–Fri
10:00–18:00 Cairo.

And now the **help centre's front page, a public tracking page, and the ShipBlu
design system's palette**. The front page was one blue band with a search box on
it; it is now a hero carrying the two questions people actually arrive with — a
phrase to search, and a parcel to find — over topic cards that show three article
titles each, a most-read and a recently-updated list, and a contact panel that
says whether support is answering right now (read from `widgetHours()`, so it
cannot disagree with the chat launcher beside it). Every block reads from the
knowledge base and hides itself when there is nothing in it. `/{locale}/track` is
new: a tracking number in, a status badge, a four-step progress line and the
knowledge-base answers for that status out. `noindex` and `Disallow`, and rate
limited per address, because every useful URL on it carries somebody's parcel
number.

**"Ask support about this shipment" opens the chat, not a sign-in wall.** The
button led to `/{locale}/forms`, which redirects to `/portal/new` when no ticket
form exists — and that calls `requireCustomer`. Production has **zero**
`ticket_forms` rows (measured 2026-09-03), so every press by the people this
page is written for — recipients, who have no ShipBlu account — ended at a login
screen. It now calls a new `shipbluChat.compose(text)` on the embed snippet,
which opens the widget with the parcel already in the composer and waits for the
visitor to write their question: the chat mints a visitor token at the moment
somebody chooses to talk, so it needs no account. The draft is built by
`lib/shipments/support.ts` from the number and the status **as the badge already
worded it** — never from `shipments.data`, so it cannot say more than the page
said — and `lib/shipments/detect.ts` reads the number back out when the message
is stored, linking the conversation to the shipment without an agent retyping
it. The `/forms` link survives as the `href`: it is where the button goes with
no JavaScript or a blocked snippet, and it is the right destination once an
admin builds a form.

**`.kb-shell` no longer carries the Freshdesk portal's hex.** It carries the
design system's `tokens/colors.css`, so the swap reaches every page under
`app/help/` rather than only the two the redesign covered — charcoal text on cool
neutrals, blu-500 as the one action colour, and the system's canonical logistics
status taxonomy behind the tracking badge, which is what gives "out for delivery"
violet of its own instead of sharing blue with "in transit". Typography did not
come across: the system substitutes Geist and Rubik and says so, while Lato and
Tajawal are the live portal's and the ones customers already read. Nor did radii,
spacing or its component bundle. Four of the six page types still wear the solid
blue band the system would not have given them — moving them is a change to their
layout rather than their colours, and it is the obvious next piece of work.

A **service notice** banner sits above the content on every help centre page,
from `KB_NOTICE_EN` / `KB_NOTICE_AR` / `KB_NOTICE_HREF` / `KB_NOTICE_TONE`. The
banner is built and its backing store is not: an environment variable is the
cheapest seam that still lets ops put a delay warning in front of every customer
without a deploy, and `lib/kb/notice.ts` is the one file a `service_notices`
table would change. Unset is no banner, deliberately — an operational claim about
the network has to be one somebody actually made. A notice written in only one
language is shown to everyone with its own `lang` and `dir` rather than withheld,
because the silent failure is an Arabic reader, who is the majority here, getting
no warning at all.

**The platform sync now exists, so the tracking page can answer.**
`plans/shipment-customer-tracking.md` §7 designed this seam and left it unbuilt,
and its absence was why nothing in this system had ever written
`shipments.status_label`. `lib/shipments/platform.ts` reads
`GET /api/v1/delivery-order/<number>/` off `api.shipblu.com`,
`lib/shipments/sync.ts` writes the label, its instant, `sync_state` and the whole
response into `data`, and the `sync_shipment` job carries it. The page needed no
change of its own, exactly as it was written to.

Both ends are wired to it now. The public page reads through
`lib/shipments/lookup.ts` — refreshing a parcel this system knows about, reading
an unknown number straight from the platform without storing anything — and draws
the real event history, newest first, with the estimated date while it is still a
prediction. In the console, an agent who types a tracking number gets one
`sync_shipment` queued for it automatically (`upsertShipmentStub` enqueues on
creation, so a customer repeating their number eleven times still costs one
lookup), and a **Fetch latest** control on both the ticket sidebar and the
shipment page calls the platform in the action and waits — the same press-and-wait
exception `refreshRequesterProfile` uses, over the same `syncShipment` the job
runs. Both controls show when the parcel was last read, because a status with no
date beside it invites an agent to repeat it to a customer as current.

What separates the two audiences is `lib/shipments/detail.ts`: `publicTracking()`
and `agentTracking()` are the only readers of `shipments.data`, and each builds a
fresh object from a named field list. Verified against the live payload for
1755021358719 — none of the ten real personal values in it reach the public
shape, and all of them reach the agent one.

One thing still gates it end to end, and it is not in the page: **nothing
schedules the sweep.** `sync_stale_shipments` is registered and runnable by hand
(`npm run job -- sync_stale_shipments`) but has no cron entry in `render.yaml`,
because how often a moving parcel should be re-read is a question about the
platform's rate limits that nobody has answered. Detection itself is no longer
the blocker — the default pattern now matches the real thirteen-digit format —
so the stubs will arrive; until the sweep is scheduled or a sync is triggered by
hand, a lookup still lands on "no delivery status for this number yet". Two things were deliberately left out of it against the
design that prompted the work: the recipient's name, address, phone and COD
amount behind a "confirm the last four digits" gate — a four-digit gate on a page
anyone can reload is a few thousand guesses, and the phone number it checks
against is the thing being protected — and a WhatsApp contact card, because no
public ShipBlu number exists anywhere in this codebase or its configuration and a
support channel printed on a help centre has to be one that answers.

**The tracking page now answers in the language it is being read in.** It drew
the platform's English status — `Out for delivery` — in the middle of an Arabic
page, on the one line the page exists for, for readers who are Egyptian parcel
recipients rather than merchants with a platform login. `lib/shipments/status.ts`
holds one vocabulary table now: each row carries the stage, the Arabic wording
and the keywords that recognise it, so a keyword can no longer be added without a
translation. `/en/track` is unchanged and the console is unchanged — an agent and
the ops team still read the platform's own word. A label no row matched is still
shown verbatim in both languages, because nothing established what it says.

The event history is worded the same way, and so is **the reason under it**.
Production writes a tracking comment as an English reason code, a dash, and
whatever the courier typed in Arabic — `Customer refused to accept the shipment -
الاوردر ناقص`. Only the first half is ours: the second is one person's account of
one parcel, and translating free text is how a page starts inventing facts. So
`commentText` translates the reason code and leaves the note exactly as typed,
and a reason code no row matched shows verbatim, dash and all.

**The Arabic wording is admin-editable, because it is not ours to be certain
about.** Whether a failed attempt reads as `محاولة تسليم غير ناجحة` is a question
about what ShipBlu's own SMS says to the same customer about the same parcel, and
getting it wrong recreates the disagreement that kept the page in English.
`/admin/tracking` (permission `admin.fields`) edits every phrase;
`shipment_phrases` stores **overrides only**, so the table is empty on the day it
ships, clearing a box deletes the row and restores the default, and adding a
phrase in code stays a deploy rather than a data migration. The read path keeps
`lib/shipments/status.ts` pure — the page loads the overrides and passes them in
— because that module is imported by the worker and tested with no database.

Reading `data->'tracking_events'` across production to check that table turned up
**two statuses the platform emits that nobody had listed**: `delivery_attempted`
and `return_to_origin`. Both were already covered by keyword; the lesson is the
method, not the miss — the eight known statuses came off one real delivery order,
and one parcel does not show a vocabulary. The same read is what turned up the
comment format above; nobody had looked at that field at all.

And now **Instagram comment management**, which is the App Review item
`instagram_business_manage_comments` and which turned out to rest on four things
that were all broken at once. The comment pipeline had never run: of 2,854 Meta
deliveries stored since 19 August, **not one carries a `changes` entry**, because
`comments` is not a subscribed field on the `instagram` object — so
`ingestMetaComment`, merged with the channel in phase 2, has never been called in
production and `conversations` holds zero comment threads. Every comment call was
Facebook-shaped on both platforms, so no Instagram comment reply this system sent
could ever have been delivered. The console could not hide or delete a comment at
all — `hideComment` had sat unimported since the channel landed, and there was no
delete — which is to say the two verbs the permission is named for were the two
the product did not have. And Instagram's webhooks had stopped verifying that
morning; see §6.22, which is the one to read first. `subscribe_meta_webhooks`
now takes an object (`object=instagram` adds `comments`, `object=page` adds
`feed`) and still merges rather than replaces, an agent with the new
`ticket.moderate_comment` permission gets Hide / Unhide / Delete under a
customer's comment, and `plans/instagram-comment-management.md` carries the
order of operations — none of which is code, and the code is inert without it.

And now **the knowledge base inside the composer**. Until this, `searchArticles`
had three callers and every one was customer-facing — the help centre, the
widget, the tracking page — so the one person who reads articles for a living
had no way to reach one without leaving the ticket. The reply tab now carries a
Knowledge panel under the textarea, beside the canned picker: up to three
articles suggested from the ticket before the agent types, a debounced search
over the same tsvector-plus-trigram ranking the help centre uses, each hit
readable as plain text in place, and a one-click insert of its title and public
URL at the caret through the same `insertCanned` the canned responses use.

It is under the composer rather than in the sidebar on purpose. Every helpdesk
worth copying puts knowledge where the agent's hands already are — Zendesk in
the context panel, Help Scout behind `/`, Intercom behind ⌘K — and the sidebar
here is `hidden … xl:block`, so on a laptop under 1280px and on every phone the
panel would simply not exist. `composer.tsx` had already named this shape as the
successor to the canned `<select>`: "if the list ever grows past what a dropdown
can carry, the folder grouping below is already the shape a search would filter".
112 articles is that point. It is expanded in place, so the no-modals rule holds.

**A folder's visibility overrides its articles', and the link gate had to be
built on that rather than on the article row.** Every one of the 112 articles
carries `visibility = 'public'`; four of them sit in folders marked
`agents_only` — working hours, and one per internal team — and are invisible on
the public help centre because `folderVisibleTo` gates them. Reading the article
row alone would have offered a one-click link to a page that 404s for every
customer, which is precisely the hole the required-`KbViewer` design exists to
close. The effective level is computed in SQL over both columns
(`effectiveVisibility` in `lib/kb/agent-search.ts`) and decides the control:
insert freely for `public`, insert with a warning for `logged_in`, read-only for
`agents_only` and for `selected_companies`, which is servable in principle and
matches nobody today. Those four internal articles are empty Freshdesk
placeholders right now, so the gate currently guards nothing worth sending —
which is the wrong way round to read it. The first sentence somebody writes into
the working-hours article is the one that must not become a customer link.

Three smaller decisions worth knowing. The agent search is a **third** read
model, `lib/kb/agent-search.ts`, beside the viewer-gated `queries.ts` and the
authoring `admin.ts` — an agent may read anything published and link only what
the recipient can open, and folding that into either of the others would have
put an agent branch inside the rule that keeps internal content out of Google.
Suggestions are a **disjunction**, not a phrase: `websearch_to_tsquery` ANDs its
terms, so handing it a whole customer message returns nothing, and `lib/kb/seed.ts`
reduces the message to at most six content words joined with `OR` — dropping any
token carrying a digit, because a tracking number is the most-repeated string in
these tickets and matches no article ever written. And the endpoint is
`/api/knowledge`, deliberately **not** under `/api/kb`, which `proxy.ts` lists in
`PUBLIC_PREFIXES`; it authorises itself with `kb.view`, which is already on the
agent role baseline.

Measured before it was built, and the figures are why bodies travel with the
search results rather than behind a second fetch: mean body 995 characters, p95
2,830, longest 3,904, so three suggestions is about 3KB on a page that already
carries an entire message timeline. Two articles have no body text at all — the
Arabic and English packaging guides are images and nothing else — and the panel
says so rather than showing an empty box. Those images are still hot-linked from
`s3.amazonaws.com/cdn.freshdesk.com` and will die with the Freshdesk account.

And now **the widget knows who it is talking to, and opens with answers rather
than a blank box.** Both were found by the same question: what does a merchant
see when the dashboard stops loading Freshchat. The old snippet handed the
widget a signed-in merchant's name, address, phone and account, and ours took
none of it, so every chat would have opened anonymously — `shipbluChatSettings`
and `shipbluChat.identify()` now carry it, `docs/embedding-the-widget.md` is the
contract, and what arrives unsigned decorates the contact without ever claiming
an account (see §"Security" and `lib/widget/identity.ts`). And the widget's only
knowledge-base surface was a suggestion strip that appears after six typed
characters, which meant it opened onto "Ask us anything" and nothing else. The
opening screen now offers the five most-read articles in the visitor's locale
through the same `popularArticles()` the help centre's front page uses — server
rendered with the frame, so they are on screen when it paints, gone the moment
there is a conversation, and empty is a normal state that hides the section.

And now **ticket categorisation**, which answers the first question anybody asks
of a helpdesk and which this one could not answer at all: what are customers
contacting us about, and why does it keep happening. Both dimensions existed and
were empty — `conversations.tags` was `{}` on all 13,748 rows and
`conversations.type` was null on every one of them, the same dead scaffolding
`agents.presence` and `custom_fields` were before something finally wrote to
them. A ticket now carries a **topic**, detected from the customer's own words as
the message lands, and a **cause**, which an agent records when they close.

The two are separate on purpose and it is the load-bearing decision.
"Where is my order" is one sentence with at least six causes behind it — the
pickup never happened, the hub mis-sorted it, the merchant gave a wrong address,
the courier never called, the zone is unserviced, or the parcel is not late and
the expectation is wrong. Inferring a cause from complaint text would
manufacture confident, wrong data in the exact place the team is trying to reason
from, so the detector names the **symptom** and the agent names the **cause**,
having actually looked. Accountability is then derived rather than typed:
`ticket_root_causes.owner` maps each cause to exactly one party, so an agent
fills one field and the report gets two dimensions that cannot disagree.

12 areas, 55 categories, 27 causes, bilingual, aligned to the parcel states in
`lib/shipments/status.ts` so a report can ask what the parcel was really doing.
The detector is rules only — inspectable, free, deterministic, and turn-off-able
by name in `CATEGORISE_DISABLED_RULES` while somebody fixes one. Two thresholds:
above 0.90 it applies — a whole message that reads as a known phrase, or two
anchored patterns agreeing — down to 0.35 it suggests into
`/admin/categories/review`, below that nothing is written. A pile of single
keywords caps below the auto line however many of them agree. Confidence is an evidence grade and not a
probability, and the console says so where the number appears.
`/reports/categories` reads the new `category_metrics_daily` and
`root_cause_metrics_daily`, both folded into the existing `rollup_metrics`
transaction. See `plans/ticket-categorisation.md`.

**It was tuned against the real corpus rather than against imagination**, and
that is the part worth copying. 769 free-text messages, 59.6% → **85.3%
classified**, and four gaps that no amount of design would have produced:
Franco-Arab (Arabic in Latin script, a whole register of customer writing),
ordinary English sentences, pasted addresses and dropped pins, and `شحنه ايه` —
frequent enough to earn a category of its own. `تمام` alone, 61 occurrences, is
the single most common free-text message in the archive. The precision pass then
made three rules _less_ eager, the important one being that "I did not receive
it" no longer accuses a courier of a false delivery scan; only the conjunction
with a tracking claim does.

**An earlier draft of this mined the bot archive and was wrong**, which is worth
knowing because the archive is the biggest thing in this database and the next
person will be drawn to it for the same reason. The bot's menu is a self-service
flow, not a ticket stream: a customer pressing "confirm my details" has no
support need, and a third of that archive is exactly that. Categorising it
measures the bot's funnel and reports the result as support demand. Categorisation
therefore excludes `whatsapp_bot` through the `readOnlyChannels()` helper that
already meant this. The archive keeps one real use — **3,159 bot conversations
contain free text the bot never answered**, which is the best available proxy for
agent-bound complaints and a leading indicator of inbound volume. That is also
why there is **no backfill job**: with the bot channel excluded there are 55
conversations in the entire archive to categorise.

And now **the chat launcher knows the difference between a customer and us.**
The help centre answers on the console's own hostname, so every agent reading an
article — which the knowledge panel inside the composer is built to make them do
— had a blue chat button floating over it, one click from filing a webchat
ticket into their own queue. `viewerIsTeamMember()` in `lib/widget/audience.ts`
reads the session rather than the cookie, because a stale cookie hiding the
launcher would take live chat away from a customer silently and for good, and
the help layout leaves `ChatWidget` out for anyone the console recognises. Only
on the pages we render: `embed.js` is cached publicly for five minutes, so a
merchant's own site cannot be told this without either dropping that cache or
letting a shared one hand a reader an answer about somebody else. A launcher
that loaded while an agent was still signed out is taken back down when they
leave the help centre, since signing in there reaches the console without a
reload (§6.78).

**The bot channel is live, and everything else is not.** This is the single most
important thing to understand about the current state, and the easiest to read
backwards.

`channels` now holds six rows — one per channel the app can receive on. Through
`whatsapp_bot`, real traffic has been arriving since 2026-08-18: **28,547
conversations and 95,930 inbound messages as of 2026-09-20**, still around 1,500
a day and now 99% of everything in the database. The database is not empty and
the system is not idle.

But that channel is **read-only observation by design**. Another service owns
that number and holds the conversation; we receive a copy of both sides.
`lib/tickets/channel-policy.ts` marks it read-only _and_ restricted, excludes it
from "all channels" even for an admin, and keeps it out of the SLA sweep, the
time-based automations and every reporting metric. Nobody on the team works
those conversations. They are transcripts, not a queue.

Every human channel put together holds **173 conversations** — 140 Facebook, 18
Instagram, 6 WhatsApp, 5 webchat, 4 email. Email, WhatsApp and webchat are still
test traffic from 18–21 August, but **Facebook and Instagram are not**: those 158
threads are real people writing to a page and an account the public can already
reach, filed under bare numeric ids and none of them answered by anybody.

**The channel rows are no longer the gap.** All five human channels now have one
— "Support Mailbox", "Facebook Page", "Instagram", "Web Chat", "WhatsApp
Support" — every one active and routed to `Support`; `whatsapp_bot` alone carries
no default group, which is right. There is still no `portal` row, so a ticket
opened from the customer portal lands with no default group.

`sla_policies` holds **4** rows and `automation_rules` **1** ("Close resolved
tickets after 3 days", §6.30), so both crons finally have work. `locations` holds
**14** rows as of 2026-10-05 (§5.1).

This branch adds **permanent deletion for admins by default**, which is a deliberate exception to
everything above about tombstones. While the product is still being tested
against real traffic, a mis-routed test ticket or a contact invented while trying
a channel out is junk in an archive that is actively being measured, and
`deleted_at` only hides it. Two new permissions — `ticket.purge` and
`contact.purge`, granted to admins and account admins, with individual overrides — put a Danger zone on the ticket sidebar
and the contact page. Deleting a contact deletes **every ticket they ever
raised**, because `conversations.requester_contact_id` is `on delete restrict`
and there is no other shape the schema allows; the panel counts the blast radius
before it happens and makes the admin type the ticket number or the customer's
own address back. Everything else is Postgres's own cascade. `lib/admin/purge.ts`
adds only what a cascade cannot do: the preview, the attachment objects in the
private bucket, the queued jobs owned by the deleted records, and one
`admin_deletions` row recording who destroyed what.

What it does **not** delete, and the panel lists every item (`RETAINED` in
`lib/admin/purge-summary.ts`) rather than implying otherwise:

- the raw `webhook_events` archive, which is keyed by provider ids and not by ours;
- daily metrics already rolled up — the nightly job rebuilds only the last three
  days, and `agent_backlog_snapshots` cannot be recomputed at all by design;
- completed and dead queue jobs, and jobs a worker is running, whose payloads can
  carry the customer's address and message bodies;
- messages the customer wrote on _other_ customers' tickets, which stay there
  with `author_contact_id` set null;
- the `admin_deletions` row itself, whose `summary` keeps the customer's name and
  address or number, or the ticket's subject;
- inbound deliveries already queued at the moment of deletion, which re-create
  the customer when they are ingested.

So this is a testing-phase cleanup tool and **not a data-erasure tool**; a
right-to-be-forgotten would be a separate job working from identifiers.

A purge is also refused, on the page and again in the action, when anything it
would take — a ticket merged into the one being deleted, or any ticket of the
customer or of a contact merged into them — is on a channel the admin cannot
see (`lib/admin/purge-visibility.ts`). Without it an admin whose override
removed `ticket.view.bot` could destroy bot transcripts the contact page never
showed them. Both actions redirect server-side on success: a revalidating action
re-renders the route it was posted from, and that route's row is the one just
deleted.

Queue cleanup runs inside the deletion transaction, **before** the cascade,
and matches both the job type and the records being deleted. A `messageId` on
`send_side_email` belongs to `side_conversation_messages`, not `messages`:
the earlier global orphan check would cancel unrelated hub emails whenever
any ticket was deleted. Only pending and failed jobs owned by this purge are
removed; unrelated jobs and work already held by a worker remain. The database
CI job exercises that distinction against Postgres with transaction-rolled-back
fixtures.

And now **WhatsApp coexistence**: a number that lives on the WhatsApp Business
_app_ on a phone can be connected from Admin → Channels in one button, through
Meta's Embedded Signup — the business token Meta mints is stored sealed, the
number subscribes itself, six months of the phone's chats and its address book
are copied in as resolved tickets and contacts, and a reply typed on the phone
lands on the ticket as the team's. It is the first credential the database has
ever held — one, sealed, opened only by the worker (§2, §8) — and **none of it
has run live**: the whole flow is proven by the unit and database tiers (§7) and
waits on Meta-side preconditions nobody has checked yet (§5.2).

So: **the system still cannot take a real human support ticket**, and the
remaining work is mostly not code — it is configuration, live-provider
verification, and cutover. But the team has started arriving: **11 agents** as of
2026-09-20, up from 3, of whom 10 have signed in at least once, and 161
conversations now carry an assignee. The capture tables the productivity report
reads are filling accordingly — 5,203 backlog snapshots, 479 presence intervals
and 215 `agent_metrics_daily` rows — so the report is no longer empty, which is
the argument for having landed the capture early. Treat "phase N is complete" as a statement about the
codebase, never about the product being usable by the support team. But do not
read "not configured" as "no data": there is a real archive now, it is worth
measuring things against, and §6.17 is what happens when you measure carelessly.

---

## 2. Live infrastructure

Everything is in **Frankfurt / eu-central-1**. Colocation is deliberate and is
worth protecting: the health endpoint reports 2–4 ms to the database, and a
console page issues 10–30 queries.

### Render — workspace `tea-da1f2lgjo6nc738hobmg`

One project, two environments: `evm-da22su3l550s73b31n60` holds the web service,
the worker and all four crons, and `evm-da22vi8jo6nc73filkmg` holds staging.
That split has been real on Render since the services were created; `render.yaml`
only started describing it in the env-group change below, and before that
declared all seven services as one flat list.

| Service                          | Type                          | Id                         | Branch                       |
| -------------------------------- | ----------------------------- | -------------------------- | ---------------------------- |
| `shipblu-support`                | web (standard, autoscale 1→3) | `srv-da1jgtg1ne8s73ciqulg` | `main`                       |
| `shipblu-support-worker`         | worker (starter)              | `srv-da1jgtg1ne8s73ciqujg` | `main`                       |
| `shipblu-support-staging`        | web (starter)                 | `srv-da1jgtg1ne8s73ciqul0` | a feature branch — see below |
| `shipblu-sla-sweep`¹             | cron `*/5 * * * *`            | `crn-da1jgtg1ne8s73ciqup0` | `main`                       |
| `shipblu-time-automations`       | cron `*/15 * * * *`           | `crn-da1jgtg1ne8s73ciquog` | `main`                       |
| `shipblu-whatsapp-template-sync` | cron `0 * * * *`              | `crn-da1jgtg1ne8s73ciquk0` | `main`                       |
| `shipblu-nightly`                | cron `0 0 * * *`              | `crn-da1jgtg1ne8s73ciqumg` | `main`                       |

¹ `shipblu-sla-sweep` runs **three** jobs,
`sla_sweep && presence_sweep && assign_sweep`. For an unknown period up to
2026-09-25 the running service dropped the middle one while the blueprint
declared it; that is fixed and §6.66 is the record, including the method that
found it — compare `list_services` to `render.yaml` rather than trusting either
alone. It is chained the way `shipblu-nightly`
chains cleanup and the rollup — same cadence, none of them long, and a second
container booting every five minutes to run a query that usually returns nothing
is not worth it. The order matters and the `&&` does too: the SLA sweep goes
first so a ticket the assignment sweep is about to hand to somebody carries its
breach flags when they open it, the presence sweep next so an agent who has
walked away is out of the rota _before_ that hand-out rather than a round later,
and a failure in any half takes the run red rather than reporting success
because the rest worked. So the service name understates what it does — grep
`render.yaml` for `startCommand` rather than trusting a cron's name.

**No production service on Render deploys itself.** `autoDeploy` is `no` and
`autoDeployTrigger` is `off` on all six of them, so merging to `main`
changes nothing that is running — a deploy is triggered by hand, from the
dashboard or the API, and until it is, `main` and production are different
software. This is easy to miss precisely because it looks like nothing went
wrong: the merge succeeds, CI is green, and the old code keeps serving. Check
what a service is actually running before concluding a change is live, and
before enqueueing a job whose handler only exists in the new code — the running
worker would take it, find no handler, and kill it.

**Staging is suspended, tracks `main`, and deploys itself.** The running
service says `branch: main` and `autoDeployTrigger: commit` — the only service
in the project that deploys itself — and `render.yaml` now says the same (it
used to pin a deleted feature branch, which failed every Blueprint sync:
§6.67, §6.76). Resuming staging therefore arms an automatic deploy of `main` on
the next commit, against staging's own database. Before resuming it, read
staging's `EMAIL_PROVIDER` in the dashboard: it should be `local`, the blueprint
no longer sets it, and staging holds a Postmark `EMAIL_API_KEY` of its own.

### Supabase — org `ihngokrzwjmgpogkecug`

| Project                 | Ref                    | Use        |
| ----------------------- | ---------------------- | ---------- |
| ShipBlu Support         | `nqbcfnvqqyqawmffgiql` | production |
| Shipblu Support Staging | `funavpkflkhthegahuay` | staging    |

Postgres 17.6. RLS is **enabled with zero policies and never `FORCE`**. The app
connects as `postgres`, the table owner, which bypasses RLS — so adding FORCE would
break every query in the app. This is a lockdown against direct PostgREST
access, not an app-level authorisation mechanism; authorisation lives in code.

**That invariant is now enforced by `db/sql/`, and it was not before.** Drizzle
does not emit `ENABLE ROW LEVEL SECURITY`, so the enabled state on the original
tables was set by hand and every table added since arrived without it. Seven
reached production that way — the five from the shipment work and
`contact_sessions` / `contact_tokens` from the customer portal before it. Since
Supabase grants `anon` and `authenticated` full DML on everything in `public`,
those seven were readable _and writable_ with the anon key that ships in client
bundles. Fixed in production on 2026-08-20 and now re-applied by a loop on every
deploy, so a new table is locked down whether or not anybody remembered.

### Environment variables — the rule

**Any value that is the same on more than one service in an environment is
declared once, in that environment's group, and nowhere else.** There are three,
and as of 2026-09-26 the dashboard matches this split:

| Group                        | Scope        | Holds                                                              |
| ---------------------------- | ------------ | ------------------------------------------------------------------ |
| `shipblu-support-shared`     | workspace    | identical everywhere and harmless outside this system if wrong     |
| `shipblu-support-production` | `Production` | anything that can reach a real customer or the production database |
| `shipblu-support-staging`    | `Staging`    | the same for staging: its own database and its own Meta app        |

`shipblu-support-shared` was called `shipblu-shared` until 2026-09-26. Render
adopts a group by name, so a rename has to land in the dashboard and in
`render.yaml` together, or the next sync creates a second, empty group.

Render gives service-level variables precedence over group values, so a key
declared in both places silently takes the service value. That cost us a
debugging session on `DATABASE_URL`. Two _groups_ linked by one service and both
declaring a key is the same trap with no precedence rule to settle it. No key
is declared twice today: the last overlaps — `NODE_VERSION` and
`EMAIL_FROM_NAME` in the staging group as well as the shared one, and `APP_URL`
on the web and worker services as well as in the production group — were
deleted from the dashboard on 2026-09-26.

Service-level entries exist only as deliberate exceptions, each commented in
`render.yaml`: `LOG_ALL_INCOMING_WEBHOOKS` on the web service, the two
`FRESHDESK_*` keys on the worker (the importer is a queued job),
and `DB_QUERY_TIMEOUT_MS` on `shipblu-nightly`, plus `NODE_ENV` on the web and
worker services. Confirmed against the dashboard on 2026-09-26.

**`shipblu-support-shared` is workspace-scoped and cannot be moved into the
project.** A group scoped to a project environment cannot be linked to any
service outside it, and Render has no project-wide scope in between — a group
belongs to one environment or to the whole workspace. Services in both
environments link this one. `render.yaml` says so with `ungrouped`, which is the
only way to state "no environment" outright; a group left in a top-level
`envVarGroups` list keeps whatever scope it happens to have.

**A secret's value is never in the file, and neither is `sync: false` inside a
group** — Render's Blueprint reference does not accept it there, and a group
entry needs a literal value or `generateValue`. A literal would commit the
secret and `value: ''` would blank the live one on the next sync. So each group
lists its dashboard-owned keys as a comment beside its literal ones. **A literal
appears only where the dashboard export showed that exact value** — today four
keys in the shared group. A literal is a value every sync writes, so one typed
from memory is a change to production nobody reviewed as one (§6.76).

**Every credential is per environment, and each environment has its own Meta
app.** Meta has no test mode: a send carrying production's page token arrives on
a real customer's phone, so staging holds its own `META_*` set, its own
`TYPESAFE_API_KEY`, its own `APP_SECRET` and its own Postmark key. Because
`META_APP_SECRET` and `META_VERIFY_TOKEN` belong to the _app_, a WABA connected
in one environment has to sit under that environment's app, or its webhooks are
stored unverified and answered 403. `FACEBOOK_PAGE_ID` and
`INSTAGRAM_ACCOUNT_ID` are still shared, so staging's app points at the same
real Page and account as production's.

One family of keys is declared without being read by name: a connected WhatsApp
business account may carry its own access token, and its row names the variable
holding it. The name must start `WHATSAPP_TOKEN_` — enforced in
`lib/whatsapp/accounts.ts`, because the value is sent to Meta as a bearer token
and a free-text variable name would be a way to exfiltrate any secret in the
process. The value goes in the environment's group; the key is listed in
`render.yaml` without it, in the same commit that names it on the account.
Staging's `WHATSAPP_ACCESS_TOKEN` is not such a name and nothing reads it.

Three keys arrived with WhatsApp coexistence on 2026-10-08, each in the
environment group and never the shared one. `WHATSAPP_CREDENTIAL_KEY` seals the
business tokens Embedded Signup stores in `whatsapp_account_credentials`:
`openssl rand -base64 32`, its own value per environment — an envelope sealed on
staging must not open on production — never derived from `APP_SECRET`, and
never named `WHATSAPP_TOKEN_*`, because that prefix is what an admin may name
as a bearer token. `WHATSAPP_CREDENTIAL_KEY_PREVIOUS` is set only during a
rotation: previous = the old key, current = the new, `npm run job --
rotate_whatsapp_credentials dryRun=true`, then without, then unset.
`META_EMBEDDED_SIGNUP_CONFIG_ID` is the Facebook Login for Business
configuration on that environment's own Meta app — an id the browser hands to
Meta's SDK, not a secret, but a configuration belongs to one app. Whether any of
the three is set is a dashboard question the repo cannot answer: `render.yaml`
lists them as dashboard-owned, nothing could have needed them before
2026-10-08, and the first live onboarding needs the first and third (§5.2) —
the page names what is missing before the button opens anything.

**Losing the key loses every stored credential, by design.** There is no
recovery but reconnecting each number through Meta's window, one popup each;
the console says so per account (the credential's `keyState` reads `unknown`,
naming the key id and the variable) rather than failing the page. The key
variables are plain `z.string().optional()` in `lib/env.ts` for the reason
`LOG_ALL_INCOMING_WEBHOOKS` is (below): a format rule there would take the
console down on a mistyped key instead of failing one WhatsApp connection with
a sentence. And a service-level copy of the key would silently shadow the
group's — the same precedence trap as `DATABASE_URL` above — which is what a
`keyState` of `unknown` on the next page load would be saying.

When you add a variable, add it to `render.yaml` in the same commit. The
blueprint is meant to describe the running system; it is not documentation that
drifts.

### Seeing an inbound webhook: `LOG_ALL_INCOMING_WEBHOOKS`

Set it to `true` on the **`shipblu-support` web service** and every inbound
delivery — Meta, WhatsApp and email — is printed with its headers and raw body.
Grep the logs for `[webhook:all]`. Unset it again afterwards.

It exists because the most expensive question about this system is also the one
the database cannot answer: **did the delivery arrive at all?** `webhook_events`
is written _after_ the signature check, and not written at all for a duplicate.
So "rejected", "malformed", "deduped" and "never sent" are the same absence of a
row — four states with four different fixes, and no way to tell them apart. The
Meta investigations in §6 each lost hours inside a parser for events that had
never reached the endpoint.

So it logs at the top of each handler, **before** verification, JSON parsing and
the duplicate check. Nothing downstream can suppress it; that ordering is the
whole feature.

Three things to know before switching it on:

- **It prints customer message content**, names and phone numbers, into the
  Render log — a less protected place than the database. Inherent: a redacted
  payload could not answer the question. Treat it as a session, not a setting.
- **Credentials never print.** `authorization` is redacted, and that is not
  hypothetical — Postmark authenticates with Basic Auth, so the inbound email
  endpoint receives `EMAIL_WEBHOOK_SECRET` on every delivery. `cookie`,
  `proxy-authorization` and `x-api-key` go with it. `x-hub-signature-256` is
  deliberately **kept**: an HMAC rather than a secret, already persisted by the
  routes on that reasoning, and a signature that is missing or mismatched is one
  of the failures this is for.
- **The Meta `GET` handshake is deliberately not logged.** Its query string
  carries `hub.verify_token`.

Only `true` turns it on — `1`, `TRUE` and `yes` are all off rather than
helpfully coerced, because the cost of a half-set flag is customer content in a
log nobody meant to fill. Read through `process.env` in `lib/webhooks/log.ts`
rather than `env()`, for the reason `SHIPMENT_TRACKING_PATTERN` is: a diagnostic
must never be able to fail the request it was only meant to describe.

**Two things this got wrong on the first attempt, both worth keeping.** It was
declared `z.enum(['true','false'])`, which reads as careful and is the opposite:
`env()` parses the whole schema and is reached by the database client, the auth
helpers and every page and action, so `True` or `1` or a trailing space would
have thrown for the _entire application_ rather than quietly disabling logging —
a debug flag that takes the site down when mistyped. It is `z.string()` now, and
the strictness lives in the reader, where it costs nothing. **Tightening the type
of a diagnostic is not free: it moves a typo from "the tool is off" to "the app
is down".**

It also emitted one log line **per header**. Render splits an app log on
newlines, so a single `console.log` became ~20 entries per delivery, and on Linux
`process.stdout` to a pipe is a _synchronous_ write — log volume on this path is
paid on the event loop, not in the background. Headers are one line now, the body
another; a delivery is at most three entries.

### The three-group split is applied; one cleanup is left

The dashboard holds the three groups `render.yaml` describes. What is left is
deleting, by hand, what the split left behind — Render _preserves_ a variable
the Blueprint stopped declaring, so none of these goes away on its own.

Keys nothing reads, in both environment groups: `WHATSAPP_APP_SECRET` and
`WHATSAPP_VERIFY_TOKEN` (retired names), staging's `WHATSAPP_ACCESS_TOKEN`,
and — once whoever uses them has been asked — `META_SYSTEM_ADMIN_TOKEN` and
`FB_PAGE_ACCESS_TOKEN_ALI`.

---

## 3. Working with other agents on this repo

More than one agent session works on this repo at once, and they do not share
context. This has already produced duplicated work: two sessions independently
diagnosed and fixed the same percent-encoded-route bug, and a whole PR had to be
thrown away. That is the single most likely way for you to waste an afternoon.

- **`git fetch origin main` before you plan, not just before you push.** Main
  moved by 20 commits during one session's context window.
- **Read the log before claiming a bug.** `git log --oneline -30 origin/main`
  costs nothing and would have caught both duplicates.
- **Claim your seam out loud** in the PR or to the user before starting on
  anything that takes more than one commit.
- **Prefer rebasing onto main over merging main in.** The history reads as a
  sequence of intentions; merge commits from parallel sessions obscure it.
- Never push to `main`. Commit → push → PR → merge → verify the deploy.

Commit messages here carry the reasoning — the trade-off taken and what the
naive alternative would have broken. They are the durable record of _why_, and
they are worth reading when something looks strange. Keep writing them that way.

---

## 4. Before every push

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

All four are clean on `main`. `npm run build` is not optional: several failures
in this project — the React export-condition one in §6.1, ambiguous route
segments — appear only at build time and never in `tsc` or the dev server.

Tests go where bugs actually hide: email threading resolution order, quote
stripping, the WhatsApp 24-hour boundary, business hours across DST, Arabic
slugs, language detection, the condition language. Not on glue code.

**Verify, do not infer.** Any claim about production should be backed by a query
or a log line, and §6.2 is a warning about what happens when it is not.

---

## 5. What is left

In rough priority order. Nothing here is blocked by anything else.

### 5.0 The queue in front of the queue

Two things sit ahead of everything below, and neither is a feature.

**Ten pull requests are open, and five of them are one change.** #151 and
#153–#157 are all the 2026-09-08 web freeze; #157 is the integration branch that
carries #153–#156 as four merges, and #151 is a second, independently written
answer to the same problem — the duplicate-work failure §3 warns about, arriving
exactly as described. They have not moved since 2026-09-09. **The defect they fix
is still live in `main`**: `app/api/events/route.ts` wires its abort handler
after seven sequential `LISTEN` awaits, and the `catch` beside it returns without
`end()`, so a client that disconnects inside that window strands a
`sessionSql()` connection opened with `idle_timeout: 0`. `transaction_timeout`
reaps it five minutes later; that is the whole of the mitigation today.

Nothing is stranded at this moment — 17 backends, none in the
`state=active` + `wait_event=ClientRead` shape, checked 2026-09-20 — so this is a
live defect rather than an active incident. Read `plans/web-freeze-2026-09-08.md`
before touching any of it.

**#151 is closed as superseded, and one idea in it is worth keeping.** Its
readiness probe made `/api/health` verify a _completed private Server Component
render_ on the same instance, rather than a pair of database probes. That is a
real answer to the rule §8 already states — a 200 is not evidence a page renders
— and the freeze is exactly the case that proves it: the health check went on
reporting success while every console page hung. The rest of #151 (a second pool
module with generation retirement and cooldown) is not worth carrying beside the
deadline instrumentation that landed, and it can fail concurrent database work by
its own description.

~~Nobody has written the probe as a follow-up anywhere else.~~ **Written
2026-09-25**, carrying #79's `/probe` page forward (#79 was closed as superseded
the same day). `/api/health` now renders `app/probe/page.tsx` over the loopback,
alongside `select 1` and inside the same five-second window, so it adds no time
to the check. (The queue count that follows still has five seconds of its own,
so the worst case for the whole check is about ten, as it was before.) It
passes only on the page's marker text. The page answers only a request carrying an HMAC of
`APP_SECRET`, and 404s any other request before touching the database, so being
public in `proxy.ts` exposes nothing. It bounds its own `select 1` with the same
cancellable probe, because the health check aborting its fetch does not stop
the render. Measured against a local Postgres 16 on a production build:

- healthy, the check answers 200 with `renderMs` beside `dbLatencyMs`;
- with Postgres frozen (`SIGSTOP`), it answers 503 in 5.0 s and the render gives
  up at the same moment rather than queueing;
- once Postgres resumes, the next poll is 200 again.

**The same run confirmed #79's other claim: one web process holds two pools.**
`db/client.ts` is bundled once for route handlers and once for pages (Turbopack
puts them in `chunks/` and `chunks/ssr/`), and each copy makes its own
postgres.js pool on first use. A temporary log line in `getSql()` fired twice in
one process, once for `/api/health` and once for the first page render. Every
page shares the second pool; nothing made a third. Three consequences:

- An instance can hold `2 × POOL_MAX` = 20 connections to Supavisor, not 10.
  Anything that sizes the pooler per instance should count both.
- `poolPressure()` in `/api/health` describes the **route-handler** pool only.
  The pool that saturated on 09-08 was the one pages use, and it is not in that
  block. The render probe is what now covers it, by failing rather than by
  reporting a number.
- Sharing one pool through `globalThis` in production, as #79 did, is not the
  one-line fix it looks like. `instrumented` in `db/client.ts` is a module-local
  `WeakSet`, so each copy would wrap the shared pool again: two deadline timers
  per query, and pressure counters split across the copies. Fix the wrapping
  first, or share the instrumented client rather than the raw pool.

One figure makes #155 more urgent than its own description says: `webhook_events`
is **402,172 rows and 1006 MB** as of 2026-09-20, against the 206,053 that PR
measured eleven days earlier. Retention is the change that stops a table
doubling every fortnight.

~~**And `main` is not deployed.**~~ **Deployed 2026-09-20.** All seven services
are on `6d9b7f3`; `/api/health` reports the commit and the new `pool` block from
#153. The standing hazard is unchanged, though, and it is why this paragraph
stays: `autoDeploy` is off everywhere, so the next merge is again not running
until somebody triggers it — including the job whose handler a queued row will
look for.

### 5.1 Configuration and cutover — the real remaining work

The system cannot take a single real ticket until this is done, and none of it
is code:

- **Freshworks is still the live support service, and it is still the default
  Meta app on the account.** This is the fact that explains the single most
  confusing thing about the Meta channels, and it is deliberate rather than
  broken: ShipBlu is still being supported out of Freshworks while this app is
  under construction, so the Freshworks app (Freshchat — `app_id`
  576817601276249, `metadata: "freshchannel"`) is the Page's default app and
  **holds thread control** on both the Messenger and Instagram inboxes.

  The consequence is that every Meta event reaches this system in the handover
  protocol's `standby` array rather than `messaging`. A secondary receiver may
  **read** a thread and may not **send** on it, so the console can show every
  Facebook and Instagram conversation and answer none of them, and
  `lib/meta/thread.ts` refuses those sends before Graph does (§6.22). Nothing
  about that is a credential, an approval or a bug — do not go looking for one.

  **The plan is a swap, not a negotiation.** When this service is ready, the
  Freshworks app is removed from the Meta account and this service's Meta app
  becomes the default; thread control follows the default app. Until that
  happens, treat **Messenger** as read-only in practice however the code is
  configured.

  **Instagram is the exception as of 2026-08-30, and it is the way out of this
  paragraph.** The account is now also connected directly through Instagram
  Login, which is not installed on the Page and therefore not subject to the
  Page's handover protocol at all: it receives its own copy of every event in
  `messaging`, and a reply sent with its own token against `graph.instagram.com`
  does not need thread control that Freshworks holds. So Instagram can be
  answered from here before the swap — which also means the Instagram App Review
  screencast can be recorded before it. `standby` on a Page delivery no longer
  refuses an Instagram send; see §6.36 and `lib/meta/connection.ts`. Messenger
  has no equivalent second route and still waits for the swap.

  Two things follow that are easy to get wrong. **The App Review screencasts
  cannot be recorded before the swap** — `pages_messaging` and the comment
  permissions all require footage of the app _sending_, and a recording of a
  reply Graph refuses is a rejected submission
  (`plans/meta-app-review-submission.md`). And **the swap is the cutover's point
  of no return** for these channels: the moment Freshworks stops being default,
  the Meta inboxes are answered here or not at all, so the channel rows, the
  agents and the groups below need to be in place first rather than after.

- ~~**Channel rows.**~~ **Done, bar one.** All five human channels have a row as
  of 2026-09-20 — "Support Mailbox", "Facebook Page", "Instagram", "Web Chat",
  "WhatsApp Support" — active and routed to `Support`, and `whatsapp_bot` is
  still the observed bot number the team does not answer (§1). **A `portal` row
  is the one still missing**, so a ticket opened from the customer portal lands
  with no default group and nothing routes it.
  A WhatsApp row now also needs a **business account** to point at — Settings →
  Channels, "WhatsApp business accounts". Nothing has to be done by hand for the
  existing setup: the hourly template sync turns `WHATSAPP_WABA_ID` into the
  first connection and adopts the numbers and templates that already exist. The
  connection is what decides the token a reply sends with and which templates
  an agent may pick, so a second WABA is a row rather than a second deploy. See
  `plans/multiple-waba-connections.md`, and note the limit it states: every
  connected WABA has to sit under the same Meta app, because the app secret that
  verifies inbound webhooks is single-valued. The env vars
  are the credentials; the rows are what the app routes on. A `portal` row is
  worth adding too: without one, tickets opened from the customer portal land
  with no default group, so nothing routes them. The `webchat` row **now exists**
  (measured 2026-08-31): it is the row whose default group decides which schedule
  the widget calls "we are here", and since the widget's FAQ screen it is also
  where that setting lives — `config.faqFolders` names one knowledge base folder
  per locale, read through `parseWidgetConfig` in `lib/widget/config.ts`. It
  carried `{"address": ""}` until then, written by `saveChannel`'s catch-all
  branch, which is why anything reading that column treats its shape as
  untrusted.
- **Every bot transcript is one-sided, and no subscription can fix it — Meta
  discontinued the field.** The archive holds what customers said to the bot and
  nothing the bot said back: **95,930 inbound rows on `whatsapp_bot` and zero
  outbound**, against 0 of 395,391 stored deliveries carrying an echo of any
  kind. The size of the hole is known exactly, because the delivery statuses
  _do_ arrive: 14,828 distinct outbound wamids in the three days to 2026-08-22
  against 10,024 inbound messages, so roughly 60% of each conversation is
  absent, permanently.

  **This entry said "the fix is one job away" for a month and it was wrong.**
  Running the job on 2026-09-21 is what settled it. `message_echoes` was a real
  WhatsApp field and Meta has since discontinued it; the team that owns this
  integration confirmed that, and the run corroborates it three ways. Graph
  refuses a subscription naming it with `"An unknown error occurred"` — what it
  answers for a field it does not know. The field is absent from the
  `whatsapp_business_account` webhook reference for v23.0, the version
  `GRAPH_VERSION` names. And the job's own read-back listed twelve subscribed
  fields with no trace of it.

  **`smb_message_echoes` is not the alternative to reach for, and its silence is
  the proof.** It is the surviving echo field — a business replying from the
  WhatsApp Business app or a companion device — and it has been **subscribed on
  this app the whole time**, across all 395,391 deliveries, without ever firing
  once. That is the evidence that this number is not operated that way: it is
  sent on through the Cloud API, where the sender already knows what it sent and
  Meta offers no echo to a third-party app. _Partly superseded 2026-10-08:_ the
  silence proved that about this number and nothing about the field, and a
  number connected through coexistence is operated from the phone — the field
  is required and ingested now; §6.85.

  So the bot's half is **not reachable by webhook at all**, and the remaining
  routes are outside this system: the service that operates the number hands the
  transcripts over directly, or they stay missing. Anyone reaching for a
  subscription change here is repeating a month of it.

  Two things were kept rather than deleted, both deliberately.
  `lib/whatsapp/parse.ts` still reads a `message_echoes` array — it costs one
  `?? []` and it is the shape the stored archive was parsed with, so a replayed
  historical delivery does not silently lose its echoes. And the branch beside
  it that treats a message from our own number as an echo is load-bearing on its
  own terms: without it our own outbound arriving under `messages` is filed as a
  customer message, inventing a contact for our own phone number.

  The general lesson is §6.43's, one product further out than the case recorded
  there: **a removal notice sits somewhere a search for the working endpoint
  never surfaces.** `message_echoes` still reads as current everywhere except
  the reference that governs it, and the nearest thing to a check is the one
  AGENTS.md already gives — read the node reference for the version
  `GRAPH_VERSION` actually names, and treat a field missing from it as a
  finding rather than as an omission by the doc.

- **Agents.** **11 accounts exist** as of 2026-09-20 (1 account_admin, 4 admins,
  2 supervisors, 4 agents), up from 3, and 10 of them have signed in at least
  once. **Seven `send_agent_invite` jobs died on 2026-09-03** with `the token …
cannot be unsealed — APP_SECRET may have been rotated`, so some of that
  onboarding did not go out by email; check nobody is still waiting on one before
  inviting the rest. `groups` (3 rows) still needs its membership — which is now load-bearing rather than
  decorative: auto-assignment only ever considers members of the ticket's group,
  so a group with an empty roster hands out nothing and says `no_group_members`
  on the timeline.
- ~~**Assignment is configured but off.**~~ **Switched on for `Support` on
  2026-09-02**, round robin; 161 conversations now carry an assignee. **The
  roster is still 3 of 11 agents**, though, which is the thing to fix next here —
  eight of the people who now have accounts are in no group, and auto-assignment
  only ever considers members of the ticket's group. `Customer Care` and
  `Merchant Care` still have empty rosters and no channel points at them, so they
  route nothing until somebody decides what belongs in them.

  Two things were in the way and are worth knowing about, because both made the
  feature look broken rather than unconfigured:

  - **`facebook`, `instagram` and `whatsapp` had no `channels` rows**, so every
    ticket on those channels arrived with `group_id` null and could never be
    assigned — 71 of them had accumulated. Rows now exist, all defaulting to
    `Support`, and the 71 were backfilled. The WhatsApp row carries
    `phoneNumberId` `838961722630554`, the support line; it must **never** carry
    the bot's `128318316834446`, which would route 13,693 bot transcripts into
    the team's queue. `resolveWhatsAppChannel` matches the number exactly and
    otherwise falls back to the first `whatsapp` row, so a blank number is safe
    and a wrong one is only ever a fallback — the bot's number is the single
    value that must not appear there.
  - **Only one agent has ever been online.** Presence gates eligibility, so round
    robin hands everything to whoever is connected. George has never signed in
    (`last_seen_at` null) and Ahmed last beat on 26 Aug, which means the rota is
    effectively one person until they open the console. This is the design
    working, but it reads as "round robin is broken" if you do not know it.

  No per-agent caps are set, and no skills are in use — so no skill timeout is
  needed yet. If skills are ever switched on, set one: without it a mistake in a
  skill's conditions is a ticket no human ever sees. `/admin` reports both,
  including any skill no active agent holds.

- ~~**Locations are empty.**~~ Entered in production on 2026-10-05 by SQL from a
  list ali@shipblu.com supplied, normalised exactly as `saveLocation` would. No
  number of locations is expected: `/admin/locations` reports how many are
  entered and operating, and the settings overview flags only an empty register.
  The rows entered that day share one `created_at`,
  `2026-10-05 10:02:27.625296+00` (keep the microseconds — to the second it
  matches none of them), which is how to select them to undo the entry. Delete
  only while no `side_conversations.location_id` points at one: the foreign key
  is `on delete set null` and would quietly strip the hub from a real thread,
  leaving only the address in `to_addresses`. That check is the SQL's to make by
  hand; the Delete button on `/admin/locations` makes it itself. `deleteLocation`
  goes through `removeLocation` (`lib/locations/remove.ts`), which locks the row,
  counts the threads, and marks a hub any thread has used not operating instead
  of deleting it — the rule `deleteInternalRecipient` already applied to the
  picker's other register.

- ~~**SLA policies and automation rules are both empty.**~~ `sla_policies` holds
  **4** rows and `automation_rules` **1** as of 2026-09-20, so neither cron runs
  over nothing any more. Whatever else Freshdesk enforces today still needs
  transcribing, and one automation rule is not a rule set.
- ~~**Canned responses are empty.**~~ Seeded in production on 2026-10-06, from
  0 rows: `canned_responses` holds the **62** responses of
  `lib/tickets/canned-library.ts` in **11** folders. Every one is `global`,
  carries both languages and both HTML bodies, and the longest Arabic body is
  976 bytes, under Instagram's 1000. Web and worker went out on `8426c35` first.
  Web went live at 07:32 UTC and applied migration 0030 in its pre-deploy; the
  worker followed at 07:37. Then three `jobs` rows went in, and the worker's log
  answered each under `[seed_canned_responses]`:

  - **10:50**, a dry run: `62 created`.
  - **10:52**, the real run (job `3181996e-892e-4a28-8a34-2a531e016c09`):
    `62 created`.
  - **10:53**, a second dry run: `0 created, 0 rewritten, 62 already current`.
    That is the idempotence the job exists for, measured against production
    rather than the test database.

  The rows were inserted from the Supabase SQL editor because the Supabase MCP
  connector answered every call that day with
  `FGA Authentication Error. Unauthorized`, including after it was reconnected.
  The running worker claims a row like this within seconds:

  ```sql
  insert into jobs (type, payload)
  values ('seed_canned_responses', '{"dryRun": true}');
  ```

  From a shell it is `npm run job -- seed_canned_responses dryRun=true`.

  Operating it from here:

  - **Re-running is safe** and changes nothing that is current. A response the
    team has edited is named in the report and left alone.
  - **To ship a content fix**, use `overwrite=true keys=<key,...>`. It replaces
    only the entries named and logs each one it replaces. It has no undo,
    because a canned response has no version table, so preview it with
    `dryRun=true` first.
  - **Retiring a response takes two steps.** A response deleted in the console
    comes back on the next run. An entry removed from the library is not
    deleted, since an automation rule may send it. So remove the entry from the
    library first, then delete its row in the console. The report names every
    seeded row the library no longer has.
  - **To undo the seed**, run
    `delete from canned_responses where seed_key like 'library:%'`. Only do it
    while no rule sends one of them: a `send_reply` action holds its
    `cannedResponseId` in jsonb, not behind a foreign key. A deleted response
    leaves a rule that logs "references a canned response that is gone" and
    sends nothing.

  The policy the responses state is quoted from the help centre as it read on
  2026-10-05: delivery hours and attempts, the 24-hour damage-claim window, the
  myBlu refund path, the COD ceiling, Fees on Delivery and the dashboard menus.
  A change to one of those articles changes the library in the same PR.

- **The side conversation picker's two registers.** Both are filled:
  `internal_recipients` has 3 teams and `locations` 14 hubs (above), so the
  picker lists _Hubs and warehouses_ first. **It preselects nobody.** It used to
  open on its first entry, and with hubs sorting first and by name an agent who
  sent without touching it asked Alexandria Hub (Finance, before 2026-10-05);
  it now opens on _Choose…_ and the form will not send until somebody is
  chosen. Only an empty directory still opens on _Someone else…_, the one
  choice there is. The subject opens on the ticket's tracking number and `|| `
  when it has exactly one parcel (`subjectPrefill`), and empty otherwise — an
  empty subject is sent as the ticket's own, or `(no subject)`, and the field
  shows which as its placeholder (`blankSideSubject` answers both). A prefill
  sent untouched goes out as the tracking number alone: `sideSubject` drops a
  trailing `||` rather than send it dangling (decided on review, 2026-10-05).
  Vendors — a courier partner — still go in `internal_recipients` at
  `/admin/recipients`, and none is entered. All three side conversations that
  exist are open and went to a typed test address, with `location_id` and
  `recipient_id` null on every one (measured 2026-10-05; the "hub" in §6.41 is
  #3, that typed address standing in for one): none has yet gone to a team or a
  real hub.
- ~~**The shared-location backfill has not been run.**~~ Run on 2026-08-21: 821
  recovered, 0 unreadable, and `/admin/import` now reports nothing text-only. It
  stays available and is safe to re-run — a second pass recovers nothing — so
  re-run it if the parser ever learns to read a shape it currently skips. §7 has
  the figures.
- **Unset config:** `WIDGET_ALLOWED_ORIGINS`, `WIDGET_IDENTITY_SECRET`. The
  email keys that were on this list are all set. `EMAIL_API_KEY` and
  `EMAIL_FROM_ADDRESS` were confirmed by the owner on 2026-10-05, since Render's
  API does not show values, and the traffic agrees: ticket #13777's reply went
  out through Postmark on 2026-09-03, and side conversations have sent through
  it since 2026-08-20. `EMAIL_REPLY_DOMAIN` is `shipblu.com`, a literal in
  `shipblu-support-shared` taken from the 2026-09-26 dashboard export
  (`render.yaml`).

  **Both are what stands between the widget and the merchant dashboard.** Measured 2026-08-31: `https://shipblu-support.onrender.com/widget`
  answers `content-security-policy: frame-ancestors 'self';`, so
  `app.shipblu.com` cannot frame it at all — the launcher would open an empty
  box. `WIDGET_ALLOWED_ORIGINS` has to name that origin before the snippet in
  `docs/embedding-the-widget.md` does anything. `WIDGET_IDENTITY_SECRET` is the
  softer half: without it the dashboard can still say who its visitor is and the
  agent still sees a name, an address and a phone — the claim just never gets to
  link the person to their shipping account.

  **`EMAIL_WEBHOOK_SECRET` is required, not optional, from #177, and was set on
  the web service on 2026-09-25.** Unset, the Postmark driver used to accept
  every inbound email as verified; it now refuses every one with a 401 and
  stores the refusal with its reason in `webhook_events.error`. The value was on
  this list until the owner set it; Render's API does not show values, so the
  confirmation is theirs, not a reading. It has two halves that must agree: the
  variable on the service, and the Basic Auth password in Postmark's inbound
  webhook URL. The running service picks the variable up on its next deploy —
  Render recorded no environment-triggered deploy or restart after the 13:22
  UTC deploy that day. If the two halves ever disagree, Postmark retries each
  401 for about ten hours, and correcting both inside that window should let the
  retries through; whether a retry already scheduled uses a URL changed after
  it was scheduled has not been observed. Nothing replays a refused row by
  itself — `process_webhook` skips unverified rows — so a delivery that exhausts
  its retries needs replaying by hand.

  **`KB_PUBLIC_HOST` was on this list and should not have been. It is set, to
  `support.shipblu.com`, and that domain still serves Freshdesk.** Measured
  2026-08-28: `/widget/embed.js` on production embeds
  `https://support.shipblu.com`, so that is what `publicBaseUrl()` returns;
  `support.shipblu.com/en/a/packaging-guidelines` answers **404** while the same
  path on `shipblu-support.onrender.com` answers 200; and Render's HTTP metrics
  broken down by host show **zero** requests reaching this service on
  `support.shipblu.com` over 48 hours. The DNS has never been pointed here.

  **Still true on 2026-09-20, and still nobody's half-hour.** Re-measured the
  same way: production's `/widget/embed.js` still emits
  `https://support.shipblu.com`, that host still answers `302 → /support/home`
  (Freshdesk's own path) at the root and still 404s
  `/en/a/packaging-guidelines`. What has changed is only the blast radius, and
  only for now — one CSAT survey has ever been created and `contact_tokens` is
  empty, so almost nothing has been mailed a dead link _yet_. That is the reason
  to unset the variable now rather than an argument for leaving it: the day the
  portal opens is the day every verification and reset email starts carrying one.

  So every absolute URL built from `publicBaseUrl()` currently names a host that
  does not serve this app. That is the sitemap, `robots.txt`, every canonical
  tag and `metadataBase`, the widget embed script, **portal
  account-verification and password-reset emails** (`lib/portal/emails.ts:21`)
  and **CSAT survey links** (`lib/csat/index.ts:91`) — the last two go to real
  customers. Unsetting the variable would repair all of them at once by falling
  back to `APP_URL`; that is a one-variable change nobody has made yet, and it
  is the cheapest item on this list.

  The knowledge panel and the article editor no longer depend on it: both build
  their links with `requestBaseUrl()` from the request's own `Host`, so they
  follow whatever domain the console is being served on. **The widget's two
  article links joined them on 2026-08-31** — the popular questions on its
  opening screen and the suggestions above its composer — for the same reason
  and one more: the widget frames whichever of our hostnames served the snippet,
  so the request's own `Host` is by construction the one that will answer. It
  was measured before the change: `support.shipblu.com/en/a/fees-on-delivery-fod`
  answers 404 while the suggestion pointing at it was being rendered, which made
  every article the widget offered a dead link. Nothing else was
  moved — a published address should stay published, and switching the sitemap
  to a request host would be a genuine mistake.
  `META_APP_ID` joined the shared group with this change and is _not_ on that
  list — it is an app id rather than a secret, only
  `subscribe_meta_webhooks` reads it, and nothing needed it before. The last of
  those is not blocking chat on the help centre and never will be: the snippet
  frames the hostname that served it, so the help centre's own iframe is
  same-origin either side of the custom domain going live. It is for the day the
  widget goes on shipblu.com.

- **Presence has never been observed with more than one agent.** It is written
  from the presence stream and verified against a local Postgres, but the multi-tab
  case is handled by expiry rather than by reference counting: closing one of two
  tabs marks the agent offline and the surviving tab's next beat — up to 25
  seconds later — puts them back. That window is a brief skip in the rota, which
  is the cheaper error, but nobody has watched it happen with a real team.
- **The tracking format is now known, and the SBID pattern is still a guess.**
  The shipping team gave the real format on 2026-08-30: **a run of at least
  thirteen digits, optionally carrying letters**, `1755021358719` being one. It
  is an epoch-millisecond timestamp, which is why every one in the archive is
  exactly thirteen digits and will stay thirteen until 2286. That is now the
  default in `lib/shipments/detect.ts`; `SHIPMENT_TRACKING_PATTERN` stays unset,
  so nothing has to be configured in Render for it to take effect — a deploy is
  the whole change.

  The old default demanded letters _and_ digits and therefore matched nothing.
  Replaying the new one over production says it now finds **24 of the 24 real
  tracking numbers in the archive and nothing else**: across 44,388 messages only
  25 contain a thirteen-digit run, 24 are unmistakable (`رقم التتبع`,
  `go.shipblu.com/en/1903828629327`, `1632778410963 ده رقم التتبع`), and the
  25th is a spam link whose 19-digit query-string parameter the guards reject.
  Nothing in the archive has letters in it at all, so that half of the format is
  supported on the shipping team's word and unattested.

  **What is still unverified is the top of the range.** "At least thirteen" is
  the promise, every observed number is exactly thirteen, and the default has no
  upper bound — so a long numeric id in a future channel is the shape most likely
  to produce a false link. The guards in `isPlausible` are what carry that
  decision, and three of them exist only because the default now matches bare
  digits: the dialled-international mobile `00201014428154`, the fraction of a
  round-tripped GPS coordinate (§6.17), and a payment card, which under a
  bare-digit pattern would be written into `shipments` under a unique index and
  shown to every agent. That last one is a leak, not a junk row.

  `SHIPMENT_SBID_PATTERN` is untouched and still a guess: nobody has said what an
  SBID looks like, so it stays keyword-anchored, and a bare number is still never
  read as one.

  The variables belong in the `shipblu-support-shared` group (then `shipblu-shared`) because the web service and
  the worker have to agree: the worker links on the pattern, the console searches
  on it, and a service that disagreed would link a ticket the search could never
  find again. ~~**After this deploys, run the backfill from `/admin/import`.**~~
  **Detection is live and working**: 40 `conversation_shipments` rows exist as of
  2026-09-20 and **38 of them were found by the detector** rather than typed by
  an agent, which is the ratio the second `/admin/import` card was built to
  report.

  **What has no schedule is the re-read.** `sync_stale_shipments` still has no
  cron entry in `render.yaml` (§1), only 17 `sync_shipment` jobs have ever run,
  and **34 of the 40 shipments were last synced more than two days ago** — the
  most recent sync anywhere is 2026-09-19. So the tracking page now reliably
  finds a parcel and then answers about it from stale data, which is the failure
  mode that invites an agent to repeat an old status to a customer as current.
  Deciding the cadence is still a question about the platform's rate limits that
  nobody has answered; picking any number and writing the cron is better than the
  status quo.

- **`/admin/import` now has a second card** whose figures answer whether the
  pattern is right: it splits links into those the detector found and those
  agents made by hand, and says so plainly when the second number is larger.

### 5.2 Live-provider verification

Everything below passes unit tests. Each is a round trip, or the half of one
nobody has run, that somebody has to actually watch against the real provider:

- **Postmark, from Outlook.** The credentials are set (§5.1), and the Gmail half
  has been watched: on ticket #13777 on 2026-09-03 a Gmail message arrived, an
  agent replied through Postmark, and the Gmail answer threaded onto the same
  ticket. Outlook is the half nobody has run — send a reply, answer it from
  Outlook, confirm it threads rather than opening a new ticket. Threading is the
  thing naive helpdesks get wrong, and the two bugs in §6.4 were both found by
  reading the API docs rather than by testing — there may be a third.
- **The widget on a genuine third-party origin**, not localhost. The
  `frame-ancestors` allowlist and the visitor token are what you are testing.
  The help centre is not that test even on its own domain — it serves the
  snippet itself, so the frame is same-origin and `'self'` already covers it.
  The identity handshake added on 2026-08-31 is part of the same test and has
  the same gap: it was driven in Chromium from a page on `localhost:8080`
  against a dev server on `localhost:10000` — a real cross-origin frame, a real
  `WIDGET_ALLOWED_ORIGINS` entry, a real Postgres — which proves the mechanism
  and proves nothing about `app.shipblu.com`, where the origin is one Render
  serves the header for.
- **The KB on its custom domain**, including that Freshdesk's old article URLs
  redirect. 174 `kb_redirects` rows exist and none has been followed in anger —
  which was read as "nothing links to them" and was not: 29 links **inside the
  articles** pointed at those legacy paths until 2026-09-03, and `support.
shipblu.com` still serves Freshdesk, so each one took a reader out of this
  help centre and into the old portal. They are now `/{locale}/a/{slug}`
  (§6.50). The redirects still matter for inbound traffic; nothing we publish
  depends on them any more.
- **A WhatsApp template send outside the 24-hour window** — the one path the
  end-to-end test in §7 could not cover.
- **Connecting a number on the WhatsApp Business app (coexistence). Built,
  proven against a local Postgres, and not yet run live.** Everything from
  Meta's popup to a phone-typed reply on a ticket — the code exchange, the
  sealed credential, `complete_coexistence_onboarding`, the copied history and
  contacts, `smb_message_echoes`, `account_update` — has been exercised only by
  the unit and database tiers (§7). What gates the live run is outside the
  repo, and each item is a trap of its own:
  - **The Meta app must be a Tech Provider** (or Solution Partner), or Embedded
    Signup refuses to open; business verification is its prerequisite. Not
    checked for either app.
  - **A Facebook Login for Business configuration** for the Business-app
    onboarding → `META_EMBEDDED_SIGNUP_CONFIG_ID` (§2), with Client/Web OAuth
    login, Enforce HTTPS and Login with the JavaScript SDK switched on, and
    **the console host in Allowed Domains for the JavaScript SDK** and in Valid
    OAuth redirect URIs — staging's host too. Missing, the popup fails inside
    Meta's window with a sentence about the domain, and nothing here can say
    more than that.
  - `WHATSAPP_CREDENTIAL_KEY` in both groups (§2). `coexistenceReadiness()`
    lists every missing variable on the page before the button does anything,
    so a code is never spent on a store that was always going to fail.
  - **The app-level webhook fields** `history`, `smb_app_state_sync`,
    `smb_message_echoes` and `account_update` on `whatsapp_business_account`:
    `npm run job -- subscribe_meta_webhooks` once per environment, **staging
    first**, because three of the four names come from the webhooks overview
    rather than from a subscription this app already holds, and one bad name
    fails the whole write (§6.85). The onboarding job reads the list back and
    records a warning per missing field; it cannot write the list itself.
  - The phone runs WhatsApp Business 2.24.17 or later and stays open until the
    history reaches 100%; onboarding unlinks companion devices; throughput on
    such a number is fixed at 20 messages a second; marketing templates are
    refused on it.

  What to read back from the first run, in order: `whatsapp_onboardings.steps`
  as the card polls it; the credential row by `select key_id, token_type,
expires_at` — never `envelope`; the `request_id`s in
  `channels.config -> coexistence`; `history` deliveries in `webhook_events`
  with the app open on the phone (`LOG_ALL_INCOMING_WEBHOOKS` for the session,
  Meta's Webhook Debugger for field names); imported resolved tickets carrying
  both directions; a phone-typed reply on a live ticket labelled "WhatsApp
  Business app" with the SLA clock stopped; a console reply landing in the
  phone's chat; and the hourly template sync reading with the stored
  credential (`last_synced_at` moves, `last_sync_error` null). The
  `debug_token.expires_at` that run stores is what says whether the credential
  never expires or a Reconnect every sixty days is part of operating the
  number, which is what the seven-day badge exists for. Reconnect — the 190
  recovery — assumes Embedded Signup completes for an already-onboarded number
  and returns a fresh token; confirm it on staging before relying on it.

- **A side conversation to a genuine forwarding list.** Everything below is
  verified against a local Postgres — the plus-address route, the References
  fallback, the signed-subject fallback, idempotent redelivery, and that a hub
  employee never becomes a `contacts` row. What no local test can establish is
  whether a _real_ forwarding list preserves the `Reply-To`, the plus-address in
  `To`/`Delivered-To`, or the `References` chain. Send one to an actual hub list
  and have somebody on it reply. If all three are eaten the reply opens a new
  customer ticket instead, which is visible immediately: the mail lands in the
  inbox as a new ticket from a hub address rather than on the thread. Since
  2026-10-05 this is one send away: the hubs are in `locations` (§5.1). A side
  message marked `sent` only means Postmark accepted it, not that the hub's mail
  group did — a group restricted to its members, or moderated, can hold mail
  from `help-support@` — so the test is a reply landing on the thread, not a
  delivery status.
- **Meta's Human Agent feature is not approved. Confirmed 2026-09-06, and it is
  the whole 24-hour-to-7-day path.** _Was a hypothesis; is now a reading._ A
  Facebook or Instagram reply sent more than 24 hours after the customer's last
  message goes out tagged `HUMAN_AGENT`, and Graph now refuses it by name:

  > To use 'Human Agent', your use of this endpoint must be reviewed and
  > approved by Facebook.

  `code 10, HTTP 403, trace AGtVAa9LUPmavPjHJ07bX3x, via graph.instagram.com`,
  on message `308729d0-4a39-4af4-bdff-5cca1b1c017f` — a deliberate test send
  6d15h after the customer's last message, so inside the seven days and outside
  the twenty-four hours. That closes the item this list carried since 2026-08-20
  as "a hypothesis, and the permission has never been checked": the feature is
  not approved, and until it is, every FB/IG reply between 24 hours and 7 days
  fails this way while replies inside 24 hours keep working — on a support
  channel that is most of them. What is missing is the approval on the
  **Instagram Login** submission, the connection the send is routed over, whose
  permissions are spelled `instagram_business_*`; an approval on the Page
  connection is a different grant and does not reach that host.

  **It also retires the request-shape candidate.** The 2026-08-20 refusal named
  nothing, so the Messenger-shaped body — `messaging_type: MESSAGE_TAG` on an
  Instagram send — was a live second explanation, and `lib/meta/send.ts` was
  written to drop it. This refusal was produced by that same body, and Graph
  still named the feature: it can only do that after parsing `tag`, so the
  parameter was not stopping the request from being understood. `send.ts` stays
  as it is — it is right on the documentation either way, which is the reason
  given for it there — but it is not what was failing.

  Two things that look like counter-evidence and are not, both of which cost
  time on 2026-09-06:

  - **A role on the app is not the exemption here.** It is for a _permission_;
    Human Agent is a _feature_, and Meta's own note on Standard Access is "some
    features might not work properly until your app has been granted Advanced
    Access." The feature reference adds that it "requires successful completion
    of the App Review process" and "is only available with business
    verification". So testing from an account you own does not route around it.
    One thing left to rule out before concluding it is _only_ the approval: the
    Instagram messaging guide requires a tester to hold a role on the app **and**
    on the Instagram professional account, and the account that sent the inbound
    DM is a different identity from the Facebook user holding the app role.
  - **The dashboard's call counter for the feature sits at 0, and must.** A call
    stopped at the capability gate never reaches the feature, so it is never
    counted against it — the same reading recorded for Business Asset User
    Profile Access below. That zero is this refusal restated, not a second
    fault.

  Corroboration that the credential and the route are sound: an Instagram
  private reply went out over the same host and the same token four days earlier
  (`72584c00-93ba-42be-8d4c-de3bc149139a`, `sent`).

  What Meta documents, read from the live pages rather than from memory: message
  tags are written up on the **Messenger Platform** Send API
  (`graph.facebook.com/<PAGE_ID>/messages`), and the Instagram API with Instagram
  Login messaging guide documents only `recipient` and `message` — it describes
  the human-agent case in prose and gives no parameter for it. The feature is
  nonetheless listed for _both_ login types on the Instagram App Review page, and
  the 403 proves `graph.instagram.com` reads the tag. So it is supported and
  ungranted, not unsupported.

  **Two things about the tag are settled in code and no longer need watching.**
  It can only be put on a message a person wrote — `send_meta` reads
  `messages.author_agent_id`, and all three automated senders stop at 24 hours
  rather than seven days — so a scheduled canned response can no longer be
  delivered to Meta as human-written work. And the request bodies for both
  platforms are asserted in unit tests against the node references.

  One residual hole, recorded rather than fixed because the failure direction is
  safe: `messages.author_agent_id` is `ON DELETE SET NULL`, so if an agent is
  deleted while a reply of theirs sits failed-but-retryable, the retry reads it
  as automated and refuses it. That is a refusal, never a false claim of human
  authorship — the right way round — but it is a real reply that will not go
  out.

- **A reaction does not reopen the messaging window in this system, and Meta says
  it should.** `messaging_postbacks`, the referral field and `message_reactions`
  are now subscribed and parsed, and `applyMetaInteraction` records all three on
  the ticket timeline. A postback and a referral also move
  `lastCustomerMessageAt`, so they reopen the 24-hour window as Meta's policy
  describes. A reaction deliberately does not: that column is also what the
  next-response SLA target is measured from, so a customer answering a reply with
  a thumbs-up would be recorded as waiting for us and the agent measured late for
  not answering it. Closing the gap properly needs a second column —
  "when did the customer last interact" is a different question from "when did
  they last ask us something", the same split as `agents.last_seen_at` against
  `last_input_at` — and the window would read the later of the two. Until then a
  thread whose only activity in seven days is a reaction is refused a reply, and
  the customer has to write again.

  A second, smaller consequence of the same design: a postback or a referral
  counts as the customer having written, so it re-arms the automation engine's
  `alreadyReplied` guard, which asks for an `auto_replied` event newer than
  `last_customer_message_at`. A customer tapping through a button menu can
  therefore be sent the same canned reply again with no message in between. That
  follows from the decision that a button press _is_ contact — the guard is
  documented as keying on "since the customer last wrote" — but it is worth
  knowing before `messaging_postbacks` starts delivering.

  **There are six dead `send_meta` rows now, not one.** The Instagram
  HUMAN_AGENT one from 2026-08-20, and five Facebook DMs on 23–24 August that
  failed _inside_ the 24-hour window, on the right page, in a thread this app
  holds control of — the case `insideWindowExplanation` was written for, which
  says in as many words that none of the usual causes applies. Six real customer
  replies that were never delivered. That is a second, unexplained refusal on
  the same channel and it has not been diagnosed; the trace ids are on the
  message rows.

- **Meta's Business Asset User Profile Access — now working for role-holders,
  and refused for everybody else.** _Updated 2026-08-27 14:40 UTC._ The first
  cause was never the approval: `META_PAGE_ACCESS_TOKEN` held a **System User**
  token, which cannot resolve a page-scoped id whatever its scopes say (§6.28).
  With a real Page token in place, the app owner's own Facebook and Instagram
  accounts both resolve — name and picture — while a customer is still refused.
  So the approval described below is a real requirement; it was simply
  underneath a configuration fault that produced the identical error. What
  follows is the record of finding that out, and should be read with §6.28.

  The User Profile API is the only thing that can tell this system who a
  Messenger or Instagram customer is — their webhooks carry a scoped id and
  nothing else, unlike WhatsApp, which puts the profile name in the payload. The
  wiring landed on 2026-08-26 and has been calling Graph since: **17
  `fetch_meta_profile` jobs between 15:26 UTC that day and 11:56 UTC on
  2026-08-27, every one of them refused.** All 29 Facebook and Instagram
  identities still have a null `profile_fetched_at` and a null `name`, which is
  the handler working as designed — a refusal is deliberately not stamped, so
  approval fixes the archive by itself.

  **The App Dashboard reports 0 calls against the feature over the last 30 days,
  and that is consistent with the above rather than a contradiction of it.** A
  call refused at the capability gate never reaches the permission, so it is
  never counted against it. The counter measures _granted_ usage; it cannot
  leave zero while the app is unapproved, and it is therefore not an independent
  problem to chase — it is the refusal, restated. The way to move it before
  approval is Meta's role exemption: a lookup for a person who holds a role on
  the app (admin, developer, tester) is answered without App Review, so have
  somebody with a role message the Page and run
  `npm run job -- backfill_meta_profiles force=true limit=1`. That is also the
  footage App Review asks for.

  **The two platforms fail differently, and only one of them is about App
  Review:**

  - **Facebook — `(#3) Application does not have the capability to make this API
call.`** Eleven refusals, the same sentence each time. This is the missing
    approval, stated as plainly as Graph ever states it.
  - **Instagram — `(#100) The page is not linked to an Instagram account or the
linked IG account is not professional account`.** Six refusals, and **not an
    approval problem at all.** The requests went to `graph.facebook.com`, which
    means `INSTAGRAM_ACCESS_TOKEN` is unset — `endpoint()` keys the host and
    credential on that variable being present. The account was on Instagram
    Login (its own app secret is what verified its webhooks — §6.26), so the
    Page token had no route to an Instagram-scoped id and granting the feature
    would have changed nothing for Instagram.

    **This is now a decision rather than a fix: the account is being moved back
    onto its Facebook Page** (§6.28). Under that setup `INSTAGRAM_ACCESS_TOKEN`
    stays unset and the refusal ends when the link is made in the Meta
    dashboard, not by setting anything here. It also folds Instagram back onto
    the Messenger path, so one Business Asset User Profile Access approval
    covers both platforms instead of one.

  **There is now a button for it.** The ticket header on a Facebook or Instagram
  ticket carries **Refresh profile** (**Fetch name from Meta** where there is no
  name yet), behind `contact.edit`, so an agent can ask again without a shell on
  the worker — and, more to the point, read Meta's answer where they are
  standing. It calls Graph in the action rather than queueing, which `AGENTS.md`
  now records as the one deliberate exception to the job rule and why; the Graph
  call itself is shared with the job in `lib/meta/profile-refresh.ts` so the two
  cannot diverge. The outcome is also written to `conversation_events`, so "we
  asked Meta on this date and were refused" survives the page being closed.

  What made this cost more than it should have: `isProfilePermissionRefusal`
  matched 10, 200 and 100/33 — Meta's documented answer — and not code 3, the
  one that actually arrives. So the log line naming the feature, written
  precisely so nobody would have to guess again after the Human Agent episode,
  **did not print once in 17 refusals.** Fixed, with code 3 in the set and the
  Instagram linkage refusal explained separately; §6.27.

  **The profile call now also asks for `locale` and `gender`**, gated behind
  `pages_user_locale` and `pages_user_gender` on top of the feature above.
  Because Graph rejects the whole request over one unapproved field, appending
  them would have cost the _name_ as well until both landed — so `fetchProfile`
  asks for them first and retries with the base fields on any non-transient
  refusal. The retry deliberately does not key on `isProfilePermissionRefusal`:
  an ungranted field answers `(#100) Tried accessing nonexisting field (locale)
on node type (User)` with no subcode, which that predicate declines by design,
  and keying on it would have missed the case the retry exists for. Transient
  failures still reach the queue's own backoff.

  The values land in `contacts.gender` and `contact_identities.profile_locale`.
  **`contacts.locale` is deliberately not written**, which is worth knowing
  before somebody "fixes" it: that column decides what an auto-reply and a CSAT
  survey go out in on _every_ channel — `preferredLocale` returns 'ar' from it
  without reading the message at all — and nothing had ever set it, so that
  branch was dead. Filling it from a Facebook interface language would wake it
  up and switch a merchant's English email auto-replies to Arabic.

  Two caveats on the log line that names the two permissions. It proves they are
  missing only when Graph _refuses_; if Graph answers 200 with the fields simply
  omitted, that reads identically to a customer who set neither. And the
  identity is stamped either way, so a later approval is picked up only by
  `npm run job -- backfill_meta_profiles force=true` — an unforced run selects
  nothing.

- **Instagram comment management. Facebook comments now work; Instagram's are
  gated by the permission itself.** _Updated 2026-08-29._ Both pipelines were
  proven this morning and they landed in different places:

  - **Facebook: working end to end.** A real comment on a Page post arrived as
    `page` / `feed` / `item: comment`, verified and processed, and
    `ingestMetaComment` created **ticket #10939** — the first comment ticket this
    system has ever made. Meta also sent a `reaction` on the same post, which
    `parseMetaWebhook` correctly dropped.
  - **Instagram: only Meta's test payload.** The "Send to Server" sample from the
    Webhooks page arrived and produced **ticket #10942** ("This is an example.",
    entry id `0`, comment id `1231231234`). That proves the callback, the
    signature check, the Instagram comment parser and the ingest all work — and
    proves nothing about the account, because the test button posts straight to
    the callback whatever the account is subscribed to. **No real Instagram
    comment has ever arrived.**

  **The `instagram` object is the right one, and the subscription is right.**
  Confirmed by running the job: `comments` is already in the app-level field
  list, and the Page-level subscription was written on 2026-08-28. So the
  webhooks are not the problem, and this is where the search should stop rather
  than continue into the dashboard.

  **What actually gates it is the permission we have not applied for.** Meta's
  own prerequisites for receiving the `comments` field are: the app subscribed to
  it, Page subscriptions enabled on the connected Page, the permissions
  `instagram_manage_comments` + `pages_manage_metadata` + one of
  `pages_read_engagement` / `pages_show_list`, **Advanced Access**, **a verified
  business**, and a media owner whose account is not private. The first two are
  done; `instagram_manage_comments` is on no line of the App Review submission
  (`plans/meta-app-review-submission.md`), and Advanced Access is exactly what
  that submission is for.

  **Meta has now confirmed that in writing, and the confirmation was sitting in
  our own table.** _2026-08-30._ Reconnecting the account fires `object:
"permissions"` webhooks, one per grant, and we store them like any other
  delivery. Both reconnections on 2026-08-29 — 15:53 and 16:45 UTC — sent exactly
  two, and no others have ever arrived:

  ```sql
  select c->>'field', c->'value'->>'verb', count(*)
  from webhook_events w,
       lateral jsonb_array_elements(w.payload->'entry') e,
       lateral jsonb_array_elements(e->'changes') c
  where w.payload->>'object' = 'permissions' group by 1, 2;
  -- instagram_basic            granted  2
  -- instagram_manage_messages  granted  2
  ```

  `instagram_manage_messages` granted and `instagram_manage_comments` absent is
  precisely the split the account shows: DMs arrive, comments never do. This is
  the cheapest check there is for "which half of Instagram is live", it needs no
  Graph call and no dashboard, and it should be the first query run the next time
  a channel works in one direction only. It also closes the two cheap conditions
  the item below asks to rule out first — a private account or a self-comment
  would not produce this asymmetry, since neither is permission-shaped.

  **App Review _is_ the blocker, and the `comments` field is Meta's documented
  exception to how access levels normally work.** _Settled from the docs
  2026-08-30, after an intermediate answer here claimed the opposite._ The
  general rule is real — Standard Access needs no review and covers a role
  holder on their own assets — and it does not apply to this field:

  > "Your app must have successfully completed App Review (advanced access) to
  > receive webhooks notifications for `comments` and `live_comments` webhooks
  > fields."

  Meta's Instagram webhooks reference states it twice more: "Advanced Access is
  required to receive `comments` and `live_comments` webhook notifications", and
  the requirements table gives the access level for both as Advanced. So an app
  **admin** commenting on their **own** public post receives nothing until the
  submission is approved, and no amount of regenerating the Page token changes
  that. Confirmed against the live account across three attempts on 2026-08-30 —
  after adding the permission to the submission and after a token regeneration
  and redeploy, still zero `changes` deliveries and, for the comments
  themselves, no HTTP request from Meta at all.

  This is exactly why the channel is split: `instagram_manage_messages` is fine
  at Standard Access for a role holder, so DMs arrive, while `comments` needs
  Advanced Access, so it is silent. **The asymmetry is the field, not the
  account.**

  **Every other precondition is now confirmed, so the approval is the only step
  left.** Both of the conditions that were open on 2026-08-30 have been checked
  and both hold:

  1. **The account is public** — checked 2026-08-30. Meta requires it: "The
     Instagram professional account that owns the media objects must be public to
     receive notifications for comments or @mentions."
  2. ~~The Page-level subscription must carry `comments`.~~ **Wrong, and
     disproved by Meta's Webhook Debugger the same day** — see §6.35. For a
     Page-connected account the app-level subscription is the only one that
     carries Instagram fields; the Page's list uses Page vocabulary, which has
     no `comments` in it. Both halves check out on this account already.

  So when Advanced Access lands, nothing else has to be changed or run for the
  first comment to arrive: `comments` is already subscribed at the app level, the
  account is linked and public, the Page is installed, and `ingestMetaComment`
  has already been exercised end to end on both platforms (#10939, #10942). If a
  comment still does not arrive after approval, that is new information — start
  at §6.35's debugger, not at the parser.

  `npm run job -- check_meta_permissions` reports the grant and now also warns,
  on the _passing_ line, that this one capability needs Advanced Access on top.

  That is a real chicken-and-egg and it is **asymmetric between the two
  platforms**: `feed` on a Page needs only `pages_manage_metadata` and
  `pages_show_list`, which the token already has, so Facebook comment footage can
  be recorded today. Instagram's cannot, because the permission being applied for
  is the same one that would let the notification arrive. The way through is
  Meta's role-holder exemption under Standard Access — a comment from somebody
  holding a role on the app — or a support conversation; it is not another
  subscribe job. Check the two cheap conditions first, though: the account must
  be **public**, and it is worth testing a comment from a _different_ account,
  since nothing in Meta's docs confirms self-comments notify.

  The three items below predate all of this and are kept for the order they set
  out:
  1. `META_INSTAGRAM_APP_SECRET` in `shipblu-support-production`, or every
     Instagram delivery keeps being answered 403 (§6.26). Nothing about comments
     can be tested while inbound Instagram is rejected.
  2. `npm run job -- subscribe_meta_webhooks object=instagram`, to add the
     `comments` field, and `object=page` for `feed`. **The `page` half is now
     done** — run 2026-08-28 18:00 UTC. It confirmed the diagnosis exactly: the
     app level already listed `feed` among 29 fields, the Page level carried 18
     and `feed` was not one of them, and the write added it. Nothing has arrived
     through it yet, because a `feed` event needs somebody to comment; that
     comment is the outstanding step, and it is also the App Review footage. **Zero comment webhooks
     have ever arrived** — re-checked 2026-08-28, still 0 of 4,503 `page` and
     `instagram` deliveries carrying a `changes` entry — so `ingestMetaComment`
     has never run in production and there are no comment threads to look at.

     **A Page webhook has two subscriptions and this job only ever wrote one.**
     Meta delivers a field only when it is subscribed at _both_ the app level
     (`POST /{app-id}/subscriptions`) and the Page level
     (`POST /{page-id}/subscribed_apps`), and the second had no implementation
     at all — which is why `feed` sat in `REQUIRED_PAGE_FIELDS` for weeks
     delivering nothing while the app-level list looked correct. `object=page`
     now does both halves, the Page one with a Page token rather than the app
     token, and the app-level "nothing to add" no longer returns early past it.
     That write also needs `pages_manage_metadata` and `pages_show_list` on the
     token, which is worth knowing because Graph's refusal names neither.

  3. The App Review approval itself, which nothing has confirmed. Graph refuses
     an unapproved hide or delete with `100/33 "Unsupported post request"`, the
     same sentence it uses for a comment that is already gone;
     `explainMetaModerationError` names the permission in the failure so the two
     are not confused, which is the lesson from the two bullets above.

  Then: comment on the account's own post from another Instagram account, reply
  publicly from the console, hide it, unhide it, delete one. Each is a beat in
  the screencast App Review asks for, and each now writes a
  `comment_hidden` / `comment_unhidden` / `comment_deleted` event.
  `plans/instagram-comment-management.md` has the whole order of operations.

- **The portal's verification and reset emails through Postmark.** The whole
  flow has been driven end to end against a local Postgres with
  `EMAIL_PROVIDER=local`, so the links, the tokens and the single-use rules are
  exercised — but nothing has yet been delivered by a real provider to a real
  inbox. Watch two things in particular: that the link survives corporate link
  scanners (verification tolerates a replayed token for exactly this reason, a
  reset deliberately does not), and that `Auto-Submitted: auto-generated` keeps
  autoresponders from opening a ticket per verification email.

### 5.3 Phase 7 — ticket, conversation and contact importers

Not started. The KB importer is the working model: idempotent on
`(source_system, external_id)`, re-runnable, enqueued from `/admin/import`, and
it repairs its own earlier rows rather than duplicating them. Every
customer-facing table carries those two columns for exactly this reason.

### 5.4 The shipping platform read API — designed, not built

The queries the endpoint would call exist and are used by the console today, in
`lib/shipments/queries.ts`: `conversationsForTrackingNumber`,
`conversationsForSbid`, `getShipmentByTrackingNumber`, `getShippingAccountBySbid`
and `contactsForSbid`. None of them takes a `SessionAgent`, which is the seam —
the console wraps them with the agent's permissions and the endpoint would wrap
them with the key's. Baking `can()` in would force the endpoint to invent a fake
agent, which is how an API ends up reaching further than any human.

What is left is the endpoint and its credential. There is still **no inbound API
key mechanism anywhere in this system**: `lib/auth/tokens.ts` and the widget's
visitor token (only the SHA-256 stored) are the precedent to extend, and a new
`api_keys` table is the missing piece. Two things to decide before writing it,
both much cheaper now than as a retrofit:

- one server-to-server platform key, or per-merchant keys? It determines whether
  `shipping_account_id` belongs on the key row.
- the endpoint must pass `restrictedChannels()` in its scope. A bot transcript is
  kept off the shop floor for the team; handing one to an external caller is
  worse.

Whatever it returns should stay conversation _summaries_ and a deep link, never
message bodies — the same reasoning as the deliberately tiny `pg_notify` payload.

### 5.5 Loose ends

- **The dead-letter queue has 57 rows in it and, until 2026-09-21, nobody had
  read them.** `/api/health` reported `dead: 56` unchanged for eleven days; the
  57th was added deliberately on 2026-09-21 and is the only one anybody has
  acted on. Four populations, and they want different answers:

  - **43 × `download_media`, all `Media download failed (500)`.** Outage-shaped
    rather than systematic — they cluster on 2026-08-29/30 (36 of them) and
    2026-09-09 (5), against 240 completed including one that succeeded today. But
    a dead job is never cleaned up and the dedupe key is **spent for good**
    (`download_media:<mediaId>`), so re-enqueuing does nothing and those 43
    customer attachments are gone. If a customer photographing a damaged parcel
    matters, the recovery path is a handler that keys differently, not a retry.
  - **7 × `send_agent_invite`**, 2026-09-03 — see §5.1's agents entry.
  - **6 × `send_meta`**, unchanged and already diagnosed in §5.2.
  - **1 × `subscribe_meta_webhooks`**, 2026-09-21, and this one is a result
    rather than a fault. It was enqueued on purpose to add `message_echoes`, and
    its five identical refusals are the evidence that Meta has discontinued that
    field — the §5.1 entry above is what it produced. It changed nothing in
    production: the merge preserved `messages` on every attempt and inbound never
    paused. Left in the table rather than deleted, because deleting the row would
    throw away the only durable record of that run; `last_error` on it is the
    Graph refusal itself.

  The lesson worth keeping is the shape: nothing surfaces a dead job to a human.
  The count is on `/api/health` and on `/admin`, and both are places you have to
  already suspect something to look at. The eleven days of an unmoving `dead: 56`
  is the demonstration — it took somebody querying the table for any of it to be
  read, and three of the four populations are still unactioned.

- **Three superseded columns are still in the schema, waiting for every service
  to be on new code.** `holidays.name`, `canned_responses.body_html` and
  `canned_responses.body_text` were replaced by `*_ar` / `*_en` pairs in
  migration 0025, which adds and does not drop. The reason is the deploy shape,
  not caution: `preDeployCommand: npm run db:migrate` is on the two **web**
  services only, so the worker and the four crons carry on running old code
  after a web deploy has migrated — and old code selects `holidays.name` inside
  `loadHoursCatalog`, which is on the SLA sweep, assignment, the nightly rollup
  and the widget's open/closed check. Dropping in the same release would have
  taken all of that down for the length of the deploy window. Drop them once
  the worker and crons are confirmed on a build that no longer reads them, and
  take the two writers below out in the same commit.

  **They are written, and the sentence that used to be here said they need not
  be.** "The columns default to `''`, so nothing has to be written to them in
  the meantime" is true of the rows that existed and false of every row created
  since: a canned response added after the migration reached the still-old
  worker as an empty body, which it sends. So `saveCannedResponse` and
  `saveHoliday` fill the superseded column from whichever language was written,
  Arabic first. A window where only one side is written is not an expand phase,
  it is the contract phase arriving early for anything new.

  Both tables were empty in production when 0025 was written and still were on
  2026-09-05 (`select count(*)` on each), which is the only reason this cost
  nothing. `db/sql/004_bilingual_backfill.sql` moves the content anyway, because
  staging and any future environment will not be empty — see §6.60.

- **`Merchant Care WABA` is connected to an id that holds no templates, and
  nothing said so.** The row was added by hand on 2026-08-23 17:33, 33 minutes
  after the hourly sync adopted the real one, and carries
  `waba_id = 26784926584531240` — 17 digits, where the working account
  (`128772296801141`) and every other WABA id here are 15. It has never appeared
  as `entry[0].id` on any of the 131,690 WhatsApp webhooks received, owns no
  channel, and has returned zero templates on every sync since.

  The sync is not failing: `graph()` throws on any non-2xx and `last_sync_error`
  is null, so Meta is answering **200 with an empty list**. That is the same
  answer an empty WABA gives and the same answer an id that is not a WABA gives,
  which is why this sat unnoticed. One call settles which:
  `GET /{id}?fields=id,name` with the same token names the object. Until
  somebody runs it, the console now at least says the account read back nothing
  — see the `no templates` badge added with this note.

- **`contacts.locale` is never written, so every contact reads `'en'`.** All
  **28,661** of them sit at the column default (re-counted 2026-09-20; it was
  6,244 when this was written, so the cost of the workaround is growing), and `lib/contacts/merge.ts` already
  documents why that is not the same as knowing: `'en'` means either "reads
  English" or "nobody has ever said". Anything that picks a language off it is
  answering an Arabic-first customer base in English — **CSAT surveys are doing
  that today** (`worker/handlers/send-csat.ts` reads the column directly). Two
  senders work around it by reading the script of the customer's own message —
  the out-of-hours reply and, since canned responses became bilingual, the
  canned reply an automation rule sends — through `preferredLocale()` in
  `lib/tickets/locale.ts`. That is a workaround and not the fix, and it is now
  in one module precisely so the next sender does not invent a third answer. The
  fix is to set the column at ingest — the widget and the portal both know the
  locale from the URL they were opened on, and a WhatsApp or email contact can
  be read the same way the auto-response reads it.
- One imported article's detected language disagrees with its category. The
  importer counts and reports these rather than silently refiling them; someone
  who reads Arabic should look at it.
- **A folder or category name is not searchable, in the console or on the help
  centre.** `kb_articles.search_vector` is generated from the title and body
  only, so "ساعات العمل" finds nothing even though a folder is called exactly
  that — and those names are often the words a person thinks in. Fixing it means
  changing the generated column, so it is a migration rather than a query
  change. Surfaced by the composer's knowledge panel, where an agent typing a
  team or topic name is the obvious first thing to try.
- ~~`KB_PUBLIC_HOST` is unset, and the composer now pastes URLs built from
  it.~~ **Both halves of that were wrong**, and it is worth keeping as a lesson
  rather than deleting: the variable is _set_, to a domain that still answers as
  Freshdesk, so the links did not "still resolve" — every one of them 404'd. The
  claim came from reading §5.1's unset-config list instead of asking production,
  which is exactly what "verify, do not infer" is for; one `curl` of
  `/widget/embed.js` showed the real value in a second. Article links in the
  composer and the editor now come from `requestBaseUrl()` and follow the host
  the agent is on. §5.1 carries what is still broken for everything else.
- ~~`logged_in` and `selected_companies` knowledge base articles are still not
  served.~~ Both are evaluated now. `publiclyVisible()` is gone; every query in
  `lib/kb/queries.ts` takes a `KbViewer`, resolved from the portal session by
  `kbViewer()`, and the rule itself lives in `lib/kb/visibility.ts`.

  **The viewer is a required argument, and that is the security design.** A
  missed call site is a compile error rather than an internal runbook in
  Google's index — there is no zero-argument predicate left to call by accident,
  so a query written next year cannot forget the rule. `tsc` found all fourteen
  call sites when the parameter was added.

  Two callers pass `ANONYMOUS` and always must:

  - **The sitemap.** `allPublishedArticles()` takes no viewer at all, so it
    cannot be handed a customer by someone being helpful. A `logged_in` article
    listed there would be advertised to the open web by the one file whose job
    is telling crawlers what to fetch.
  - **The widget's search.** The widget authenticates a _visitor_ — a token
    minted for a browser on somebody else's site — which is not the portal
    session that says who a customer is.

  **A folder's visibility gates the articles inside it**, so a public article in
  a `logged_in` folder needs a sign-in. The folder is what the navigation
  exposes; an article reachable by URL from a folder nobody can list is a hole
  in the hardest place to notice.

  This is only safe because every help centre page is `force-dynamic`. **A
  cached page that varied by viewer would serve one signed-in customer's render
  to an anonymous crawler** — if any of them is ever given a `revalidate` or made
  static, it has to stop calling `kbViewer()`. The comment on that function says
  so.

  `selected_companies` resolves against `contacts.company_id` against the
  article's `visible_to_company_ids`. It is **correctly evaluated but still
  serves nothing in practice**: neither the article editor nor the folder form
  offers that level, so the only source is the Freshdesk importer, and nothing
  populates `visible_to_company_ids` — an imported one has an empty allowlist,
  which matches nobody. Finishing it means a company picker in the editor and a
  mapping in the importer; until then the level is safe rather than useful.

- Ticket statuses show customers the configured `customer_label` or a plain word
  for the category in their own language — never the status's own name. That
  field has no per-locale variant, so setting it pins one language for every
  reader; leaving it null is usually the better answer.
- ~~**Custom ticket fields can be defined and referenced, but never carry a
  value.**~~ Built. `conversations.custom_fields` is written by two forms now —
  the conversation sidebar in the console, gated on `ticket.edit_fields`, and
  the portal's new-ticket form for any field marked both visible _and_ editable
  by customers — so a condition on `custom.<key>` finally matches something.
  Both required flags are enforced: `required_on_create` refuses a portal
  ticket, `required_on_resolve` refuses an agent's move to a resolved status and
  the reply-and-resolve button with it, naming the fields that are empty.

  Four decisions worth not re-deriving. **Neither flag stops an automation** —
  a rule cannot fill a field in, so enforcing it there would wedge tickets
  nobody was asked to clear. **`required_on_create` is checked only against the
  fields a customer can see and edit**, because an admin can mark an
  internal-only field required and a customer has no way to answer it; without
  that filter one such field would refuse every ticket anybody tried to open.
  And **"empty" is defined once**, in `isBlank`, deliberately mirroring
  `isEmpty` in `lib/rules/conditions.ts` — otherwise a ticket could read as
  complete on the form and empty to a rule. A consequence: an unticked required
  checkbox counts as answered, because "no" is an answer. Finally, **the console
  patches the column in the database** (`custom_fields || '{...}'::jsonb`, or
  `- 'key'` to clear) rather than reading the map, merging in JavaScript and
  writing it back: the sidebar saves on every change, so two agents on one ticket
  editing two different fields would otherwise race and the slower write would
  silently undo the other.

  What is still missing is the **importer mapping**, which belongs with §5.3
  rather than here — a Freshdesk ticket's custom fields have nowhere to land
  until the ticket importer exists. `usage_count` on canned responses was the
  other member of this family and is now counted on send (below).

- ~~`canned_responses.usage_count` is never incremented, and the reason is
  bigger than the column.~~ Both halves are done. The composer's reply tab now
  carries a picker, scoped to the agent's own `personal` responses, their teams'
  `group` ones and everything `global` — in the query rather than in the
  renderer, because a list narrowed after it is built is a list already sent to
  the browser, and a personal response is somebody's own draft wording. Each arm
  tests its own key too, so an orphaned `personal` row with a null `agent_id` is
  visible to nobody rather than to everybody.

  ~~`usage_count` is incremented by both senders — the agent's composer and the
  automation's `send_reply`, which had been reading the body and leaving the
  count alone.~~ Agents only since 2026-10-07; see below. **Counted on send, not
  on insert**, so a response an agent
  reached for and thought better of does not score. It over-counts in one
  direction on purpose: an agent who inserts one and rewrites every word still
  registers a use, because the alternative is diffing the sent body against the
  stored one and picking a similarity threshold nobody can defend. Two snippets
  in one reply attribute to the last one picked, because the column counts
  replies rather than fragments.

  ~~The figures start from this change, so **a response the team has sent for
  months still starts at zero** and the ranking is only meaningful once some
  traffic has gone through it. The tooltip says so.~~ It never applied to a
  production row, and the tooltip no longer says it; see below.

  **A response is now two bodies, one per language, and the picker carries a
  toggle beside it.** It opens on the language the customer is writing in — the
  same `detectLocale` reading the knowledge panel beside it searches on — so an
  agent answering an Arabic ticket reaches for the Arabic wording without
  touching it. A response written in only one language stays in the list and
  says so on its own option rather than disappearing, because the team writes
  the Arabic first and hiding the rest would make the boilerplate look missing.
  `send_reply` had to make the same choice with nobody to ask, and makes it per
  ticket through `requesterLocale()` rather than at the rule — one rule serves
  both halves of the queue. `usage_count` still counts replies rather than
  languages: which language a response goes out in is not what the column ranks.
  (The split below sits beside it rather than changing what it counts.)

  **Since 2026-10-07: agents only, and split by language.** Two changes the team
  asked for together. An automation's `send_reply` **no longer counts** — the
  column says which responses agents reach for, and a rule sends its response to
  every ticket it matches, so one acknowledgement rule would outrank everything
  chosen by hand. Production had never had a `send_reply` rule and every one of
  its 62 responses stood at 0 that day, so nothing already counted needed taking
  back. And the agents' uses are now split by language in `usage_count_ar` and
  `usage_count_en`, beside the total, with `/admin/canned` showing all three.
  The language is the body the composer inserted — posted as `cannedLocale`
  beside `cannedResponseId`, and the one `resolveLocale` chose rather than what
  the toggle says, so an Arabic-only response picked with the toggle on English
  counts as Arabic. `recordCannedUse` in `lib/tickets/canned-usage.ts` treats
  both the posted id and the posted language as claims: it re-reads the response
  through `cannedVisibleTo`, the rule the picker's list is built from (so
  somebody else's personal response, or a team's the agent is not on, counts
  nothing), and puts the language through `resolveLocale` against the bodies it
  just read. Then it moves the total and the language in one statement, and it
  never throws. The total stays the
  authority and the split is a breakdown of it: a use posted without a language
  (a console tab rendered before the deploy) moves the total alone, so Arabic
  plus English can be less than Used. Nothing can backfill it — no message row
  records which canned response it came from.

  The old tooltip's "a response the team has sent for months still starts at
  zero" never applied to a production row, and it is gone. Counting went live
  on 2026-08-22 (#70), and all 62 responses were created on 2026-10-06, so each
  has been counted since it existed. Their zeros mean no agent had sent one: the
  last agent reply in production was on 2026-09-26.

  The same change closed two ways the composer over-counted, both reproduced in
  Chromium before the fix. **A refused send** (a required field, a missing root
  cause, a closed window) had React reset the form (§6.80): the textarea came
  back empty while `ReplyBody` and its hidden field kept the earlier pick, and
  the reply the agent then wrote from nothing was counted as that response. And
  **clearing the box** by hand kept the pick too. `ReplyBody` now forgets the
  pick whenever the agent empties the box; a reworded response still counts, as
  before. The first it also caught on the form's `reset` event, until #337 moved
  the reply form onto `useActionForm`: a refusal now keeps the agent's text and
  the pick together, so there is no reset left to listen for.

- **The dead-scaffolding sweep, run rather than recommended.** §1 has said it is
  worth grepping for other columns nothing reads or writes; this is the answer as
  of `e5e2f8a`. Of 548 columns across 52 tables, five are referenced nowhere in
  `lib/`, `app/`, `worker/` or `components/`:

  | Column                               | What it was for                                                   |
  | ------------------------------------ | ----------------------------------------------------------------- |
  | `kb_articles.visible_to_company_ids` | read by the visibility rule now; still written by nothing (above) |
  | `kb_folders.visible_to_company_ids`  | the same, at folder level                                         |
  | `conversations.parent_id`            | child tickets — nothing creates one, and no UI offers it          |
  | `messages.bcc_addresses`             | BCC on an outbound email; the composer has no field for it        |
  | `conversation_presence.is_typing`    | a typing indicator; the focus beat writes the row but not this    |

  None of them breaks anything by sitting there, and none is worth building on
  spec. They are listed so the next session can tell "deliberately unbuilt" from
  "somebody forgot", which is the distinction that cost the time when
  `custom_fields` turned out to be the second kind. The command is
  `db/schema` parsed for column names, grepped against those four directories —
  cheap enough to re-run whenever a feature lands.

  Note what the sweep does **not** catch: a column that is read but never
  written. That is the `custom_fields` shape and the more dangerous one, because
  the reader makes it look alive. Nothing mechanical finds those; they turn up
  by asking, of each read, who writes it.

- ~~`metrics_daily` rows written before the totals-slice fix are inflated.~~
  Repaired. `rollup_metrics` now takes a range (`{"from","to"}`, `{"days":N}`)
  and rebuilds those days from the source tables, and every write asserts that
  the totals row equals the sum of its channel rows — the invariant the bug
  broke — failing the run if it does not. To rebuild history after any future
  change to the figures, enqueue a job row rather than waiting for the nightly:

  ```sql
  insert into jobs (type, payload) values ('rollup_metrics', '{"days": 90}');
  ```

  The running worker claims it within seconds. `npm run job -- rollup_metrics`
  cannot carry a payload (`run-job.ts` passes `{}`), so the queue is the route
  for anything other than the default three-day window.

- **Connections are left mid-transaction by the pooler. Reaped, not solved.**
  Backends appear as `state=active` + `wait_event=ClientRead` with an open
  transaction — the extended query protocol interrupted after Execute and
  before Sync, i.e. a client that stopped mid-statement. They hold their locks
  and a `max_connections` slot (60) until killed; on 2026-08-19 two sat on
  `agents` for six hours and blocked every deploy (§6).

  What was ruled out, with evidence:

  - _Deploys and instance restarts._ No deploy ran at either leak onset.
  - _Aborted server renders._ 60 console requests killed 40 ms in, mid-render,
    against plain Postgres: zero stuck backends. The pooler has to be in the
    path.
  - _The client library._ postgres.js defers `end()` while a query is in flight
    and sends a proper Terminate; it never closes mid-query.

  What triggers it inside Supavisor (or the Render↔Supabase network) is **not
  established**.

  **Revised 2026-09-09: the app can produce this signature on its own, and the
  ruling-out above has a gap.** The 09-08 freeze stranded five connections that
  the reaper then killed, and the web process was the cause —
  `app/api/events/route.ts` wires its abort handler at L98, _after_ seven
  sequential `LISTEN` round trips, so a client that disconnects inside that
  window leaves a `sessionSql()` client (`idle_timeout: 0`) with no remaining
  handle, and the `catch` at L68–73 omits `end()`. No pooler needed. The
  aborted-render experiment above tested _aborting a render_; it did not test a
  stalled event loop or an exhausted pool, which is what happened. That is a gap
  in the experiment rather than a contradiction of it — but "it cannot be
  instrumented from the app side" was wrong, and the instrumentation that is
  actually missing is postgres.js's own queue depth. See
  `plans/web-freeze-2026-09-08.md` and §62.

  So it is reaped rather than prevented: `transaction_timeout = '5min'` is set
  on the `postgres` role, which terminates any transaction spanning longer than
  that, including the implicit single-statement kind these are (verified on
  17.6: `25P04`). `idle_in_transaction_session_timeout` would _not_ catch them,
  because they report `active` rather than `idle in transaction`. Migrations opt
  out in `db/migrate.ts` — building an index legitimately runs long.

  If the leak rate ever rises enough to matter before the reaper fires, find
  them with:

  ```sql
  select pid, state, wait_event, now() - xact_start as age, left(query, 80)
  from pg_stat_activity
  where xact_start < now() - interval '5 minutes' and pid <> pg_backend_pid();
  ```

- **The sign-in throttle's bucket map is bounded now; for the whole of the
  project's history it was not.** `lib/auth/throttle.ts` keys a bucket per email
  and per source, for sign-in and for anything that sends mail to a typed
  address. `hit()` only resets a key it sees _again_ and `clearLoginAttempts`
  only deletes on a successful sign-in — and the `mail:` / `mailip:` keys had no
  remover at all — so a key used once was never removed by anything.
  `pruneThrottleBuckets()` was written for exactly this, carried the comment
  "keeps the map from growing without bound on a long-lived instance", and had
  no caller in the repo's history. So an attacker spraying distinct addresses at
  `/login` was filling a Map rather than being throttled by one, on the endpoint
  that is reachable without signing in.

  Swept inside `hit()` instead, amortised: one O(size) pass per 256 _new_ keys,
  counted on the branch that adds one, so the sweep is paid for by the growth it
  bounds. Not a timer and not the `cleanup` job, because neither can reach this
  — the map is per-process heap, a request-scoped web process has nothing to
  hang an interval on, and a job runs in the worker. `throttleBucketCount()` is
  exported only so a test can assert the bound: ten rounds of a thousand fresh
  addresses a window apart settle under 4,000 entries, where the unswept version
  holds 20,002.

- **A side conversation marked done reopens when the hub actually answers, and
  this is already right — an earlier draft of this entry said otherwise.**
  `isSideConversationOpen` claimed in its own doc comment to be "used by the
  reply action to refuse writing into a thread that is done". Nothing called it,
  and the comment described a policy this system does not have: `ingestSideReply`
  sets `state: 'open'` and clears `closed_at` when a reply arrives on a `done`
  thread, guarded by `!automation.isAutomated` so an out-of-office does not
  count. That is the better answer of the two — refusing would drop the thing an
  agent was waiting for — and it matches what a customer's reply does to a
  resolved ticket.

  Recorded because the mistake is instructive twice over. The dead function's
  comment sent one reader looking for a refusal that was never written, which is
  §6.63's whole point; and this entry then repeated the claim as a known gap,
  which would have sent the next session to "fix" working behaviour. A gap
  asserted from a deleted function's comment is not a gap until the live path
  has been read.

- **An article can now be linked to its translation from the console, and that
  is the first half of two.** `kb_articles.translation_group_id` is
  `notNull().defaultRandom()`, so every article starts alone in a group of its
  own, and the help centre's switcher renders whatever shares the group
  (`translationsOf`). Until this branch nothing outside the Freshdesk importer
  ever wrote the column: `linkTranslation` was the one code path that could and
  had never been referenced from any `.tsx` file, so it was a live `'use server'`
  endpoint with no caller. It is now wired to a **Translations** section in the
  article sidebar, which lists what this article is already linked to and offers
  every other article the reader may see in another language. Both sides are
  re-checked server-side, and the candidate list goes through `readableByRole`
  for a sharper reason than the other read models: an unfiltered dropdown would
  leak the titles of admins-only runbooks to a supervisor.

  **This costs nothing today and would have opened at the first natively
  authored pair.** All 112 production articles came from Freshdesk, where the
  importer sets the groups: 54 of the 58 groups are correct ar/en pairs, and the
  four singletons are placeholder rows all titled "مقالة جديدة", not content
  waiting to be linked (queried 2026-09-09). The gap was prospective, which is
  why it was worth closing before `seed_console_handbook` and the editor start
  producing native content.

  **TODO — the second half, and two rough edges the first half leaves:**

  1. **`saveArticle` should accept a group to join at creation.** Writing the
     second language is currently a save followed by a separate link, and a
     person can do the first and forget the second — which produces exactly the
     unlinked pair this exists to prevent. "Add a translation" from an existing
     article, carrying its group into the new row, is the workflow that cannot
     be half-completed.
  2. **There is no unlink.** A wrong link can be pointed somewhere else but not
     undone back to "alone", because that means allocating a fresh
     `translation_group_id` and nothing exposes that. Cheap to add next to the
     picker; left out here to keep the restoration reviewable.
  3. **Linking moves only this article, so a group it was already in is left
     behind.** Right for two locales — "this is the Arabic of that" — and the
     thing to revisit if a third is ever added, when the intent becomes "merge
     these groups" rather than "point this one".

- **`jobs` carries the high-water mark of its busiest week, and reclaiming it is
  a manual step.** On 2026-09-09 the table held **1,150 live rows in 52 MB**, 30
  MB of it indexes, `jobs_dedupe_idx` alone 15 MB — the one table the Supabase
  advisor calls bloated. That is its shape rather than a fault: ~200,000 rows are
  inserted and deleted every seven weeks, and vacuum makes space reusable
  without shrinking the files.

  `db/sql/005_storage_parameters.sql` lowers the autovacuum scale factors so the
  churn is collected on absolute counts rather than on a fifth of a table that is
  almost always tiny. That slows further bloat; it gives nothing back. Reclaiming
  what is already there is:

  ```sql
  REINDEX INDEX CONCURRENTLY jobs_dedupe_idx;
  ```

  Run it by hand — `CONCURRENTLY` cannot go in `db/sql/`, because `db/migrate.ts`
  sends each file as one `sql.unsafe(contents)` and therefore one implicit
  transaction. Check the `pg_stat_activity` query above for a conflicting lock
  first: this is the table the worker claims from every second.

---

## 6. Traps that have already bitten us

Each cost real time. Most are also comments in the code.

1. **`NODE_ENV=development` is set globally in this container** and breaks
   React's export-condition resolution during prerender, failing with
   `Cannot read properties of null (reading 'useContext')`. `npm run build` pins
   `NODE_ENV=production` for exactly this reason. This was first misdiagnosed as
   a Next/React version incompatibility, and a version matrix was bisected
   before anyone checked the environment.
2. **RSC prefetches of a `force-dynamic` route return 200 without running the
   page.** A 200 in the request logs is not evidence the page renders. Only full
   navigations — no `?_rsc=` — tell you anything. This turned a 404 hunt into an
   afternoon.
3. **`npm ci` under `NODE_ENV=production` skips devDependencies**, which broke
   Render builds; hence `npm ci --include=dev`. The same pruning removes `tsx`,
   which the worker needs _at runtime_ — it lives in `dependencies` deliberately.
4. **`generateValue: true` on a per-service env var evaluates independently per
   service.** `APP_SECRET` came out different on every service, which would have
   made every customer email reply fail HMAC verification and silently open a
   new ticket instead of threading.
5. **Render gives service-level env vars precedence over group values** (§2).
6. **Next hands dynamic route params over still percent-encoded.** Every Arabic
   slug 404'd while the pages above them, which take no parameter, looked
   healthy — so it read as an import bug. `decodeSlugParam()` in `lib/kb/slug.ts`
   is the fix; use it in any new route that matches a param against stored text.
7. **Egypt reinstated DST in 2023** — Cairo is UTC+2 in winter, UTC+3 in summer.
   Hand-converted test fixtures produced six failures against correct code.
   Build test instants from Cairo wall-clock with luxon and let the timezone
   database do the conversion.
8. **WhatsApp's 24-hour window belongs to a (business number, customer) pair.**
   Replying from a different number is a re-engagement message to someone who
   never engaged — and the send API _accepts_ it, with the rejection arriving on
   a status webhook a second later, so no pre-send check can catch it. The
   sending number is resolved from the conversation for this reason.
9. **ASCII slugify erases Arabic entirely**, collapsing every Arabic article
   onto one URL.
10. **Freshdesk visibility must default closed.** `visibility === 3 ?
'agents_only' : 'public'` publishes internal content the first time
    Freshdesk adds a level we have not seen.
11. **A worker retrying a bad password every few seconds trips Supavisor's
    shared auth circuit breaker**, locking every other service out of the
    database. `lib/queue/backoff.ts` classifies failures so auth errors back off
    hard.
12. **Postmark's `MessageID` is an internal UUID, not the RFC `Message-ID`
    header.** Storing it as the message's channel id breaks threading for every
    reply. `SendResult` keeps `providerMessageId` and `rfcMessageId` separate.
13. **One untranslated item can veto an entire language.** Freshdesk language
    discovery probed a single category; ShipBlu's first category is an
    untranslated internal staff guide, so `en` 404'd there and the English pass
    was skipped for the whole account — reporting success, with half the
    knowledge base missing. Probe several items, and articles as well as
    categories. Any "does this exist?" check against one sample has this shape.
14. **A silent success is worse than a failure.** That import read "58 articles"
    and looked clean. Counts that can hide a systematic gap should be broken
    down along the dimension that can fail — per language, per channel, per
    account.

15. **Replaying `db/sql/` took an ACCESS EXCLUSIVE lock on every busy table.**
    The file dropped and recreated identical triggers on each deploy, so a
    deploy needed an exclusive lock on `agents`, `conversations`, `messages` and
    the rest to do nothing at all — and any concurrent _reader_ blocked it. On
    2026-08-19 two connections left mid-transaction on `agents` sat in
    `ClientRead` for six hours, and every deploy from 16:45 onward died on
    `DROP TRIGGER IF EXISTS touch_updated_at ON agents` after burning the full
    two-minute `statement_timeout` — reporting only "canceling statement due to
    statement timeout", which points at the migration rather than at the
    connection actually responsible. The trigger DDL is now skipped when the
    trigger already exists, so the steady state takes no locks, and
    `db/migrate.ts` sets `lock_timeout = 10s` and prints the `pg_stat_activity`
    query to run when it does hit one. **Connections left mid-transaction are a
    live problem in their own right** — new ones appear within minutes; see §5.5.

16. **`CREATE INDEX CONCURRENTLY` cannot go in `db/sql/`.** `db/migrate.ts`
    sends each file as one `sql.unsafe(contents)`, which under the simple query
    protocol wraps the whole file in an implicit transaction, and
    `CONCURRENTLY` cannot run inside one. The three shipment trigram indexes
    there build on tables that were empty at first deploy, so the blocking build
    cost nothing — but an index on a table the size of `messages` needs its own
    migration. There is a note to this effect in the file itself.

17. **A count of digits is not a count of tracking numbers.** `shipments` sat at
    zero across 9,544 messages while 837 of them contained a six-or-more-digit
    run — which reads as the conservative detection pattern under-matching, and
    invites widening it to bare numbers. Reading the messages instead of the
    aggregate showed the digits were GPS coordinate fractions from shared pins
    and Egyptian postal codes inside geocoded addresses. One "tracking number"
    appearing six times, which looked like the clinching evidence of a real
    parcel being chased, was a coordinate fragment.

    Widening the pattern on that basis would have attached junk shipments to
    hundreds of real tickets — the failure `lib/shipments/detect.ts` is
    deliberately built to avoid, arrived at by way of the metric that was
    supposed to justify the change. **This is trap 14 inverted**: there, a total
    hid a real gap; here, a total invented one that was not there. Same lesson
    either way — before acting on an aggregate, read the rows underneath it.
    Both times the rows were one query away.

    **Follow-up, 2026-08-30.** The real format arrived — thirteen-plus digits,
    bare — and it vindicates the restraint twice over. Widening to _six_ digits
    on the strength of that 837 would have been wrong; widening to thirteen,
    which is what the format actually is, matches 24 real numbers and one spam
    link. The archive that looked like evidence of under-detection was hiding 24
    genuine tracking numbers all along, none of which the letters-and-digits
    default could ever have caught. Reading the rows is what distinguished the
    two widenings, and it was the same one query both times.

18. **A module reachable from the search parser must not call `env()`.**
    `lib/shipments/detect.ts` reads its three variables straight from
    `process.env`, because `env()` validates the whole schema and the detector is
    imported by `parseSearchTerm` — going through it made an inbox search fail on
    a missing `DATABASE_URL` in any context without a database. Same shape as the
    bug that made `APP_URL` optional. The variables are still declared in
    `lib/env.ts` so that file stays the catalogue of what this system reads.

---

19. **A fixed-position iframe parts an iOS caret from its field.** The caret is
    positioned against the document rather than against the fixed element the
    input belongs to, so a page scrolling behind the chat panel drags the
    visitor's cursor across the page while they are typing. They need not scroll
    deliberately either: Safari scrolls the document to reveal a focused input,
    and zooms the page in on any field under 16px, which is another scroll. The
    widget pins the host body while its full-screen panel is up and sizes both
    of its fields at 16px. Chromium reproduces none of this, emulated phone or
    not — the caret is the one part of that fix nothing here can test.

20. **A JS `Date` cannot be a keyset-paging cursor over a Postgres timestamp.**
    Both backfills paged on `(created_at, id)`, taking the cursor from the last
    row of each batch. Neither ever terminated. postgres.js hands a
    `timestamptz` back as a JS `Date`, which holds milliseconds, while the column
    holds microseconds — so a cursor read back through JS is _earlier_ than the
    row it came from, that row satisfies its own `created_at > cursor`, and the
    same batch is returned for ever. On Postgres 16 every row in a seeded table
    reports `created_at > date_trunc('milliseconds', created_at)` as true.

    Both now page on the primary key, which survives the round trip intact. The
    scan is then ordered by uuid rather than by time, which costs a backfill
    nothing.

    Worth noting how long it hid: `backfill_shipment_links` shipped with this and
    sat behind a live button on `/admin/import` for weeks. It looked correct, it
    passed review, and its unit tests all passed — because the tests covered the
    detection logic and nothing exercised the loop against a real database. The
    figure that would have given it away is that the `jobs` table has never held
    a single `backfill_shipment_links` row. **A job that has never been run is
    not tested, whatever its tests say.**

21. **luxon in a client component puts a date library in the console's bundle.**
    The custom-field editor lives in the conversation sidebar, which is a client
    component, and the module it imported also held the parser that reads a
    `datetime-local` wall clock as an instant. That needs the timezone database,
    so luxon — which had never been in a client bundle here — would have shipped
    to every agent on the busiest route in the product.

    Split by _side_, not by subject: `lib/tickets/custom-fields.ts` is what both
    sides import and is luxon-free, and `custom-fields-parse.ts` holds the
    direction that needs it and is server-only. The read direction — instant to
    Cairo wall clock — goes through `Intl.DateTimeFormat` with a `timeZone`,
    which the runtime already carries and which `lib/format.ts` has always
    relied on. Do not hand-roll the other direction to avoid the dependency:
    finding a zone's offset for a given wall clock is exactly the arithmetic
    §6.7 says not to write.

    Worth checking for on any new client component that reaches into `lib/`:
    `grep -rl luxon .next/static/chunks/` after a build answers it in one call,
    and the answer should stay empty.

22. **A Messenger ticket can arrive on a page this app cannot answer, and Graph
    will not say so.** Ticket #6410 was a real "Testing" message that reached
    the inbox normally and whose reply failed three times with
    `code 1, "An unknown error has occurred."` and an HTTP 500 — the code
    `TRANSIENT_CODES` retries, so it burned every attempt and told the agent
    nothing. Two separate things were wrong and Graph answers both with that
    same sentence:

    - The message arrived on page `101449698657189`, while `FACEBOOK_PAGE_ID` is
      `955333171001884`. A page-scoped id is scoped to the page that issued it,
      so the recipient simply does not exist on the other page. Every Facebook
      message before it had come from the configured page, which is why this had
      never shown up.
    - Every event from that page arrives in the webhook's `standby` array, not
      `messaging`. That is Meta's handover protocol saying **another app holds
      thread control** — the echoes name it: `app_id` 576817601276249,
      `metadata: "freshchannel"`, so Freshchat is the primary receiver on that
      inbox and we are a secondary one. A secondary receiver may read the thread
      and may not send on it. **This is expected and not a fault**: Freshworks is
      still the live support service and still the default Meta app on the
      account, and it stays that way until the cutover swaps them — §5.1 has the
      arrangement and what it blocks.

    The code made the second one invisible: `parseMetaWebhook` flattened
    `standby` into `messaging` and the distinction was gone one line into the
    system, so the ticket looked ordinary all the way to the composer. It is now
    carried as `standby` on the message's `meta` and both refusals are decided
    in `lib/meta/thread.ts` before a request is made — checked in the console so
    an agent is not invited to write, and again in the send job because thread
    control can move in between.

    **Neither is fixable in code.** Sending as `101449698657189` needs that
    page's own token, and sending at all needs Freshchat to hand thread control
    over. Until both are true, connecting a page to the Meta app produces
    readable tickets that cannot be answered — which is worth knowing before the
    next page is connected, because the tickets look completely normal.

23. **A debounce is not backpressure, and a global invalidation can freeze an
    I/O-bound service while CPU looks idle.** On 2026-08-25 the customer-bot
    channel was busy while one agent had the inbox open. Every message insert
    and every delivery-status update emitted the same `conversation_changed`
    notification to every console and widget. The console's 750 ms debounce
    started another full `router.refresh()` even when the previous server render
    had not completed, and rendering the thirty-row inbox re-armed automatic
    prefetches for its dynamic ticket links. One event stream therefore became
    a queue of overlapping list renders plus several detail renders each.

    Render showed the consequence rather than the cause: CPU peaked below 7%
    and memory below 220 MB, health checks and webhook writes stayed fast, but
    RSC responses remained open for up to 87 minutes and eventually returned
    502 when the instance was replaced. CPU autoscaling could not see a request
    and database-connection backlog dominated by waiting.

    The invariant is now structural. Queue notifications are semantic and split
    by channel; the restricted bot is absent from the default working queue.
    Ticket pages and widgets listen to a UUID-specific topic. Presence is a
    separate lightweight stream, so non-inbox pages hold no LISTEN connection.
    The browser allows one refresh transition at a time, collapses events during
    it into one trailing refresh with a cooldown, pauses while hidden, and the
    large inbox list disables automatic route prefetch. Do not replace any of
    those with a larger pool or instance: capacity can postpone unbounded fan-out
    but cannot make it bounded.

24. **`request.url` in a route handler names the address the server is bound
    to, not the `Host` it was asked for.** So `new URL('/login', request.url)`
    built `http://localhost:10000/login` on Render, and signing out dropped the
    agent on a dead address on their own machine. No proxy header corrects it:
    with `Host: support.shipblu.com` and `X-Forwarded-Host` both set, the
    handler still resolved to the internal listen address — only the _scheme_
    followed `X-Forwarded-Proto`, which is what makes the bug survive a casual
    look at the headers. Reach for `redirectTo()` in `lib/http/redirect.ts`
    instead: a relative `Location` is resolved by the browser against the URL it
    actually requested, so it is correct on the custom domain, the Render
    service URL and localhost alike. `proxy.ts` is not affected — middleware
    redirects go through `request.nextUrl`, which does carry the real host. The
    same trap was live in the legacy Freshdesk redirect, where it mattered more:
    a 301 is cached indefinitely, so each visitor would have remembered the
    internal address rather than merely failing once.
25. **A `next/font` variable is not one family, and its hidden half answers for
    every script.** `adjustFontFallback` (on by default) emits a metric-matched
    `local("Arial")` face — `Lato Fallback` — and splices it into the variable
    right behind its own family, so `--font-lato` is `"Lato", "Lato Fallback"`.
    That face declares no `unicode-range`, so it is a candidate for _every_
    codepoint. With `var(--font-lato)` leading the help centre stack it sat
    ahead of Tajawal, and every Arabic glyph on the Arabic-first site rendered
    in Arial on any machine that has Arial — all of Windows and macOS. It looked
    correct in development because a Linux container has no Arial, the face
    errored, and Arabic reached Tajawal by accident: the bug was invisible
    exactly where it would have been caught. **`adjustFontFallback: false` does
    not fix it** — Turbopack, the bundler both `next dev` and `next build` use
    here, accepts the option and ignores it (verified on 16.3.1 by renaming the
    variable and watching the rename land in the served CSS while the fallback
    stayed). The fix is ordering, in `.kb-shell`: name `Lato, Tajawal` before
    the variables that also contain them. Anything covering every codepoint goes
    after the script-specific family, never before it. Checking this needs
    `CSS.getPlatformFontsForNode` over CDP — a computed `font-family` shows the
    stack you asked for, never the font that painted — and, on Linux, a
    `@font-face` override standing in for the Arial the container lacks.
26. **One Meta app does not mean one app secret, and Instagram is the exception.**
    An Instagram professional account connected through **Instagram Login**
    rather than through its linked Facebook Page is a second identity inside the
    same app: its own access token, its own host (`graph.instagram.com`), and its
    own **Instagram app secret**, which is what signs the `instagram` object's
    webhook deliveries. Nothing in the payload says which secret was used — same
    object, same entry id, same `facebookexternalua`, same header shape — so the
    only symptom is `signature_verified = false`, which the endpoint answers 403
    and files as evidence. On **2026-08-26 at 07:37 UTC** the account was moved
    onto that setup and **every Instagram delivery from that minute failed
    verification: 2,309 in thirteen hours, 100% of them**, while Facebook's 111
    deliveries over the same hours kept verifying against the unchanged
    `META_APP_SECRET`. Real customers' messages were dropped — the last before
    this was written is an Arabic question about how the service works — and
    **nothing alerted, because a rejected forgery and a rejected genuine delivery
    were the same event**. Three things changed as a result: the secret is now
    chosen from the payload's own `object` and both candidates are tried
    (`lib/meta/signing.ts`); the reason is written to `webhook_events.error`, so
    the query that finds this is `select error, count(*) from webhook_events
where not signature_verified group by 1` rather than a log line nobody was
    reading; and `META_INSTAGRAM_APP_SECRET` / `INSTAGRAM_ACCESS_TOKEN` exist as
    an optional pair, unset meaning exactly the old behaviour. **The 2,309 are
    not recoverable**: only the parsed payload is stored, not the raw bytes, so
    their signatures can never be re-checked against the right secret — which is
    the argument for keeping the raw body on an unverified delivery, and the
    reason the App Review permission's own name (`instagram_business_*` rather
    than `instagram_*`) is worth reading as a statement about which setup an app
    is on.

    **Update, 2026-08-27 01:15 UTC — Instagram Login is no longer the leading
    explanation, and the outage is still live.** `META_INSTAGRAM_APP_SECRET` has
    since been set, and the new diagnostic reports, on all 495 deliveries since
    the deploy went live at 21:50:52:

    `signature did not match META_INSTAGRAM_APP_SECRET or META_APP_SECRET`

    That sentence names a candidate only when its value is set and non-empty
    (`signingCandidates` in `lib/meta/signing.ts`, and identical values are
    deduplicated to one name), so it is proof that **both secrets are configured
    and neither one signed these payloads**. 2,981 rejected and counting, 19
    hours in. Two explanations survive, and they are not the same problem:

    - The value pasted into `META_INSTAGRAM_APP_SECRET` is not the Instagram app
      secret — the wrong field copied out of the dashboard (the Instagram app
      _id_, a client token) or a stale one.
    - **The deliveries are signed by a Meta app we hold no secret for at all** —
      i.e. somebody created a _second_ app for the Instagram Login setup and
      pointed its webhook at this callback URL, rather than adding the use case
      to the existing one. This would be the bigger finding: `META_APP_ID` would
      then name the wrong app, `subscribe_meta_webhooks` would be reading and
      writing the wrong app's field list, and **App Review would have to be
      submitted on the app that actually owns the account**, which is a different
      question from which permission to submit.

    `npm run job -- subscribe_meta_webhooks object=instagram` tells the two
    apart, and reads before it writes, so it is safe to run for the answer
    alone: "This app has no instagram subscription" means the deliveries belong
    to another app, and a reported callback URL and field list means they belong
    to this one and the secret is simply wrong.

    The lesson underneath both is the one that has not been fixed: **nothing
    alerts on this.** The reason is on the row now, which is how the paragraph
    above got written, but it still took a person running a query at one in the
    morning. A rejected-delivery count belongs somewhere a human sees without
    asking; nobody has decided where.

    **Resolved 2026-08-27 01:29:01 UTC.** A credential was corrected at 01:26
    and the `service_updated` deploy carrying it went live at 01:29:22;
    Instagram deliveries verified from that minute on, and the ones since are
    all processed into tickets — `conversations` on that channel went from 2 to
    4 within the hour. **Final tally: 3,044 deliveries rejected over 17 hours
    and 52 minutes**, from 07:37:39 on the 26th to 01:29:01 on the 27th, of
    which 1,736 carried a message. None is recoverable.

    **What the fix does not tell us is which configuration we are now on**, and
    that is the gap worth reading twice. A corrected Instagram app secret and an
    account moved back onto its Facebook Page produce the identical
    `signature_verified = true` — and they are different setups with different
    App Review permissions. The verification path knew which candidate matched
    and threw it away, on the reasoning that logging it was marginal. It was not
    marginal: it was the one fact the App Review submission hangs on, discarded
    at the moment it became knowable. `noteVerifyingSecret` now names the
    matching secret in the web log once per instance, and again if it ever
    changes, so the next deployment of this answers it without anybody
    reconstructing it from a deploy timeline.

    **And the answer, read at 02:38 UTC, is "both".** Instagram deliveries
    verify against `META_INSTAGRAM_APP_SECRET` _and_ `META_APP_SECRET`,
    alternating within seconds on one web instance, and the split is by
    envelope: 9 `messaging` deliveries and 5 `standby` ones in the same burst.
    Two credentials, one Instagram account, both live. Either the account is
    connected through Instagram Login _and_ through its linked Facebook Page on
    the same app — one app holds both secrets, and that is what the Instagram
    Login setup is — or two apps are subscribed and both point here. Nothing
    visible from this side separates those.

    Three consequences, none of them optional:

    - **Neither secret can be removed.** Dropping either resumes 403s for that
      half of the traffic. `signingCandidates` trying both is not belt and
      braces here; it is load-bearing.
    - **Something else holds thread control.** `standby` is the handover
      protocol saying so, which is the condition `lib/meta/thread.ts` already
      refuses sends for — and a plausible reading of the six dead `send_meta`
      rows in §5.2, five of which failed _inside_ the window with Graph naming
      no cause. Worth checking before blaming Human Agent.
    - **The App Review answer is no longer "pick the name that matches the
      connection"**, because two connections are live. Which permission to
      submit depends on which of them the helpdesk is meant to be, and that is a
      decision nobody has made — see `plans/instagram-comment-management.md`.

    It also broke the notice that found it. Keyed on the secret alone and
    re-announcing on change, it logged a line per delivery once the two started
    alternating — the exact noise the once-only design existed to prevent, from
    an assumption ("a signing secret changes on the order of never") that was
    false within the hour. It is keyed on secret _and_ envelope now, which bounds
    it at a handful of lines and makes the pair — which credential signs which
    channel — the thing it reports.

27. **"Zero API calls" in Meta's dashboard is not "we never called it", and a
    permission diagnostic is only as good as the code it matches on.** Meta's
    App Dashboard reported **0 calls against Business Asset User Profile Access
    in 30 days** while the worker was calling that endpoint several times a day
    — 17 refusals in the first 21 hours after the wiring shipped. Both are true:
    a call refused at the capability gate never reaches the permission, so it is
    never counted against it. **The counter measures granted usage, not
    attempted usage**, which means it stays at zero until approval and can never
    be evidence about whether the code works. The log and the `jobs` table
    answer that question; the dashboard does not. (Written while every call was
    being refused. Successful calls began on 2026-08-27 once the token was
    fixed — §6.28 — so this is now checkable against the dashboard rather than
    inferred from a zero.)

    The expensive half is what the refusals said. `isProfilePermissionRefusal`
    matched Meta's documented answer — `100/33`, plus 200 and 10 — and Facebook
    returns **`(#3) Application does not have the capability to make this API
call.`** So every refusal fell through to the generic branch, and the
    sentence naming the feature — written after the Human Agent episode
    (§5.2) _specifically_ so nobody would have to guess a second time — printed
    zero times out of 17. A diagnostic keyed on a code nobody verified is a
    diagnostic that is silent exactly when it is needed, and nothing in the
    pre-push loop can catch it: no test has a Graph to ask. **Read the codes out
    of the production log before trusting a set of them**, the same way §7 says
    to run raw SQL against the real database before pushing it.

    Third finding from the same log, and the one that would have been missed
    entirely: **Instagram was failing for a completely different reason wearing
    the same word.** `(#100) The page is not linked to an Instagram account or
the linked IG account is not professional account`, from
    `graph.facebook.com` — i.e. `INSTAGRAM_ACCESS_TOKEN` is unset, `endpoint()`
    fell back to the Page token and the Facebook host, and the Page has no route
    to an Instagram-scoped id because the account is on Instagram Login (§6.26).
    Approving the feature would not have fixed one Instagram lookup. This is why
    §1's rule about breaking a count down along the dimension that can fail
    applies to failures too: "17 refused" reads as one problem and was two.

28. **`META_PAGE_ACCESS_TOKEN` held a System User token, and that was the whole
    Meta outage.** Resolved 2026-08-27, after a day spent reading it as an App
    Review problem.

    A page-scoped id can only be resolved by that Page's own token. The value in
    `META_PAGE_ACCESS_TOKEN` was a **System User** token belonging to a different
    integration ("ShipBlu Merchant Backend"), minted under the Helpdesk app. Its
    scopes were complete and correct — `pages_messaging`, `pages_read_engagement`,
    `pages_manage_metadata`, `instagram_basic`, `instagram_manage_messages`, all
    present — which is exactly why nobody looked at it: **the scope list is the
    thing everyone checks, and it was innocent.** Graph's answer was
    `(#3) Application does not have the capability to make this API call`, which
    reads as "the app is not approved" and is really "this actor is not the
    Page". Replacing it with the Page's own token (`GET /{page-id}?fields=
access_token`, authorised with the System User token, which never expires)
    fixed Facebook and Instagram in the same minute.

    **Check `Type: Page` in Meta's Access Token Debugger before believing any
    Graph refusal that names a capability.** Scopes are not the same question,
    and a token can carry every scope you need and still be the wrong kind.

    Two conclusions recorded earlier died with it:

    - **Instagram is reachable through the Facebook Page after all.** The
      `(#100) The page is not linked to an Instagram account` refusals were the
      same wrong token, not a missing Page↔Instagram link. With the Page token,
      ticket #6478 resolved on `graph.facebook.com` at 14:36 UTC. The earlier
      version of this entry read that error as proof the account was on
      Instagram Login and that `INSTAGRAM_ACCESS_TOKEN` had to be set; **it is
      not proof of anything, and the variable stays unset.** An error message
      about a relationship between two objects is not evidence about that
      relationship when the caller is not one of them.
    - **The counter argument in §6.27 is now testable.** Real successful calls
      are being made, so whether the App Dashboard's usage figure moves is a
      question with an answer rather than an inference from zero.

    **The approval is still needed, and is now the only thing left.** With the
    token fixed, an account holding a role on the Meta app resolves and a member
    of the public does not: #6410 and #6478 both named at 14:35–14:37 UTC, while
    #8125 — a customer with twelve messages since 25 August — was refused
    `permission: true` between the two successes. That is precisely the Standard
    Access boundary, so **Business Asset User Profile Access at Advanced Access
    is a genuine requirement** and not a misdiagnosis. Both things were true at
    once, and the token was masking the one underneath.

    The upside: a role-holder's account now produces a real, successful call, so
    the screencast App Review asks for can finally be recorded.

29. **Moving Instagram back onto its Facebook Page: the code needs no deploy,
    and the order of the two steps is the whole risk.** Decided 2026-08-27, and
    see §6.28 — the evidence that the account was on Instagram Login turned out
    to be a wrong-token error, so the premise below is weaker than it reads.
    Kept because the mechanics are right whenever the move is made.
    the helpdesk owns the **Page-connected** Instagram account, not the
    Instagram Login one, which reverses the recommendation standing in
    `plans/instagram-comment-management.md`.

    **Nothing in this repo has to change for the switch to work**, which is what
    the optional-pair design in §6.26 bought. `endpoint()` picks the host and
    credential from whether `INSTAGRAM_ACCESS_TOKEN` is set, and it is unset, so
    every Instagram call already goes out as Page token + `graph.facebook.com` —
    the target configuration. `signingCandidates` already offers **both** app
    secrets for an `instagram` delivery, so webhooks keep verifying across the
    cutover no matter which secret signs them, with no deploy timed to the
    minute and no window of 403s.

    **So the only dangerous move is unsetting `META_INSTAGRAM_APP_SECRET` too
    early.** Do it _after_ the account is linked to the Page and the log says
    `instagram messaging deliveries are verifying with META_APP_SECRET`. Unset
    it while the account is still on Instagram Login and every Instagram
    delivery fails verification again — §6.26, reproduced deliberately. The
    variable costs one extra HMAC per Instagram delivery while it lingers, which
    is not a reason to hurry.

    **The scoped ids survive the move, and this was verified rather than
    assumed.** During the hour both connections were live, the same account
    (`entry.id` 17841448759001625) and the same sender IGSID appeared in a
    `messaging` delivery signed by `META_INSTAGRAM_APP_SECRET` _and_ in a
    `standby` delivery signed by `META_APP_SECRET`, seconds apart. Identical
    ids across the two connections means `contact_identities` stays valid, no
    contact fragments into two, and no open thread loses its 24-hour window.
    That was the one failure mode that would have made this migration
    unaffordable, and it is ruled out by data rather than by Meta's docs.

    **It was unset too early, and Instagram has been dropping messages since.**
    _Confirmed from the data 2026-08-28 18:00 UTC._ The warning above describes
    what then happened, hour by hour:

    | Hour (UTC)         | verified | unverified | reason stored                                    |
    | ------------------ | -------- | ---------- | ------------------------------------------------ |
    | 27 Aug 01:00       | 30       | 127        | `… META_INSTAGRAM_APP_SECRET or META_APP_SECRET` |
    | 27 Aug 02:00       | 14       | 0          | —                                                |
    | 27 Aug 11:00       | 2        | 0          | —                                                |
    | 27 Aug 12:00       | 2        | 18         | `signature did not match META_APP_SECRET`        |
    | 27 Aug 13:00 → now | 0        | 844        | `signature did not match META_APP_SECRET`        |

    Two clean hours of 100% verification, then the reason stops naming
    `META_INSTAGRAM_APP_SECRET` — which `signingCandidates` only omits when the
    variable is unset — and verification goes to zero and stays there. **844
    Instagram deliveries dropped between 27 Aug 12:52 and now, still ongoing.**

    The reason line is the diagnosis on its own: it names the candidates that
    were _tried_, so "did not match META_APP_SECRET" alone means one secret was
    offered where two were needed. The account is therefore still signing with
    its Instagram app secret — the move to the Page has not taken effect, whatever
    the dashboard shows.

    **The fix is to put `META_INSTAGRAM_APP_SECRET` back**, and it is safe
    regardless of which setup the account is really on: both candidates are
    tried, so a restored variable cannot break a Page-connected account. Then
    wait for the log to say Instagram is verifying against `META_APP_SECRET`
    before removing it again — which is what the paragraph above already said,
    and is worth reading twice because the cost of getting it wrong is a day of
    a customer channel.

    **And the move itself has not taken effect, which is the finding under the
    finding.** The intent is Facebook Login only, with Instagram Login
    disconnected — in which case no Instagram app secret would be needed and
    every delivery would verify against `META_APP_SECRET`. The traffic says
    otherwise. All 1,254 `instagram` deliveries since 27 August are the same
    account, `17841448759001625`, and they split three ways:

    | Shape       | Verified | Count | Window                        |
    | ----------- | -------- | ----- | ----------------------------- |
    | `messaging` | no       | 1,204 | 27 Aug 00:04 → still arriving |
    | `messaging` | yes      | 41    | 27 Aug 01:29 → 11:46 only     |
    | `standby`   | yes      | 9     | 27 Aug 02:38 → 13:08 only     |

    Read it as two connections, not one. `messaging` verified **only** during
    the hours `META_INSTAGRAM_APP_SECRET` was set, so it is signed by the
    Instagram app secret — that is the Instagram Login setup, still primary,
    still delivering. `standby` verified at 13:08, _after_ the variable was
    unset, so it was signed by `META_APP_SECRET` — that is the Page-connected
    side, which was working and has produced nothing since.

    `META_APP_SECRET` itself is not in question: `page` and
    `whatsapp_business_account` deliveries verify against it 100% over the same
    hours. Only the `instagram` object fails, which is what makes "a second
    signing identity is still live" the only reading left.

    So the sequence is: restore the variable to stop dropping messages, then
    disconnect the account under **Instagram → API setup with Instagram login**
    in the App Dashboard — the setup being removed is what stops the Instagram
    secret signing — and confirm `messaging` deliveries start verifying against
    `META_APP_SECRET`. Removing the variable is the _last_ step, not the first.
    Disconnecting in the dashboard and unsetting the variable are two changes,
    and doing the second without the first is exactly what produced the 844.

    **Resolved 2026-08-28 18:19 UTC by disconnecting, and the intent was right
    all along.** The account was disconnected under Instagram Login and
    Instagram verification recovered within minutes — no Instagram app secret
    restored, and none needed. The turnaround is exact:

    | Time (UTC)    | Shape       | Verified | n   |
    | ------------- | ----------- | -------- | --- |
    | → 18:08:31    | `messaging` | no       | 766 |
    | 18:08 → 18:19 | —           | —        | 0   |
    | 18:19:43      | `standby`   | **yes**  | 5   |

    So `META_INSTAGRAM_APP_SECRET` stays unset and §6.26's optional pair is now
    genuinely dormant. The lesson survives with its order corrected: unsetting
    the variable was not the mistake, doing it _before_ the disconnection was —
    and the fix was never to restore the variable but to finish the move.

    **What it uncovered is worse than what it fixed: everything now arrives in
    `standby`, on both platforms.** Over the 24 hours to 18:20 the verified
    traffic is 5 Instagram `standby` and 40 Page `standby` against 3 Page
    `messaging`. Standby means another app is the primary receiver for that
    inbox, so `metaThreadState` refuses the send before it is made
    (§6.22) — this app can read every Instagram and Messenger conversation and
    answer none of them. That is not a credential problem and no approval fixes
    it; thread control has to be passed to this app in the Meta app's Messenger
    settings — which is the cutover, not a config fix. **The app holding it is
    Freshworks**, still the live support service and still the account's default
    Meta app by design; §5.1 has the arrangement and the swap that ends it. It
    is also the thing that makes an App Review screencast impossible until then:
    a recording of a reply Graph refuses is a rejected submission.

30. **`npm run db:seed` is not part of any deploy, so adding a row to
    `db/baseline.ts` does not put it in production.** `render.yaml` runs
    `preDeployCommand: npm run db:migrate` and nothing else; the seed is a
    manual script. This is easy to miss because the seed's own doc comment says
    it is "safe to re-run after every deploy", which reads as a description of
    what happens rather than of what it would survive.

    It bit the three-day close rule: the rule is a `db/seed.ts` entry, and
    merging it would have shipped a feature that did not exist in the only
    database that matters. The row was inserted directly instead, verified
    against an empty `automation_rules` first (`select` before `insert`, §5) and
    reversible with
    `delete from automation_rules where name = 'Close resolved tickets after 3 days'`.

    Adding `&& npm run db:seed` to both `preDeployCommand`s would close the gap
    permanently and is deliberately not done yet — it changes the deploy
    contract for two services to fix a problem that has so far occurred once.
    Until it is, treat anything added to the seed as needing a hand-run against
    each environment, and say so in the PR.

31. **A time-based rule can only act on a ticket the sweep can see.**
    `liveTickets` in `lib/automations/index.ts` is the population, and it filters
    by status category. It excluded `resolved` until 2026-08-28, which made
    "close a ticket that has been resolved for three days" unwritable as a rule:
    an admin could compose it in the UI, save it, watch it sit at `is_active =
true` with a null `last_run_at`, and find nothing wrong with the rule itself.
    Any new rule about a state the sweep does not select for has the same shape
    of failure — silent, and indistinguishable from a condition that does not
    match.

32. **A second phone number on the same WABA can fail signature verification
    while the first one passes, and nothing says so.** _Found 2026-08-28._
    `whatsapp_accounts` holds two rows and both leave `token_env_var` null, so
    both fall back to the same credential — and signature verification does not
    look at the phone number at all. Yet within WABA `128772296801141`:

    - `128318316834446` — 3,444 deliveries in 48 hours, **100% verified**.
    - `838961722630554` — 7 verified on 18 August, 5 more up to 27 Aug 15:25,
      then **150 consecutive failures** through 18:00 on 28 August, still
      arriving.

    Same WABA id in the payload, same `facebookexternalua`, same endpoint. An
    HMAC does not depend on which number a message was sent to, so "the second
    number is misconfigured" cannot be the whole story: the plausible reading is
    that its deliveries are signed by a _different app_ — an alternate callback
    or a second app subscribed to the same WABA — and this is **not established**.

    What is established is that a real inbound number has been dropping messages
    for a day, that it worked before 27 Aug 15:25, and that the break falls in
    the same afternoon as the Instagram one (§6.29). Do not assume they share a
    cause; do check what changed in the App Dashboard that afternoon. The query
    that finds this is the delivery breakdown **split by
    `value.metadata.phone_number_id`** — totalling by WABA reports 96% healthy
    and hides it completely, which is exactly the shape `AGENTS.md` asks counts
    to be broken down along.

    **What the switch does not settle: who is actually answering this inbox.**
    Over 36 hours the `instagram` object delivered 1,037 inbound messages and
    **1,166 outbound echoes** — something is replying at volume on this account,
    and it is not this app, whose Instagram sends fail. `standby` traffic was 5
    events total (4 `message_edit`, 1 `read`) and no messages at all, so the
    handover picture is not a clean "another app is primary": it is a busy
    channel owned by something outside this system. Settle that before any App
    Review screencast, per `plans/instagram-comment-management.md` — a recording
    of a reply Graph refuses is a rejected submission.

    **The permission set flips with the connection**: `instagram_basic` +
    `instagram_manage_comments` + the `pages_*` items, not the
    `instagram_business_*` pair. See the table in the plan.

33. **Meta's "Send to Server" test button works exactly once, then reports
    success forever while doing nothing.** _Found 2026-08-30._ The button posts a
    _byte-identical_ sample on every press. `deliveryId()` derives the delivery
    key from the batch contents, so every press produces the same
    `c:17865799348089039:add`, the unique index rejects it, `onConflictDoNothing`
    returns no row, and the endpoint answers `200 {"status":"duplicate"}` without
    enqueuing anything. Meta shows a green "successfully sent" for a delivery
    that reached a ticket only on the very first press in the life of the table —
    ours was 2026-08-29 09:50:44, ticket #10942.

    That is correct behaviour for real traffic and it should not be relaxed: a
    genuine Meta redelivery of a real comment must be dropped. What was wrong is
    that the drop was **silent**, so "we deduped it" and "it never arrived" — a
    parser bug and a permission problem, with nothing in common — looked
    identical from the outside. It sent an afternoon into the comment parser
    looking for a fault in code that had already handled the same payload
    correctly the day before. The endpoint now logs the colliding key.

    Reading the request log tells the two apart before any code is opened. The
    test button and real traffic use **different user agents**, and the response
    size splits on the outcome:

    | `userAgent`                | Meaning               | `responseBytes` |
    | -------------------------- | --------------------- | --------------- |
    | `facebookexternalua`       | real delivery         | 408 = queued    |
    | `Webhooks/1.0 (fb.me/...)` | dashboard test button | 412 = duplicate |

    On 2026-08-30 the three presses at 13:23:52, 13:24:50 and 13:25:31 were all
    `Webhooks/1.0`, all 200, all 412 bytes, and `webhook_events` has no row after
    13:19:59. To actually exercise the pipeline again, delete that one row — or
    read the log line — rather than pressing the button harder.

    **A green test button is not evidence the account is subscribed, either.** It
    posts straight at the callback, so it proves the URL, the signature and the
    parser and says nothing whatsoever about what Meta will send unprompted. The
    subscription question is answered by the `permissions` webhooks in §5.2.

    **There is now a switch for the general version of this.** Set
    `LOG_ALL_INCOMING_WEBHOOKS=true` on the `shipblu-support` web service and
    every inbound delivery — Meta, WhatsApp and email — is printed with its
    headers and raw body _before_ signature verification, JSON parsing and the
    duplicate check, so nothing downstream can hide it. That is the ordering
    that matters: `webhook_events` is written after the signature check and not
    at all for a duplicate, so the database cannot distinguish "rejected",
    "malformed", "deduped" and "never sent" — and this investigation burned an
    afternoon on exactly that ambiguity.

    Turn it off again afterwards. It puts customer message content into the
    Render log, which is less protected than the database; credential headers
    (`authorization` — Postmark sends `EMAIL_WEBHOOK_SECRET` there on every
    delivery — plus `cookie` and `x-api-key`) are redacted regardless, and
    `x-hub-signature-256` is deliberately kept because it is evidence rather
    than a secret. The Meta GET handshake is deliberately **not** logged: its
    query string carries `hub.verify_token`.

34. **Two different things gate a Meta capability, and the Instagram `comments`
    webhook is gated by the rarer one.** _Found 2026-08-30, over three wrong
    turns — record the whole path, because each turn was individually
    reasonable._

    **The grant.** A permission has to be in the scope list of the authorisation
    that minted the token. Meta reports an unrequested permission as silence, not
    as an error.

    **The access level.** Every permission has Standard Access — no review, but
    only for app admins, developers and testers on assets they administer — and
    Advanced Access, which reaches the general public and is what an App Review
    submission asks for.

    For nearly everything, an admin testing on their own account is covered by
    Standard Access and App Review is irrelevant until launch. That general rule
    is correct, and applying it here was still wrong:

    > "Your app must have successfully completed App Review (advanced access) to
    > receive webhooks notifications for `comments` and `live_comments` webhooks
    > fields."

    **`comments` is the documented exception.** Advanced Access is required to
    _receive the notification at all_ — not merely to moderate, and not merely
    for the public. An app admin commenting on their own public post gets
    nothing.

    The three wrong turns, in order, since the next person will be tempted by
    each:

    1. _"The parser is broken."_ It is not, and it never was: a real Facebook
       comment made ticket #10939 and Meta's Instagram sample made #10942, both
       on 2026-08-29. What made it look broken was the dashboard test button
       silently deduping (§6.33).
    2. _"Apply for the permission."_ Adding `instagram_manage_comments` to the
       submission grants nothing — a submission is a request for Advanced Access
       and does nothing until approved. A comment posted straight afterwards
       still produced no delivery.
    3. _"App Review is irrelevant, it is only the grant."_ The general rule,
       misapplied to the one field it does not cover. Regenerating the Page
       token and redeploying changed nothing, correctly.

    **The evidence that settles it without reading any of this again**: the
    channel is split by _field_, not by account. `instagram_manage_messages` is
    fine at Standard Access, so DMs arrive — 100+ verified `standby` deliveries
    on 2026-08-30 alone. `comments` needs Advanced Access, so across the entire
    life of the table exactly one `changes` delivery exists on the `instagram`
    object and it is Meta's own test payload. **Zero real Instagram comments have
    ever reached the endpoint, so no amount of reading the ingest path can
    explain them.** When a channel works in one direction only, check whether the
    two directions have different access levels before opening any parser.

    Carry forward:

    - **Granted ≠ delivered.** Check the access level as well as the grant.
      `npm run job -- check_meta_permissions` now warns on the _passing_ line
      where Advanced Access is required on top, which is the case a clean grant
      list would otherwise send somebody back into the parser for.
    - **Missing ≠ declined.** Declined means somebody unticked it in the dialog;
      missing means it was never in the dialog. Different fixes.
    - **There is no second gate.** A Page-level `comments` subscription looked
      like one for a few hours; §6.35 is why it is not, and why the doc example
      that suggested it was describing the other Instagram connection entirely.
    - The account must also be **public** for comment notifications — checked
      2026-08-30 and it is, so the approval is the only step left.

35. **Meta's Webhook Debugger answers the subscription question outright, and a
    doc example does not.** _2026-08-30._ App Dashboard → **Webhook Debugger**
    takes Page ids and reports, for each: the app's subscribed IG webhook fields,
    the app's subscribed fields _for that Page_, whether an Instagram account is
    linked, and the Manage Messaging toggle. Run it before theorising about a
    subscription — it is one screen, it is authoritative, and it writes nothing.

    For Page `101449698657189` (ShipBlu):

    - **Subscribed IG webhooks for this app**: `comments`, `live_comments`,
      `message_edit`, `message_reactions`, `messages`, `messaging_handover`,
      `mentions`, `messaging_seen`, `messaging_postbacks`, `standby`.
    - **Subscribed fields by app for page**: the messaging set plus `standby` and
      `feed`. **No `comments`, and correctly so.**
    - **Instagram account linked to page**: `shipblu`.
    - **Manage Messaging toggle**: On.

    Every subscription-shaped explanation is now closed: `comments` is subscribed
    at the app level, the account is linked, the Page is installed, messaging is
    on. What is left is the access level (§6.34) — the one thing this screen does
    not show.

    **It also corrects a fix made hours earlier in the same investigation.** The
    Instagram webhook setup doc shows
    `POST /me/subscribed_apps?subscribed_fields=comments,messages`, which was read
    as "the Page subscription must carry `comments`" and turned into code. It does
    not. The debugger states the rule for this connection in one line — _"For
    Instagram, app level webhook subscription is required via the Webhooks
    product"_ — and the doc's own curl gives it away on a closer look: it is
    addressed to `graph.instagram.com/{ig-account-id}`, the **Instagram Login**
    product, where `/me` is the Instagram account and `comments` is one of its
    fields. Here the account is connected through its Facebook Page,
    `subscribed_apps` is addressed to the Page, and Page vocabulary has no
    `comments` at all — Facebook's comments arrive under `feed`. Reverted.

    The generalisation, which §6.26 already taught about app secrets and which
    keeps costing more than it should: **the two Instagram connections differ in
    the host, the token, the ids _and_ the field vocabulary.** A Meta doc example
    proves nothing until you check which host its URL names, and when that is
    ambiguous the debugger settles it without touching production.

36. **Both Instagram connections are live on purpose now, and almost everything
    that reads as a property of "the Instagram account" is really a property of
    one connection.** _2026-08-30._ The account is connected through its Facebook
    Page **and** through Instagram Login, which §6.26 discovered by accident and
    §6.29 spent two days trying to collapse back to one. Keeping both is the
    right answer, and it changes what four separate signals mean.

    |                | `facebook_page`                                  | `instagram_login`        |
    | -------------- | ------------------------------------------------ | ------------------------ |
    | host           | `graph.facebook.com`                             | `graph.instagram.com`    |
    | credential     | `META_PAGE_ACCESS_TOKEN`                         | `INSTAGRAM_ACCESS_TOKEN` |
    | signs webhooks | `META_APP_SECRET`                                | `INSTAGRAM_APP_SECRET`   |
    | permissions    | `instagram_basic`, `instagram_manage_*`          | `instagram_business_*`   |
    | handover       | yes — `standby` when another app owns the thread | none                     |

    The ids are the one thing that does **not** differ: the same account id and
    the same IGSID appear on both, verified from production traffic rather than
    from Meta's docs (§6.29). That is what makes a connection a pure route — a
    contact, a ticket and a 24-hour window mean the same thing on either — and it
    is why this is a routing change rather than a data migration.

    Four consequences, each of which was a bug until this landed:

    - **`standby` belongs to the Page, not to the account.** Freshworks is the
      Page's primary receiver, so every Instagram delivery reaching this app
      through the Page arrives in `standby` — and that was read as "this account
      cannot be answered", refusing every Instagram reply in the console. It says
      nothing about a send made with the Instagram account's own token.
      `lib/meta/thread.ts` now only lets a `standby` block a send **over the
      connection that reported it**. This is the change that makes Instagram
      answerable before the Freshworks swap (§5.1).
    - **Which connection delivered an event is knowable exactly once**, at the
      endpoint, from which app secret verified the signature. The payloads are
      otherwise byte-identical — same object, same `entry.id`, same user agent.
      It is stored on `webhook_events.connection` and copied onto the message's
      `meta`, because nothing downstream can recover it.
    - **The delivery key now includes the connection**, so both copies of a
      message are stored instead of the second being deduplicated away. Ingest
      still keys on the `mid`, so there is one ticket; what this buys is a
      per-connection delivery count — the number that would have shown the Page
      connection going silent within the hour on 27 August rather than the next
      day — and a second chance at a batch whose job died.
    - **An App Review permission name says which connection somebody submitted
      for, not which one the account is on.** §6.29 read `instagram_business_*`
      as evidence of the setup and was wrong. Both sets are needed now, and
      `check_meta_permissions` reports them separately.

    **`INSTAGRAM_APP_SECRET` is the name to use**, matching Meta's own dashboard
    and pairing with `INSTAGRAM_ACCESS_TOKEN`. `META_INSTAGRAM_APP_SECRET` is
    still read, deliberately: unsetting an Instagram app secret has twice taken
    the channel down for the better part of a day (§6.26's 3,044 and §6.29's
    844), and a second name costs one HMAC on a delivery that was going to be
    hashed anyway. Identical values under both names are deduplicated. Unset the
    old one only once the web log says
    `instagram … deliveries are verifying with INSTAGRAM_APP_SECRET`.

    **The live symptom that produced all this**, for the next person matching on
    it: real Instagram `comments` deliveries began arriving at 15:22 UTC on
    2026-08-30 — the first real ones ever — and every one was answered 403 with
    `signature did not match META_APP_SECRET`. The reason line names the
    candidates that were _tried_, so naming only one where two connections are
    live is itself the diagnosis: the secret was set in Render under a name the
    code did not read. Same shape as §6.26 and §6.29, third occurrence.

    **Confirmed end to end at 16:20:30 UTC**, minutes after the deploy went live.
    One burst carried both connections, each labelled and each verifying against
    its own secret: an `instagram_login` `changes`/`comments` delivery, and five
    `facebook_page` `standby` deliveries over the following 35 seconds. The
    comment became ticket #13745 in 614 ms — the first real Instagram comment
    this system has ever ingested.

    Two things the real payload settled that had been guesses in the code:

    - **A top-level Instagram comment carries no `parent_id`.** Meta's sample
      does, alongside a distinct `media.id`, which is what made the shape look
      ambiguous for months — the sample is describing a _reply_. The guard in
      `lib/meta/parse.ts` stays but is now belt over braces.
    - **The Instagram `comments` value has no `verb` field at all**, unlike
      Facebook's `feed`. There is no deletion shape to look for, which is the
      next entry.

    Three things are still **not** settled and should not be assumed:

    - Whether the direct connection delivers `comments` for the general public at
      Standard Access. **The 16:20 delivery does not settle it**: it came from
      `ali.nasser47`, which holds a role on the Meta app, and Standard Access
      covers a role holder on assets they administer. So this is exactly the
      §6.34 boundary that made the Page connection's comments look broken, and it
      still needs a comment from an account with no role on the app. Until then
      the Instagram comment App Review item stays blocking.
    - Whether Meta ever sends `standby` on the Instagram Login connection. It has
      never been observed and there is no primary receiver for it to be second
      to, but the code handles it rather than assuming: a `standby` recorded by
      the direct connection blocks a send over the direct connection.
    - Whether a **message send** works over the direct connection. Still
      untested, and it is the half the whole design rests on — the argument that
      Instagram is answerable before the Freshworks swap is a prediction until a
      DM reply lands.

    **A write over the direct connection does work, and that much is no longer a
    prediction.** At 16:29 UTC an agent deleted a comment from the ticket and the
    round trip completed on the first attempt:

    | Time (UTC)  | What                                                        |
    | ----------- | ----------------------------------------------------------- |
    | 16:29:05.90 | comment `18554566741078148` verified on `instagram_login`   |
    | 16:29:06.35 | ticket #13746 opened                                        |
    | 16:29:23.56 | agent pressed delete; `moderate_meta_comment` enqueued      |
    | 16:29:26.47 | `DELETE graph.instagram.com/…` accepted, job ok in 2,895 ms |

    `[moderate_meta_comment] delete instagram comment … via instagram_login`, and
    the `comment_deleted` event carries the connection. **This is the first
    authenticated Graph write this system has ever made over Instagram Login**,
    and it settles two things a webhook could not: the token authenticates for
    writes and not merely for signing, and `instagram_business_manage_comments`
    is genuinely granted rather than assumed.

    What it does **not** settle is the send. `POST /{ig-id}/messages` is a
    different endpoint under a different permission
    (`instagram_business_manage_messages`), and it is the one that carries the
    standby argument. Do not read a successful delete as evidence for it.

37. **A deleted Instagram comment produces no webhook, so a ticket outlives the
    thing it is about and nothing says so.** _2026-08-30, established by deleting
    a real comment and watching._

    The comment behind ticket #13745 was deleted at some point between 16:21 and
    16:28 UTC. **No HTTP request reached `/api/webhooks/meta` in that window** —
    checked in Render's _request_ log, not `webhook_events`, which is what makes
    it conclusive: the database cannot distinguish "never arrived" from
    "arrived and was rejected before storage" (§6.33), and the request log can.
    Not a `remove` verb, not an empty change, no request at all.

    **Neither direction produces one.** Tested twice: once with the commenter
    deleting their own comment, and once at 16:29 with the account deleting one
    through our own moderation control (§6.36's round trip). Silence both times.
    The second matters less — we made that change and know its outcome — but it
    rules out the reading that Meta does notify on deletion and the first test
    simply missed it.

    Facebook is different and no better: a deletion arrives as `feed` with
    `verb: remove`, and `OPENING_VERBS` in `lib/meta/parse.ts` drops it. The
    ticket is not marked either way.

    So on both platforms the ticket keeps the customer's words and goes on
    presenting them as live. That is defensible — the delivery is the record, and
    a deletion should not erase what we were told — but it has a sharp edge:
    **the first and only time anybody learns the comment is gone is when an
    agent's reply is refused.** Until now that refusal printed Graph's bare
    "Unsupported post request" plus a code, which reads as a broken integration
    rather than as a customer changing their mind. `explainMetaSendError` now has
    a branch for it naming the three causes in likelihood order — deleted,
    wrong node (Instagram threads are one level deep), unapproved permission.

    What is deliberately _not_ done: polling comment ids to detect deletions.
    That is a Graph call per open comment ticket per interval, to discover
    something that changes nothing about how the ticket is handled — the agent
    still reads it, still decides, and now gets a sentence that explains the
    refusal when they act. Revisit only if comment tickets become common enough
    that agents are regularly writing replies into nothing.

38. **The delivery-order endpoint's `?pin=` is not checked, so a tracking number
    is the only credential protecting a customer's name, address and phone.**
    _2026-08-30, established by requesting the same parcel three ways._

    `GET https://api.shipblu.com/api/v1/delivery-order/<number>/` was fetched
    with `?pin=` empty, with `?pin=1234`, and with no `pin` parameter at all. All
    three returned **byte-identical bodies** — `diff` on the saved responses is
    empty. The body carries the recipient's full name, email address, phone
    number, street address, GPS coordinates to six decimal places, and the
    cash-on-delivery amount.

    So the pin is decoration. Anyone holding a thirteen-digit number — a
    neighbour, a doorman, whoever the merchant forwarded it to, or a script
    walking the number space — can read all of that, and the numbers are
    sequential-looking millisecond timestamps rather than anything unguessable.
    **This is a property of the platform, not of this repo, and it is the one
    finding here that somebody outside this codebase has to act on.**

    What this repo does about it, which is containment rather than a fix:
    `syncShipment` writes the payload only to `shipments.data`, and no public
    page selects that column. `getShipmentByTrackingNumber` returns a
    `ShipmentDetail` whose field list does not include `data`, which is what
    keeps `/help/<locale>/track` rendering a status and a stepper instead of
    somebody's address — the same line the tracking page already drew for itself
    (§1) and the reason it draws it. **Widening `ShipmentDetail` to carry `data`
    is the one-line change that would publish all of it.**

39. **The current-estimate endpoint returns a timestamp whose time half is
    noise, and it is keyed by an id the tracking number cannot stand in for.**
    _2026-08-30, established against the live API._

    `GET /api/v1/orders/<id>/current-estimated-date/` answers
    `{"order_id":3150567,"tracking_number":"1755021358719","current_estimated_date":"2026-08-31T23:49:51.999811+03:00"}`.
    Two things about that value cost time if you assume otherwise.

    **The time is the moment you asked.** Two calls three seconds apart returned
    `23:49:51` and `23:49:54` — it tracks the request clock, not the parcel. Only
    the calendar date is data. `lib/shipments/platform.ts` therefore takes the
    leading `YYYY-MM-DD` by regex rather than parsing to a `Date`: the value
    carries `+03:00`, so `new Date(v).toISOString().slice(0,10)` is right for
    twenty-one hours a day and silently a day early for the other three. There is
    a test pinning exactly that boundary.

    **The tracking number is not an id here.** Passing `1755021358719` to this
    endpoint 404s; only `3150567` works. That is the whole reason
    `shipments.platform_order_id` exists as a column — without it the endpoint is
    unreachable for any parcel whose delivery-order payload we are not currently
    holding. A malformed id makes the API serve an **HTML error page** rather
    than JSON, so the client rejects anything non-numeric before the round trip.

    **It keeps answering after delivery, with a future date.** Parcel
    1755021358719 was delivered on the 30th and the endpoint still reported the
    31st. `currentEstimateFor` therefore skips the call for any parcel whose
    stage is terminal and stores null, so the column empties when a parcel lands
    instead of keeping the last guess made before it did. The gap between the two
    estimates is real and worth surfacing: on 1591424095705 the parcel was booked
    for 2026-08-22 and currently reads 2026-09-01.

40. **A parcel being returned keeps reporting `delivery_attempted`, so the
    tracking page drew the outbound bar for a parcel that will never arrive.**
    _2026-08-31, found on live parcel 1591424095705._

    The platform signals a return through `rto_requested`, and **not** through
    the status. That parcel reads `status: "delivery_attempted"`,
    `rto_requested: true`, with a `return_to_origin` event already fired. So
    `stageFor` saw `delivery_attempted`, returned `attempted` → step 2 of 4, and
    the page drew the delivery bar with "Out for delivery" lit and "Delivered"
    still ahead — plus "Estimated delivery 1 September", because the estimate is
    suppressed only on a `terminal` stage and `attempted` is not one.

    The design was right and the input was wrong. `TRACKING_STEPS` already
    carried the reasoning — "putting 'returned to sender' on a progress bar that
    ends in 'delivered' says the parcel is still coming" — and `return_to_origin`
    already mapped to `step: null`. It just keyed on a field the platform does
    not update. **`rto_requested` is the authority; the status lags it for the
    whole return.**

    Two things follow, and the second is the one that is easy to miss:

    - The return needs **its own bar**, because its steps are not the delivery
      steps. `RETURN_STEPS` is the vocabulary ShipBlu's own team gave:
      `return_to_origin` → returning to sender, `in_transit`/`en_route` → on the
      way, `out_for_return` (and `return_attempted`, the same step tried again) →
      out for return, `returned` → returned.
    - It needs **its own words**, because the same event means opposite things on
      the two legs. `in_transit` outbound is "on its way to you" and during a
      return is "on its way back to the shop"; `return_to_origin` read through
      the delivery table reaches an Arabic reader as `مرتجعة إلى الراسل` — the
      past tense — above a bar whose first step has only just lit. Hence
      `RETURN_VOCABULARY` and `returnStatusLabel`, and hence
      `returnProgress` returning `startedAt`: the history rows on either side of
      that instant are read through different tables.

    The step is taken from the events **after** the return began, not from all of
    them — every return is preceded by an outbound `in_transit`, and counting
    those puts a parcel that has only just been turned around at "on the way
    back".

- **A `published`/`public` article can sit inside a folder nobody may read, and
  production has fifteen of them.** _Found 2026-08-31, building the widget's FAQ
  screen._ The Arabic staff handbook (`دليل الموظف`) is four `agents_only`
  folders whose articles are each marked `status = 'published'` and
  `visibility = 'public'` — so `articleVisibleTo(ANONYMOUS)` alone returns the
  employee handbook, and only `folderVisibleTo(ANONYMOUS)` beside it keeps that
  out of a panel embedded on a customer's website. `lib/kb/visibility.ts` already
  says the folder gates the article; what was not written down is that the
  combination exists in real data rather than in principle, which is what makes
  a query missing the second predicate look correct in testing.

  Two consequences beyond remembering to write both. Any new KB read model takes
  a `KbViewer` and applies **both** predicates — `folderArticles` in
  `lib/kb/queries.ts` is the shape to copy. And any admin control that _names_ a
  folder for a customer-facing surface has to exclude the non-public ones from
  the picker and refuse them in the action — one rule, in
  `offerableFaqFolders`/`resolveFaqFolders` (`lib/widget/config.ts`), because a
  picker offering more than the action accepts presents a choice that fails on
  save. A staff folder chosen there would otherwise save cleanly and then show
  the customer an empty panel, reading as a broken feature rather than a refused
  setting, and nobody goes looking for the cause.

  `folderArticles` also carries `eq(kbArticles.locale, locale)` even though the
  folder implies it. A folder has no locale of its own — it inherits its
  category's — and only one console action enforces that an article filed in it
  matches; the Freshdesk importer does not. Without the predicate one mis-filed
  row puts an English FAQ in the Arabic widget, where every tap 404s, because
  `getArticle` _does_ filter on locale.

- **An unverified value written to `contacts` is an identity-matching key, even
  with no `contact_identities` row.** _Found 2026-08-31, in review of the widget
  work._ `mergeCandidates` (`lib/contacts/merge.ts`) matches on `primary_email`
  **and** `primary_phone`, so anything the out-of-hours widget form stores
  surfaces as a merge suggestion: a visitor who types a real customer's mobile
  makes that customer appear beside their own throwaway contact, reason
  `'phone'`. Nothing merges on its own — the decision stays with an agent, and
  the address beside it has always had the same exposure — but "it gets no
  identity row, so it is inert" is not a sound argument, and it had been written
  into `attachVisitorDetails` before anyone checked the merge suggester.
  Skipping the identity row narrows the blast radius from a routing rule to a
  suggestion an agent can decline; it does not remove it.

41. **The plus-addressed reply token does not survive the mail path into this
    system, so the first reply anybody ever sent us bounced.**
    _2026-09-01, side conversation #3 on ticket #13756._

    An agent opened a side conversation, the hub received it, replied — and got a
    bounce back in their own inbox. Nothing arrived on the ticket. `jobs` showed
    `send_side_email` completed, `side_conversation_messages` showed the outbound
    row `sent`, and `webhook_events` showed **no inbound email at all**, that day
    or since 2026-08-18.

    The reply address is the cause. `replyDomain()` resolves to `shipblu.com`,
    whose MX is **Zoho**, and the route into this system is a Zoho forwarding
    rule on the single address `help-support@shipblu.com` pointing at Postmark's
    inbound endpoint `69a4cd2a…@inbound.postmarkapp.com`. The Reply-To we
    advertised was `help-support+s3.<sig>@shipblu.com`, which is not that address
    and is not a Zoho mailbox — so it was rejected at Zoho, before Postmark could
    ever see it.

    **Threading was never the problem; the address was.** `resolveThread` is
    fine, the HMAC is fine, and the three-signal design is fine. What was wrong
    is that the most reliable of the three signals is the only one that needs the
    _mail path_ to cooperate, and nothing had ever checked whether this one does.

    It hid for two weeks because **this was the first outbound email the system
    had ever sent to a real recipient.** All three rows in `messages` for the
    `email` channel are inbound, from the 2026-08-18 routing test. A Reply-To had
    never been exercised, so a flaw present since August surfaced the first time
    somebody used the feature.

    So `EMAIL_REPLY_PLUS_ADDRESSING` now gates the token, default off, and the
    fallback is `EMAIL_FROM_ADDRESS` itself — the one address provably
    deliverable, because we just sent from it, and the same answer
    `send-notification-email` has always given. Replies thread on `References` or
    on the signed `[#S3.<sig>]` subject tag instead, both of which were exercised
    end to end when the feature landed (§7).

    **Inbound still accepts a token wherever one appears**, so this is reversible
    from the dashboard alone: add a Zoho routing rule covering
    `help-support+*@shipblu.com`, confirm a plus-addressed test mail reaches
    `webhook_events`, then set the variable. Tokens already in the wild keep
    working either way. Two general lessons:

    - **A reply address is infrastructure, not code.** Whether `user+tag@` is
      deliverable is a property of the receiving mail host, and Zoho, Google and
      a raw Postmark inbound address all answer it differently. Check it against
      the host before designing on top of it.
    - **A feature verified end to end against a local Postgres has not been
      verified against the mail system.** §7 records this exact path threading
      three separate ways — and every one of those runs fed the parser an email
      that had already been constructed, so none of them could have caught a
      delivery that never happens.

42. **Graph refuses a comment reply the app is not approved for with code 200,
    which the send-error explanations did not cover — so the agent got
    "(#200) Permissions error" and nothing else.**
    _2026-09-01 12:25:01 UTC, ticket #13755._

    `POST /1261963959273229_1084459191222048/comments` came back `HTTP 403`,
    code 200, `"(#200) Permissions error"`. `explainMetaSendError` matched only
    `100/33` on the comment path, so the refusal fell through to the generic
    branch and the timeline showed Meta's five words verbatim. The agent then
    tried **Reply privately**, which failed too — that one as `100/33`, so it
    _did_ get the full explanation, which leads with "the comment is gone". Two
    failures on one ticket pointing at opposite causes, neither of them right.

    **That second failure had its own cause and this entry did not find it:** the
    private reply was posting to an endpoint Meta removed after Graph API v3.2.
    See §6.43. Nothing below is wrong about the comment reply, but do not read
    this entry as having accounted for the private one.

    The cause is the approval: **`pages_manage_engagement` at Advanced Access**,
    which this Page token does not carry. The discriminator was already written
    down in `commentTargetExplanation` — "that one fails _every_ comment reply
    rather than this one, so it is only the answer if no reply has ever
    succeeded" — and the database settles it: across all time,
    `meta->>'sendKind' = 'comment_reply'` has exactly one row and it is this
    failure. **No comment reply has ever succeeded here.**

    `lib/meta/errors.ts` now matches 3, 10 and 200 on the comment edges — the
    same three codes the profile lookups already treat as "Graph refused the app,
    not the request" — and says so, naming the permission, Advanced Access, and
    `check_meta_permissions`. Kept separate from the `100/33` branch on purpose:
    the two need opposite responses, and folding them together would have made
    the observed refusal print the deleted-comment sentence.

    The file's own instruction is what was followed here: it said the comment
    branch was "not observed against the real Graph … if a real refusal arrives
    wearing a different code, read it out of the log and widen this rather than
    guessing now." One arrived. It was read out of the log.

    **Getting the grant is circular, and `test_comment_permission` is the way
    out.** The App Dashboard will not offer the "Request advanced access" button
    for `pages_manage_engagement` until the app has made a _successful_ call
    against it — and it can take 24 hours to activate after the first one. There
    is no path to that from the console, because every comment reply an agent can
    reach is the refusal above. So:

    ```bash
    npm run job -- test_comment_permission
    ```

    It comments on the Page's own newest published post and deletes the comment
    in the same run, which exercises the permission in both directions. Options:
    `postId=<id>` to choose the post, `keep=true` to leave the comment up,
    `message=...` to change the words. It writes to the live Page, so it is a job
    somebody types and nothing schedules.

    Read the outcome, because the two mean opposite things. Succeeding says the
    scope is on the token and only the Advanced Access grant is missing. Being
    refused with the same code 200 says the scope is **not on the token at all**,
    which no test call can fix — the Page token has to be re-minted with
    `pages_manage_engagement` in its OAuth scope list, and
    `check_meta_permissions` shows whether `granular_scopes` names this Page.

43. **The Facebook private reply was posting to `{comment-id}/private_replies`,
    an edge Meta removed after Graph API v3.2 — on a client that addresses
    v23.0.** _2026-09-02, found by checking the shape against Meta's reference._

    Every Facebook private reply this app has ever attempted asked a comment node
    for an edge it does not have. Three attempts, all failed, none by any other
    cause:

    | When (UTC)          | `sendKind`      | Result                           |
    | ------------------- | --------------- | -------------------------------- |
    | 2026-09-01 12:25:36 | `private_reply` | `100` "Unsupported post request" |
    | 2026-09-02 08:29:53 | `private_reply` | same                             |
    | 2026-09-02 10:39:17 | `private_reply` | same                             |

    **The log could not have told us.** Graph answers a nonexistent edge with
    code `100` and this sentence:

    ```
    Unsupported post request. Object with ID '…' does not exist, cannot be
    loaded due to missing permissions, or does not support this operation.
    ```

    Which is, word for word, what it says about a comment the customer deleted.
    That is the exact failure mode `lib/meta/comments.ts` was written to defend
    against, stated in its own header comment, and it caught Instagram's three
    wrong shapes while carrying this one. §6.42 read one of these very rows as
    the deleted-comment case one day earlier.

    **Production still cannot isolate it, and this is worth being careful
    about.** `comment_reply` uses `POST /{comment-id}/comments`, which _is_ a
    valid edge, and it failed identically — same code, same sentence, same object
    id — six times over the same two days. So the two share a visible cause,
    §6.42's missing `pages_manage_engagement` at Advanced Access, and the logs
    cannot separate that from this. Both are real and they are independent:
    granting the approval would have left the private reply failing with an
    unchanged error message. Do not close this by reading a green comment reply.

    The fix is a deletion rather than a correction. Meta documents one shape for
    both platforms now — Messenger Platform → Private Replies — and it is the one
    `commentRequest` already built for Instagram:

    ```
    POST https://graph.facebook.com/v23.0/{PAGE_ID}/messages
    { "recipient": { "comment_id": "…" }, "message": { "text": "…" } }
    ```

    So the `platform === 'facebook'` branch is gone and there is no Facebook
    spelling left to drift. Host and token stay `endpoint()`'s business, which is
    the only thing that still differs between the two.

    **It also moves which approval governs the send**, and §6.42's explanation
    said the opposite. A private reply is a message addressed to a comment id,
    sent through the endpoint a DM goes out of, so it needs **`pages_messaging`**
    plus the **MESSAGING** task on the Page — not `pages_manage_engagement`. The
    old text ("a private reply needs it too — the same approval covers both") was
    true of neither endpoint, and would have sent an agent after a grant that
    could not have changed the answer. `commentPermissionExplanation` now branches
    on `sendKind` and names the messaging permission. Note the MESSAGING task is a
    role on the asset rather than a scope on the token, so `granular_scopes` — and
    therefore `check_meta_permissions` — cannot rule that half in or out.

    **The durable lesson is about the test, not the endpoint.**
    `comments.test.ts` opens by saying every assertion in it is against Meta's
    reference, which is the right instinct and is why the Instagram shapes are
    correct. It did not survive contact with a _removed_ feature: the removal
    notice lives on its own legacy page, while the v23.0 Comment node reference
    simply does not list the edge among `comments`, `likes`, `reactions`,
    `private_reply_conversation`. An absence reads as "the page did not bother",
    not as "this was deleted". When writing a shape down from a doc, check the
    node reference **for the version the client actually addresses** and treat a
    missing edge as a finding.

    **Confirmed working the same day.** An Instagram private reply went out at
    11:55:43 UTC with the corrected shape and came back `sent`, carrying a real
    `IGMessageID`. That is the first private reply this product has ever
    delivered, on either platform. Facebook's is refused for an unrelated reason
    — §6.44.

44. **A private reply is subject to the handover protocol, and the console
    explained it as a missing permission.** _2026-09-02, two Facebook private
    replies, `10 / 2018300`._

    With the endpoint corrected (§6.43) and `pages_manage_engagement` granted —
    a Facebook public comment reply succeeded at 11:48:20 — the Facebook private
    reply still fails:

    ```
    (#10) Message failed to send because another app is controlling this thread now.
    (Meta: code 10, subcode 2018300, HTTP 400, via graph.facebook.com)
    ```

    **This is correct behaviour and Meta's sentence is accurate.** Freshworks is
    the Page's primary receiver, so it owns the thread; a private reply is a
    message from the Page, and the handover protocol governs it exactly as it
    governs a DM. Nothing in this repo fixes it — thread control has to be passed,
    which is a decision made in the other tool. The same account's Instagram
    private reply succeeded seven minutes later over `instagram_login`, which is
    §6.29's asymmetry again: the direct connection is not installed on the Page
    and has no primary receiver to be second to.

    **What was wrong was the explanation.** `explainMetaSendError` printed the
    permission branch underneath it — go and check `pages_messaging`, run
    `check_meta_permissions` — because code `10` is one of the three
    `COMMENT_PERMISSION_CODES`, and only the **subcode** separates a handover
    refusal from a permission one. So the timeline carried a correct sentence
    from Meta followed by a wrong diagnosis from us, which is worse than printing
    nothing: the agent goes and checks approvals that were never the problem.
    `isHandoverRefusal` now matches subcode 2018300 ahead of that branch.

    A private reply is where this surfaces because it is the one send that
    reaches the messages endpoint with no inbound DM behind it.
    `metaThreadStateFromMessage` pre-empts a DM into a standby thread and returns
    a refusal before the request is made; it has nothing to read for a comment
    ticket, so Graph is the first thing that knows.

45. **The console badged every private reply "posted publicly".** _2026-09-02,
    reported off the first Instagram private reply that succeeded._

    The timeline derived publicness from `meta.metaKind`, which is `'comment'`
    for a private reply as much as a public one — it belongs to the comment
    thread and is addressed to a comment id. The `isPublic` flag the reply action
    writes for exactly this purpose was declared in the component's type and
    never read.

    The direction it failed in is the bad one: it told an agent that a sentence
    meant for one person was sitting under the post for everyone. The rule now
    lives in `lib/meta/visibility.ts` with tests, rather than inline in the
    component where it could not have one — three states out of two fields,
    written in two places and read in a third. A private reply gets its own
    "sent privately" badge, because silence left it looking like an ordinary
    comment reply.

46. **A JS array interpolated into a raw `sql` fragment is not an array to
    Postgres.** `sql`${column} = any(${values})`` reads exactly like working
    SQL and is not: drizzle-orm interpolates each element as its own bind
    parameter, so Postgres receives `any($2, $3)` — a row constructor — and
    answers `op ANY/ALL (array) requires array on right side` (42809). The
    version that shipped this way type-checked, passed ESLint and Prettier, and
    died on its first real execution. Use `inArray()`, which builds an `IN` list,
    and reach for a raw fragment only where the builder genuinely cannot express
    something.

    Found in `lib/categorise/queries.ts` by standing a Postgres up locally and
    running the query, which is the only thing that finds this class: Vitest runs
    without a database, and the `database` CI job only executes job handlers — a
    query in a page or an action, which this was, is still first executed in
    production. Same family as the `operator does not exist: text = channel`
    entry above.

47. **A rendered one-time link in `jobs.payload` is a live credential at rest.**
    _2026-09-03, caught in review before it shipped._

    The agent invitation was enqueued the way every other ticket-less email is,
    with the composed body in the payload — so the activation URL sat in
    plaintext in `jobs`. `cleanup` keeps a completed job for **7 days**, which is
    the invite's entire TTL, and never deletes a `dead` one at all, so the link
    outlives the invite it belongs to. `invites` goes to real trouble to prevent
    exactly this: a SHA-256 for the lookup and an AES-GCM envelope for
    redisplay, so that a database dump alone yields no usable token. Enqueueing
    the rendered link handed it straight back one table over.

    The fix that does **not** work is carrying the raw token in the payload
    instead and rendering the body in the handler — the token _is_ the
    credential, so that moves it without protecting it. `send_agent_invite`
    carries the invite's **id** and rebuilds the link from the envelope, which is
    the path the pending-invites screen already took.

    So: anything with a one-time link in it either carries an id and rebuilds, or
    accepts that the credential is readable for a week. `send_notification_email`
    still takes bodies, and the portal's verification and reset links still go
    through it — `password_resets` stores only a hash, so there is nothing to
    rebuild from and closing it needs a column, not a handler.

48. **`className` cannot override `FIELD_BASE`'s background, and fails
    silently.** _2026-09-03, same review._

    A read-only field was styled by passing `bg-[var(--muted)]` to `Input`
    alongside `FIELD_BASE`'s own `bg-[var(--surface)]`. Both are single-class
    utilities of equal specificity, so the winner is whichever Tailwind emits
    **later in the stylesheet** — not whichever the class attribute lists last.
    It emits `--surface` second (offsets 23493 vs 23672 in the built CSS), so the
    override never applied and the field rendered exactly like an editable box,
    on the one page whose whole point is that there is nothing to type in it.

    The surviving classes made it look half-intentional: `cursor-default` and the
    text colour do not conflict with anything, so the field was subtly different
    and not obviously wrong.

    `Input` now picks the background itself from the `readOnly` prop, so the two
    are mutually exclusive and there is no conflict to lose. Keyed off the prop
    rather than the `read-only:` variant deliberately: CSS `:read-only` also
    matches every _disabled_ field. The general rule — do not pass a utility
    through `className` that the component already sets; change the component.

49. **A body `<h1>` in a knowledge-base article renders as plain paragraph
    text.** _2026-09-03._ Tailwind's preflight resets every heading to
    `font-size: inherit; font-weight: inherit`, and `.kb-article` in
    `app/globals.css` deliberately styles `h2`–`h6` only — the article page
    already renders the title as the page's `h1`. So the 128 body `h1`s the
    Freshdesk import brought with it, across 44 of 112 articles, picked up
    nothing at all: no size, no weight, no colour, not even the `margin-top:
2em` that separates a section from the one above it, because that rule names
    `h2`–`h6` too. Verified in the served stylesheet rather than inferred:
    `h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}` and
    `.kb-article h2,.kb-article h3,…` are both in
    `/_next/static/chunks/04dkjnvi0lxh0.css`.

    Every section heading in the step-by-step guides was one of these, so
    "Order", "Customer Details" and "Packages" read as ordinary bullet text in
    the middle of a list. `lib/kb/format.ts` maps them to `h2` and lifts them
    out of the list item Freshdesk left them in.

    The general shape is worth keeping in mind beyond headings: **the stylesheet
    is the specification for what stored HTML may contain.** `.kb-article` says
    what it styles, and anything outside that list is unstyled by construction
    rather than by accident.

50. **The classes a paste brings with it are live utilities in this app.**
    _2026-09-03._ Three of the imported articles carry a chunk of ChatGPT's DOM,
    `class="markdown prose dark:prose-invert"` and all — and because this app is
    built with Tailwind, `flex`, `flex-col`, `items-end`, `gap-2`, `w-full`,
    `text-base`, `text-lg` and `mx-auto` are real rules in the served CSS
    (checked, one by one, in the built chunk). So a pasted wrapper turned part
    of an article into a flex column with its content pushed to the inline end,
    and a `text-lg` on a heading resized it. Froala's `fr-*`, Zoho's `zw-*` and
    a WordPress theme's `fusion-text` were inert; these were not.

    Two more from the same corpus, both invisible in an English spot check:
    inline `color:rgb(0, 0, 0)` from a light-mode editor, on a help centre that
    answered `prefers-color-scheme: dark` at the time — the app is light-only
    now, and the colour is stripped for the plainer reason that the article's
    text colour is the stylesheet's; and `dir="ltr"` with
    `text-align:left`, which 25 of the Arabic articles carry, un-mirroring a
    paragraph in the middle of a right-to-left page. `lib/kb/format.ts` strips
    all of it, and the rule that catches the next one is in
    `scripts/ci/repo-rules.mjs`: a write path that sanitises an article body and
    does not normalise it fails the build.

51. **`kb_articles.updated_at` is not an edit date — every page view moves
    it.** _2026-09-03._ `recordArticleView` increments `view_count` on the
    article row, and `touch_updated_at` fires on any update of a table with that
    column, so a read writes the timestamp. The article page renders it as
    "Updated <date>" under the title, which means a busy article tells every
    customer it was revised today and a quiet one looks stale.

    Two consequences. The line on the page is worth either sourcing from
    somewhere else — `kb_article_versions` knows when the body actually changed
    — or dropping. And nothing should reason about content freshness from this
    column: 99 of the 112 articles read 2026-08-19, the import date, and the
    handful that read later are the ones somebody happened to open.

52. **`current_date` in a page query is the database's date, and the database is
    UTC.** _2026-09-04._ `/reports/categories` filtered its rollups with
    `day >= current_date - N`, which is a different day from the one
    `rollup_metrics` bucketed them into for the first two hours of every Cairo
    morning — the rollup uses the reporting zone, deliberately, so that an
    evening shift does not land on tomorrow. Nothing catches this: the SQL is
    valid, the numbers look plausible, and the window is only ever wrong by a day
    at one edge. Every report now derives its window once, in the page, through
    `rangeIn()` in `lib/reports/rollup.ts`, and no read query mentions
    `current_date`. A live query comparing a `timestamptz` against that window
    has to name the zone too — cast the date to `timestamp` and apply
    `at time zone <reporting zone>`, not a bare `::date` comparison in UTC.

53. **A console page with no scroll container is silently truncated, not
    scrollable.** _2026-09-04._ The console shell is `h-dvh overflow-hidden` with
    a `min-h-0 flex-1` content column, so a page that does not open its own
    `app-scroll h-full overflow-y-auto` wrapper renders everything below the fold
    where nobody can reach it — and with no padding either. `/reports/categories`
    shipped that way and read as an unfinished page: half of it existed and could
    not be seen. `/reports/agents` and `/inbox/new` have the wrapper; the admin
    pages get it from `app/(console)/admin/layout.tsx`. A new page under
    `(console)` outside `admin/` has to bring its own.

54. **A range control over a rollup with no backfill looks broken.**
    _2026-09-04._ 7, 30 and 90 days on `/reports/categories` answered
    identically, which was reported as the buttons not working. They worked:
    `rollup_metrics` recomputes three days a night, categorisation only started
    on 2026-09-01, and there is no category backfill — the whole archive is three
    days deep (verified: `category_metrics_daily` holds 8 rows over 3 days;
    `root_cause_metrics_daily` is empty). A control whose effect is invisible has
    to say so itself, so the page now prints the window it selected and, when the
    figures begin after the window opens, says where they begin and why. Worth
    remembering for the next report built on a young rollup.

55. **The article page in the console required `kb.edit`, so no agent could
    open an article.** _2026-09-04, writing the team handbook._ `/kb` needed
    `kb.view`, which the agent baseline carries, and `/kb/[id]` needed
    `kb.edit`, which starts at supervisor. An agent could therefore see every
    title in the list, click one, and land back on the inbox with
    `?error=forbidden`.

    Survivable while the knowledge base was entirely customer-facing — an agent
    could read any of it on the help centre like anybody else. Not survivable
    the moment internal articles exist: an article addressed to agents that no
    agent can open is not published, it is filed. The page now serves a
    read-only render at `kb.view` and the editor at `kb.edit`; every write still
    goes through `requirePermission` inside the actions, so nothing was widened
    but reading.

    And "nothing was widened but reading" turned out to be the sentence to
    distrust: the read-only branch applied **no status gate**, so every agent
    could now read the body of any draft. `agent-search.ts` states the opposite
    rule for the composer — "no reviewer has agreed to its contents" — and it
    holds more strongly where the whole body is on screen rather than a search
    snippet. Readers get published articles and a notice for anything else.

    Two general shapes, both worth keeping. A permission that gates a _route_
    rather than the writes on it will eventually gate a reader it was never
    meant to. And widening who may reach a page widens everything that page
    renders, not only the part you were thinking about when you widened it.

56. **`kb_categories` has no visibility column, so a category holding only
    internal folders was still a public page.** _2026-09-04, reviewing the
    handbook._ Visibility and the role floor are columns on `kb_articles` and
    `kb_folders`; a category has neither. `getCategory` filtered the folders it
    returned and then returned the category anyway, so
    `GET /ar/c/handbook-console` answered 200 to a signed-out visitor with the
    category's Arabic name as the `<title>` and its description as the meta
    description. The fifteen articles were never reachable — every query that
    could reach one threads a viewer — but the page around them was, and it was
    indexable.

    `getCategory` now answers null when nothing inside it is readable, which is
    the cut `listCategories` already took for the front page ("an empty category
    on a help centre reads as a broken page"). The general shape: a table with no
    visibility axis inherits one only if every read of it derives the answer from
    the children that do have one.

57. **A client component importing one constant from a module that touches the
    schema ships the whole schema.** _2026-09-04, reviewing the handbook._
    `FLOOR_LABELS` — four strings — lived beside the SQL predicates in
    `lib/kb/internal.ts`, which value-imports `@/db/schema`. Three `'use client'`
    files imported it, and the first-load JS of `/kb/[id]`, `/kb/new` and
    `/kb/structure` therefore carried every Drizzle table definition in the
    repository: 579 KB per route, of which 87 KB was the schema. Nothing failed.
    `tsc`, `eslint`, `vitest` and `next build` were all green, and the evidence
    is only in `.next/diagnostics/route-bundle-stats.json`.

    The labels moved to `lib/kb/floors.ts`, which imports the visibility enum as
    a `type` and so is erased entirely; the three routes now load 484–492 KB with
    no schema string in any chunk. `scripts/ci/repo-rules.mjs` walks the graph
    out of every `'use client'` file and fails on a value import that reaches
    `db/schema` or `db/client`. It stops at `'use server'` modules — a client
    form importing its own actions file is a network boundary, not a dependency —
    which is why the first version of the check reported 88 violations.

    The trap generalises past the schema: the `node:fs` version of this mistake
    fails the build, and every other version of it just makes the app slower.

58. **`key={state.nonce}` on a form clears the fields, not the state that
    renders them.** _2026-09-04, reviewing the handbook._ Every composer and
    admin form in this app clears itself by remounting on the nonce the action
    returns, which works because the inputs are uncontrolled — the DOM nodes are
    new. A `useState` in the component that _declares_ the form is above that
    boundary and survives, so anything driven by it silently carries over into
    the next submission.

    Twice, in the same review. `/kb/structure` kept "Agents only" selected after
    adding an internal folder, so the next folder was created internal with an
    empty name box. Worse, `ReplyForm` kept `usedId` — the canned response the
    last reply used — in a hidden `cannedResponseId` field, so every subsequent
    reply from the same open ticket incremented `usage_count` for a response it
    did not contain, compounding with how many replies the agent sent.

    The rule: state that a keyed form's submission depends on belongs _inside_
    the keyed subtree, in a component of its own. State that is deliberately
    sticky (`privately` and the canned picker's language toggle) belongs
    outside it — and both are visible controls, so what carries over is on
    screen rather than in a hidden field. The side-conversation recipient was a
    third until 2026-10-05, when the picker stopped preselecting anybody: a
    recipient carried over from the last thread is the preselection that change
    removed, so it moved inside the key (`SideConversationDraft`).
    The toggle is the case that shows why the distinction is not about risk: it
    _should_ survive a send, because an agent who has decided to answer an
    Arabic ticket in English is answering the whole thread in English.

    Two corrections from 2026-10-05 (§6.80). Not every form cleared this way:
    the admin editors close instead, and `TemplateForm` never cleared. And the
    key is no longer `state.nonce ?? 0`. A refusal carries no nonce, so that key
    fell back to 0 on the first refusal after a send and remounted the form,
    which wiped it. The key now comes from `useActionForm` and holds the last
    success's nonce.

59. **An `UPDATE` that changes nothing still moves `updated_at`.**
    _2026-09-04, review of the handbook seed._ `touch_updated_at` is created
    `BEFORE UPDATE` on every table with the column by a loop in
    `db/sql/001_extensions_and_triggers.sql`, and it fires on the statement, not
    on a diff. So an upsert re-asserting values a row already holds —
    `set({folderId, visibility, position})` — writes the timestamp on every row
    it visits while truthfully reporting "0 rewritten, 15 already current".

    Two reasons that is worse than untidy. `/kb` orders by `updated_at desc`, so
    a no-op re-run floats the whole seeded set to the top of the list; and §6.51
    already records that this column is not an edit date, which is exactly the
    confusion a job moving it for nothing deepens. An idempotent writer has to
    compare before it writes, field by field.

    The measurement matters as much as the fix. The job's own tally could not
    have caught this — it was reporting the truth — and neither could
    `updated_at > created_at`, because the statement resetting the fixtures
    fires the same trigger. Diff every timestamp across the run.

60. **Splitting a column into a bilingual pair is silent data loss until
    something copies it across.** _2026-09-05, review of #137._ Migration 0025
    added `canned_responses.body_{html,text}_{ar,en}` and
    `holidays.name_{ar,en}` as `text NOT NULL DEFAULT ''` — the only shape an
    `ADD COLUMN` on a live table can take — and the new read paths look at the
    new columns only. Nothing copied the old ones. So every row that existed
    before the migration read as having no body and no name at all:
    `availableLocales` answers `[]`, the composer's picker lists a response and
    inserts nothing when it is chosen, and `sendCannedReply` logs "references a
    canned response with no body" and returns, so every automation rule that
    replies stops replying. No error surfaces anywhere a person looks.

    It reached `main` green because both tables are empty in production, which
    is also why it cost nothing: the CI `database` job proves `db/sql` replays
    idempotently against an _empty_ database, and a backfill is the one thing an
    empty database cannot test. The fix is `db/sql/004_bilingual_backfill.sql`
    plus a CI step that seeds a pre-split row before replaying — assert the
    content moved, moved to the right language, and did not move again.

    The second half is the same trap from the other end. `db/schema/config.ts`
    keeps the superseded columns for one release because the worker and the four
    crons deploy separately from the service that runs the migration and the old
    code still selects them — but the new write path had stopped filling them,
    so a row created after the migration was `''` to the old reader. An
    expand/contract window only holds if both sides are written for its whole
    length.

61. **An App Review _feature_ is invisible to every check this system makes, and
    a role on the app does not exempt it.** _2026-09-06, testing the human agent
    tag on Instagram._ Two gates share one refusal code and almost one sentence,
    and only one of them is a permission:

    |                                         | permission                           | feature            |
    | --------------------------------------- | ------------------------------------ | ------------------ |
    | e.g.                                    | `instagram_business_manage_messages` | Human Agent        |
    | granted to                              | the token                            | the app            |
    | visible in `debug_token`                | yes, in `scopes`                     | **never**          |
    | a role on the app covers it             | yes, at Standard Access              | **no**             |
    | dashboard call counter before the grant | moves                                | **cannot leave 0** |

    Every column of the right-hand side was assumed to read like the left one.
    `check_meta_permissions` reports on `scopes`, so it printed "every capability
    is granted" — truthfully — while the app was refused; the counter sitting at
    0 was read as a second, separate fault when it is the same fact seen from the
    dashboard; and "I have a role on the app" was taken as the exemption it is
    for a permission. `FEATURES` in `lib/meta/capabilities.ts` now holds the ones
    this system depends on and the job prints them as _not checked_, which is the
    only honest thing it can say about a gate a token cannot describe.

    **The diagnostic written for this refusal did not fire, for the third time in
    the same file.** `humanAgentExplanation` had been keyed on codes 1 and 2 —
    the shape of the 2026-08-20 failure, which is the shape Graph uses when it
    declines to say anything. The real refusal is `10` _with the feature named in
    the message_, so it fell through to Meta's own sentence and none of the
    context above. §6.27 and §6.34 are the same mistake on `fetch_meta_profile`
    and on comment moderation. The rule that keeps being relearned: **key a
    refusal branch on something read out of a log, and when the log finally
    arrives, go back and widen the branch** — a matcher built from the documented
    shape is silent exactly when it is needed. It now matches the feature's name
    rather than code 10 alone, because 10 is how Graph refuses an app on any
    edge.

62. **A query that times out is not evidence the query is slow, and "canceling
    statement due to statement timeout" names the victim rather than the cause.**
    _2026-09-08, over most of a day spent reading a 55-minute freeze as a
    Supabase problem._ The app's only error line was a failed
    `attachments ⋈ messages` select on one conversation. Run against production
    unchanged, that statement is a three-index nested loop over a **192-row**
    table for a ticket with **five messages**: `Execution Time: 0.399 ms`. It was
    killed at the two-minute `statement_timeout`. It was not blocked on a lock
    either — `log_lock_waits = on`, `deadlock_timeout = 1s`, and not one
    lock-wait line in the window.

    The two minutes were spent waiting for a **pool slot**, not in Postgres.
    `db/client.ts` runs `max: 10` with no query timeout and no checkout timeout
    anywhere in the repo, and postgres.js queues beyond `max` in memory,
    uncapped and untimed: a query submitted when all ten slots are busy returns
    a promise that settles when a slot frees and **never rejects**. So Postgres
    logs nothing, CPU idles (0.1–0.3% throughout), and the one statement that
    had reached a backend is the only thing that leaves a trace — pointing at
    itself.

    **The one-step test: look at the worker.** It shares the database, the
    pooler and the network, and it was answering in 46–661 ms in the middle of
    the freeze. If the worker is healthy while the web service is not, the
    database is not the problem, and no amount of `pg_stat_statements` will say
    so — its top entry here is a catalogue query Supabase Studio issues.

    Two consequences worth carrying separately. `app/api/health/route.ts` awaits
    `select 1` on the same exhausted pool and only catches _rejections_, so it
    hangs instead of returning its 503 — which is why the instance was not
    replaced for 50 minutes. And this shape is **chronic, not incidental**:
    `destination stream closed early` appears on eight days between 08-26 and
    09-08, across twelve instance ids, peaking at 26 collapses inside 900 ms on
    09-03. Full reconstruction in `plans/web-freeze-2026-09-08.md`; §5 is revised
    in light of it.

63. **A doc comment naming its own callers is not evidence it has any, and a
    dead function is cheapest to run and dearest to read.** _2026-09-09, found
    while deleting dead exports rather than by debugging anything._ Twenty-seven
    exported values had exactly one mention in the repo — their own declaration.
    Four of them described the system's behaviour in the present tense and got
    it wrong: `onInboundMessage` opened with "the single call every inbound path
    makes" while no path made it (`lib/tickets/lifecycle.ts` inlines the same
    branch); `isSideConversationOpen` said "used by the reply action to refuse
    writing into a thread that is done", which nothing does; `allRuleKeys`
    claimed the disabled-rules check and the structural tests used it, and
    neither did; `resetEmailProviderCache` existed for tests that swap drivers,
    and no test swaps drivers. Each reads as a description of the running system
    and is a description of an intention.

    Two further consequences of the same absence. `pruneThrottleBuckets`
    promised a bound that was therefore never enforced (§5.5), and
    `linkTranslation` was a `'use server'` export with no caller — a live POST
    endpoint whose authorisation a review pass hardened without anyone noticing
    nothing could reach it. **An unreferenced export in a `'use server'` file is
    not inert the way an unreferenced function is; it is a published endpoint.**

    **Two of the twenty-seven were wired up rather than deleted, and the check
    does not care which.** `findRedirect` was live logic the legacy route had
    copied inline, and `linkTranslation` was the only implementation of a
    capability the help centre already renders the other half of (§5.5). That is
    the right shape for this rule: "nothing references this" is a fact, and
    whether the answer is a deletion or a caller is a judgement the check should
    force someone to make rather than make for them.

    **The first version of the check was itself the bug it was written about.**
    It counted bare identifiers across the repo and called an export live if the
    token turned up anywhere else, which is not the question. `lib/portal/tickets.ts`
    still held a dead `contactName` and a dead `subjectFrom` that no module
    imported, and the count waved both through — `contactName` because it is an
    ordinary object key in three other files, `subjectFrom` because two ingest
    modules happen to define their own. So the check certified a file clean while
    the defect was still in it, which is worse than no check once §6.63 tells the
    next session the scan is mechanical. It asks the module graph now: an export
    is live when another module names it in an import or a re-export, and nothing
    else counts. The resolver was already in the same file, doing this correctly
    for the client-bundle rule, and is now shared rather than reimplemented — the
    private-copy lesson again, in the file that enforces it.

    `plans/query-optimisation-and-cleanup.md` had already scanned for these,
    verified them by hand, confirmed three, and asked for the check to be made
    mechanical so the next session would not redo the scan. The next session
    redid the scan. The rule is now `dead-exports` in
    `scripts/ci/repo-rules.mjs`, which finds all twenty-seven on `b1d911a` and
    none on the branch that fixed them — because a scan a session performs is a
    scan every later session performs.

64. **A migration's lock estimate ages with the tables it locks, and #157's was
    eleven days stale.** _2026-09-20, found by re-measuring before the deploy
    rather than after it._ The declined finding on #157 costed migration 0026's
    five non-concurrent `CREATE INDEX` and concluded "the builds are sub-second"
    from `messages` at 44,705 rows / 39 MB and `conversations` at 13,817 / 3.9
    MB. Both figures were right when written. By the deploy `messages` was 95,452
    rows / 85 MB — and the **sixth** index, the partial rebuild on
    `webhook_events`, had never been costed at all, on a table that had reached
    **402,197 rows and 894 MB of heap**. A non-concurrent build holds a SHARE
    lock for a full heap scan, and `webhook_events` is the table every inbound
    webhook inserts into before returning 200.

    What made it safe was timing rather than luck: checked immediately before
    merging, inbound was **4 deliveries in ten minutes** against a 24-hour mean
    of ~1,309/hour, because 23:40 UTC is 02:40 in Cairo. The deploy ran
    23:38–23:41 and 46 webhooks landed in the following quarter hour with nothing
    dropped. Run this migration's shape in the Cairo small hours, and re-read the
    table sizes rather than the pull request's — `lock_timeout` bounds _acquiring_
    the lock, never holding it, so a stale estimate does not fail loudly, it just
    blocks writes for as long as the scan takes.

65. **The index nobody had measured was costing an admin page nineteen seconds.**
    _2026-09-20, measured either side of the same deploy._ `#155` replaced
    `webhook_events_unprocessed_idx` — a full index on `(processed_at,
received_at)` — with a partial one on `received_at where processed_at is
null`, and argued it from write cost and 13 MB of disk. The read side turned
    out to be the bigger half. `lib/reports/live.ts`'s `count(*)`/`min(received_at)`
    under `where processed_at is null`, which is on an admin page:

    |                | before        | after     |
    | -------------- | ------------- | --------- |
    | Execution time | **19,445 ms** | **86 ms** |
    | Heap fetches   | 24,848        | 99        |
    | Buffers        | 21,956        | 242       |

    The leading column was non-null on ~98% of rows, so the index-only scan was
    doing a heap fetch for nearly every one. Nobody had run an `EXPLAIN` on it;
    the page was presumably just known to be slow. The lesson is the method —
    when a rewrite is argued from write cost, `EXPLAIN (analyze, buffers)` the
    read it serves before and after, because that is where the number nobody
    expected turns up.

66. ~~**A cron has been running two of its three jobs.**~~ **Fixed 2026-09-25;
    the diagnosis below stands and is why the fix was safe.** _Found 2026-09-21
    by reading `list_services` against the file while deploying something else._
    `render.yaml:400` declares `shipblu-sla-sweep` as
    `sla_sweep && presence_sweep && assign_sweep`. The running service
    (`crn-da1jgtg1ne8s73ciqup0`) is `sla_sweep && assign_sweep`. The other three
    crons match their blueprint entries character for character, so this is not
    a sync that failed — it is one hand-edit to one service, and nothing records
    who made it or why.

    **`presence_sweep` therefore runs nowhere in production**, and has not for
    at least as long as the dashboard has held that command. It is the
    background half of the idle policy — the half that catches a slept laptop, a
    dropped network, a console on an instance a deploy replaced, and a browser
    closed without ever going idle.

    What it does _not_ mean is that agents stay signed in. `getSessionAgent()`
    enforces the sign-out on every page and every action, so an abandoned
    session is already refused on its owner's next request. What accumulates is
    the rows, and the rota: an abandoned console goes on reporting its owner as
    available until somebody touches it.

    Measured before proposing the fix, which is the useful half of this entry.
    `presence_policy` holds **zero rows**, so `loadPresencePolicy()` returns
    `UNSET` — `DEFAULT_POLICY` (away 10 min, sign-out 30) with `changedAt: null`.
    That null matters: `signOutCutoff`'s grace period only protects a window
    somebody _just enabled_, and there is nothing to grant a grace against here.
    So the first run after this is fixed deletes **31 of 32 sessions** and parks
    **0 agents** — zero because `shouldAutoAway` requires `presence = 'online'`
    and only one agent is, and that one is inside the window.

    **No check in this repo can catch this.** `job-registry` in
    `scripts/ci/repo-rules.mjs` proves every `npm run job --` in `render.yaml`
    names a real `JobType`; nothing compares `render.yaml` to the dashboard,
    because CI has no Render credential and the blueprint is not authoritative
    over a service somebody edited by hand. `render.yaml` describes the system
    we meant; `list_services` is the only thing that reports the one that is
    running. Read the second before believing the first about anything
    operational — a cron's declared command included.

    **How it was fixed, and why in two steps rather than one.** The start
    command is not editable through the Render MCP tools — they expose create,
    read, `trigger_deploy` and environment variables, and nothing that updates a
    service. The one available path is `create_cron_job`, which is a delete and
    a create rather than an edit, and losing this cron's run history is a worse
    outcome than the drift. So the edit itself was made by hand in the
    dashboard, and it now matches `render.yaml:400` character for character.

    Before that, the backlog was spent deliberately: one `presence_sweep`
    enqueued as a `jobs` row at 2026-09-25 00:02, which the worker claimed and
    completed. It deleted **all 26 sessions** and parked **0 agents**. The shape
    of the 09-21 prediction held exactly; only the count had moved, 32 → 26.

    That ordering is the point. Restoring the command with the backlog still
    there would have been the retroactive-timer trap `lib/presence/idle.ts` is
    written against — the first run destroying every session at once, with no
    countdown, because `changedAt` is null and grants no grace. Running it by
    hand first spent that blast radius at a chosen moment: **0 sessions active,
    0 in the 30-minute-to-2-hour band, the newest 17.5 hours idle**, so nobody
    was mid-reply and nothing was owed a countdown. Seeding a `presence_policy`
    row to buy the grace window was considered and rejected — it would have
    written config nobody asked for to protect zero at-risk sessions.

    Verified on the next scheduled run, 00:10:45 UTC, green, with the 00:05 run
    on the old command directly above it in the same log:

    ```
    [job] sla_sweep ok in 257ms
    [presence_sweep] parked=0 sessions_signed_out=0
    [job] presence_sweep ok in 195ms
    [job] assign_sweep ok in 805ms
    ```

    `assign_sweep` running _behind_ `presence_sweep` is the half worth checking
    rather than assuming: these are chained with `&&`, so a sweep that threw
    would have taken the run red and stopped assignment behind it.

    One loose end left rather than acted on: **5 agents still hold
    `is_accepting_tickets` with no session and `presence = 'offline'`.** That is
    believed harmless because presence gates assignment eligibility, so an
    offline agent is not picked regardless — but that path was not traced, and
    this is recorded as an open question rather than as a fact.

67. **A warning in this file about live infrastructure had drifted into saying
    the opposite of the truth, and still read as careful.** _2026-09-21, same
    pass._ §2 used to say staging "is pinned to the feature branch
    `claude/shipblu-support-app-03p2we` rather than to a staging branch" and
    told the reader not to assume it tracks `main`. `render.yaml:508` does say
    that. The running service says `branch: main`, `autoDeploy: yes`,
    `autoDeployTrigger: commit` — it is the **only service in the project that
    deploys itself**, and the advice was backwards.

    Inert today, because staging is suspended. The cost is banked rather than
    paid: resuming it arms an automatic deploy of `main` on the next commit,
    against staging's own Supabase project, at a moment when whoever resumed it
    believed they were deploying an eleven-month-old feature branch.

    The shape is worth more than the instance. A sentence about infrastructure
    is true on the day it is written and silently expires afterwards, and a
    confidently-worded one expires no more slowly — this one survived several
    passes over this file precisely because it sounded like somebody had
    checked. Both §2 paragraphs now name their source, and anything in this file
    that asserts what a service is configured to do should be read as a claim
    with a date on it, re-checked against `list_services` before it is acted on.

68. **Two changes that were each sound shipped in one release and produced a
    ratchet.** _2026-09-25, found by comparing `list_services` to `render.yaml`
    — not by the comparison, but because `shipblu-nightly` was the only cron in
    the listing with no `lastSuccessfulRunAt` at all._

    `#153` gave every query a 30-second deadline. `#155` widened webhook
    retention to three clauses. Both landed in `#159`, deployed 2026-09-20
    23:38. The `cleanup` run that same night — on the old code, hours earlier —
    took **25,483 ms**. The deadline it was about to be given was 30,000.

    | Night | `cleanup` |                        |
    | ----- | --------- | ---------------------- |
    | 09-20 | 25,483 ms | ok, pre-deadline       |
    | 09-21 | 27,249 ms | ok                     |
    | 09-22 | 30,240 ms | ok                     |
    | 09-23 | —         | **cancelled, `57014`** |
    | 09-24 | 31,929 ms | ok                     |
    | 09-25 | —         | **cancelled, `57014`** |

    **The compounding is the part worth understanding.** Every night the delete
    is cancelled, the rows it should have removed are still there to slow the
    next attempt — so the table and the runtime climb together and the failure
    gets likelier, not flatter. 402,172 rows on 09-20; 440,587 and 1,172 MB on
    09-25. A bare `count(*)` on the table timed out at 60 s while this was being
    diagnosed.

    And the cron chains `cleanup && rollup_metrics`, so **a failed night
    silently skips the rollup too**. Metrics survived only because the failures
    were not consecutive and `rollup_metrics` recomputes three days back — which
    stops being true the moment two land in a row, which the ratchet was making
    likelier every night.

    Neither PR could have caught this, and that is the lesson rather than an
    excuse. `#153` measured the deadline against request paths, where 30 s is
    already past the point a reader has left. `#155` measured retention against
    correctness — which rows, not how long. The interaction lives in neither
    diff, and nothing in CI can see it: Vitest runs no SQL, and the `database`
    job runs `cleanup` against an empty schema where one statement and a
    thousand are indistinguishable. **A deadline is a claim about every query's
    duration, so adding one is a change to every long-running statement in the
    system, whether or not the diff mentions them.**

    **The fix is the deadline, and it took a wrong turn to establish that.**
    `DB_QUERY_TIMEOUT_MS` is set to 180,000 on `shipblu-nightly` alone — the
    per-service exception `lib/env.ts` already describes, on the one service
    that is the case it describes. The first attempt was to batch the delete
    into 5,000-row statements, and review caught that it is **strictly worse**
    before it shipped.

    The reason is worth keeping, because the batching looked obviously right:
    **the cost is not the deleting, it is finding the rows.** No index serves
    this predicate — an `OR` needs every arm indexed before Postgres will build
    a `BitmapOr`, and only the third arm has one. So the plan is a sequential
    scan of the whole table, and a bounded `LIMIT` does not bound a scan. On
    2026-09-25:

    ```
    Seq Scan on webhook_events  (actual time=970.599..18946.837 rows=5000)
      Rows Removed by Filter: 332234
      Buffers: shared hit=13339 read=97073
    Execution Time: 18959.439 ms
    ```

    18,959 ms to find the _first_ 5,000 of **27,976 matches in 436,200 rows**.
    Batching pays that per batch, so six batches cost six full scans where one
    statement cost one. The bound that appears to make each statement cheap
    makes the job quadratic.

    Two numbers settle what the problem actually was. Only **6% of the table is
    deletable**, and the oldest row is **exactly the retention horizon** — so
    retention keeps the table bounded whenever it runs, and this was never a
    backlog that needed draining in pieces. It was one scan that outgrew one
    deadline.

    **Left open, deliberately: indexing the predicate.** Two partial indexes
    would let the other two arms be served — `processed_at` where it is not
    null, and `received_at` where `signature_verified` is false — and turn the
    scan into a bitmap. That is the real optimisation, and it is a build lock on
    a 1.2 GB table, which §6.64 is the lesson about. Its own change, its own
    window. Not urgent: at 30-day retention and current volume the scan grows
    with daily traffic rather than without bound, and 180 s is several times the
    headroom needed.

    **Also left, with reasons: the `&&`.** `cleanup && rollup_metrics` still
    skips the rollup when cleanup fails. `;` is what the sibling cron uses and
    the argument there is explicit — a snapshot's measurement cannot be taken
    again once the hour has passed. A rollup's can: it rebuilds three days on
    every run, so a skipped night self-heals on the next one. Swapping the
    operator would trade a visible failure for a silent one, since the cron's
    exit code would then be the rollup's alone. The reason it was ever a problem
    was cleanup failing nightly, which is what the deadline fixes.

    The deadline was raised before any of this was understood, because the next
    run was hours away and any fix needed a deploy. That ordering was right even
    though the fix it was buying time for turned out to be the wrong one.

69. **A null `whatsapp_account_id` is invisible to every read and unreachable by
    the sync that would repair it.** Rows that predate multi-WABA carry null, and
    three separate filters then agree to ignore them:
    `listApprovedTemplates(accountId)` matches on `= accountId`, so an agent's
    template picker is simply empty; the upsert's conflict target is
    `(whatsapp_account_id, name, language)` and a null never matches, so the next
    sync inserts a second copy beside each orphan rather than updating it; and
    `staleTemplateFilter` skips nulls too, so the orphan stays `APPROVED` for
    ever. Nothing logs, and the console shows the account as synced.

    The adoption in `ensureEnvironmentAccount` is the only thing that clears
    them, and it used to run only on the call that _inserted_ the row — so
    connecting `WHATSAPP_WABA_ID` by hand on the channels screen, which that
    screen invites, took the insert path away and left every template orphaned.
    It now runs on every call. That is safe because a null link can only mean
    "configured before there were accounts": `saveChannel` refuses a WhatsApp
    channel with no account once one exists, and a template is only ever written
    by the sync, which always names one.

70. **A form field that is not rendered submits nothing, and `text()` reads
    nothing as `''`.** Ticking "send nothing" on an auto-response unmounts the
    four body textareas, so saving wrote four empty strings over the Arabic,
    English and holiday messages behind them — muting a rule for a week
    destroyed its content, and un-ticking the box gave back four blank boxes
    with no undo. The guard that would have caught it
    (`!silent && !bodyAr && !bodyEn`) is skipped in exactly the case that does
    the damage. A server action must write only the fields the form actually had
    on screen; a conditionally rendered field means a conditional in the
    `values` object too.

71. **`next dev` rewrote AGENTS.md whenever it thought an agent was running
    it.** _2026-09-25._ Next 16 detects a coding agent and appends a block of
    its own to `AGENTS.md` on every start, telling the agent to commit it — and
    `CLAUDE.md` and the Copilot file are symlinks to that file, so every session
    that ran the dev server was left with a dirty tree whose easiest resolution
    was committing text nobody here wrote. `agentRules: false` in
    `next.config.ts` turns it off (#172); the reasoning is beside it, and the
    `next-agent-rules` repo rule fails a pull request that drops the setting,
    including a Next upgrade that removes the option. If a session's tree still
    shows AGENTS.md modified after `npm run dev`, Next has found another way to
    write it.

72. **A browser submits a textarea's line breaks as CRLF, so a split on `\n`
    never sees a blank line.** _2026-09-25._ The HTML spec normalises a
    textarea's value to `\r\n` in form data, and `textToHtml` split
    paragraphs on `/\n{2,}/`, which `\r\n\r\n` does not match — so every
    agent reply, and every canned response saved from the admin textarea, went
    out as one `<p>` joined by `<br>`s. Nothing looked wrong in a unit test fed
    `\n`. Any helper reading text a person typed into a form normalises line
    endings first (#171).

73. **`fetch` with no signal waits five minutes, and a signal governs the body
    as well as the status.** _2026-09-26._ Node 22's `fetch` gives up on its own
    only after five minutes without response headers, and never on a body that
    keeps trickling in (undici's `headersTimeout` and `bodyTimeout`, both
    300 000 ms, read from Node's own source). The worker awaits a whole batch
    before it claims the next, so one unresponsive provider held every queued
    job — sends included — for at least that long, which is also exactly the
    stalled-job reclaim window. And an `AbortSignal.timeout` passed to `fetch`
    keeps running while the body is read: a deadline passing after the status
    rejects `text()`, `json()` or a stream reader with the signal's own
    `DOMException`, which names no call and is not the client's error type. A
    body read outside the client's error handling therefore escapes it — and on
    a send the provider had already accepted, that becomes a retry and a second
    copy to the customer. The escape itself never reached `main`: it was caught
    in review of the first commits of row 2.8 of `plans/refactor-in-stages.md`,
    before any of them merged, and that row (#184–#188) gives every outbound
    call in a job path a deadline and reads each body inside it. Two clients
    already passed a signal before it, `lib/shipments/platform.ts` and
    `lib/typesafe/client.ts`, and both read the body inside their own `try`, so a
    deadline passing mid-body there is caught and retried as transient. Neither
    sends anything to a customer. Until the follow-up to row 2.8 (#205) both
    misreported it, though: a timeout mid-body read as "a 200 that was not
    JSON", which points at a proxy rather than at latency, and one at the status
    as the signal's own nameless "aborted due to timeout". Each now checks
    `isTimeout` from `lib/http/deadline.ts` and names the deadline in seconds.

74. **A run of merges to `main` shows cancelled CI runs, and they are not
    failures.** _2026-09-25._ `ci.yml` puts every run for a ref in one
    concurrency group and exempts `main` from `cancel-in-progress`, so an
    in-flight run on `main` is never cut short — but a group holds at most one
    _pending_ run, and GitHub cancels the waiting one when another arrives. Merge
    three PRs in a minute and the middle merge commit's run reads "cancelled".
    Judge `main` by its newest head. If that head's own run reads cancelled,
    re-run it once; a second failure is real. Row 0.4 (#193) gives each push to
    `main` a concurrency group of its own, after which every merge keeps its
    result and this entry describes history.

75. **Two traps in the cloud agent container, not in the product.**
    _2026-09-25._ `pkill -f <pattern>` matches the shell running the command,
    because its own command line contains the pattern, so a one-line "stop the
    dev server and restart it" kills itself before the restart. Kill by pid — a
    pid file, or `pgrep -x` on the process name — rather than by `-f`. And the
    session's scratchpad parent, `/tmp/claude-0`, loses its `o+x` bit within
    seconds of being given it, so a Postgres started as the `postgres` user with
    its data directory under the scratchpad dies with "could not stat data
    directory". Keep a local database's data directory somewhere the `postgres`
    user can traverse on its own, or verify against CI's `database` job instead.

76. **The Blueprint had not synced in weeks, and the error named the one
    service nobody runs.** _2026-09-25._ Every sync failed with
    `projects[0].environments[1].services[0].branch: branch
claude/shipblu-support-app-03p2we could not be found` — staging's pin to a
    feature branch that had been deleted. One unresolvable field fails the
    whole sync, so none of the six production services had been reconciled
    against `render.yaml` either, and the file drifted unchecked. §6.67 had
    already recorded that the running staging service tracks `main`; nothing
    acted on it because staging was suspended and the failure looked local to
    it.

    The drift found when the file was re-read against the dashboard was worse
    than the error. The blueprint generated `APP_SECRET` into `shipblu-shared`,
    where it does not live — it is in `shipblu-support-production` — so the
    first successful sync would have minted a second reply-signing key beside
    the real one, in two groups linked by the same services with no documented
    tiebreak. It set `EMAIL_PROVIDER=postmark` into production while the live
    copy is in shared. It put the Freshdesk credentials on the web service,
    though the importer is a queued job and the dashboard (correctly) has them
    on the worker. And the Meta credentials and `TYPESAFE_API_KEY` it placed in
    production so staging could not inherit them are all in `shipblu-shared`,
    which staging links.

    (Group names in this entry are as they were that day; the shared group
    has since been renamed `shipblu-support-shared`, and on 2026-09-26 the
    Meta and TypeSafe keys were moved into the environment groups, with a
    separate Meta app for staging.)

    Fixed by making `render.yaml` describe rather than assert: staging on
    `main`, every group key listed as a comment with `envVars: []`, the service
    keys moved to where the dashboard has them, and `autoDeployTrigger` written
    out to match (quoted `'off'`: bare `off` is YAML 1.1 for `false`). Left for
    the dashboard, recorded in the file: `KB_PUBLIC_HOST`,
    `SUPABASE_STORAGE_BUCKET`, `APP_URL` and `EMAIL_PROVIDER` each set in two
    places; the Meta and TypeSafe keys to move out of shared before staging is
    resumed; `EMAIL_WEBHOOK_SECRET` set nowhere, so inbound mail is accepted
    unauthenticated. The lesson is the one §6.67 already taught, from the other
    side: a Blueprint that cannot sync is not documentation, it is a list of
    changes queued to land all at once on the day somebody fixes the branch.

77. **An inbound email's time was the sender's clock.** _2026-09-30, raised in
    review on #324 and fixed before it bit._ `ParsedInboundEmail.receivedAt`
    was Postmark's `Date` field, which is the mail's own header, so
    `messages.created_at`, `last_message_at`, `last_customer_message_at` and the
    next-response SLA all ran on whatever the customer's machine thought the
    time was. Two hours slow, and an answer to our 10:00 reply was stored at
    08:30. It sorted above that reply on the timeline, the card previewed our
    older message, the list ranked the ticket by 08:30, and a one-hour
    next-response target was breached before the mail arrived. Twelve hours
    fast, and the ticket sat at the top of the list all day. A header that did
    not parse became an Invalid Date, which throws on insert. The job went to
    `dead`, and a hand replay of the stored delivery parsed the same bytes and
    failed the same way, so the mail could not be ingested until the parser
    changed. The delivery row is kept for 30 days, so once the fix is deployed a
    replay (`npm run job -- process_webhook webhookEventId=<id>`) lands it at its
    original arrival.

    Sized before fixing, read-only: **5** inbound email replies in production
    ever (email is not live) and **0** of them sort before an outbound message
    that preceded them. The two that can be matched to their Postmark delivery
    carry a header **20 s** before `webhook_events.received_at`, which is the
    whole Zoho-forward-to-Postmark transit. So for an honest clock the fix moves
    the stamp by seconds, and for a wrong one it removes however wrong the clock
    was. The five stored rows were left alone, since they are already in order.

    The instant is now `webhook_events.received_at`, which `process_webhook`
    passes to ingest as `InboundDelivery`. That is our clock, and a late run or
    a replay does not move it. It is a separate argument rather than a field on
    `ParsedInboundEmail`, so nothing a provider returns can carry it. The header
    is kept as `meta.dateHeader` and nothing reads it.

    Review on #328 found three more places the same rule had to reach:
    - **A new ticket's `created_at`** was the insert's `now()`, and its
      first-response and resolution targets count from it. So a backlog was
      excused on a new ticket and charged on a reply. It is now the receipt
      too.
    - **The "last" columns moved backwards.** Each delivery keeps the instant
      it arrived, so the one processed last is not always the newest. The worker
      claims several jobs at once, and a failed attempt retries behind a later
      mail. `latest()` moves them forward only, as `interactionWindowSet`
      already did for Meta.
    - **The fallback Message-ID** for a payload carrying none was minted from
      `Date.now()`. A retry after the message had committed got a new id,
      missed the duplicate check, and stored the mail twice. It is now derived
      from the payload.

    A `stored_at` column beside `created_at` was the alternative, and it was
    rejected. It fixes only the readers that are moved onto it, leaving
    `last_message_at`, the SLA, `requesterLocale()` and volume-by-hour on the old
    value. It also puts two clocks on one row for every future query to choose
    between, and it needs a backfill and an index build on `messages` (§6.64).

    Left open:
    - **Receipt is not when anybody could read the mail.** During a worker
      backlog an agent can write after the mail arrived but before it was
      processed. `last_agent_message_at` is then later than
      `last_customer_message_at`, so `AWAITING_US` in `lib/reports/live.ts`,
      the hourly backlog snapshot and `assign_sweep`'s reclaim all read the
      ticket as answered, and the card previews our message, while
      `next_response_due_at` says a reply is owed. Any arrival instant has
      this property, and the header, seconds earlier still, had it too.
      Closing it means deciding what "awaiting us" is measured from, which is
      its own change.
    - **WhatsApp and Meta** stamp inbound rows with the provider's
      whole-second `sentAt` and ours with `now()`, so an answer landing in the
      same second as our reply can still sort before it. Their new tickets
      also still take `created_at` from the insert.

78. **The help centre's chat launcher rode into the console.** _2026-10-03,
    reported from a phone: the launcher over the inbox, bottom-left, so it was
    the Arabic one._ `viewerIsTeamMember()` keeps `ChatWidget` out of the help
    layout for a signed-in agent, and that only decides what a fresh render
    _loads_. The snippet appends its launcher to `document.body`, outside
    anything React renders, and nothing ever took it back off. The bare
    hostname opens the Arabic help centre (`app/page.tsx`), so an agent who is
    signed out loads the launcher there like any customer would. The header's
    Sign in link leads to the form on `/{locale}/account/login`, whose
    `portalSignIn` action sends an agent on with
    `redirect(safePath(next, '/inbox'))`. A redirect from a server action is a
    client-side navigation: both surfaces share the root layout, the document
    is never replaced, and the launcher stays put. The console's own `/login`
    does the same after a visit to the help centre and a press of Back. A
    panel left open full screen also covered the whole console and left
    `position: fixed` on the body.

    The gate cannot reach this, because the gate is a render decision and the
    launcher is not rendered. The fix is a lifetime, in two halves.

    The snippet gained `destroy()`. It removes the launcher, the frame, its
    stylesheet and its own tag, and every listener it added to the window, the
    document and the visual viewport. It lets go of a pinned body without
    scrolling the page the reader arrived on, and it gives up the `shipbluChat`
    name so a later load runs a fresh copy. It belongs to the help centre and is
    not part of the host API. Its docblock names the four limits a merchant
    would trip over, among them that a copy loaded after it re-reads
    `shipbluChatSettings`, identity included.

    `ChatWidget` and the gate moved up into `app/help/layout.tsx`, above the
    locale segment, and that placement is the design. The `[locale]` layout is
    replaced on every language switch, so a teardown on unmount there closes an
    open chat on every switch. The first version of this fix deferred the
    teardown by a task and let the replacing mount cancel it. That held only
    while nothing split the commit, and it ran after the browser had painted.
    In review, a measurement found a frame of the launcher over the inbox in
    about a quarter of runs. Above the segment, an unmount means the help
    centre has gone, so the teardown is a plain layout-effect cleanup and lands
    before the paint. `app/help/chat.test.ts` pins where `ChatWidget` is
    rendered and covers the orderings a navigation produces.

    Three things finish it:
    - **A snippet still loading when the reader leaves** is torn down when it
      lands. Removing its tag would not have stopped it.
    - **The help centre loads the snippet as `/widget/embed.js?v=2`**, so no
      browser can hand it a cached copy from before `destroy()` existed.
    - **Two error boundaries keep a failure inside the help centre.** Before
      them, an error fell through to `global-error`, which replaces the root
      layout. Now that the help layout going takes the chat with it, a
      customer would have lost their open conversation to an error on an
      unrelated page. `[locale]/error.tsx` catches a page. `app/help/error.tsx`
      catches the `[locale]` layout itself, whose `AccountNav` reads the
      database for a signed-in customer; a boundary never catches the layout in
      its own segment. Both answer "Try again" with `retry`. `reset` re-renders
      the failed payload the router already holds, so the button did nothing.

    Verified in Chromium at a phone size against a local build, on `main` and
    on the fix:
    - the header sign-in, with the panel open, closed and never opened;
    - the console's `/login` route;
    - Back and Forward between the two surfaces;
    - a snippet held in flight past the sign-in;
    - a language switch with the panel open, which stays open;
    - a page error mid-conversation, with Postgres stopped under a client-side
      navigation, which keeps the chat, the open panel and an unsent draft.

    On `main` the launcher, or the whole panel, was on `/inbox`; with the fix it
    was on no console page, and no page error was raised. Sampled every
    animation frame over 25 sign-ins with the panel closed and 25 with it open:
    the deferred teardown showed the launcher over the inbox in 20 of each, and
    the layout-effect teardown in none.

    Still open: a help-centre tab that was already open when its reader signed
    in somewhere else keeps its launcher on help pages until it reloads. The
    layout is not re-rendered by a soft navigation, so the gate is not asked
    again. The launcher never reaches the console that way.

    Generally: anything a script hangs off `document.body` in this app outlives
    the page that put it there, because no client-side navigation replaces the
    body. A layout-level gate on what loads does not cover what is already
    loaded.

79. **Instagram's phone-number card reached the inbox as "[template]".**
    _2026-10-05, asked about by the team._ When a customer sends Instagram a
    message that is only a phone number, Instagram follows it with a card of its
    own: "Phone number", the number, and WhatsApp message and WhatsApp call
    buttons. Meta's inbox draws it in the customer's column. The Page connection
    delivers it as a second message from the customer, whose one attachment is
    `{ type: 'template', payload: { generic: { elements: [] } } }`, with
    everything the card showed removed. `displayText()` printed an unknown
    attachment type in brackets, so the card was filed as an inbound reply
    reading `[template]`.

    Sized read-only before fixing, as of 2026-10-05 13:00 UTC: **14** such
    messages in production since 2026-09-20, in 13 conversations. All came over
    `facebook_page`, all in `standby`, and each was 0.4–1.8 s after an Egyptian
    mobile number sent alone by the same customer: 11 digits as a rule, once
    written `+20 1xx xxx xxxx`. Every valid number sent alone on Instagram was
    followed by one; a 12-digit number was not, and neither was either of the
    two written in Arabic-Indic digits, nor any of about 50 on Messenger. The
    card's effects:
    - it was the inbox headline in place of the number (9 open tickets at the
      time);
    - it counted as a second inbound message in today's volume;
    - it moved `last_customer_message_at` and restarted the next-response
      clock;
    - the categoriser read it as text.

    `parseMetaWebhook` now drops a `template` attachment with no value anywhere
    in its payload. A message left with no text, no attachments and no
    `is_unsupported` flag is not filed, and `process_webhook` logs it as
    `[meta] … empty card(s) ignored`. The rule is judged by content, not type: a
    template that carries something is the customer sending us something, and
    keeps reaching an agent. The delivery itself stays in `webhook_events` like
    every other. It takes effect when the worker is deployed.

    The 14 cards already filed were deleted by hand on 2026-10-05, matched by
    id and by the empty-card shape. Nothing referenced them but three
    `ai_category_runs.message_id` links, which the foreign key set to null. A
    backup of the rows and a restore script were checked field by field
    against the database first. They are kept outside the repo because they
    hold customer identifiers. A card filed between that delete and the
    deploy is still in `messages`. The same shape test finds it:
    `raw_body::jsonb #> '{message,attachments}'` equal to the empty card on
    an inbound Instagram reply reading `[template]`.

    Still open: the other attachment types Instagram now documents (`ig_post`,
    `ig_reel`, `reel`, `story_mention`) are not in `ATTACHMENT_TYPES` either.
    Nothing in production has carried one yet. When one does, it will read
    `[ig_post]` with an `unsupported` attachment rather than show the post.

80. **React 19 resets a form after every function action, a refused one
    included.** _2026-10-05: found reviewing the side-conversation picker's
    "Choose…" default, then measured across the console's forms the same day._
    `<form action={fn}>` makes React queue a native `form.reset()` before it
    calls `fn`, and run it once the action settles, whatever the action
    answered. A success hides this, because the form clears anyway. A refusal
    does not, and it had three consequences:
    - **Every uncontrolled field went back to its `defaultValue`.** A refused
      send wiped the reply, the note, the question, the typed address, the
      customer's email on a new ticket and an admin's whole editor, at the
      moment the agent was about to correct one word of it. An editor of a
      saved row went back to the row, which reads as an undo rather than a
      wipe. A ticked box unticked and a chosen file was dropped. On the reply
      form the hidden `cannedResponseId` survived the body it credited, which
      is §6.58's over-count again.
    - **A controlled `<select>` or checkbox stopped matching its own state.**
      In the browser React never marks a controlled select's option
      `defaultSelected`, so the reset lands on the option the server rendered
      as selected, or on the first enabled one if the form was mounted in the
      browser. A
      controlled checkbox goes back to what it showed at mount. React state
      keeps the agent's choice, so everything drawn from state still says it,
      while the control, which is what gets submitted, says something else. It
      heals on the component's next render, which is why nobody noticed:
      typing into a controlled field puts it right, typing into an
      uncontrolled one does not. Measured:
      - the side-conversation picker showed, and sent, Alexandria;
      - `TemplateForm` went back to the first template while the preview and
        the variable boxes stayed on the chosen one, so the resend sent
        template one with template two's values. Every send after a success
        did the same, because the form has no key;
      - on a comment thread, "Reply privately instead" unticked while
        `metaSendKind` still said `private_reply`, so the resend went out as
        Meta's once-per-comment private reply under a box that read public;
      - a new ticket's priority fell back, and was sent that way: to Low when
        the form was reached by the inbox's link, so even an untouched Urgent
        default was downgraded, and to the server-rendered default after a full
        page load. A custom dropdown emptied, a multi-select lost its ticks, and
        the attachment was dropped while the visibility pass still counted it;
      - the article editor showed and sent `public` under a note still saying
        the article was internal, and moved the language and folder too. A new
        knowledge-base folder was sent as Public with no floor;
      - adding a channel sent a WhatsApp number as an email channel. A group's
        assignment strategy was saved as Manual. An auto-response marked "Send
        nothing" was sent as an ordinary reply with no body. A WhatsApp account
        an admin was disconnecting was re-saved connected, and as the default.
    - **A refusal after a success remounted the form anyway.** The keyed forms
      used `key={state.nonce ?? 0}`. A refusal carries no nonce, so the first
      one after a send moved the key back to 0, and the remount wiped the form
      with or without the reset. The side-conversation form's first fix stopped
      the reset and still lost everything this way on a ticket's second thread,
      until #335 kept the nonce through a refusal.

    **How it was measured.** A scratch harness bundled each real component with
    esbuild against the React that Next vendors, in its development and
    production builds. `next/navigation` was stubbed, and every `'use server'`
    module was replaced by a stub that records the `FormData` it receives and
    answers a refusal or a success with a fresh nonce. Playwright drove it in
    the container's Chromium and counted native `reset` events and remounts on
    every refusal, so each wipe has a measured cause. The same scripts ran
    against the commit before the fix and against the fix, with every check
    phrased as the behaviour wanted, and each group of forms was re-run by a
    second, adversarial pass. In the final run of all of them, against `main`
    with #335 merged, the code before this change failed 576 of 1,112 checks
    across both builds, in 33 of 38 scenarios. The five without a failure cover
    the two side-conversation forms, which #335 had already fixed; the purge
    panel and merge rows, which were never converted; two forms on one page
    leaving each other alone; and the article editor's success path, which the
    old reset got right. The fix failed 12 of 1,150 checks: six checks on each
    build, every one of them a success-path change listed below. The extra
    scenario is the slug's, which needs the fix's answer. React logged no
    warning or error outside the redirect test, where a stand-in boundary
    catches one on purpose.

    **The fix is `useActionForm`** (`components/use-action-form.ts`):
    - It submits from `onSubmit`, cancels the native submission and dispatches
      the action inside `startTransition`. React keeps a path for exactly that
      (a submit event that was `defaultPrevented` while a transition started):
      it calls `startHostTransition` with a null action, which marks the form
      pending for `useFormStatus` and queues no reset. `SubmitButton` needed no
      change.
    - `action` stays on the form too, for a submission made before hydration:
      React captures it and replays it once it loads, where a form with no
      `action` would send its fields to the page's own URL as a query string.
      That one replayed submission takes React's own path, reset included.
    - Only a success moves its `key`. A success is what `ok()` answers; one
      without a nonce is given a fresh one, so the key and everything keyed on
      it still move. Any other answer keeps the nonce the state already had.
    - An action that throws becomes a refusal saying no answer came back, with
      the draft kept and the page re-read in case it landed. The forms whose
      retry reaches a customer or a hub (reply, template, both side
      conversations) pass `LOST_SEND`, which says to check the timeline before
      sending again. Before, `useActionState` rethrew it while rendering,
      the console fell through to `global-error`, and the draft went with it: a
      dropped connection, or an action a deploy removed. Next's own redirect and
      not-found are rethrown through `unstable_rethrow`, so `RedirectBoundary`
      still sees them; `requireAgent()` redirecting an ended session is not a
      lost send.

    The last two came from #335's `useSubmitWithoutReset`, written for the
    side-conversation forms the same day. The hook absorbed it, and those
    forms now use `useActionForm` like every other; one shape rather than two.

    Its `form` is spread onto the element, `<form {...form}>`, rather than
    wired as `action` and `onSubmit`: a form given only `action` still submits,
    through React's own path, reset and all. The `form-reset` repo rule refuses
    a console form with a function `action`, no spread and no `onSubmit`, that
    holds a field a reset moves. Run against `main` before this change it named
    15 of the converted forms; it cannot see a field another component renders
    (`EditorForm`'s children, `Toggle`).

    Converted: the composer's reply, note, template and both side-conversation
    forms; the new-ticket form; `EditorForm`, and with it every admin editor
    built on it; the channel add, edit and web-chat forms; the invite,
    idle-policy and capacity forms; the article editor, the category and folder
    forms and the translation-link picker; the contact's SBID box; and the
    tracking-phrase editor. The side-conversation forms also moved from
    hand-rolled `busy` state onto `useActionState` and `SubmitButton`.
    `SideReplyForm`'s "Sending…" had never appeared, because `setBusy(true)`
    ran inside the action's own transition.

    Three actions changed with it:
    - `saveChannel` and `createInvite` answered a success with no nonce, and
      their add forms relied on React's reset to clear. They now answer with
      `ok()`, `AdminState` builds on `ActionState`, and the add forms are keyed
      on the success.
    - `saveArticle` returns the slug it stored, and the slug box remounts on
      the save holding it. A slug left blank is generated by the server, and a
      box still blank after the save would send blank again and regenerate the
      slug from the next title, moving the article's URL. The answer arrives in
      the same commit as the key. The revalidated page is not promised to, and
      an uncontrolled input React mounts is dirty from birth, so it would not
      follow a page that arrived later.

    The translation-link picker and the contact's SBID box are keyed the same
    way as the add forms; their actions already returned a nonce.

    What the success path gave up, all measured, none of it a change to stored
    data:
    - An editor that stays open after a save (the article editor, recipients,
      channels, web chat, idle policy, the tracking phrases) shows what was
      typed rather than the server's normalised form: tags as typed, a name not
      yet trimmed or lowercased. Saving again stores the same row. React's
      reset after the success used to clear each field's dirty flag so the
      revalidated value showed. The same flag now also keeps a later change
      made elsewhere from showing in a box whose last action was a save.
    - In exchange those editors keep their selects. On `main` the reset after a
      successful save put an uncontrolled select back on the option it mounted
      on, because React never moves `defaultSelected` after mount. The next
      save quietly undid the recipient's kind, the channel's account and group,
      and the web chat's folders.
    - The newly keyed forms (the channel add, the invite, the SBID box, the
      translation-link picker) lose the caret after a success submitted with
      Enter, because the remount replaces the input; the reset kept it. The
      composer forms were always keyed and always did this.

    Left on a bare `action=`: forms of hidden fields and a button, which have
    nothing for a reset to move (`DangerAction`, thread control, profile
    refresh, comment moderation, the article status, restore and delete
    buttons, merge rows, the availability switches, the import and backfill
    buttons, agent activate). The purge panel stays too, because its one typed
    field is controlled and a reset leaves it alone. Those forms still get
    React's reset, and it changes nothing in them. Nothing else in the console
    resets a form: there is no reset button and no `requestFormReset` call. So
    a converted form's controlled select cannot drift from what it submits.
    `TemplateForm` now clears after a send: its choice and values moved into a
    child keyed on the success. It never cleared before. The values stayed and
    the reset moved only the select, so the next send paired template one with
    template two's values; without the reset, a second press would have sent
    the same paid template again. The agent's capacity box, which submits on
    blur, now sends only a value that changed since it last sent: a refused cap
    stays in the box rather than being put back, and resending it on every
    focus change repeated the refusal.

    **Not changed: the help centre and the sign-in pages**, which this fix's
    scope, the agent console, left out. Measured the same way on the same day,
    every one of them reproduces. The ones that matter: the portal's reply box
    empties a customer's whole reply when the ticket was closed while they
    typed; the portal's new-ticket form wipes everything and puts an edited
    subject back to the one it was opened with; registration empties the name,
    email and password for an address the browser accepts and the server
    refuses (`mona@shipblu`); both sign-in forms empty the email after a wrong
    password; and the agent invite puts a corrected name back to the admin's
    spelling, which a resend then writes onto the agent row. The help centre's
    ticket form keeps its typed text, which is controlled, and loses its
    dropdowns and ticks. The hook fits all of them: their `error` is a
    `StringKey`, which is a string.

    Generally: assume a native reset is a desync, not a clear. The default a
    controlled `<select>` or checkbox carries is the one it was rendered with,
    not the one React state holds, so anything that resets the form underneath
    React moves the control silently, and whatever reads React state goes on
    describing the old choice.

    The reply form was measured again on 2026-10-07, before it moved onto
    `useActionForm`, and lost the agent's text on a refusal. The
    canned-response pick it carries in a hidden field did not — React mirrors
    a controlled value into `defaultValue`, so a reset puts it straight back —
    and the next reply counted a response it no longer contained. `ReplyBody`
    cleared the pick on `reset` until the conversion left no reset to listen
    for. The pick now stays with the draft it credits, and is forgotten only
    when the agent empties the box.

81. **An `sr-only` span scrolled the whole console off the screen.** _2026-10-05,
    caught in review before merge._ The inline image preview gave each
    attachment list a screen-reader live region, `sr-only`, which is
    `position: absolute`. Nothing between the timeline and `<html>` is
    positioned, so the box was placed against the document, past the shell's
    `overflow-hidden`. That clips only what it contains, and a box whose
    containing block is above it is not contained. The span sat at its static
    position thousands of pixels down the thread and stretched the document
    to reach it: 7,791px against an 800px viewport on a 59-message ticket.
    Scrolling past the end of the timeline then chained to the window and took
    the header, timeline and composer off the screen. It happened on every
    ticket with a picture below the first screen, whether or not anybody
    opened one.

    It was invisible to every check that ran first. Typecheck, lint and the
    build have no opinion, and a browser run asserting the shell's and the
    document's `scrollTop` stayed 0 passed, because nothing had scrolled yet.
    What caught it was measuring `document.documentElement.scrollHeight`
    against `clientHeight`, and then wheeling past the end. The fix is a
    `relative` wrapper on `AttachmentList`
    (`app/(console)/inbox/[number]/attachments.tsx`), so the box belongs to the
    pane, which clips it.

    Generally: anything `position: absolute` inside a console scroll pane,
    `sr-only` included, needs a positioned ancestor inside that pane. The
    timeline pane in `view.tsx` is now `relative` itself, so nothing added to a
    thread can escape it. The inbox list's `sr-only` spans are safe only
    because their rows are `relative`. Making every `.app-scroll` positioned
    from `globals.css` looks like the general fix and is not: the class is
    declared only under `@media (pointer: fine)`, so phones would never get it.
    It is also unlayered, so it would beat Tailwind's `fixed` on the admin
    mobile nav, which carries `app-scroll`. To check, compare the document's
    `scrollHeight` with its `clientHeight`; a `scrollTop` of 0 proves nothing.

82. **A media element never comes back through `/api/attachments`.**
    _2026-10-05, found before shipping inline voice notes and video._ The route
    answers 307 to a Storage URL signed for five minutes. An `<img>` fetches
    once, so that was always enough. An `<audio>` or `<video>` fetches in
    ranges for as long as it plays, and every engine sends those later range
    requests straight to the signed URL it was redirected to. Chrome and
    Firefox were measured doing it, it is in both engines' loader source, and
    Safari has been reported doing the same. So once five minutes have passed,
    a video resumed from a pause, or seeked past what was buffered, asks
    Storage with a dead signature.

    The Storage origin answers that with a 400 and a JSON body. Chrome's
    response blocking (ORB) hides a cross-origin JSON body from the media stack
    as a network failure, and the element then retries the dead URL for about
    31 seconds before it reports an error. Firefox reports one at once. Waiting
    for the error is therefore not a recovery strategy. Every other Storage
    error is JSON too, so a range that fails for any reason after the first
    response costs Chrome the same half minute before the player can react;
    with the three reloads a player allows itself, a file whose later ranges
    keep failing takes about two minutes to reach its failure line.

    The origin checks the signature only as a request starts and then streams
    the rest, so a response that began before the deadline keeps arriving after
    it. And the project is on the Pro plan, which puts Supabase's Smart CDN in
    front of Storage: an edge that has cached a response for one signed URL
    keeps serving it for that URL after the token expires. Neither breaks
    playback, but expiry is not revocation — only deleting the object cuts off
    a URL that has already been handed out.

    `lib/attachments/signed-url.ts` decides before the request instead:
    - **When.** On a URL more than four minutes old, a play or a seek reloads
      the element when the position has nothing buffered ahead of it. A
      `waiting` is judged the same way unless bytes arrived in the last three
      seconds, because a response that is still arriving is a slow link, and a
      reload would throw it away to start the wait again. A `stalled` reloads
      when the element cannot play on, whatever `buffered` says: for a plain
      `src` MP4, Chrome maps the bytes received linearly onto the duration, so
      the bytes ahead of the first frame — a `moov` at the head of the file
      most of all — put the reported edge 1.4 to 2.5 seconds past where
      playback really starves, enough to let the `waiting` through and freeze
      the picture for 13 to 34 seconds.
    - **How.** The reload calls `load()`, which goes back through the route
      for a new signature, and puts back the position, the speed and the
      playing state. A video keeps its box while a reload ahead of an expiry
      is in flight, and focus stays on the player: Chromium 141 blurs a
      focused native control inside `load()`.
    - **Timed from metadata.** The URL's age runs from `loadedmetadata`, not
      `loadstart`. With `preload="none"`, `loadstart` fires at render, so a
      voice note played four minutes after the page opened would reload on its
      first press.
    - **`waiting` is not starvation on its own.** Chrome fires it on every
      seek, into buffered data too. Treating it as starvation reloaded a
      replayed voice note and cut the replay off.

    The route marks its redirect `no-store` and must stay a 307. A 301 or 308
    can be cached, and then the browser would reuse a dead signature.

    Voice notes rarely reach any of this. The largest in production is about
    212 KB, so the first response carries the whole note, and replaying it an
    hour later makes no request at all.

    Ogg Opus, which is what every WhatsApp voice note is, plays on an iPhone
    only from iOS 18.4, whatever browser the phone runs. Below that, an
    ungated player shows a duration and plays nothing. So the console asks
    `canPlayType` in the browser, and any phone that cannot play a note keeps
    the download link.

    Known gaps, left on purpose after three rounds of measuring them, because
    every fix tried brought a worse problem with it. Each needs a URL more
    than four minutes old:
    - A click or a drag on the timeline past what was buffered reloads at the
      first seek past the buffer. A drag lands there rather than where it was
      released, and when the reload outlasts the click the video comes back
      paused. Treating a seek close behind the controls' pause as a drag
      latched on a person's own pause-and-arrow and later played a paused
      video by itself; deciding seeks only once seeking settled reloaded in
      the middle of a drag held still, and let Firefox spend its reloads on
      every stale seek.
    - Firefox fails a request at once while the network is down, so a short
      outage that refuses connections can spend all three reloads in
      milliseconds and show the failure line. Spacing the reloads out let
      Chromium's own late `pause` stop the video it was meant to resume.
    - In Firefox, focus on a player's native control can fall to the page
      after an error reload, because Firefox blurs it after `load()` returns.

    Not verified on a real Safari: whether it keeps requesting the signed URL
    after the redirect, what it does when that URL expires, and whether
    `play()` after `load()` works without a new tap.

83. **Enter in the knowledge search sent the agent's half-written reply.**
    _2026-10-07._ The knowledge panel renders inside the inbox reply `<form>`,
    beside the canned picker, and its "Search articles…" box was a plain text
    input. Enter in a single-line input is the browser's implicit submission
    of the form that owns it. So an agent who typed half a reply, opened the
    panel, searched and pressed Enter sent that half to the customer.
    Reproduced in Chromium at desktop width and in a 390px touch-emulated
    viewport. It was not tried on a real phone's keyboard, whose search key
    reaches the page as the same Enter keydown.

    The box is now a `SearchInput` (`components/search-input.tsx`), which
    owns no form: `form=""` names none, so its form owner is null, and no key
    path can submit the reply. A keydown guard on the one input was the first
    fix. Review pointed out that it holds only for that input, and only for an
    Enter that arrives as a cancellable keydown. Enter in a `SearchInput`
    blurs it instead, since the search already runs as the agent types. On a
    phone, blurring is what puts the keyboard away so the results under it
    can be read.

    The rule is general: a text box rendered inside a form it is not a field
    of is a `SearchInput`, or Enter in it submits whatever the form submits.
    No repo rule checks it, because the box and the form it lands in are
    usually in different files, as they were here. A single-file check would
    have missed this instance, and today it would flag only the invite page's
    read-only email box, which is nameless on purpose. A sweep of every
    `<form>` in the console, help centre, widget and sign-in pages found no
    other instance, and no native `<button>` missing its `type`.

84. **A bare `Date` in a `sql` template stranded every automated reply.**
    _2026-10-07, found by the first database test of `send_reply`; never
    reached a customer._ `deliverAutomatedReply` stamped
    `first_auto_replied_at` with ``sql`coalesce(..., ${now})` ``, which
    postgres.js refuses with `ERR_INVALID_ARG_TYPE` — the trap AGENTS.md
    describes under Tests, on the same `prepare: false` client production
    uses. It runs after the message insert and before the event and the send
    job, so every automated reply — the out-of-hours one and every automation
    rule's — would have been left `pending` on the timeline for good and never
    sent on a carrier channel. On web chat, where the row is the delivery, the
    visitor would have seen it. Either way no `auto_replied` event was written,
    so a time-based rule would have sent it again each sweep. Production
    never ran it, though the deployed worker (`8426c35`) carries the line:
    the out-of-hours reply is inactive (its row last changed on 2026-09-02,
    the day of the last `auto_replied` event), no rule has ever had a
    `send_reply` action, and `first_auto_replied_at` is set on no
    conversation. Fixed by binding `now.toISOString()` behind `::timestamptz`,
    through `firstAt()` beside `latest()` in `lib/tickets/latest.ts`, so the
    coalesce form has one audited implementation as the greatest form does.
    `lib/tickets/outbound.db.test.ts` now runs the write against Postgres,
    and `outbound.test.ts` and `latest.test.ts` assert no `Date` survives in
    the fragment. The unit test had checked the fragment's shape against a
    mocked client, which is how a statement Postgres never saw passed for a
    tested one.

85. **`smb_message_echoes`'s silence proved only that no number was operated
    from the phone — and coexistence is exactly what changes that.**
    _2026-10-08; a reading corrected before it cost anything._ §5.1's
    bot-transcript entry argued that the field had been subscribed on this app
    across all 395,391 deliveries without firing once, and that the silence
    was the proof the support number is not operated from the WhatsApp
    Business app. Right about the number, wrong as a rule — and
    `docs/meta-endpoints.md` §7 had turned it into one, listing
    `smb_message_echoes` beside the discontinued `message_echoes` as
    "deliberately not used", one tidy-up away from being dropped from
    `REQUIRED_WHATSAPP_FIELDS` as dead. A number connected through coexistence
    _is_ operated from the phone, and its replies arrive on that field and on
    nothing else; dropping it would have silently lost every one of them while
    the console reported the number connected. So the field is required now,
    with `history`, `smb_app_state_sync` and `account_update`
    (`COEXISTENCE_WHATSAPP_FIELDS` in `lib/meta/subscriptions.ts`), and each
    is ingested — the echo by `ingestWhatsAppEcho`, which on a coexistence
    channel files it as the team's reply (outbound, no author, moving
    `last_agent_message_at` and never `last_customer_message_at`) and on a
    plain support number still ignores it as our own send coming back; the
    history and contacts by `lib/tickets/ingest-whatsapp-history.ts`, as a
    record rather than traffic (no window, no clocks, no automations, no media
    download, each thread one resolved `import` ticket); `account_update` by
    `applyWhatsAppAccountUpdate`, idempotent because it is deliberately not
    deduplicated at the door — the key is spent for good and a second
    disconnect of the same number must not be swallowed. The bot number's half
    is still unreachable: it is sent through Cloud API by another service,
    where Meta offers no echo. The general lesson is one step out from §6.43's:
    **a count of zero is evidence about the configuration that produced it,
    not about the field** — change what a number is, and the figure stops
    meaning anything. None of this has run live (§5.2), which is also why the
    field list grows on staging first.

86. **Every Graph credential this app sends rides in a URL, and a fetch
    tracing span records the URL whole.** _2026-10-09, found in review of the
    coexistence change; nothing traces yet, so nothing has left the process._
    Next 16's patched `fetch` wraps every server-side call in a span named
    `fetch GET <url>` with `'http.url': <url>`
    (`next/dist/server/lib/patch-fetch.js`). No `instrumentation.ts` exists,
    so the tracer is a no-op and no span is exported. The day one is added —
    `@vercel/otel` or any OTLP exporter, to see why a page is slow — every
    Graph request goes to the tracing vendor with its query string: the Page
    token on every call through `lib/meta/client.ts` (`access_token=`, line
    209, the console's own actions in `app/(console)/meta-actions.ts` among
    them — the largest instance, and older than coexistence); the app secret
    and the single-use code on the Embedded Signup exchange
    (`tokenExchangeUrl`); and the business token in `debug_token`'s
    `input_token`. The modules' rule — a sentence names host and path, never
    the URL — covers logs and error messages and says nothing about spans.
    So whoever adds instrumentation keeps the `graph.facebook.com` and
    `graph.instagram.com` query strings out of every span. With `@vercel/otel`
    that is
    `instrumentationConfig: { fetch: { ignoreUrls: [/^https:\/\/graph\.(facebook|instagram)\.com\//] } }`;
    with anything else, a `SpanProcessor` that strips the query from the span
    name, `http.url` and `url.full`. The worker needs the same if it ever
    gains OpenTelemetry's undici instrumentation, because it calls Graph with
    the same tokens through plain `fetch`. Three tempting fixes do not work.
    `NEXT_OTEL_FETCH_DISABLED=1` hides only Next's span, and `@vercel/otel`
    sets it itself and records its own span with the full URL. Setting
    `next.internal` on a request suppresses Next's span, but it is an
    internal flag outside Next's public types, and `NEXT_OTEL_VERBOSE=1` brings
    the span back. And taking the credential out of the query string is
    impossible for `debug_token`, whose `input_token` has no other shape, and
    unproven for the exchange: Meta documents only the GET, and a wrong guess
    spends a code that works once. Not yet a CI check. It belongs in a rule of
    its own under `scripts/ci/rules/`, refusing an instrumentation file that
    does not keep both hosts out, rather than in `credential-confinement`,
    which is about the stored credential.

## 7. Verification already done

- **The knowledge-base role floor, against a real Postgres.** _2026-09-04._ The
  predicate and the console handbook were exercised on a local Postgres 16 with
  the migrations and `db/sql` applied, because `readableByRole` and
  `effectiveFloor` are raw `sql` fragments used from pages and actions rather
  than only from a job handler, and vitest executes no SQL.

  Six article shapes — public; public carrying a floor; internal with no floor;
  internal only through its folder (production's shape); internal with a floor
  on the article; and article and folder disagreeing — read by each of the four
  roles, through all four internal read models (`listArticlesForAdmin`,
  `getArticleForEdit`, `searchForAgent`, `suggestForAgent`). 95 assertions, all
  as intended: the floor is ignored on anything a customer can open, the folder
  supplies it when the article does not, and the stricter of the two wins.

  Then the handbook itself. Seeded into an empty database it wrote 5 folders and
  15 articles; a second run and an `overwrite=true` run each reported everything
  current and cut no `kb_article_versions` row. Editing an article's body by
  hand made the next run report one drifted article and change nothing;
  `overwrite=true` restored it and cut exactly one version row. On the seeded
  data an agent sees 8 articles, a supervisor 11, an admin 14 and an account
  admin 15 — and every customer-facing surface (`listCategories`,
  `searchArticles`, `getArticle` by slug, `getCategory`, and the sitemap)
  returns zero of them for both an anonymous reader and a signed-in one.

  Re-run after review, on the merged state, with two additions. Every article's
  `updated_at` was diffed across a run rather than trusted to the job's tally
  (§6.59): a no-op run writes **no row at all**, and after one article was
  deliberately misfiled to `visibility = 'public'` the next run repaired it and
  moved that one row's timestamp and no other's. And each read model is now also
  asserted to report the _effective_ level, not the column — the distinction
  that decides whether the list badges an internal article and whether the
  article page offers a help-centre link that would 404.

- **The knowledge base's formatting standard, applied to production.**
  _2026-09-03._ `normalise_kb_formatting` ran against the live database after
  #133 deployed: 108 of 112 articles changed, 266,219 characters became 170,596,
  and 29 cross-links stopped pointing at the Freshdesk portal. Per locale, which
  is the breakdown that matters here — 54 of 54 English and 54 of 58 Arabic (the
  four that did not change were one already-clean article and three of the
  employee-handbook stubs).

  Verified rather than assumed, in this order. The dry run's per-locale
  character totals were compared against a reference computed locally from the
  same 112 bodies and matched exactly on both sides — 134,072→89,386 and
  132,147→81,210 — before anything was written. After the write, a fingerprint
  over every row (`md5` of each body, keyed by `md5(locale || slug)`, aggregated
  in a stable order) was computed on the database and independently from the
  local reference: `0a5c001b77725ed91f117e56b551fd69` both times, so all 112
  stored bodies are byte-identical to what was reviewed. Then all 108 public
  article pages were fetched from the running app on full navigations — not RSC
  prefetches, per trap 2 — and every one returned 200 with markup byte-identical
  to the reference.

  The way back is `kb_article_versions`, which held nothing before this and now
  holds one row per changed article: each is that article's pre-cleanup body,
  restorable from the console.

  One finding fell out of the verification. **`packaging-guidelines` and its
  Arabic translation contain no text at all** — five screenshots each, no words,
  and no `alt` on any of them. Their `body_text` is empty, so they are findable
  by title and by nothing else, and a screen reader gets nothing. Five other
  articles link to that page for the detail it is supposed to carry.

- **Derived article text rebuilt after the heading fix (#321).**
  _2026-09-29._ With `6c59889` live on all six services, `normalise_kb_formatting`
  ran three times through a `jobs` row: a dry run, the write, and a second dry
  run. The first reported `changed 0` and `text 3` Arabic, `22` English — the
  same 25 articles a read-only count of headings holding lower-case Latin text
  had found beforehand; the three Arabic ones are integration pages
  (`زامت`, `ماجنتو`, `ماي-بلو`) whose headings are English product names. The
  write rebuilt `body_text` and `excerpt` on exactly those 25 rows. Checked on
  the database before and after: the per-locale `md5` fingerprint over every
  `body_html` is unchanged (`4cceb4fe…` ar, `73fe9524…` en), the one over
  `body_text` moved, `kb_article_versions` stayed at 108 rows, and no excerpt
  opens on a capitalised heading any more. The second dry run reported `text 0`
  in both locales. The way back is to revert #321 and run the job again: both
  columns are derived from `body_html`, which this never touched.

- **WhatsApp, end to end on production.** A synthetic webhook was enqueued; the
  job completed in 170 ms on the first attempt. The same `wamid` redelivered
  under a different event id was logged as a duplicate and wrote nothing. Every
  test row was then deleted and the ticket sequence reset.
- **Error 131047 diagnosed from the data**, not guessed: `webhook_events` showed
  inbound arriving on the real business number while the failure status came
  back on the test number.
- **The Freshdesk KB import is complete and correct.** 58 Arabic articles and 54
  English, all published, across 3 categories and 12 folders. The 4-article gap
  is exactly `دليل الموظف`, the internal staff guide, which has no English
  version in Freshdesk — so nothing is missing. Its 4 folders are the only
  `agents_only` ones; every other folder is public. That visibility came from
  Freshdesk and matches the category's meaning, so it needs no decision.
- **Production health**, checked 2026-08-21 on `98ec9d4`: `status: ok`, 2 ms
  database latency, queue empty. **One dead job** — the `send_meta` row in §5.2,
  which is a real undelivered customer reply and not a transient failure.
  Everything else in the job history is completed work: 43,396 rows, almost all
  `process_webhook`, which is what 1,500 bot conversations a day looks like.
- **WhatsApp coexistence, against a local Postgres 16.** _2026-10-08._ The
  migrations and the `db/sql/` replay applied clean onto an empty database, and
  nine database-tier files — `lib/whatsapp/credentials`, `onboarding`,
  `onboarding-reads` and `coexistence-state`, `lib/tickets/ingest-whatsapp` and
  `ingest-whatsapp-history`, `worker/handlers/process-whatsapp-webhook` and
  `sync-whatsapp-templates`, and `lib/admin/settings` — passed (106 tests), with
  the coexistence unit tier beside them (68 files under `lib/whatsapp`,
  `lib/meta`, `lib/tickets`, `lib/queue` and `worker/handlers`, 1,590 tests).
  What that proves: a stored credential round-trips through `storeBusinessToken`
  and `tokenForAccount` and resolves ahead of a variable and the shared token;
  `credentialStatuses()` and the admin's account rows carry no `envelope`;
  storing clears `token_env_var` and the two refused edits are refused; a
  cascade on account delete leaves the `removed` event; a wrong key throws
  `CredentialKeyError` and leaves the row; the reseal moves rows and writes
  events while `dryRun` writes nothing; the partial unique index refuses a
  second live attempt and a stale one is superseded; the job's final attempt
  marks the row failed and a transient error lands in `last_transient_error`
  and `next_attempt_at`; a coexistence echo moves `last_agent_message_at` and
  the response clocks and leaves `last_customer_message_at`, while a plain
  support echo stays ignored; two history threads become two resolved `import`
  conversations with both directions, no `jobs` rows and placeholder media,
  replay writes nothing, and a later live inbound opens a new ticket rather
  than the import; progress, a decline and a contact's name land where the
  console reads them. What it cannot prove is anything Meta answers — §5.2
  lists the round trip, and nothing in it has run.
- **Multiple WABA connections, against a local Postgres 16.** Migration 0011 and
  the `db/sql/` replay both applied clean, and RLS came out enabled and not
  forced on `whatsapp_accounts`. A legacy null-account template upserted onto
  itself rather than duplicating, which is the `NULLS NOT DISTINCT` case the
  constraint exists for; two accounts each kept their own `shipment_update` with
  independent statuses; marking one account's templates stale left the other's
  untouched. `phone number → account` resolved through `channels` with the
  default account as the fallback, disconnecting an account cascaded its
  templates while leaving its channel rows intact, and
  `ensureEnvironmentAccount` adopted a single-WABA install — numbers and
  templates — idempotently. Not yet exercised against a real second WABA: no
  second business account exists to connect.
- **Side conversations, end to end against a local Postgres 16.** The migration
  and the `db/sql/` replay both applied clean; the `attachments_one_owner` CHECK
  refuses a row with neither owner. An agent's question was sent through
  `send_side_email` with `Reply-To: support+s1.<sig>@reply.shipblu.com`, and the
  hub's reply threaded back three separate ways — by plus-address, by
  `References` alone with the address stripped, and by the signed subject tag
  with both gone. On each: no new ticket, **no new `contacts` row**, nothing
  written to the ticket timeline, `last_message_at` moved and
  `last_customer_message_at` did not. A redelivered Message-ID was reported as a
  duplicate and wrote nothing. A genuine customer email in the same database
  still opened a normal ticket. Reading the ticket back through
  `lib/portal/tickets.ts` as the requester, the hub's words, our question, the
  hub employee's name and the hub address are all **absent from the payload**,
  not merely unrendered.

- **Shared locations, measured against the archive before the code was written.**
  Of the 821 messages whose stored payload mentions a location, all 821 have a
  `location` object carrying both coordinates; all are typed as JSON numbers, all
  fall inside valid latitude and longitude, and none sits at 0,0. So the range
  check in `lib/tickets/shared-location.ts` rejects nothing real, and the SQL
  prefilter the backfill uses has no false positives on this archive. 136 of the
  821 carry a name and a geocoded address; the other 685 are a bare pin, which is
  why the map link matters more than the label. The four gates are clean and both
  the web service and the worker are live on `98ec9d4`.

  Those figures are a snapshot taken before the deploy, which is why the run
  below counts 845 rather than 821: the archive grows by a few hundred pins a day
  and every number here is only true of the moment it was measured.

  **The live path is verified on production.** Both services went live on
  `98ec9d4` at 02:28 on 2026-08-21, and by 09:58 sixteen pins had arrived and been
  stored structurally — every one typed as a JSON number, every one in range, and
  the most recent candidate in the table is itself one of them, so nothing is
  slipping past. Thirteen are bare pins and three carry a name, which is the same
  roughly one-in-six ratio as the archive.

  The write is **additive, confirmed in the data**: `whatsappType` and
  `phoneNumberId` are still present on all sixteen rows. That was the specific
  risk — `meta` is a single jsonb column and assigning it rather than merging
  would have silently dropped the media block and the bot's `echo` flag on every
  pin.

- **The backfill, run on production on 2026-08-21.** Enqueued as a job row rather
  than clicked, which is the route §5.5 documents for a payload the one-shot
  runner cannot carry. A `dryRun` pass first, then the real one, then a third to
  prove it settles:

  | run     | candidates | already | recovered | unreadable | time   |
  | ------- | ---------- | ------- | --------- | ---------- | ------ |
  | dry run | 845        | 24      | 821       | 0          | 157 ms |
  | real    | 845        | 24      | **821**   | 0          | 8.1 s  |
  | again   | 845        | 845     | 0         | 0          | 106 ms |

  **845 of 845 pins now open on a map, and nothing was unreadable.** The dry run
  wrote nothing, confirmed by query. Checked afterwards on all 845 rows: every
  latitude and longitude is a JSON number and in range; **every row still carries
  its `whatsappType` and `phoneNumberId`**, so the jsonb merge took nothing away;
  and no row holds a pin whose `raw_body` never contained one, so nothing was
  invented. The third run left the `meta` of all 845 byte-identical, by checksum.

  The `821` in the two runs before it is the same 821 that had sat unchanged all
  day while the candidate count climbed with traffic — which is what a backfill
  figure should do, and was the sign the live path and the archive were being
  counted separately rather than confused.

- **Both backfills, run end to end against a local Postgres 16** — and the first
  run is what found the bug in §6.20. Nine messages were seeded to cover every
  branch: a bare pin, a pin with name and address, a pin on a row already
  carrying `media` and the bot's `echo` flag, an out-of-range coordinate, a
  malformed `raw_body`, a row already holding a pin, a text message mentioning
  the word, and a message with no pin at all — across two channels, so the
  per-channel tally could be checked rather than assumed.

  All of it behaved: 5 pins written at full precision, the out-of-range and
  malformed rows skipped and counted as unreadable, the already-structured row
  reported as already-done and left untouched, and the message with no mention
  never scanned. **The merge held** — the row with `media`, `echo`,
  `creationType`, `whatsappType` and `phoneNumberId` kept all five and gained
  `location`. A second run recovered nothing and left the `meta` of every row
  byte-identical, checked by checksum rather than by eye. `dryRun` wrote nothing.

  `backfill_shipment_links` was run too, since it carried the same defect, and
  now completes over the same table in 40 ms.

### Tooling notes for this environment

Supabase and Render MCP tools work and are the fastest way to check real state —
`execute_sql` against `nqbcfnvqqyqawmffgiql` answers most "is it actually
configured?" questions in one call. Outbound HTTPS goes through an agent proxy;
`curl` to the production health endpoint works. Never disable TLS verification.

---

## 8. Security constraints — non-negotiable

- **A production database password was pasted into chat and must be treated as
  compromised.** It was rotated. Never echo credentials, in any direction.
- Secrets never enter the repo. `render.yaml` uses `sync: false` or the env
  group, always without values.
- **The database holds exactly one credential, and a dump contains no usable
  one without a key the dump does not contain.** `whatsapp_account_credentials`
  is the one place to look: a WhatsApp business token Embedded Signup minted,
  AES-256-GCM under `WHATSAPP_CREDENTIAL_KEY` from the environment group, opened
  by the worker and by nothing on the web service (`credential-confinement`).
  Every other credential is in the environment and named from a row — a
  WhatsApp account's token is named, or stored sealed, never plaintext.
- **Graph requests carry credentials in their URLs** — the Page token on every
  call, the app secret and code on the Embedded Signup exchange, the business
  token in `debug_token`. Nothing traces today; whoever adds an
  `instrumentation.ts` keeps both Graph hosts' query strings out of every span
  first (§6.86).
- RLS: enabled, zero policies, **never FORCE** (§2).
- Email bodies and imported KB HTML are attacker-controlled. **Sanitise on
  write, never on read** — the stored row is then safe for every consumer, and
  re-sanitising on read would mask a gap upstream. Remote images are blocked by
  default in email; article iframes are restricted to an allowlist of video
  hosts.
- Attachment paths derive from ids we generate, never from a supplied filename.
  The bucket is private; the console mints short-lived signed URLs.
- Public endpoints (KB feedback and views, the widget) are rate limited in
  memory. Writing a row per rejected request would be a cheaper way to hurt the
  database than the endpoint itself.
- The widget iframe runs on our origin, so the visitor token lives in _our_
  localStorage and embedding it never gives the host site access to a
  conversation.
- `X-Frame-Options: DENY` everywhere except `/widget`, which uses
  `frame-ancestors` with an explicit allowlist.
