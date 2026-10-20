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
  from a queued job. On production priority runs it arrives about 2 s after
  the message (p90 3 s, p99 6 s). An `on_create` rule therefore always sees no
  category.
- **The first message often says nothing.** On Facebook, five identical
  greetings of 10–13 characters open 137 of 248 DM tickets (55%), and each is
  followed by unrelated topics. The informative message is the second one at
  the median, arriving 0.3 min later, and at p90 it arrives 9.5 min later.
  Something has to wait for it without assigning the ticket first, and the
  engine has no way to hold anything.
- **`on_update` fires on every touch.** It runs on every customer reply, every
  sidebar edit and every applied priority answer, and it remembers nothing per
  ticket (`lib/automations/index.ts:38-42`). A rule "category is sales → move to
  Sales" moves the ticket back to Sales every time the customer writes, after
  an agent has deliberately moved it to Support.
- **A per-channel choice becomes rules multiplied by channels.** Three
  categories on five channels is fifteen rules to author. A typo in any of them
  silently leaves tickets in the default group, and nothing says why.

Making the engine able to do this means adding a hold, a fire-once trigger, a
fallback timer and SLA re-selection. That builds the routing feature inside the
engine, against the README's stated reason for keeping one engine. So the
initial route is decided once, by one tested module, from a channel setting and
a group named on the category's row. After that, the ordinary `on_update` pass
runs, and a rule can still say "sales on the merchant number goes to Merchant
Care".

The rest of this file covers what the research found, the decisions and what
each one rules out, the work in the order it has to ship, how each stage is
verified and rolled back, and the questions only the support lead can answer.

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
- **Assignment today happens almost entirely in the sweep.** Only 9 of 532
  tickets were assigned on arrival. The other 253 assignments came from
  `assign_sweep`, at a median of 40 hours, and none at all have happened since
  2026-10-07.
- **Only one group has members.** Support has 3 (admins). Merchant Care,
  Customer Care and Inbound Sales Team (created 2026-10-19) have 0. Nine of
  twelve active agents are in no group. An agent-role user sees only tickets
  assigned to them (`lib/tickets/visibility.ts:21-23`), and
  `ticket.view.group` is declared but never read.
- **The SLA policies cannot select by group.** Their group conditions compare
  `group.id` to group _names_ ("Merchant Care"), but the fact is a uuid, and
  the condition builder offers it as free text
  (`app/(console)/admin/field-options.ts:64`). Policy 1 is the default and sits
  at position 1, matching every chat channel, so policy 4 ("Live Support
  (Merchant Care)") is unreachable whatever the names say.
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
  `isCommentChannel` live in `lib/tickets/channel-policy.ts`, and the roughly
  25 `channel === 'facebook' || channel === 'instagram'` sites call them
  instead.
- **`carrierFor` becomes an exhaustive switch with no `default`.**
  `lint:strict` then refuses the next enum value that nobody routes.
- **Readers ship before writers.** That way no deployed code ever meets a value
  it does not know.

What must not move is listed in [Stage 1](#stage-1--comment-channels).

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
- **Step B — the database.** Tables, columns, indexes, constraints, the two
  enum types and `db/sql/002` are renamed, under a short maintenance sequence.

Step B has to happen, and before Stage 3: the new field wants the name
`ticket_categories`, and the name cannot mean two things. The deploy window is
real, because only the web service runs migrations and the worker and crons
deploy separately by hand (`render.yaml:286-288`). Old code meeting renamed
tables fails the whole ticket page, through `allLimited` in
`lib/tickets/conversation.ts:254-322`. It also silently skips categorising
every message ingested in the window, because the error is caught and there is
no backfill. The maintenance sequence avoids both: suspend the worker and
crons, deploy web (which migrates), deploy the worker and crons, then resume.
Webhooks keep landing in `webhook_events` the whole time, because receiving
them is the web service's job and processing them is the worker's.

Two traps in the migration tooling are fixed before Step B, not discovered
during it:

- **`drizzle-kit generate` passes CI without writing a migration.** It asks
  interactively about every renamed table and column, and without a terminal
  it prints "Interactive prompts require a TTY", writes nothing, and **exits
  0**. CI's drift step (`.github/workflows/ci.yml:135-144`) would therefore
  pass a schema rename with no migration. Stage 0 makes that step fail on the
  message.
- **The generated rename drops and re-adds every index and constraint.** With
  the prompts answered, the rename drops and re-adds the composite PK, every
  FK (to `conversations`, `messages`, `agents`) and every index, because their
  names derive from the table. The migration is generated at a TTY so the
  snapshot is right. Its SQL is then edited to
  `ALTER … RENAME CONSTRAINT` / `ALTER INDEX … RENAME TO`, which reaches the
  same end state with no lock beyond the instant of the catalogue change. The
  `--custom` flag is not used: it saves the _old_ snapshot, and every later
  generate would prompt again.

### 3. The new category is a registry row and a foreign key, like root causes

The design is a `ticket_categories` table shaped like `ticket_root_causes`:

- `key`: immutable, `sales`, `customer_support`, `merchant_support`. A CHECK
  holds it to lowercase letters and underscores; hyphens appear only in labels.
- `label_en` and `label_ar`, both required.
- `description`, which is the sentence Jev is shown for the option.
- `position`, `is_active` (retired, never deleted) and `is_system`.
- `route_group_id`, the group a ticket with this category goes to on a channel
  that routes by category. It is nullable, and null means "stay in the
  default group".

`conversations.category_id` is a single-valued foreign key with `on delete
restrict`, beside `root_cause_id`. Three alternatives were rejected:

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

A second call costs about 700 input tokens, roughly twice per ticket, on about
120 tickets a week.

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
  again (`lib/priority-ai/decide.ts:24-33` records the same lesson).
- **The first confident answer settles the category, and later messages leave
  it alone.** The category drives routing, and a ticket that changes teams
  mid-conversation is worse than one an agent relabels by hand. Settling also
  ends the calls: messages after it are not classified.
- **Only the requester's own words are classified.** A passer-by's "price?" on
  a comment thread must not turn a complaint into a sales ticket. This uses the
  requester-only rule priority already applies.
- **A cap per ticket.** No more than five classified messages, and none after
  the first agent reply. A ticket that has not settled by then is a person's
  call.
- **One threshold on the winner's share,** default 0.6, as for priority. It
  starts as a guess, and the shadow period is what calibrates it.
- **Every answer is a row.** The row records mode, prediction, the full
  distribution, outcome, latency, tokens and a `request_fingerprint`.
  - **Fingerprint:** a hash of the option keys, their descriptions and the
    instruction version. An admin editing a description changes the question,
    and a report must not average two questions.
  - **Baseline:** each row also records a free baseline beside the answer: the
    rules detector's subcategory mapped to a category, plus the channel row,
    any linked shipment and `requester_kind`. These are recorded, **not sent
    to Jev in v1**, so a disagreement between Jev and the baseline can be read
    as being about the text.

The mode is an admin switch (`off`, `shadow`, `apply`), stored in a one-row
settings table, not an environment variable. That is the canned-suggestion
precedent: production already holds `TYPESAFE_API_KEY`, so key-as-flag would
switch it on for every environment that has the key. Staging stays off because
its database says so. The key remains a precondition, shown on the page.

Every existing Jev request keeps its exact input across the comment split,
because `metaPlatformOf` maps a comment channel back to its platform in
`stateFor`. The priority request in particular stays byte-identical. The new
classifier is told `is_public_comment` explicitly.

### 5. Routing is a channel setting plus a hold, decided once by `lib/routing/`

`channels.routing_mode` is an enum column, not a config key, because
`saveChannel` rebuilds config by type:

| Mode              | What happens to a new ticket                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `default_group`   | Today's behaviour, and the default for every row.                                                                                |
| `category_shadow` | The ticket stays in the default group. The router records where it _would_ have gone.                                            |
| `category`        | Assignment and the out-of-hours reply are held until the category is settled or the window ends, and the ticket then moves once. |

`category_shadow` is per channel because the channels are at different points.
Messenger is read-only until the Freshworks swap, so routing it live moves
copies of tickets that somebody in Freshchat is answering. Instagram and the
comment channels are answerable today.

The decision lives in three pieces:

- `lib/routing/hold.ts` is pure: is this ticket waiting for a route?
- `lib/routing/decide.ts` is pure: route, keep, wait or fall back, and why.
- `lib/routing/apply.ts` takes the ticket's row lock, writes the decision, and
  after the commit re-selects the SLA, assigns, sends the held out-of-hours
  reply and runs the normal `on_update` pass.

The tests sit on the two pure files, where the decisions are. The rules:

- **Hold, do not reassign.** While a route is pending, `assignConversation`
  skips the ticket with a new reason, `awaiting_route`, and
  `maybeSendAutoResponse` skips it too. Neither writes to the timeline: a
  timeline entry per skip already produced 1,432 rows for 137 tickets. The
  alternative was to let the default group assign and then unassign on
  classification. It was rejected because it breaks "never overwrites an
  assignee" (`lib/assignment/index.ts:29-33`), and the ticket would appear in
  one agent's queue and then vanish. A hold placed in `assignConversation`
  also covers `assign_sweep` and the presence-triggered sweep at no extra
  cost.
- **The hold is computed, not stored, and it ends by itself.** A ticket is
  pending only while all of these hold:
  - its channel is in `category` mode;
  - the classifier is in `apply`;
  - the ticket has no routing decision and no assignee;
  - `created_at` + the window has not passed.

  Switching either setting off releases every held ticket at once. A
  classifier that is down cannot strand a ticket past the window.

- **A fallback job settles every ticket at the end of the window.**
  `settle_routing {conversationId}` is enqueued at creation with `runAt =
created_at + window` and dedupe key `settle_routing:<id>`. A key is spent for
  good, which is correct here, because routing is once ever per ticket. It
  routes on a category if one is settled, and otherwise keeps the default
  group. `assign_sweep` is the backstop, since the hold lapses on its own.
- **The window defaults to 5 minutes, adjustable from 1 to 30.** Of 257 short
  chat openers, 191 had a follow-up within 2 minutes and 195 within 10. The
  shadow period records when each ticket would have been decided, which is
  what tunes it. For context: today's median time to _assignment_ is 40 hours.
- **A route happens once, and only on a new ticket.** These leave
  `routing_decided_at` set, and nothing re-routes after it:
  - a continuation or a reopen never routes;
  - a person changing the group or assignee during the hold ends it (outcome
    `manual`);
  - so does a rule's `assign_group` or `auto_assign`, including `on_create`
    (outcome `rule`). A rule beats the router, as it beats the channel
    default today;
  - an agent reply or `opened_by_agent` ends it as well;
  - a ticket whose group is no longer the channel's default when the router
    runs is kept where it is.
- **The SLA policy is re-selected on a route made inside the hold, before any
  first response.** `onGroupChanged` deliberately does not re-select it
  (`lib/sla/index.ts:551-575`). That doctrine is about not retargeting a ticket
  an agent was already told about. A route inside the first minutes is still
  arrival, so the policy is chosen on the facts the ticket was routed with, and
  policies can key on `category`. The exception is narrow, and the doc comment
  says exactly where it applies.
- **The timeline says what happened.** It records a `routed` event naming the
  category, the group, Jev's probability and the outcome (`category`,
  `fallback`, `manual`, `rule` or `no_route_for_category`). Today
  `group_changed` says only "moved the ticket to another group".
- **An agent changing the category relabels the ticket and does not move it.**
  The sidebar then offers the move in one click ("Sales tickets go to Inbound
  Sales Team — move?"). An automatic move there would take the ticket away
  from the agent who just made the change. This is a
  [question](#questions-for-the-support-lead).

The settled design in `README.md:352-357` ("The routing rules are the automation
rules") is amended in the same PR, with the reasons at the top of this file. The
routing table is a lookup like `default_group_id` and holds no conditions, so
it is not a second engine. Rules still decide every exception.

**Coexistence numbers stay `default_group`.** Their replies are typed on the
phone, so moving one of their tickets to Sales changes nothing about who
answers it.

## The work, in the order it ships

Every PR follows `AGENTS.md`:

- It runs `typecheck`, `lint`, `lint:strict`, `test`, `knip`, `build` and
  `repo-rules` before pushing.
- Every new raw SQL fragment gets a `*.db.test.ts`.
- Every new job type gets an entry in `JOB_PAYLOADS` with a `z.strictObject`
  payload, a handler, a registration, and a line in `scripts/ci/db-jobs.txt`.
- Every new env var appears in `lib/env.ts` and `render.yaml` in the same
  commit.
- The docs that a change makes stale are updated in that PR.

No production service deploys itself, so every stage names its deploy order.

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
- **0.2 — Groups are chosen, not typed.**
  - The condition builder offers `group.id` as a choice of groups and stores
    the uuid (`app/(console)/admin/field-options.ts:64`). Every other group
    picker already does this.
  - The four production SLA policies are then fixed through the console. That
    is a production write, so it follows the `AGENTS.md` sequence: read the
    rows, say the change, have the way back. Fixing them means two things:
    - **uuids, not names**, in every group condition;
    - **an order that lets a group policy match.** Today policy 1 catches every
      chat ticket before policy 4 is reached, so policy 1 moves to the end or
      loses its channel branch.
- **0.3 — A group cannot be deleted out from under routing.** `deleteGroup`
  refuses while a channel or a form names the group as its default. Today
  both are `on delete set null`, and new tickets would silently land in no
  group and never be assigned. Stage 3 adds "or a category routes to it".
- **0.4 — Channel lookup is deterministic.** `channelFor`
  (`lib/tickets/ingest-meta.ts:575-583`) and `defaultEmailChannel`
  (`lib/tickets/ingest.ts:332-339`) order by `created_at`. Today a second row
  of a type makes the choice of default group, and from Stage 5 the routing
  mode, depend on the order the rows happen to come back in.
- **0.5 — An agent can see their group's queue.** `ticket.view.group` is
  implemented in `conversationVisibility`: an agent sees tickets assigned to
  them **and** tickets in groups they belong to. Agents get it by default, and
  the inbox gains a "My groups" view and a group filter.
  - **Why it is here:** routing into a group is only useful if the group's
    members can see what is in it. Sales tickets arriving out of hours, or
    while everybody is at capacity, wait unassigned, and today no agent-role
    user can see an unassigned ticket.
  - **Two cautions.** It is a visibility change across every page that lists
    tickets, so it gets a `*.db.test.ts` over the predicate. And the role
    default is a [question](#questions-for-the-support-lead).
- **0.6 — Staffing (operations, not code).** Agents need to be put into Inbound
  Sales Team, Merchant Care and Customer Care, and a decision made on what
  Support is for once those groups exist. Without this, every routed ticket
  waits with `no_group_members`, and each of those groups escalates after 60
  minutes to a named agent.

### Stage 1 — comment channels

**1.1 — Readers (no behaviour change).** Deploy web and worker; order does
not matter.

- The enum values go in through a one-line `ALTER TYPE … ADD VALUE` migration,
  following the precedent of `db/migrations/0004_tired_namora.sql`. Nothing
  else may use the values in the migration's own transaction (55P04).
- `channel-policy.ts` gains the helpers above. `CONVERSATION_CHANNELS` (which
  the compiler checks both ways) and `FILTERABLE_CHANNELS` list the two new
  values, and so does the hand-written union in
  `lib/tickets/inbox-filters.ts:16`.
- `carrierFor` becomes an exhaustive switch with no `default`. Comment channels
  go to `send_meta`. `sendsByEmail` follows.
- Every `facebook || instagram` site calls the helper. Among them:
  - reply-actions writes `meta.platform: metaPlatformOf(channel)`;
  - send-meta maps the channel to its platform;
  - `conversation.ts` keeps comment channels out of Meta thread state;
  - the composer, the header, `inbox-badges`, `meta-actions` and
    `canned-suggest`;
  - CSAT, which checks comments first so the skip still reads
    `comment_thread`;
  - every `stateFor` sent to Jev, mapped back to the platform.
- Labels and badges:
  - `ChannelBadge` entries for "Facebook comment" and "Instagram comment" use
    the platform's colour **and** the globe glyph public posts already carry,
    because colour is never the only signal.
  - `channelLabel` in `lib/format.ts`.
  - The condition builder's channel choices.
  - `AUTO_RESPONSE_CHANNELS`.
- **Auto-responses.** A rule scoped to "every channel" no longer matches a
  comment channel; only a rule naming that channel does. Today a company-wide
  out-of-hours reply would go out as a **public** comment reply
  (`send-meta.ts:431-436` infers `comment_reply`). The only row is inactive,
  so this changes nothing live and closes the trap before it opens.
- **The external id stays a safeguard.** The send path, the 24-hour guard and
  the CSAT skip keep their `rootCommentId(externalId)` test beside the new
  channel test.

**1.2 — Writers.** Deploy the worker, then web.

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
- **Backfill job `split_comment_channels`** (strict payload, `dryRun`). It
  moves existing comment tickets (52 today) to the new values. It sets
  `channel_id` to the comment row where one exists; 13 of the 52 have a null
  `channel_id` today because they predate the channel rows. It is idempotent,
  reports counts, and has a `*.db.test.ts`.
  - It runs only after 1.1 is deployed everywhere: dry run, then real.
  - Each moved row fires `notify_change` on both queue topics. That is
    harmless at this size.
- Then run `rollup_metrics from=2026-08-29`, so historic reports show the
  split. Its reconcile check (channel slices sum to totals) is the
  verification.

**1.3 — Lock the invariant.** A CHECK in `db/sql` (idempotent, guarded by
constraint name) enforces it: an external id matching `^(facebook|instagram):comment:`
if and only if the channel is a comment channel. The pair can then never
disagree again, and the three ways the code detects a comment today become one
answer.

**Must not change:**

- the comment-edge reply and `commentReplyTarget`;
- `send_meta` handling `comment_reply` and `private_reply` before it reads
  thread state, the window or `messagingTag`;
- the 24-hour guard's comment exemption;
- the CSAT skip;
- the external id format;
- webhook routing;
- contact identities;
- the priority request's bytes.

**Docs:** README.md (channels), `AGENTS.md` (the comment exemption wording, the
`HUMAN_AGENT` section), and the stale comment in
`lib/tickets/live-conversation.ts:19-23`. In `docs/PROJECT-STATE.md`, the
claim that no Instagram comment has ever arrived is wrong: 9 Instagram comment
tickets exist.

**Rollback.** An enum value cannot be dropped cheaply, and does not need to be.
Undo the backfill first with a reverse `UPDATE … SET channel = 'facebook'
WHERE channel = 'facebook_comment'` (and the same for Instagram), run as a
`SELECT` first. Then revert the code. Reverting the code while rows still hold
a comment value brings back the `carrierFor` email default; 1.1's exhaustive
switch is what makes that impossible to merge by accident.

### Stage 2 — the subcategory rename

**2.A — Code and UI (no migration).** Any deploy order.

- **Wording.** "Subcategory", in the sidebar block, admin pages, reports,
  review queue, shadow page, nav, error text and event-label sentences. The
  Arabic wording comes from the support lead.
- **Routes** move to `/admin/subcategories`, `/admin/subcategories/review`,
  `/admin/subcategories/shadow` and `/reports/subcategories`.
  - **Redirects.** `next.config.ts` serves permanent redirects from the old
    paths. There are no redirects today, and bookmarks exist.
  - **Revalidation targets.** The three `revalidatePath('/admin/categories/review')`
    call sites move as well: `lib/tickets/console-guards.ts:96`,
    `app/(console)/ticket-actions.ts:324` and
    `app/(console)/contacts/actions.ts:332`. A stale one passes CI and quietly
    stops the queue refreshing.
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
- **Job type.** `backfill_categorise_ai` becomes `backfill_subcategorise_ai`.
  It has 0 stored rows and no cron.
- **Env vars.** `CATEGORISE_*` becomes `SUBCATEGORISE_*`. `render.yaml` says
  they are "set nowhere". Read the Render dashboard on both services first,
  because a value set there under the old name would silently fall back to the
  default.
- **Events.** New writes use `subcategorised` and
  `subcategory_added|confirmed|rejected|removed`, with `subcategoryKey` in the
  event data and actor `subcategory-detector`. `event-labels.ts` reads both the
  old and new strings.
- **Handbook.** The `categorising` article's content changes but its key stays
  the same, then `seed_console_handbook overwrite=true` runs.
- **Docs.** `AGENTS.md` §"Ticket categorisation" and `docs/PROJECT-STATE.md`
  are updated. `plans/ticket-categorisation.md` and
  `plans/categorisation-through-typesafe.md` get a one-line historical note
  rather than a rewrite.

**2.B — The database (maintenance sequence).**

- **The migration** is generated at a TTY with the rename prompts answered.
  Its SQL is then edited to rename the derived constraint and index names in
  place rather than drop and re-add them, as described in decision 2. It
  renames:
  - `ticket_categories` → `ticket_subcategories`
  - `conversation_categories` → `conversation_subcategories`, with its columns
    `category_id` → `subcategory_id` and `category_key` → `subcategory_key`
  - `category_metrics_daily` → `subcategory_metrics_daily`
  - `ai_category_runs` → `ai_subcategory_runs`
  - the enum types `category_audience` and `category_review_state`. No SQL
    casts to these, so the enum rename is free.
- **`db/sql/002_categories.sql` becomes `002_subcategories.sql`.** It keeps
  its place in the replay order and handles both databases: on production it
  renames the six CHECK constraints if their old names exist, and on a fresh
  database it creates them under the new names.
- **Raw SQL with no database test is tested before merge.** These were never
  executed in CI: `categoryTotals`, `areaTotals`, `channelTotals`,
  `causeCoverage`, `ruleScores`, `categoryUsage` and `runLabels`. They get a
  `*.db.test.ts`, or one `execute_sql` each against a Supabase branch.
- **Verification before merge:**
  - CI's `database` job, which migrates an empty Postgres and replays
    `db/sql` twice;
  - a second `drizzle-kit generate` reports nothing to migrate;
  - the migration applied to a Supabase branch of production, then
    `\d conversation_subcategories`.
- **Deploy sequence:**
  1. Pick the time. Avoid 00:00 UTC, when `shipblu-nightly` runs the rollup,
     and off-hours suits it best.
  2. Suspend the worker and the crons.
  3. Deploy web, which runs the migration before traffic moves.
  4. Load a ticket page and `/admin/subcategories`.
  5. Deploy the worker and crons, then resume them.
  6. Watch for `subcategorised` events on new messages.

  Expected window: a few minutes of queued (not lost) webhook processing.

- **Rollback.** Before the worker resumes: redeploy the previous web and run
  the reverse rename migration, which is prepared and tested in the same PR
  but not merged. After the worker resumes, roll forward.

**Gate:** Stage 3 does not start until 2.B is deployed to web, worker and every
cron, and verified. After that, nothing running can read `ticket_categories`
expecting the old meaning, and the name is free.

### Stage 3 — the category field

**3.1 — Schema, admin and the ticket.** Deploy web, then the worker.

- **Schema.**
  - The `ticket_categories` registry, as described in decision 3.
  - `conversations.category_id` (FK `restrict`) and an index for the inbox
    filter.
  - The key-shape CHECK in `db/sql`.
- **Seeding.** `lib/categories/registry.ts` holds the starter set: three rows
  with English and Arabic labels and descriptions written for Jev. Being in
  code means the wording goes through review. `seed_ticket_categories` puts
  the set in idempotently, finding rows by key, and production runs it by
  hand, because deploys only run `db:migrate`
  (`docs/PROJECT-STATE.md` §6.30). `db/baseline.ts` seeds the same set for
  tests and development.
- **Admin.** A "Categories" page:
  - **Edit** labels, description, position, active flag and the route group.
  - **Add** a category.
  - **Retire** a category, never delete one.
  - **Permission.** It is gated by `admin.categories`, which is free after
    Stage 2.
  - `deleteGroup` also refuses while a category routes to the group.
- **The ticket.**
  - A Category select beside Group and Priority in the sidebar.
  - A badge in the header, because the sidebar renders only from `lg` up.
  - `ConversationDetail` carries the field.
  - A new `updateTicket` case writes the column and a `category_changed`
    event in one transaction, then runs `afterTicketUpdate`.
  - It is gated by a new permission, `ticket.set_category`, which agents get
    by default.
  - The new event string `category_changed` cannot collide with the old
    `category_*` history.
- **Rules.** A `category` fact (the key, or null) appears in the condition
  builder as a choice from the registry, never as text, for the reason 0.2
  exists. There is also a `set_category` automation action, so a rule such as
  "anything on the merchant number is merchant support" can set the category
  and be respected as owned.
- **Inbox.** A category filter axis, views, and a row badge.
- **Docs.** `AGENTS.md` gains a section next to the subcategory one: the
  routing-label framing, the ownership rules, and the reuse of the
  `ticket_categories` name after the gate.

**3.2 — Where a person sets it at creation.** Deploy web.

- A form gets `default_category_id`, recorded at creation as a
  `category_changed` by `form:<slug>`. Like `priorityChosenBy`, this is read at
  the time and never from the form as it stands later.
- The console's new-ticket form gets a category chooser, which counts as
  owned. Production has no forms today, so this can follow later without
  blocking anything.

### Stage 4 — Jev sets the category

**4.1 — The classifier, shipped off.** Deploy the worker, then web.

- **Code.**
  - `lib/category-ai/` (request, decide, run, enqueue, settings).
  - `lib/tickets/classifiable.ts`, extracted from priority, with priority
    switched to it in the same PR and its tests unchanged.
  - The `classify_category {messageId}` job (strict payload).
  - A `classify_category:<messageId>` dedupe key, queue priority 30.
  - An entry in `purge-jobs`' `messageJobTypes`.
  - A `skip:` line in `scripts/ci/db-jobs.txt`, since the job needs the
    provider.
- **Runs table.** `ai_category_runs`, which has a unique `message_id` and the
  same upsert-over-`failed` discipline as `ai_priority_runs`. Its name is free
  after the gate.
- **Settings.** `category_ai_settings` is a one-row table holding the mode, the
  threshold and the hold window, read through a 30-second memo. The
  "Categories" admin page shows the mode switch, the key's presence, and
  per-category readiness (route group, member count).
- **Wiring.** `afterMessageStored` enqueues the job in its own `try/catch`,
  beside priority's.
- **After commit.** An applied answer calls `lib/routing/apply.ts` once that
  exists in Stage 5 (until then, nothing), then `afterTicketUpdate`.
- **Tests.**
  - `decide.test.ts` covers every rule in decision 4, the greeting case
    included.
  - `run.db.test.ts` covers ownership, settling, the cap, the requester-only
    skip and the upsert.
  - A request test asserts the priority request is byte-identical to before.
- **Docs.** `lib/typesafe/client.ts` and `lib/env.ts`, whose comments list
  every TypeSafe user and so get a fourth entry; `docs/PROJECT-STATE.md`,
  which corrects "priority ships off"; and `AGENTS.md`'s AI-provider section,
  which says what this one may touch.

**4.2 — Shadow, then evaluate, then apply.** These are operations, not code,
apart from the report.

- Switch to `shadow` and leave it for at least two weeks. Every answer is a
  row; nothing is written to tickets.
- **Ground truth is made, not assumed.** Nobody has ever reviewed a
  subcategory (1 confirmed, 0 rejected), so the agreement report cannot wait
  for labels to appear on their own.
  - **Labels.** A supervisor labels a sample of at least 100 tickets across
    channels, using the Category select from 3.1.
  - **The report.** `/reports/category-ai` compares each run with that label
    and with the rules baseline: per channel, a confusion matrix, coverage and
    the share of `unknown`. It counts only runs with the current
    `request_fingerprint`.
- **Criteria to move to `apply`** (proposed): 90% precision on `sales` and
  `merchant_support` at the chosen threshold, on at least 30 labelled
  tickets each. The threshold is set from the report.
- **Optional backfill.** `backfill_category_ai dryRun=true`, then without it,
  over open tickets. It sets the category on the existing backlog, so the inbox
  filter and reports are useful, but **routes nothing**: 207 tickets sit
  unassigned today, and moving them is a staffing decision, not a side effect.

### Stage 5 — routing by category

**5.1 — The router.** Deploy the worker (which carries `settle_routing`) before
web, which queues it. An unknown job type retries rather than dying, but the
fallback would land late.

- **Schema.**
  - `channels.routing_mode`: an enum, `not null default 'default_group'`.
  - On `conversations`: `routing_decided_at`, `routing_outcome` (an enum:
    `category`, `fallback`, `manual`, `rule`, `no_route_for_category`,
    `kept_moved`) and `shadow_route_group_id` for `category_shadow`.

  These are columns and not events alone, because the hold is evaluated in
  `assignConversation` for up to 500 tickets per sweep and needs to be cheap.

- **`lib/routing/`.** `hold.ts`, `decide.ts` and `apply.ts`, as in decision 5.
  `apply.ts` is called from the category classifier after an applied answer,
  and from `settle_routing`.
- **`lib/tickets/lifecycle.ts`.** On a created ticket in a `category` or
  `category_shadow` channel, it enqueues `settle_routing` with `runAt =
created_at + window`. In `category_shadow` the job records
  `shadow_route_group_id` and the would-be outcome, and moves nothing.
- **The hold.** `lib/assignment/index.ts` gains the `awaiting_route` skip
  (kept out of `WORTH_RECORDING`), joining `channels` on `channel_id`; a null
  `channel_id` means `default_group`. `lib/auto-response/index.ts` also skips
  while pending.
- **SLA.** `lib/sla/` gains `reselectOnRoute`, which re-selects the policy and
  re-applies due dates. It only runs inside the hold before a first response,
  and its doc comment says why that is an exception to `onGroupChanged`'s
  rule.
- **Stamps that end the hold.** `routing_decided_at` is written by:
  - the console's group, assignee and agent-reply paths (`manual`);
  - the automation engine's `assign_group` and `auto_assign` actions
    (`rule`).
- **Timeline.** `event-labels.ts` gives the `routed` event a sentence naming
  the category, the group and the probability.
- **Admin.** The channel editor gets a routing-mode control. Every one of the
  three forms that post to `saveChannel` carries it, and an absent field means
  "unchanged" (the trap `forms.tsx:431-433` already guards). A readiness panel
  shows, per category, the classifier mode, the route group and its member
  count.
- **Tests.**
  - `decide.test.ts`: every outcome; `unknown` waits; the window expiring; a
    rule's move; an agent's move; an assigned ticket; `already decided`; a
    late Jev retry after the fallback settled the ticket. Priority-style
    10/40/90/160 s backoff can answer after the window, and that must keep,
    not re-route.
  - `apply.db.test.ts`: the row lock, the SLA re-selection, the held reply
    sent once, and `afterTicketUpdate` after the route.
  - An assignment test: `awaiting_route` covers the sweep.
- **Docs.** `README.md:352-357` is amended, with the reasons at the top of
  this file. `AGENTS.md` gets a "Routing by category" section with the rules
  above.

**5.2 — Turning it on, channel by channel (operations).**

1. Prerequisites: the Stage 0.6 groups are staffed and 0.5 is shipped.
   Classifier in `apply`, with category route groups set.
2. The Instagram DM channel and the comment channels go to `category_shadow`
   for a week. Read the would-be routes against the agents' own moves.
3. Then they go to `category`.
4. Messenger goes to `category_shadow` now, and to `category` the day of the
   Freshworks swap. Before the swap it would route copies of tickets that
   Freshchat agents are answering.
5. Email and webchat follow on the same evidence. The coexistence numbers
   stay `default_group`.

**Rollback.** Set a channel's mode back to `default_group`. The hold is
computed, so every held ticket is released at once, and the next sweep assigns
it in its current group. Already-routed tickets stay where they are, which is
correct.

### Stage 6 — reporting

- `metrics_daily` gains a category dimension: a fifth single-dimension slice
  and `byCategory` beside `byGroup`. This changes its unique index and the
  slice reconcile (`lib/reports/rollup.ts:171-190,533-559`), then
  `rollup_metrics from=` rebuilds history.
- Live open/awaiting by category beside `channelLoad`.
- `/reports/routing` shows routes by outcome, time to decision against the
  window, and fallback share per channel. Those are the numbers that say
  whether the window and the threshold are right.

## Verification queries (run after each stage, read-only)

| Stage | Question                                                  | Shape                                                                                                                                    |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Every comment ticket on a comment channel, and only those | `count(*) filter (where (external_id ~ '^(facebook\|instagram):comment:') <> (channel in ('facebook_comment','instagram_comment')))` = 0 |
| 1     | No comment reply queued as email                          | `jobs` where `type='send_email'` joined to comment-channel messages = 0                                                                  |
| 2     | Detector still writing                                    | `subcategorised` events in the last hour > 0 during traffic                                                                              |
| 3     | Registry seeded                                           | 3 active rows, every `route_group_id` resolving to a group                                                                               |
| 4     | Classifier healthy                                        | `ai_category_runs` errors = 0; p90 message→run < 10 s; `unknown` share per channel                                                       |
| 4     | Ownership honoured                                        | No `jev:category` event after a non-Jev `category_changed` on the same ticket                                                            |
| 5     | Nothing stranded                                          | Open tickets with `routing_decided_at is null` older than the window on a `category` channel = 0                                         |
| 5     | Routes match categories                                   | `routing_outcome='category'` tickets whose group ≠ their category's `route_group_id` (minus later manual moves) = 0                      |

## Risks not closed by the design

- **The evaluation rests on very few tickets.** Sales on Facebook DMs is
  about 70 classifiable tickets so far. The criteria in 4.2 say "at least 30
  labelled per category", and that will take weeks at current volume.
- **Sales versus merchant support is hard to tell from words.** An existing
  merchant asking about rates (`billing.pricing`) and a prospect asking about
  rates (`commercial.pricing_enquiry`) can write the same sentence, and no
  record tells them apart in production. Expect merchant support to be the
  weakest class until shipping accounts are linked.
- **Customer text goes to TypeSafe a second time per message.** The
  data-processing caveat recorded for canned suggestions
  (`docs/PROJECT-STATE.md`, the canned-suggestion section) applies, and needs
  an answer.
- **Two classifiers each run `afterTicketUpdate`.** A rule "group is Sales and
  priority is urgent" fires on whichever pass comes last. Rules are
  level-triggered, so the last pass sees both facts. It still means two
  `on_update` passes at creation, which `plans/priority-through-typesafe.md`
  already accepts for one.
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

## Questions for the support lead

Each one has the default this plan assumes, so work can start while it is
answered.

1. **"Categorised by Jev" means the new category** (sales / customer / merchant
   support). It does not mean making Jev's _subcategory_ answers live, which
   stay a shadow measurement. **Default: the new category only.** Promoting
   subcategories is a separate, argued change.
2. **The on-screen name "Category"** sits beside "Status category" in the rule
   builder. **Default: "Category", with "Status category" unchanged.** Arabic
   wording for both "category" and "subcategory" is also needed (suggested:
   التصنيف / التصنيف الفرعي).
3. **A fourth value for job applications, partnership and courier offers, and
   vendors.** Jev's shadow run found 11 such tickets on 126 Facebook DMs.
   **Default: no fourth value.** They answer `unknown` and stay in the
   default group, and "Other" can be added later from the admin page.
4. **The category and subcategories are independent.** **Default: yes.**
   Alternatively, each subcategory could carry a "usually" category to narrow
   the picker.
5. **Where each category routes.** **Default:**
   - Sales → Inbound Sales Team
   - Merchant support → Merchant Care
   - Customer support → Customer Care, or Support?

   What is Support for once those three are staffed?

6. **The hold window.** **Default: 5 minutes,** tuned from the shadow data.
7. **An agent changing the category.** **Default: relabel only, with a
   one-click "move to <group>" offer.** The alternative is an automatic
   re-route.
8. **Agents see their groups' unassigned tickets** (Stage 0.5). **Default: yes,
   for every agent role.** Without it, a routed ticket nobody is free to take
   is invisible.
9. **Coexistence numbers stay on their default group.** **Default: yes.**
   They are answered on the phone.
10. **Messenger routes in shadow until the Freshworks swap**, and Instagram and
    the comment channels go live first. **Default: yes.**
11. **The comment channels' names, default group, and whether an out-of-hours
    reply may ever be posted publicly on a comment.** **Default: "Facebook
    comments" / "Instagram comments", in the same group as their platform
    until you choose otherwise, and never public unless a rule names the
    channel.**
12. **Rebuild historic reports for the comment split** from 2026-08-29.
    **Default: yes.** Separately, back-classify the open backlog's category
    without routing it. **Default: yes, after the shadow period.**
13. **The rename reaches the database, URLs, permission keys, the job name and
    the `CATEGORISE_*` variables, keeping stored history.** **Default: yes.**
    The cost is one maintenance window of a few minutes.
14. **Who may change a ticket's category, and who manages the list.**
    **Default: every agent changes it; admins manage it.**
15. **SLA by category.** Policies can key on the new category once Stage 5
    re-selects them on a route. Should Sales tickets get their own targets? And
    are the four existing policies restructured in Stage 0.2 as proposed?
16. **TypeSafe's data-processing terms** cover a second per-message call
    carrying customer text. **This needs a yes before 4.2.**
