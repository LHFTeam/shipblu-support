# Comment channels, subcategories, a ticket category, and routing by it

Five requests, from the support lead on 2026-10-19:

1. Facebook comments and Instagram comments become channels of their own.
2. The ticket field called "category" becomes "subcategory", everywhere.
3. A new ticket field called "category" says whose work a ticket is: sales,
   customer support or merchant support, with more values to come.
4. Jev — TypeSafe's System One, already the provider behind priority — sets
   that category on incoming messages.
5. Each channel chooses whether a new ticket goes to the channel's default
   group or to the group its category names, and the ticket is then assigned
   to a member of that group. The example given: a Messenger message that Jev
   reads as sales goes to the Sales group, and somebody in Sales gets it.

The fifth came with a question: should this be a per-channel setting, or an
automation? **It should be a setting, with automations able to refine what it
does.** An automation alone cannot do it, for four reasons that are each
facts about the code rather than preferences:

- **The category arrives after everything that would act on it.** A new
  ticket's `on_create` rules, SLA, auto-assignment and out-of-hours reply run
  inline, in that order (`lib/tickets/lifecycle.ts:65-70`). Jev's answer comes
  from a queued job, about 2 s after the message on production's priority runs
  (p90 3 s, p99 6 s). So an `on_create` rule almost never sees a category.
  Nothing guarantees it never does: priority documents the same race in
  `lib/priority-ai/run.ts:286-299`, and only provider latency keeps the job
  second.
- **The first message often says nothing.** On Facebook, five identical
  greetings of 10–13 characters open 137 of 248 DM tickets (55%), and each is
  followed by unrelated topics. The informative message is the second one at
  the median, arriving 0.3 min later, and at p90 it arrives 9.5 min later.
  Something has to wait for it without assigning the ticket first, and the
  engine has no way to hold anything.
- **`on_update` fires on every touch and remembers nothing.** It runs on every
  customer reply, every sidebar edit and every applied priority answer
  (`lib/tickets/lifecycle.ts:76-77,86-89`). It keeps no per-ticket record of
  having run (`lib/automations/index.ts:392-395`). A rule "category is sales →
  move to Sales" moves the ticket back to Sales every time the customer
  writes, after an agent has deliberately moved it to Support.
- **A per-channel choice becomes rules multiplied by channels.** Three
  categories on five channels is fifteen rules to author. A typo in any of them
  silently leaves tickets in the default group, and nothing says why.

Making the engine able to do this means adding a hold, a fire-once trigger, a
fallback timer and SLA re-selection. That builds the routing feature inside the
engine, against the README's stated reason for keeping one engine. So the
initial route is decided once, by one tested module, from a channel setting and
a group named on the category's row. After that, the ordinary `on_update` pass
runs **before** anybody is assigned, so a rule can still say "sales on the
merchant number goes to Merchant Care".

The rest of this file covers what the research found, the decisions and what
each one rules out, the deploy rules every stage obeys, the work in the order it
has to ship, how each stage is verified and rolled back, and the questions only
the support lead can answer. A first draft was reviewed adversarially against
the code through five lenses before this version: deploy order, rollback,
migrations, routing races and the classifier. Its findings are folded in.

## What production says (read-only, 2026-10-19/20)

Measured against `nqbcfnvqqyqawmffgiql` with SELECTs only; the numbers are small
and should be read as a guide:

- **Volume.** 532 human tickets since 2026-08-18, now about 110–120 new live
  tickets a week. Comment tickets: 43 Facebook and 9 Instagram, 13.8% of Meta
  tickets. They come from 10 and 4 people respectively, and almost every one
  holds a single inbound message.
- **The subcategory detector rarely knows whose work a ticket is.** Of 484 live
  tickets, 305 have no real subcategory. Among primary subcategories, 148 of
  226 are `service.*` ("asking for a human", "acknowledgement"), which says
  nothing about sales versus support. Jev's one shadow run over September did
  better: on 126 Facebook DMs it found 39 sales, 28 customer, 2 merchant, 11
  other and 46 unclear. Among Facebook DMs that can be classified at all,
  sales is roughly 40–50% and merchant support under 10%.
- **No record says who is a merchant.** `contact_shipping_accounts`,
  `shipping_accounts` and `is_shipper` are empty, and `requester_kind` is null
  on every ticket. Text is the only signal, plus one configuration fact: the
  "Nayera Mohamed" coexistence number defaults to Merchant Care.
- **Jev is fast and reliable on the priority path.** 1,423 runs with 0 errors.
  Provider latency is p50 238 ms; from message to answer it is p50 2.2 s.
  Priority has been in `apply` since 2026-10-13, despite
  `docs/PROJECT-STATE.md` §1 still saying it "ships off".
- **Assignment today happens almost entirely in the sweep, and the sweep has
  stopped.** Only 9 of 532 tickets were assigned on arrival. The other 253
  assignments came from `assign_sweep`, at a median of 40 hours. Nothing at all
  has been assigned since 2026-10-07, and nobody has established why (see
  Stage 0.7).
- **Only one group has members.** Support has 3 (admins). Merchant Care,
  Customer Care and Inbound Sales Team (created 2026-10-19) have 0, though all
  four are `round_robin`. Nine of twelve active agents are in no group.
- **Agents cannot see unassigned work.** An agent-role user sees only tickets
  assigned to them, because seven separate places enforce "assigned to me
  unless `ticket.view.all`" (Stage 0.5 lists them). `ticket.view.group` is
  already in the `AGENT` role's defaults (`lib/auth/permissions.ts:227-229`),
  but nothing reads it.
- **The SLA policies cannot select by group.** Their group conditions compare
  `group.id` to group _names_ ("Merchant Care"), but the fact is a uuid, and
  the condition builder offers it as free text
  (`app/(console)/admin/field-options.ts:64`). The same builder writes
  automation and skill conditions, so those may hold names too. Policy 1 is the
  default and sits at position 1, matching every chat channel, so policy 4
  ("Live Support (Merchant Care)") is unreachable whatever the names say.
- **Messenger is read-only from here until the Freshworks swap.** Freshchat
  holds thread control on the Page: 240 of 248 first DMs arrived in `standby`,
  and 6 Facebook DM tickets were ever answered from this system
  (`docs/PROJECT-STATE.md` §5.1). Instagram through Instagram Login, and
  comments through the comment edge, can be answered here today. The live
  coexistence number is answered on the phone: all 1,029 of its outbound
  replies were Business-app echoes.

## Decisions

Each decision says what it closes. Where a decision is the support lead's to
make, it is listed again under [Questions](#questions-for-the-support-lead) with
the default this plan assumes.

### 1. Comment channels are new `channel` enum values, scoped to the work surface

`facebook_comment` and `instagram_comment` join `channelEnum`. They are written
to `conversations.channel` and `channels.type`. The config and reporting tables
that copy a ticket's channel inherit them: `auto_responses`, `csat_rules`,
`csat_surveys`, `metrics_daily`, the subcategory and root-cause rollups, and
`canned_suggestions`. They are **not** written to `contact_identities`,
`webhook_events`, `messages.meta.platform`, job payloads or the external id.
Those name the platform, and that must not change:

- **Contacts.** `contact_identities` is unique on (channel, identifier). 7 of
  10 Facebook commenters share a contact with their DM history, so a comment
  value there would split real people in two.
- **Webhooks.** One webhook delivery carries both DMs and comments
  (`lib/meta/parse.ts:63-85`), so the webhook's channel cannot be either one.
- **External id.** `${platform}:comment:${root}` is the dedupe and threading
  key (`findByExternalId`, `rootCommentId`).

This follows the repo's own precedent. `whatsapp_bot` got "its own value rather
than `whatsapp` with a flag, because the discriminator is what every read,
filter and report already keys on" (`db/schema/enums.ts:14-20`). Two other
shapes were rejected:

- **A second channel row with a config flag.** Nothing reads
  `conversations.channel_id` for Meta. Filters, views, rules, SLA, reports and
  auto-responses all key on `conversations.channel`, so comments would be
  "separate" nowhere anyone looks. It also runs into two traps:
  - `channelFor` takes `limit(1)` with no order.
  - `saveChannel` rebuilds a Facebook or Instagram row's config as `{}` on
    every save (`app/(console)/admin/channels/actions.ts:347-351`).
- **A separate `surface` column.** This is the flag design the bot channel
  already rejected, with a new fact, filter, rollup dimension and scope
  column to match.

The cost is breadth, and the compiler catches little of it, because almost
every channel list in the code is `string`-typed and every switch has a
`default` arm. Two of those defaults fail silently and badly:

- `carrierFor` sends any channel it does not know to `send_email`
  (`lib/tickets/outbound.ts:269-273`), and `sendsByEmail` follows it.
- `reply-actions` copies `meta.platform` from the channel
  (`app/(console)/reply-actions.ts:118,172-182`), and `send_meta` throws on
  anything that is not `facebook` or `instagram`
  (`worker/handlers/send-meta.ts:117-121`).

Three things contain the breadth:

- **One helper module.** `isMetaChannel`, `metaPlatformOf` and
  `isCommentChannel` live in `lib/tickets/channel-policy.ts`, and every site
  that compares a channel with `'facebook'` or `'instagram'` calls them
  instead. That includes the ones written as `case` labels, such as
  `channelSwitch` in `lib/csat/decision.ts:120-133`.
- **`carrierFor` takes `ConversationChannel`, not `string`, as an exhaustive
  switch with no `default`.** `lint:strict` then refuses the next enum value
  that nobody routes. Re-typing it reaches its string-typed feeders:
  `AutomatedReply.channel`, `enqueueAutomatedDelivery`, `storeAgentReply`,
  `sendsByEmail` and `lacksEmailRecipient`. A caller holding a bare string
  narrows it through a guard built from `CONVERSATION_CHANNELS`, never a
  cast.
- **Readers ship before writers, on every service.** That includes the four
  crons, which build their own copy of the code (see
  [Deploy rules](#deploy-rules-every-stage-obeys)).

**Stored configuration is code too.** Automation rules, SLA policies and skills
all match the `channel` fact against `conversations.channel`. Any stored
condition that says `channel is facebook` stops matching comment tickets the
moment they move. So Stage 1.2 begins by reading every such condition and
deciding it row by row. A code review cannot see these rows.

### 2. The rename covers the topic taxonomy only, all the way to the database, in two steps

"Category" means four things in this repo, and only one of them is being
renamed:

| Meaning                                                     | Where                                                                                                                                   | Renamed?                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| The topic taxonomy (area → 55 keys such as `delivery.late`) | `lib/categorise/`, `ticket_categories`, `conversation_categories`, `category_metrics_daily`, `ai_category_runs`, admin and report pages | **Yes → subcategory**               |
| Status category (open / pending / resolved / closed)        | `ticket_statuses.category`, the `status.category` fact, `set_status.category`, `status_changed` event data                              | No; stored automation rules name it |
| Knowledge-base categories                                   | `kb_categories`, `/help/[locale]/c/[category]`, the Freshdesk import                                                                    | No                                  |
| Meta's template and pricing categories                      | `whatsapp_templates.category`, `lib/whatsapp/*`                                                                                         | No; Meta's field names              |

"Everywhere" is taken to mean: what people see, the code's names, and the
database's names. Stored history keeps its words, because rewriting an
append-only audit table to match a rename would put a lie in it. That history
is:

- 722 `categorised` events, 1 `category_*` event and the `category-detector`
  actor label. These are kept and displayed as "subcategory".
- The two strings Jev is sent, `CATEGORY_QUESTION = 'category'` and its
  English instructions (`lib/categorise-ai/request.ts:24,71-80`). Changing
  them changes the experiment, so they are kept as they are.

It ships in two steps because the database half has a real deploy-window
cost and the code half has none:

- **Step A — code and UI.** Everything is renamed, but the SQL names stay
  pinned through Drizzle's explicit strings, for example
  `pgTable('conversation_categories', …)`. This is verified to generate no
  migration. Old and new code agree on the database, so web, worker and crons
  can deploy in any order.
- **Step B — the database.** Tables, columns, index names, constraint names,
  the two enum types and `db/sql/002` are renamed, under a short maintenance
  sequence.

Step B has to happen, and before Stage 3: the new field wants the name
`ticket_categories`, and the name cannot mean two things. The deploy window is
real, because only the web service runs migrations (`render.yaml:286-288`).
Until traffic shifts to the new release, old web instances (up to three) keep
serving against renamed tables. That fails their ticket pages through
`allLimited` (`lib/tickets/conversation.ts:254-322`). It also silently skips
subcategorising any message they ingest themselves: web chat, portal and form
messages are ingested on the web service, and the error is caught with no
backfill. Suspending the worker and crons closes every other path, because
webhook processing is the worker's job and receiving webhooks only appends to
`webhook_events`. The remaining gap is the preDeploy-to-cutover span on web
chat, portal and forms. Production has five web chat tickets ever, so the gap
is measured afterwards and closed by hand if it is not empty (2.B).

**The migration is generated, not hand-edited.** `drizzle-kit generate` is run
at a TTY with the rename prompts answered, and the result is committed as
generated. That gives:

- `ALTER TABLE … RENAME TO` and `RENAME COLUMN`;
- a drop and re-add of the foreign keys and the composite primary key, whose
  names derive from the table;
- a drop and create of each explicit index string renamed in `db/schema`.

The tables hold a few hundred rows each and the worker is suspended, so those
locks last milliseconds. Rewriting the drops as renames would save nothing and
break the "never hand-edit a migration" rule. CI could not then check the
result, because the drift step only regenerates and the `generated-files` rule
refuses only modified files that already exist. Two pieces are invisible to
Drizzle and go in `db/sql`, as idempotent statements guarded on the owning
relation:

- the implicit `<table>_pkey` index names, which `ALTER TABLE RENAME` leaves
  behind;
- the six CHECK constraints.

Two traps in the tooling are fixed before Step B rather than discovered during
it:

- **`drizzle-kit generate` passes CI without writing a migration.** It asks
  interactively about every renamed table and column, and without a terminal
  it prints "Interactive prompts require a TTY", writes nothing, and **exits
  0**. CI's drift step (`.github/workflows/ci.yml:135-144`) would therefore
  pass a schema rename with no migration. Stage 0.1 makes that step fail on
  the message.
- **The `--custom` flag is not used.** It saves the _old_ snapshot, so every
  later generate would prompt again.

### 3. The new category is a registry row and a foreign key, like root causes

The design is a `ticket_categories` table shaped like `ticket_root_causes`:

- `key`: immutable, `sales`, `customer_support`, `merchant_support`. A CHECK
  named `ticket_categories_key_format` holds it to lowercase letters and
  underscores, and refuses `unknown`, which is reserved for Jev's escape hatch
  (decision 4). Hyphens appear only in labels. The CHECK's name is
  deliberately not the old `ticket_categories_key_shape`, which belongs to the
  renamed table's history.
- `label_en` and `label_ar`, both required.
- `description`, which is the sentence Jev is shown for the option.
- `position`, `is_active` (retired, never deleted) and `is_system`.
- `route_group_id`, the group a ticket with this category goes to on a channel
  that routes by category. It is nullable, and null means "stay in the
  default group".

`conversations.category_id` is a single-valued foreign key with `on delete
restrict`, beside `root_cause_id`. The rule fact is `category.id`, read straight
off the conversation row as `group.id` is. A fact holding the key would need
every loader (automations, SLA, assignment) to join the registry, and a loader
that forgot would see null silently, as `formSlug` already can. The condition
builder offers it as a choice of registry rows and stores the uuid.

Three alternatives were rejected:

- **An enum like `priority`.** "More may be added" then means a migration and a
  deploy per value. It also has nowhere to keep two labels, a description for
  Jev, or a target group.
- **A custom ticket field.** There is no foreign key and no protection:
  `admin.fields` can delete the field or strip an option
  (`app/(console)/admin/fields/actions.ts:50,143-178`), and every stored value
  and route then stops matching in silence. `lib/forms/elements.ts:22-39`
  already says column-backed questions should not become ticket fields.
- **Deriving the category from subcategories.** On Facebook, 83 of 133 primary
  subcategories are `service.*`, which is line-neutral. Subcategories are also
  many per ticket, while the category is one.

`conversations.type` is null on every row and could hold the key. But it is
free text described as a "Freshdesk ticket type", so it is not reused for this.

**Every writer stamps its event the way priority's writers do.** That covers
the console, the `set_category` action, Jev and the backfill. Each writes the
column and a `category_changed` event in one transaction, with the event
stamped by `clock_timestamp()` after the update holds the row lock.
`PRIORITY_STAMP` is generalised for this (`lib/tickets/priority-stamp.ts`).
With the default `now()`, a change that waited on another writer's lock sorts
before it, and the ownership rule in decision 4 would read the wrong order.

**It is a routing label, not a claim about the requester.**
`db/schema/enums.ts:257-260` rules out detecting a _prospect_ from vocabulary.
`requester_kind` is a statement about who someone is, and words are not
evidence of that. The new category says which team's work a ticket is, which
words _are_ evidence of. So it never writes `requester_kind`, and the docs say
so beside both.

The category and the subcategories are independent judgements in this plan:

- The category is one per ticket, it routes, and Jev sets it.
- Subcategories are several per ticket, they describe the topic, and the rules
  detector sets them.

Whether a subcategory should also carry a "usually this category" link for the
picker is a [question](#questions-for-the-support-lead), not a dependency.

**SLA policies can key on the category, everywhere.**
`applySlaOnCreate` selects the policy before any category exists. So the
policy is selected again whenever the category is first set before the first
response, on every channel and whoever sets it. It is also selected again when
a route moves the group before the first response (decision 5). Both go through
one function, `reselectPolicyBeforeFirstResponse`. It reuses the pause crediting
in `recomputeOwedClocks`, so a pause taken in those minutes is not lost.

`onGroupChanged` deliberately never re-selects the policy
(`lib/sla/index.ts:551-575`), because "which targets a ticket is held to is what
an agent was told when it arrived". Before the first response nobody has been
told anything, so this is the same principle applied to the moment it was
written for. The function's doc comment says exactly where it applies. Without
it, a category-keyed policy would match only on routed tickets: the same
unreachable-policy failure Stage 0.2 exists to fix.

### 4. Jev's category classifier is its own module, beside priority

`lib/category-ai/` mirrors `lib/priority-ai/`: request, pure `decide.ts`, run,
enqueue and settings, with its own `classify_category` job and its own runs
table. It is not a second question on the priority call. The wire format would
allow one (`lib/typesafe/client.ts:95-99`), but two things argue against it:

- **Priority is live in apply mode.** Nothing measures whether adding a
  question shifts its answers.
- **The two classifiers stop at different points.** Priority runs on every
  message, while category needs only the first few. Sharing the call would
  couple their switches, selection, failure and dedupe.

A second call costs about 700 input tokens per message classified. The real
number of calls per ticket comes from the shadow rows, not from a guess.

What is shared is extracted rather than copied. That means the message
selection (`skipReason`/`isMachineMail` in `lib/priority-ai/run.ts:346-379`,
moved to `lib/tickets/classifiable.ts`) and the context (`stateFor` and
`earlierMessages`). Both classifiers then ask about the same messages, with the
same context, for the same reasons.

The classifier's rules, and what each one closes:

- **A person, a form or a rule always wins.** These count as owned:
  - any `category_changed` event not written by `jev:category`;
  - an `opened_by_agent` event;
  - a form default recorded as `form:<slug>` at creation;
  - a column that does not hold what the classifier last wrote.

  This is the same ownership test as `lib/priority-ai/run.ts:389-442`, and it
  is decided under the ticket's row lock.

- **`unknown` is offered in code and named in the instructions, and it never
  settles anything.** It covers greetings, thanks, a lone image, and anything
  unrelated to ShipBlu. A greeting is the most confident answer a classifier
  gives, so the escape hatch must never apply or stop the ticket being asked
  again (`lib/priority-ai/decide.ts:24-33` records the same lesson). The key is
  reserved three times over:
  - by the registry's CHECK;
  - by the admin action;
  - by the request builder, which refuses a registry row named `unknown`.

  Category keys come straight from the registry, so a collision would
  otherwise merge the two silently. Canned suggestions avoid the same problem
  with positional keys.

- **The first confident answer settles the category, and later messages leave
  it alone.** The category drives routing, and a ticket that changes teams
  mid-conversation is worse than one an agent relabels by hand.
  - **What "first" means.** The earliest settling answer by the message's
    `created_at`, decided under the row lock. Jobs run concurrently and retry
    out of order (`lib/priority-ai/run.ts:198-202`).
  - **After settling.** A job that finds the ticket already settled records
    outcome `after_settle` and writes nothing. Messages enqueued after the
    settle are checked before the provider call and not asked at all.
  - **In shadow.** A ticket settles at its first non-`unknown` `would_apply`
    run, exactly as priority's shadow weighs answers against its own last
    `would_apply` (`lib/priority-ai/run.ts:180-188`). Otherwise the shadow
    would measure a classifier that never settles, which is not the one
    `apply` turns on.
- **Only the requester's own words are classified.** A passer-by's "price?" on
  a comment thread must not turn a complaint into a sales ticket. This uses the
  requester-only rule priority already applies.
- **A cap per ticket.** No more than five classified messages, and only while
  `first_responded_at` is null. That column moves for agents and for
  Business-app echoes but never for an automated message
  (`lib/tickets/outbound.ts:20-25`). So an out-of-hours acknowledgement does not
  end classification before the informative second message, and a ticket that
  has not settled by the first human reply is a person's call.
- **One threshold on the winner's share,** default 0.6, as for priority. It
  starts as a guess, and the shadow period is what calibrates it.
- **Every answer is a row.** The row records mode, prediction, the full
  distribution, outcome, latency, tokens and a `request_fingerprint`.
  - **Fingerprint:** a hash of the serialised `questions` object exactly as
    sent (keys, criterion strings, the `unknown` criterion, instructions),
    plus a `STATE_VERSION` constant bumped whenever `state` changes shape. An
    admin editing a label or description changes the question, and a report
    must not average two questions.
  - **Baseline:** each row also records a free baseline, computed in the same
    call and **not sent to Jev in v1**. Disagreements can then be read as
    being about the text. It holds:
    - `detectCategories` output put through a reviewed area-to-category map
      in `lib/category-ai/baseline.ts`. `commercial.*` and `account.signup` go
      to sales, other merchant-audience areas to merchant support, and
      recipient areas to customer support. `service.*`, `meta.*` and `other.*`
      map to null. Computing it in the same call is the rule `AGENTS.md`
      already sets for the shadow categoriser, since agents curate the stored
      rows.
    - The channel row, any linked shipment, and `requester_kind`.

The mode is an admin switch (`off`, `shadow`, `apply`), stored in a one-row
settings table, not an environment variable. That is the canned-suggestion
precedent: production already holds `TYPESAFE_API_KEY`, so key-as-flag would
switch it on for every environment that has the key. Staging stays off because
its database says so. The key remains a precondition, shown on the page. The
enqueue path reads the switch through a 30-second memo, as `suggestionsLive()`
does. A memo that fails to read answers `off` and logs: the classifier misses a
message rather than breaking ingest.

Every existing Jev request keeps its exact input across the comment split.
`metaPlatformOf` maps a comment channel back to its platform in **both**
`stateFor` functions, `lib/categorise-ai/request.ts` and
`lib/canned-suggest/request.ts`. The priority request in particular stays
byte-identical, and a test asserts it. The new classifier is told
`is_public_comment` explicitly.

### 5. Routing is a channel setting plus a hold, decided once by `lib/routing/`

`channels.routing_mode` is an enum column, not a config key, because
`saveChannel` rebuilds config by type:

| Mode              | What happens to a new ticket                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `default_group`   | Today's behaviour, and the default for every row.                                                                           |
| `category_shadow` | The ticket stays in the default group. The router records where it _would_ have gone.                                       |
| `category`        | Assignment and the out-of-hours reply are held until the router settles the ticket, and the ticket then moves at most once. |

`category_shadow` is per channel because the channels are at different points.
Messenger is read-only until the Freshworks swap, so routing it live moves
copies of tickets that somebody in Freshchat is answering. Instagram and the
comment channels are answerable today. `saveChannel` refuses either category
mode on a coexistence row: its replies are typed on the phone, so routing its
tickets changes nothing about who answers them.

**Which tickets route.** Only a ticket created by an inbound ingest path on a
`category` channel: email, WhatsApp, Meta DM or comment, or the widget. Tickets
created through `createTicket` never route; that is forms, the portal and
agent-opened tickets, each of which brings its own group. Nor do continuations,
reopens, imported history or echo-first conversations.

**State lives in two places.**

- **Two columns on `conversations`,** `routing_window_ends_at` and
  `routing_decided_at`. These are what the hold is computed from. They sit on
  the row because `assignConversation` already selects the whole row, so the
  check costs nothing even across 500 tickets a sweep.
- **A `routing_decisions` table,** one row per ticket that entered routing:
  - live or shadow;
  - outcome: `category`, `fallback`, `manual`, `rule`, `released`,
    `not_open`, or `no_route_for_category`;
  - from and to group, category, Jev's probability;
  - window end and decision time.

  The report reads this table. The timeline gets one `routed` event per
  decision, naming the category, the group, the probability and the outcome,
  including a decision that moved nothing. Today `group_changed` says only
  "moved the ticket to another group", and nothing else reads that event.

**The creation pass begins routing.** A new step, `beginRouting`, runs in
`afterInboundMessage(created=true)` right after the `on_create` rules and before
the SLA. Under the row lock, for a `category` channel:

- **A rule already decided.** If an `on_create` rule moved the group or
  assigned the ticket, the outcome is `rule`, and nothing is held.
- **A category already exists.** It may have been set by a rule's
  `set_category`, or by Jev answering before the creation pass finished. The
  ticket routes now, and the SLA, assignment and reply that follow see the
  routed group.
- **Otherwise it is held.** It writes `routing_window_ends_at = max(created_at,
now()) + window`. The anchor is processing time, not `created_at`, so an
  email processed late after a worker pause still gets its full window. It
  then enqueues `settle_routing` for that instant.

For `category_shadow` it writes only a shadow `routing_decisions` row and the
same job, and holds nothing. Because the window is written at the end of the
creation pass, a classifier answer that lands before it finds no window and
records `wait`. `beginRouting` then routes on that answer, so a rule always
gets the first word.

**The hold.** A ticket is held exactly while all of these are true:

- `routing_window_ends_at` is set;
- `routing_decided_at` is null;
- `assignee_agent_id` is null;
- now is before `routing_window_ends_at` + 10 minutes.

`assignConversation` skips a held ticket with a new reason, `awaiting_route`,
and so does `maybeSendAutoResponse`. Neither writes to the timeline: a timeline
entry per skip already produced 1,432 rows for 137 tickets.

The 10-minute grace is a safety valve for a stuck job, not a second window. In
normal running only `settle_routing`, or a stamp, ends a hold. The hold
therefore never lapses at the instant `settle_routing` becomes due, which would
let a sweep assign a ticket in its default group just as the router moves it.

As hardening, `assignConversation` also re-reads `group_id` under its group
lock and gives up if the ticket moved meanwhile. That closes the same race for
rules, which exists today.

The alternative was to let the default group assign and then unassign on
classification. It was rejected because it breaks "never overwrites an
assignee" (`lib/assignment/index.ts:29-33`), and the ticket would appear in one
agent's queue and then vanish.

**What ends a hold, and how.** One helper, `endHold(tx, id, outcome)`, does it.
It writes `routing_decided_at = coalesce(routing_decided_at, now())` and the
decision row's outcome only when it was not already set, so a later pass never
overwrites an outcome. It is called in the same transaction as the write that
ends the hold, **before** anything that assigns:

- **`manual` (a person).** The console's group, assignee, reply and category
  edits.
  - A category edit during the hold ends it without moving the ticket, and the
    sidebar offers the move in one click ("Sales tickets go to Inbound Sales
    Team — move?").
  - A person's assignment carries over from today unchanged: an agent who takes
    a held ticket from their group's queue ends the hold. The queue therefore
    marks a held ticket "Routing…" with the time the hold ends (Stage 0.5).
- **`rule` (the automation engine).** It stamps before it calls
  `assignConversation` for `auto_assign` with a group, and before `assign_group`
  writes. Otherwise the new `awaiting_route` skip, which sits beside the other
  early returns, would swallow a rule's `auto_assign` before its group move.
  The ticket would then be stamped `rule` while still in the default group. An
  `auto_assign` with no group means "assign within the current group", so it
  does not end the hold; it is held like any other assignment.
- **A rule's `set_category` during the hold** does not end it. The router
  routes on that category when it settles, because a rule's category is the
  admin's routing configuration speaking.

**`settle_routing` is the end of the window by definition.** It never waits.
Under the row lock, `decide.ts` returns one outcome:

- **`category`.** The category is settled (by Jev, or by a rule) and names a
  route group. The ticket moves.
- **`no_route_for_category`.** The category is settled but has no route group.
  The ticket stays in its default group.
- **`fallback`.** No category was settled in the window. The ticket stays in
  its default group.
- **`released`.** The channel is no longer in `category` mode, or the classifier
  is no longer in `apply`. This is re-read at decision time, so switching
  either off moves nothing more.
- **`not_open`.** The ticket was resolved, closed, marked spam or deleted
  during the window. Nothing is moved, re-selected, assigned or sent.

A classifier answer inside the window calls the same `apply.ts`. A late answer,
after the settle, finds `routing_decided_at` set and keeps the ticket where it
is. That matters because Jev's retries back off 10, 40, 90 and 160 s. The
dedupe key `settle_routing:<id>` is spent for good, which is correct because
routing is once ever per ticket. The job is conversation-scoped, so it joins
`send_csat` in `lib/admin/purge-jobs.ts`, and its handler ends via
`subjectGone` on a purged ticket.

**After a decision commits, the order is the creation pass's order**
(`lib/tickets/lifecycle.ts:26-43,93-99`):

1. **The `on_update` pass,** if the ticket moved. That way "sales on the
   merchant number → Merchant Care" runs before anybody is assigned.
2. **`reselectPolicyBeforeFirstResponse`,** on the group as it stands after
   the rules.
3. **`assignConversation`.**
4. **The held out-of-hours reply.**

Doing it the other way round leaves a Sales agent holding a Merchant Care
ticket. `assign_group` never touches the assignee, and `auto_assign` returns
`already_assigned` before it moves anything. It would also tell the customer
Sales' hours. When the classifier's answer is what routed the ticket, the
classifier does **not** also call `afterTicketUpdate`. One owner per pass,
or level-triggered rules write their tagging and watcher events twice.

**The held reply is owed by state, not by one caller.** Whatever ends a hold —
`endHold`'s callers, `apply.ts`, `settle_routing` whatever its outcome — calls
`maybeSendAutoResponse` after its commit. The claim on `auto_responded_at`
keeps it to one send. It gains a status check, because its documented
precondition, that every caller has just reopened the ticket
(`lib/auto-response/index.ts:255-260`), no longer holds once a job calls it.

**The window defaults to 5 minutes, adjustable from 1 to 30,** and is copied
onto the ticket at creation. Changing the setting never moves a window already
running. Of 257 short chat openers, 191 had a follow-up within 2 minutes and
195 within 10. The shadow period records time to decision per ticket, which is
what tunes it. For context, today's median time to _assignment_ is 40 hours.

**Shadow is defined, not assumed.** In `category_shadow`:

- Nothing is held, so assignment on arrival and the sweep go ahead.
- The shadow decision ignores machine assignments (`auto_assign`,
  `assign_sweep`), which a live hold would have prevented, and still counts
  manual and rule moves.
- It records `shadow_decided_at` when the classifier settles, as well as at
  `settle_routing`.
- It never writes `routing_decided_at`, so moving a channel to `category`
  later starts clean.

Without this, a shadow week on a staffed group would record nearly every
ticket as kept, and report a routing rate the live mode would not have.

The settled design in `README.md:352-357` ("The routing rules are the automation
rules") is amended in the same PR, with the reasons at the top of this file. The
routing table is a lookup like `default_group_id` and holds no conditions, so
it is not a second engine. Rules still decide every exception, and they run
before assignment.

## Deploy rules every stage obeys

No production service deploys itself. Only web runs migrations, as its
preDeploy (`render.yaml:286-288`). The worker and the four crons each build and
run their own copy of the code: `shipblu-sla-sweep`, which runs `assign_sweep`;
`shipblu-time-automations`; `shipblu-hourly`; and `shipblu-nightly`. Six rules
follow:

1. **A stage that adds schema deploys web first**, so its preDeploy migrates,
   then the worker, then all four crons. A worker carrying new columns before
   the migration fails every `insert(conversations)`, because Drizzle names
   every column and sends `default` for unset ones. It also fails every
   whole-row select, which covers ingest, assignment, SLA, automations and all
   three senders. Its jobs would reach `dead` after about five minutes of
   backoff.
2. **Readers before writers means every service.** A cron left on old code is
   old code: an old `shipblu-time-automations` sends a rule's reply on a
   comment ticket through the old `carrierFor` to email. An old
   `shipblu-sla-sweep` assigns held tickets with no hold.
3. **A new job type is enqueued only after an admin flips a switch.** The
   classifier defaults to `off` and every channel to `default_group`. So
   deploying web first never queues a job the worker does not know.
4. **A stage is "deployed" when web, worker and all four crons run it.** Each
   stage's last check confirms the deployed commit on all six services.
5. **No migration, now or later, may reference a new enum value.** Drizzle
   applies every pending migration in one transaction, which on a fresh
   database (CI, `shipblu_test`) is all of them, so the value would be used in
   the transaction that adds it (55P04). Anything naming a new value — a
   default, a partial index, a CHECK — goes in `db/sql`, which runs after the
   commit.
6. **Every PR follows `AGENTS.md`:**
   - It runs `typecheck`, `lint`, `lint:strict`, `test`, `knip`, `build` and
     `repo-rules` (with new files staged) before pushing.
   - Every new raw SQL fragment gets a `*.db.test.ts`.
   - Every new job type gets an entry in `JOB_PAYLOADS` with a `z.strictObject`
     payload, a handler, a registration, and a line in `scripts/ci/db-jobs.txt`.
   - Every new env var appears in `lib/env.ts` and `render.yaml` in the same
     commit.
   - Every new permission key gets a comment saying why it is separate.
   - Every new console page brings its own scroll container and reads through
     `lib/`.
   - Every new form uses `useActionForm`.
   - The docs a change makes stale are updated in that PR.

## The work, in the order it ships

```
Stage 0  foundations ─┬─> Stage 1  comment channels ─────────────────────┐
                      └─> Stage 2  rename (A then B) ─> Stage 3 category ─┴─> Stage 4 Jev ─> Stage 5 routing ─> Stage 6 reporting
```

Stages 1 and 2 touch different seams and may proceed side by side, but their
migrations land one at a time.

### Stage 0 — foundations (each worth having on its own)

- **0.1 — CI fails a rename with no migration.** `ci.yml`'s drift step fails
  when generate prints "Interactive prompts require a TTY". It ships before
  anybody touches a table name.
- **0.2 — Groups are chosen, not typed.** The condition builder offers
  `group.id` as a choice of groups and stores the uuid
  (`app/(console)/admin/field-options.ts:64`). The work runs in this order:
  - **Read first.** With read-only SELECTs, quote every `group.id` condition in
    `automation_rules`, `sla_policies` and `skills`, not only the SLA policies,
    since the three share the builder.
  - **Show what does not match.** Once the field is a choice, the builder shows
    a stored value with no matching group as "Unknown: <value>" so an admin can
    remove it. A stale name otherwise renders as a blank select. In a list it
    becomes an invisible member that is written back on every save
    (`app/(console)/admin/condition-builder.tsx:170-203`).
  - **Fix the stored conditions through the console.** That is a production
    write, so it follows the `AGENTS.md` sequence: read the rows, say the
    change, have the way back. The four SLA policies need two things:
    - **uuids, not names**, in every group condition;
    - **an order that lets a group policy match.** Today policy 1 catches every
      chat ticket before policy 4 is reached, so policy 1 moves to the end or
      loses its channel branch. This is done together with Stage 1.2's channel
      inventory, since both change the same rows.
- **0.3 — A group cannot be deleted out from under routing.** `deleteGroup`
  refuses while a channel or a form names the group as its default. Today
  both are `on delete set null`, and new tickets would silently land in no
  group and never be assigned. Stage 3 adds "or a category routes to it".
- **0.4 — Channel lookup is deterministic.** Every lookup that picks one row
  of a type orders by `created_at, id`, as `webchatChannel` already does
  (`lib/widget/session.ts:113-127`). That covers:
  - `channelFor` (`lib/tickets/ingest-meta.ts:575-583`);
  - `defaultEmailChannel` (`lib/tickets/ingest.ts:332-339`);
  - `portalChannel` (`lib/portal/tickets.ts:393-400`);
  - `resolveWhatsAppChannel`'s fallback for an unknown number
    (`lib/tickets/ingest-whatsapp.ts:766`).

  From Stage 5 a ticket's channel row decides its routing mode, so an
  unordered choice would make routing depend on the order the rows happen to
  come back in.

- **0.5 — An agent can see their group's queue.** `ticket.view.group` is
  already in the `AGENT` role (`lib/auth/permissions.ts:227-229`); nothing
  reads it.
  - **One predicate.** The rule "assigned to me, or in a group I belong to,
    when I hold `ticket.view.group`" goes in one place: `conversationVisibility`
    extended with a group-membership arm, plus a row-level twin for single-row
    checks.
  - **Every copy switches to it.** Seven places enforce "assigned to me unless
    `ticket.view.all`" today:
    - the inbox list (`lib/tickets/inbox.ts:169-171`);
    - the inbox counts (`:410-417`), whose cache is keyed on `viewAll` alone
      and must also key on group membership, and which gain a "My groups"
      count;
    - the ticket page (`lib/tickets/conversation.ts:195-197`);
    - `loadConversation`, the guard every ticket action uses
      (`lib/tickets/console-guards.ts:60`);
    - the attachment route (`app/api/attachments/[id]/route.ts:74`);
    - `scopeForAgent` and the shipment read model
      (`lib/tickets/visibility.ts:42`, `lib/shipments/queries.ts:158-159`);
    - `conversationVisibility` itself.

    Changing only the last one would leave a routed ticket out of the inbox
    and unopenable, which is the gap this item exists to close.

  - **The inbox.** It gains a "My groups" view and a group filter. A ticket
    held for routing (Stage 5) carries a "Routing…" badge with the time the
    hold ends, so an agent who takes it knows they are ending the route.
  - **Tests.** A `*.db.test.ts` shows a group member admitted, and a non-member
    refused, by the inbox list, the counts, the ticket page, and an
    assign-to-self action.
  - **It switches on for every agent at once.** Deploying this enables group
    visibility for every agent-role user the moment it lands, because the
    grant already exists. Q8 decides whether the key stays in `AGENT`.
    Answering "no" means removing it there in the same PR, with per-agent
    overrides for anyone who should keep it. 0.5 does not deploy until Q8 is
    answered.
- **0.6 — Staffing and group settings (operations, not code).**
  - Put agents into Inbound Sales Team, Merchant Care and Customer Care, and
    decide what Support is for once those groups exist.
  - For each future route group, read and confirm:
    - `assignment_strategy`, which must not be `manual`. Manual is the
      column's default (`db/schema/agents.ts:159`), `assign_sweep` skips such
      groups, and the skip is not recorded.
    - `assign_within_hours_only` and the group's hours.
    - That at least one member is active and accepting tickets.

  Without this, every routed ticket waits unassigned, and each of those groups
  escalates after 60 minutes to a named agent.

- **0.7 — Find out why `assign_sweep` stopped (read-only).** It has assigned
  nothing since 2026-10-07, yet it is routing's backstop and its rollback path.
  - **Logs.** Read `shipblu-sla-sweep`'s logs for the
    `[assign_sweep] reclaimed= assigned=` line.
  - **The chain.** Check whether an earlier step fails. The cron chains
    `sla_sweep && presence_sweep && assign_sweep` (`render.yaml:411`), so a
    throwing earlier sweep stops assignment silently, as §6.66 already
    records once.
  - **The groups.** Check the accepting state of Support's three members.

  Fix the cause or name it before Stage 5.

### Stage 1 — comment channels

**1.1 — Readers (no behaviour change).** Web first (it migrates), then the
worker and all four crons. 1.2 does not start until all six run 1.1.

- The enum values go in through a one-line `ALTER TYPE … ADD VALUE` migration,
  following the precedent of `db/migrations/0004_tired_namora.sql`. Deploy
  rule 5 applies from then on.
- `channel-policy.ts` gains the helpers in decision 1. `CONVERSATION_CHANNELS`
  (which the compiler checks both ways) and `FILTERABLE_CHANNELS` list the two
  new values, and so does the hand-written union in
  `lib/tickets/inbox-filters.ts:16`. Realtime topics follow from
  `CONVERSATION_CHANNELS`.
- `carrierFor` takes `ConversationChannel` as an exhaustive switch, and its
  feeders are re-typed (decision 1). Comment channels go to `send_meta`.
  `sendsByEmail` and `lacksEmailRecipient` follow.
- Every site that compares a channel with `facebook` or `instagram` calls the
  helper. Among them:
  - reply-actions writes `meta.platform: metaPlatformOf(channel)`;
  - send-meta maps the channel to its platform;
  - `conversation.ts` keeps comment channels out of Meta thread state;
  - the composer, the header, `inbox-badges`, `meta-actions` and
    `canned-suggest`;
  - both `stateFor` functions sent to Jev, mapped back to the platform;
  - CSAT's `channelSwitch`, where comment channels map to their platform's
    switch. `scheduleSurvey` then still queues the job and `decideSurvey` still
    records `comment_thread`, rather than answering `channel_unsupported`
    before anything is queued.
- Labels and badges:
  - `ChannelBadge` gives "Facebook comment" and "Instagram comment" a mark of
    their own: the platform's glyph with a small globe overlay. Several places
    draw the mark without its label (the inbox row, the header, the
    conversation-row avatar), and there the four Meta channels must be told
    apart by shape, not hue.
  - `channelLabel` in `lib/format.ts`.
  - The condition builder's channel choices.
- **Auto-responses.** A rule scoped to "every channel" no longer matches a
  comment channel; only a rule naming that channel does. Today a company-wide
  out-of-hours reply would go out as a **public** comment reply
  (`send-meta.ts:431-436` infers `comment_reply`). The only row is inactive,
  so this changes nothing live and closes the trap before it opens.
  - Both channel lists change: `AUTO_RESPONSE_CHANNELS` in the action and the
    form's own copy in `app/(console)/admin/auto-responses/forms.tsx:23-40`.
  - The null scope's label becomes "Every channel except public comments",
    with an `InfoTip` saying why.
- **The external id stays a safeguard.** The send path, the 24-hour guard and
  the CSAT skip keep their `rootCommentId(externalId)` test beside the new
  channel test.

**1.2 — Stored configuration, then writers.** The worker carries the writer;
deploy it with web and the crons.

- **Before anything writes the new values: the inventory.** With read-only
  SELECTs, quote every `automation_rules`, `sla_policies` and `skills`
  condition, and every `auto_responses` scope, whose text names `facebook` or
  `instagram`. Decide each row with the support lead, and edit through the
  console under the live-write sequence, together with 0.2's SLA restructure.
  `csat_rules` is a channel column and comment tickets are never surveyed, so
  it needs no change.
- Ingest writes `channel: '<platform>_comment'` for a comment ticket
  (`lib/tickets/ingest-meta.ts:216`).
- `channelFor` looks for the comment row and falls back to the platform's row
  if none exists. Until an admin creates a comment channel, its tickets keep
  today's default group.
- `resolveContact` stays on the platform.
- The admin channels page can create "Facebook comments" and "Instagram
  comments" rows. They need no credentials, since they ride the Page and
  Instagram tokens, and their config is `{}`. The page's four type allowlists
  and its config branch learn the new types.
- **Backfill job `split_comment_channels`** (strict payload, `dryRun`).
  - **What it moves.** Existing comment tickets (52 today) move to the new
    values, and `channel_id` is set to the comment row where one exists; 13 of
    the 52 have a null `channel_id` because they predate the channel rows. It
    also moves the frozen channel copies for those tickets,
    `csat_surveys.channel` and `canned_suggestions.channel`. Otherwise their
    CSAT skips would stay in the platform slices of rebuilt reports, which the
    rollup's reconcile check cannot see.
  - **How it is built.** It is idempotent, reports counts, and has a
    `*.db.test.ts`.
  - **When it runs.** It runs once all six services run 1.2: dry run, then
    real.
  - **Side effect.** Each moved row fires `notify_change` on both queue topics.
    That is harmless at this size.
- Then run `rollup_metrics from=2026-08-29`, so historic reports show the
  split. Its reconcile check (channel slices sum to totals) is one
  verification. The CSAT columns per channel are the other.

**1.3 — Lock the invariant.** A CHECK in `db/sql`, idempotent and guarded by
constraint name and table:

```sql
(coalesce(external_id, '') ~ '^(facebook|instagram):comment:')
  = (channel in ('facebook_comment', 'instagram_comment'))
```

The `coalesce` matters, because a regex on null is null and a CHECK passes on
null. 1.3 deploys only after `split_comment_channels dryRun=true` reports
nothing to move with all six services on 1.2. Adding the CHECK validates every
row, and one stray row would fail web's preDeploy. After that the pair can
never disagree again, and the three ways the code detects a comment today
become one answer.

**Must not change:**

- the comment-edge reply and `commentReplyTarget`;
- `send_meta` handling `comment_reply` and `private_reply` before it reads
  thread state, the window or `messagingTag`;
- the 24-hour guard's comment exemption;
- the CSAT `comment_thread` skip;
- the external id format;
- webhook routing;
- contact identities;
- the priority request's bytes.

**Docs:** README.md (channels), `AGENTS.md` (the comment exemption wording, the
`HUMAN_AGENT` section), and the stale comment in
`lib/tickets/live-conversation.ts:19-23`. In `docs/PROJECT-STATE.md`, the
claim that no Instagram comment has ever arrived is wrong: 9 Instagram comment
tickets exist.

**Rollback, in this order.** 1.1 itself is never reverted. Its migration
cannot be deleted (`scripts/ci/rules/generated-files.mjs:52-63`), and its
readers are harmless.

1. **If 1.3 has shipped:** merge and deploy the removal of the CHECK from
   `db/sql`, then `ALTER TABLE conversations DROP CONSTRAINT …`. Dropping it
   by hand alone does not last, because every web deploy replays `db/sql`.
2. **Revert 1.2's writers** and deploy web, worker and crons with 1.1's
   readers still in place, so nothing writes comment values any more.
3. **Reverse the backfill** with an `UPDATE`, run as a `SELECT` first, that
   sets each comment channel back to its platform in `conversations`,
   `csat_surveys` and `canned_suggestions`, and restores `channel_id`.
4. **Rebuild the reports** with `rollup_metrics from=2026-08-29`.

### Stage 2 — the subcategory rename

**2.A — Code and UI (no migration).** Any deploy order, but all six services.

- **Wording.** "Subcategory", in the sidebar block, admin pages, reports,
  review queue, shadow page, nav, error text and event-label sentences. The
  Arabic wording comes from the support lead (Q2).
- **Routes** move to `/admin/subcategories`, `/admin/subcategories/review`,
  `/admin/subcategories/shadow` and `/reports/subcategories`.
  - **Redirects.** `next.config.ts` serves **temporary** redirects from the
    old paths (`permanent: false`, a 307). Stage 3 removes the
    `/admin/categories` redirect in the PR that puts the new Categories page
    there. A permanent 308 would be cached by every browser that followed it,
    and would keep sending admins to subcategories after Stage 3.
  - **Every hard-coded path moves**, not only the three
    `/admin/categories/review` revalidations outside the folder
    (`lib/tickets/console-guards.ts:96`, `app/(console)/ticket-actions.ts:324`,
    `app/(console)/contacts/actions.ts:332`). That includes:
    - the four `revalidatePath('/admin/categories')` calls in
      `admin/categories/actions.ts`;
    - the in-page links to `/review` and `/shadow`;
    - `app/(console)/admin/nav.tsx:46`;
    - `app/(console)/reports/page.tsx`'s link.

    A stale one passes CI. After Stage 3 it would name the new page.
- **Code.**
  - `lib/categorise/` → `lib/subcategorise/` and `lib/categorise-ai/` →
    `lib/subcategorise-ai/`, with every exported name renamed to match.
  - `category-actions.ts` → `subcategory-actions.ts`.
  - The schema identifiers, with the SQL strings pinned to the old names.
  - The cross-imports from `lib/priority-ai/`.
- **Permission keys.** `ticket.categorise` becomes `ticket.subcategorise` and
  `admin.categories` becomes `admin.subcategories`. No production agent holds
  an override of either. That is checked again on the day, because an override
  of a renamed key would silently lapse.
- **Job type.** `backfill_categorise_ai` becomes `backfill_subcategorise_ai`,
  with its `db-jobs.txt` line. It has 0 stored rows and no cron.
- **Env vars.** `CATEGORISE_*` becomes `SUBCATEGORISE_*`. `render.yaml` says
  they are "set nowhere". Read the Render dashboard on both services first,
  because a value set there under the old name would silently fall back to the
  default.
- **Events.** New writes use `subcategorised` and
  `subcategory_added|confirmed|rejected|removed`, with `subcategoryKey` in the
  event data and actor `subcategory-detector`. `event-labels.ts` reads both the
  old and new strings.
- **Handbook.** Three articles name the taxonomy: `categorising`, the ticket
  fields list (`lib/kb/handbook.ts:203`) and the administration article
  (`:424-426`). Their content changes but their keys stay the same, and their
  Arabic moves to the agreed subcategory word. Then
  `seed_console_handbook overwrite=true` runs.
- **Docs.**
  - `AGENTS.md` §"Ticket categorisation".
  - `AGENTS.md` §"The one AI provider", which names `lib/categorise-ai/`,
    `ai_category_runs`, `ticket_categories` and `conversation_categories` for
    the shadow categoriser. After Stage 3 reuses two of those names, stale text
    there would point readers at the wrong table.
  - `docs/PROJECT-STATE.md`.
  - `plans/ticket-categorisation.md` and
    `plans/categorisation-through-typesafe.md` get a one-line historical note
    rather than a rewrite.

**2.B — The database (maintenance sequence).**

- **Schema.** The four table names, two column names, two enum type names, and
  every explicit index string on those tables are renamed in `db/schema`:
  - `ticket_categories` → `ticket_subcategories`
  - `conversation_categories` → `conversation_subcategories`, with its columns
    `category_id` → `subcategory_id` and `category_key` → `subcategory_key`
  - `category_metrics_daily` → `subcategory_metrics_daily`
  - `ai_category_runs` → `ai_subcategory_runs`
  - the enum types `category_audience` and `category_review_state`

  The index strings are explicit, not derived, so a table rename alone leaves
  them behind.

- **The migration** is generated at a TTY with the rename prompts answered, and
  committed exactly as generated (decision 2).
- **`db/sql/002_categories.sql` becomes `002_subcategories.sql`.** It keeps its
  place in the replay order. Every guard matches on the constraint's name
  **and** its table (`conrelid = 'ticket_subcategories'::regclass`), so it
  handles both databases:
  - on production it renames the six CHECK constraints when the old name
    exists on that table and the new one does not;
  - on a fresh database it creates them under the new names;
  - it renames the three implicit `_pkey` indexes, guarded on `indrelid`.

  A guard on the name alone would one day find Stage 3's constraint on the new
  `ticket_categories` and fail every replay.

- **Raw SQL with no database test is tested before merge.** These were never
  executed in CI: `categoryTotals`, `areaTotals`, `channelTotals`,
  `causeCoverage`, `ruleScores`, `categoryUsage` and `runLabels`. They get a
  `*.db.test.ts`, or one `execute_sql` each against a Supabase branch.
- **Verification before merge:**
  - CI's `database` job, which migrates an empty Postgres and replays
    `db/sql` twice;
  - a second `drizzle-kit generate` reports nothing to migrate;
  - the migration and `db/sql` applied to a Supabase branch of production;
  - no `pg_class` relation still named `ticket_categories%`,
    `conversation_categories%`, `category_metrics_daily%` or
    `ai_category_runs%`.
- **Deploy sequence:**
  1. Pick the time. Avoid 00:00 UTC, when `shipblu-nightly` runs the rollup,
     and choose a time when web chat, portal and form traffic is about zero.
  2. Suspend the worker and the crons.
  3. Deploy web, which runs the migration before traffic moves. Note the
     migration's start time and the moment the new release went live.
  4. Load a ticket page, a web chat ticket, `/admin/subcategories` and its
     shadow page.
  5. Deploy the worker and crons, then resume them.
  6. Watch for `subcategorised` events on new messages.
  7. List inbound messages on web chat and portal tickets created between the
     two times in step 3 with no `subcategorised` event. If there are any,
     re-run the detector over them, or accept the loss explicitly.

  Expected window: a few minutes of queued (not lost) webhook processing.

- **Rollback.** A tested runbook, not a reverse migration in the repo. Drizzle
  applies only migrations newer than the newest row in
  `drizzle.__drizzle_migrations`, and the forward file cannot be deleted from
  `main`.
  1. Keep the worker and crons suspended.
  2. On the session connection, run the reverse SQL by hand: tables, columns,
     FK, PK and index names, both enum types, the six CHECK names and the three
     `_pkey` names.
  3. In the same transaction, delete the forward migration's row from
     `drizzle.__drizzle_migrations`, so a later deploy from `main` re-applies
     it.
  4. Deploy the previous web commit by hand. Its preDeploy replays the old
     `002_categories.sql`, which now finds its old names again.
  5. Do not deploy `main` until the roll-forward is intended.

  This exact sequence, including the later roll-forward, is rehearsed on the
  Supabase branch before 2.B merges.

**Gate:** Stage 3 does not start until 2.B is deployed to all six services and
verified. After that, nothing running can read `ticket_categories` expecting the
old meaning, and the name is free.

### Stage 3 — the category field

**3.1 — Schema, admin and the ticket.** Web first (it migrates), then the
worker and all four crons. An old time-automations cron would drop a
`set_category` action without a word, because `parseActions` filters what it
cannot parse.

- **Schema.**
  - The `ticket_categories` registry, as described in decision 3.
  - `conversations.category_id` (FK `restrict`) and an index for the inbox
    filter.
  - In `db/sql`: the `ticket_categories_key_format` CHECK, and
    `OLD.category_id IS DISTINCT FROM NEW.category_id` added to the
    `queue_relevant` list in `001_extensions_and_triggers.sql:370-385`. Without
    the second, open inboxes do not redraw when only the category changes.
- **Seeding.** `lib/categories/registry.ts` holds the starter set: three rows
  with English and Arabic labels and descriptions written for Jev. Being in
  code means the wording goes through review. `seed_ticket_categories` puts
  the set in idempotently, finding rows by key, and production runs it by
  hand, because deploys only run `db:migrate`
  (`docs/PROJECT-STATE.md` §6.30). `db/baseline.ts` seeds the same set for
  tests and development.
- **Admin.** A "Categories" page at `/admin/categories`. This PR removes the
  2.A redirect from that path.
  - **Edit** labels, description, position, active flag and the route group.
    The route-group picker shows each group's strategy, members accepting now
    and hours gate, and warns on a `manual` group.
  - **Add** a category. The key `unknown` is refused.
  - **Retire** a category, never delete one. Retiring uses `ConfirmSubmit`.
  - **Permission.** It is gated by `admin.categories`, which is free after
    Stage 2.
  - `deleteGroup` also refuses while a category routes to the group.
- **The ticket.**
  - A Category select beside Group and Priority in the sidebar.
  - A badge in the header, because the sidebar renders only from `lg` up.
  - `ConversationDetail` carries the field.
  - A new `updateTicket` case writes the column and a `category_changed` event
    in one transaction, with the stamp of decision 3. It then re-selects the
    SLA policy if there has been no first response yet, and runs
    `afterTicketUpdate`.
  - It is gated by a new permission, `ticket.set_category`, which agents get
    by default.
  - The new event string `category_changed` cannot collide with the old
    `category_*` history. `event-labels.ts` gets a case for it naming the
    category, and for `jev:category` Jev's probability, as `priority_changed`
    does.
- **Rules.** The `category.id` fact appears in the condition builder as a
  choice of registry rows. There is also a `set_category` automation action, so
  a rule such as "anything on the merchant number is merchant support" can set
  the category and be respected as owned.
- **SLA.** `reselectPolicyBeforeFirstResponse` lands here, called on every
  category change before the first response (decision 3).
- **Inbox.** A category filter axis, views, and a row badge.
- **Docs.**
  - `AGENTS.md` gains a section next to the subcategory one: the routing-label
    framing, the ownership rules, the event stamp, and the reuse of the
    `ticket_categories` name after the gate.
  - A handbook article on the Category field.

**3.2 — Where a person sets it at creation.** Web, worker and crons; no schema
beyond one column.

- A form gets `default_category_id`, recorded at creation as a
  `category_changed` by `form:<slug>`. Like `priorityChosenBy`, this is read at
  the time and never from the form as it stands later.
- The console's new-ticket form gets a category chooser, which counts as
  owned. Production has no forms today, so this can follow later without
  blocking anything.

### Stage 4 — Jev sets the category

**4.1 — The classifier, shipped off.** Web first (it migrates the new tables),
then the worker and all four crons. With the switch at `off` nothing is
enqueued, so no job type is ever unknown.

- **Code.**
  - `lib/category-ai/` (request, decide, run, enqueue, settings, baseline).
  - `lib/tickets/classifiable.ts`, extracted from priority, with priority
    switched to it in the same PR and its tests unchanged.
  - The `classify_category {messageId}` job (strict payload).
  - A `classify_category:<messageId>` dedupe key, queue priority 30.
  - An entry in `purge-jobs`' `messageJobTypes`.
  - A `skip:` line in `scripts/ci/db-jobs.txt`, since the job needs the
    provider.
- **The backfill job, `backfill_category_ai`.** It has a strict payload with
  `dryRun`, a `run:` line in `db-jobs.txt`, and two modes:
  - **`record`.** It writes only `ai_category_runs`, under its own run label
    and fingerprint, simulating settling, over human tickets since
    2026-08-18. That lets labelled evaluation start now rather than after weeks
    of new traffic, following the `backfill_categorise_ai` precedent.
  - **`apply`.** It sets the column and its `category_changed` event (actor
    `jev:category`) on open tickets, and nothing else. It never calls
    `afterTicketUpdate`, `lib/routing/apply.ts` or an SLA hook, so it neither
    fires rules nor moves the 207-ticket backlog. Its dry run reports how many
    open tickets each `on_update` rule keyed on `category.id` would match.
- **Runs table.** `ai_category_runs`, which has a unique `message_id` and the
  same upsert-over-`failed` discipline as `ai_priority_runs`. Its name is free
  after the gate.
- **Settings.** `category_ai_settings` is a one-row table holding the mode, the
  threshold and the routing window, read through a 30-second memo. The
  "Categories" admin page shows the mode switch, the key's presence, and
  per-category readiness (route group, strategy, members accepting now).
- **Wiring.** `afterMessageStored` enqueues the job in its own `try/catch`,
  beside priority's.
- **After commit.**
  - Until Stage 5: an applied answer calls `afterTicketUpdate`, as priority's
    does.
  - From Stage 5: if the ticket is held, the classifier calls
    `lib/routing/apply.ts` **instead**; otherwise it calls `afterTicketUpdate`.
- **Tests.**
  - `decide.test.ts` covers every rule in decision 4: the greeting, `unknown`,
    and shadow settling.
  - `run.db.test.ts` covers:
    - ownership;
    - settling by the earliest message, with jobs out of order;
    - `after_settle`;
    - the cap, including an out-of-hours acknowledgement followed by a second
      customer message that is still classified;
    - the requester-only skip;
    - the upsert.
  - A request test asserts the priority request is byte-identical to before.
- **Docs.** `lib/typesafe/client.ts` and `lib/env.ts`, whose comments list
  every TypeSafe user and so get a fourth entry; `docs/PROJECT-STATE.md`,
  which corrects "priority ships off"; and `AGENTS.md`'s AI-provider section,
  which says what this one may touch.

**4.2 — Shadow, then evaluate, then apply.** Operations, plus the report.

- Run `backfill_category_ai mode=record` over the archive, then switch the live
  classifier to `shadow` for at least two weeks.
- **Ground truth is made, not assumed.** Nobody has ever reviewed a
  subcategory (1 confirmed, 0 rejected), so labels cannot be expected to
  appear on their own.
  - **Where labels come from.** A supervisor labels a sample through the
    Category select from 3.1, stratified by Jev's predicted class so the rare
    class is represented. Ground truth is **only** a `category_changed` event
    with an `actor_agent_id`. Never the column, which also holds rule and form
    writes, and on the merchant number those would inflate merchant precision.
  - **The report.** `/reports/category-ai` grades **one settling answer per
    ticket** against that label and against the rules baseline, per channel:
    - a confusion matrix;
    - coverage;
    - the share of `unknown`;
    - the share of tickets settled on their first message, which catches
      greetings settling a class.

    It counts only one `request_fingerprint` at a time, chosen by the reader.
- **Criteria to move to `apply`** (proposed):
  - 90% precision on `sales`, with sales recall reported beside it, on at least
    30 labelled tickets.
  - The threshold set from the report.
  - Merchant support is expected to stay below 30 labelled tickets for a long
    time: 2 of 126 in September. Until it reaches 30, the report says so, and
    Q5 decides whether merchant answers may route before then.

### Stage 5 — routing by category

**5.1 — The router.** Web first (it migrates), then the worker, then all four
crons. `shipblu-sla-sweep` must run 5.1 before any channel leaves
`default_group`, or its old `assign_sweep` assigns held tickets. Nothing
enqueues `settle_routing` until an admin changes a channel's mode.

- **Schema.**
  - `channels.routing_mode`, an enum `not null default 'default_group'`.
  - `conversations.routing_window_ends_at` and `routing_decided_at`.
  - The `routing_decisions` table (decision 5).

  No backfill is needed. The window column is only ever written for tickets
  created after a channel enters a category mode, so the existing backlog is
  untouched by construction.

- **`lib/routing/`.**
  - `hold.ts` and `decide.ts` are pure.
  - `begin.ts` is the creation-pass step.
  - `apply.ts` holds the row lock, decides, writes, and runs the after-commit
    order.
  - `end-hold.ts` is the stamp helper.
- **`lib/tickets/lifecycle.ts`.** `beginRouting` runs after the `on_create`
  rules and before `applySlaOnCreate`. Its docstring explains the order.
- **The hold.**
  - `lib/assignment/index.ts` gains `awaiting_route`, kept out of
    `WORTH_RECORDING`, plus the group re-read under the group lock.
  - `lib/auto-response/index.ts` skips while held and re-checks the ticket's
    status.
- **Stamps.** `endHold` is called from:
  - the console's group, assignee, reply and category paths (`manual`), in the
    same transaction as their write;
  - the automation engine's `assign_group` and grouped `auto_assign` (`rule`),
    before it assigns.
- **The fallback job.** `settle_routing {conversationId}`:
  - a strict payload, enqueued at `routing_window_ends_at`;
  - conversation-scoped in `purge-jobs`;
  - `subjectGone` on a missing ticket;
  - a `skip:` line in `db-jobs.txt`.
- **Timeline.** `event-labels.ts` gives `routed` a sentence for every outcome
  in decision 5.
- **Admin.**
  - The channel editor gets a routing-mode control with an `InfoTip`. Every one
    of the three forms that post to `saveChannel` carries it, and an absent
    field means "unchanged" (the trap `forms.tsx:431-433` already guards).
  - `saveChannel` refuses a category mode on a coexistence row.
  - A readiness panel shows, per category, the classifier mode, the route
    group, its strategy, members accepting now and hours, and warns on
    anything that would leave routed tickets unassigned.
- **Tests.**
  - **`decide.test.ts`:**
    - every outcome;
    - `unknown` waiting;
    - a classifier answer before the creation pass;
    - a rule's `set_category` during the hold;
    - a person's category edit during the hold;
    - an `auto_assign` with and without a group;
    - resolved and spam during the window;
    - the channel or classifier switched off mid-window;
    - a late Jev retry after the settle;
    - a window setting changed after enqueue;
    - shadow ignoring machine assignments.
  - **`apply.db.test.ts`:**
    - the row lock;
    - an `on_update` rule moving a routed ticket. It asserts the assignee comes
      from the final group, and so does the out-of-hours reply's calendar;
    - the held reply sent once for every way a hold ends;
    - SLA re-selection with pause credit.
  - **An assignment `*.db.test.ts`:**
    - `awaiting_route` covering the sweep;
    - `settle_routing` interleaved with `assign_sweep` at the window's end.
- **Docs.**
  - `README.md:352-357` is amended, with the reasons at the top of this file.
  - `AGENTS.md` gets a "Routing by category" section with decision 5's rules.
  - The handbook gets an article on routing, the hold and the "Routing…"
    badge.

**5.2 — Turning it on, channel by channel (operations).**

1. **Prerequisites.**
   - All six services run 5.1.
   - Stage 0.5 is shipped and 0.6 is done: each route group has a non-manual
     strategy and members who accept tickets.
   - 0.7's cause is known, and the sweep has assigned something in the last
     day.
   - The classifier is in `apply`, with category route groups set.
2. The Instagram DM channel and the comment channels go to `category_shadow`
   for a week. Read `routing_decisions` against the agents' own moves.
3. Then they go to `category`.
4. Messenger goes to `category_shadow` now, and to `category` the day of the
   Freshworks swap. Before the swap it would route copies of tickets that
   Freshchat agents are answering.
5. Email and webchat follow on the same evidence. The coexistence numbers
   stay `default_group`; `saveChannel` enforces it.

**Rollback.** Set a channel's mode back to `default_group`. New tickets are
never held again. Tickets already held settle at their window's end, at most 5
minutes later, as `released`, and are assigned in their current group with
their held reply sent. Already-routed tickets stay where they are, which is
correct.

### Stage 6 — reporting

Web first (it migrates `metrics_daily`), then the worker and crons, with
`shipblu-nightly` before any `rollup_metrics from=` rebuild.

- `metrics_daily` gains a category dimension: a fifth single-dimension slice
  and `byCategory` beside `byGroup`. This changes its unique index and the
  slice reconcile (`lib/reports/rollup.ts:171-190,533-559`), then
  `rollup_metrics from=` rebuilds history.
- Live open/awaiting by category beside `channelLoad`.
- `/reports/routing` shows, per channel:
  - routes by outcome;
  - time to decision against the window;
  - the fallback share;
  - routed tickets still unassigned.

  Those are the numbers that say whether the window and the threshold are
  right, and whether ask 5 is met.

## Verification queries (run after each stage, read-only)

| Stage | Question                                                  | Shape                                                                                                                                                 |
| ----- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Every comment ticket on a comment channel, and only those | `count(*) filter (where (coalesce(external_id,'') ~ '^(facebook\|instagram):comment:') <> (channel in ('facebook_comment','instagram_comment')))` = 0 |
| 1     | No comment reply queued as email                          | `jobs` where `type='send_email'` joined to comment-channel messages = 0                                                                               |
| 1     | The SLA did not change under comments                     | Comment tickets created after 1.2 with a null `sla_policy_id` = 0, and the same policy mix as before the split                                        |
| 2     | Detector still writing                                    | `subcategorised` events in the last hour > 0 during traffic                                                                                           |
| 2     | Old names gone                                            | No `pg_class` relation named `ticket_categories%`, `conversation_categories%`, `category_metrics_daily%` or `ai_category_runs%` before Stage 3        |
| 3     | Registry seeded                                           | 3 active rows; every `route_group_id` resolves to a non-manual group                                                                                  |
| 4     | Classifier healthy                                        | `ai_category_runs` errors = 0; p90 message→run < 10 s; `unknown` share per channel; calls per ticket                                                  |
| 4     | Ownership honoured                                        | No `jev:category` event after a non-Jev `category_changed` on the same ticket, ordered by the stamped `created_at`                                    |
| 5     | Nothing stranded                                          | Tickets with `routing_window_ends_at` set, `routing_decided_at` null, and `now() > routing_window_ends_at + 10 min` = 0                               |
| 5     | Routes match categories                                   | `routing_decisions.outcome='category'` whose `to_group_id` ≠ the category's `route_group_id` at decision time = 0                                     |
| 5     | Routed means assigned                                     | `outcome='category'` tickets still unassigned N minutes after `decided_at`, broken down by group and strategy                                         |

## Risks not closed by the design

- **The evaluation rests on very few tickets.** Sales on Facebook DMs is
  about 70 classifiable tickets so far. The archive backfill in `record` mode
  helps, but merchant support may take months to reach 30 labels.
- **Sales versus merchant support is hard to tell from words.** An existing
  merchant asking about rates (`billing.pricing`) and a prospect asking about
  rates (`commercial.pricing_enquiry`) can write the same sentence, and no
  record tells them apart in production. Expect merchant support to be the
  weakest class until shipping accounts are linked.
- **Customer text goes to TypeSafe a second time per message.** The
  data-processing caveat recorded for canned suggestions
  (`docs/PROJECT-STATE.md`, the canned-suggestion section) applies, and needs
  an answer.
- **Two classifiers each run an `on_update` pass at creation.** A rule "group
  is Sales and priority is urgent" fires on whichever pass comes last. Rules
  are level-triggered, so the last pass sees both facts. The router's own pass
  is not a third, because the classifier that routed does not call
  `afterTicketUpdate` as well.
- **The webchat widget's open/closed line uses the channel's default group's
  calendar** (`lib/widget/session.ts:98`), before any category exists. On a
  `category` webchat channel it can disagree with the routed group's
  out-of-hours reply.
- **Inbound Sales Team reclaims after 10 minutes.** A routed sales ticket
  bounces back to the queue whenever its holder is offline for 10 minutes
  before the first reply. That is configured on purpose, but it is worth
  knowing.
- **Escalation counts from the ticket's creation, not from when it entered
  the group** (`worker/handlers/assign-sweep.ts:206`). A route lands within
  minutes, so this is harmless, but it is not exact.
- **A person can end a route by taking the ticket.** In working hours, an agent
  who opens a held ticket from "My groups" and assigns it ends the hold. The
  "Routing…" badge says what they are doing, and nothing stops them, which is
  deliberate: a person is never overruled.

## Questions for the support lead

Each one has the default this plan assumes, so work can start while it is
answered.

1. **"Categorised by Jev" means the new category** (sales / customer / merchant
   support). It does not mean making Jev's _subcategory_ answers live, which
   stay a shadow measurement. **Default: the new category only.** Promoting
   subcategories is a separate, argued change.
2. **The on-screen name "Category"** sits beside "Status category" in the rule
   builder. **Default: "Category", with "Status category" unchanged.** Arabic
   wording for both "category" and "subcategory" is also needed. Suggested:
   التصنيف for category and التصنيف الفرعي for subcategory. Today's handbook
   uses التصنيف for what becomes the subcategory, so this decides 2.A's
   handbook text.
3. **A fourth value for job applications, partnership and courier offers, and
   vendors.** Jev's shadow run found 11 such tickets on 126 Facebook DMs.
   **Default: no fourth value.** They answer `unknown` and stay in the
   default group. If "Other" is added later, its description must exclude
   greetings. Otherwise a greeting answered "other" would settle the ticket
   before its informative message arrives.
4. **The category and subcategories are independent.** **Default: yes.**
   Alternatively, each subcategory could carry a "usually" category to narrow
   the picker.
5. **Where each category routes, and when merchant support may route.**
   **Default:**
   - Sales → Inbound Sales Team
   - Merchant support → Merchant Care, routing only once its own evaluation
     gate is met; until then it stays in the default group
   - Customer support → Customer Care, or Support?

   What is Support for once those three are staffed?

6. **The hold window.** **Default: 5 minutes,** tuned from the shadow data.
7. **A person changing the category.** **Default: relabel only, with a
   one-click "move to <group>" offer,** including during the hold, which it
   ends. The alternative is an automatic re-route.
8. **Agents see their groups' tickets** (Stage 0.5). The permission is already
   granted to every agent role, and implementing it switches it on.
   **Default: keep it.** "No" means removing it from the `AGENT` role in the
   same PR. Without it, a routed ticket nobody is free to take is invisible to
   the group.
9. **Coexistence numbers stay on their default group.** **Default: yes,
   enforced.** They are answered on the phone.
10. **Messenger routes in shadow until the Freshworks swap**, and Instagram and
    the comment channels go live first. **Default: yes.**
11. **The comment channels:**
    - **Names.** **Default: "Facebook comments" / "Instagram comments".**
    - **Default group.** **Default: the same as their platform's, until you
      choose otherwise.**
    - **Out-of-hours replies on comments.** A reply there is posted publicly.
      **Default: never, unless a rule names the comment channel.**
    - **Existing rules and policies.** For each rule and policy that names
      Facebook or Instagram (1.2's inventory): should it also name the comment
      channel?
12. **Historic data.**
    - **Reports.** Rebuild them for the comment split from 2026-08-29.
      **Default: yes.**
    - **The open backlog.** Back-classify its category, without routing it.
      **Default: yes, after the shadow period.**
13. **The rename reaches the database, URLs, permission keys, the job name and
    the `CATEGORISE_*` variables, keeping stored history.** **Default: yes.**
    The cost is one maintenance window of a few minutes, off-hours.
14. **Who may change a ticket's category, and who manages the list.**
    **Default: every agent changes it; admins manage it.**
15. **SLA by category.** Policies can key on the category, and the policy is
    re-selected whenever the category is first set before the first response.
    Should Sales tickets get their own targets? And are the four existing
    policies restructured in Stage 0.2 as proposed?
16. **TypeSafe's data-processing terms** cover a second per-message call
    carrying customer text. **This needs a yes before 4.2.**
