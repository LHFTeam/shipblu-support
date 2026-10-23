# A WhatsApp number that belongs to a person

> the way our team works is that a member may get a whatsapp business number
> assigned to them, and once they do, they are responsible for that number. if a
> merchant sends a message to one team member and then another, they should be
> treated as different tickets, and only the person responsible for that number
> is accountable for that sla breach

That is the requirement, as it was asked. Earlier the same day came a question
it depends on: on a ticket, how do you tell which of our numbers it is on?
Nothing showed it.

Three changes follow from it, and this work makes all three:

1. **WhatsApp threads on the customer and our number**, not on the customer
   alone, so a merchant writing to two team members has two tickets.
2. **A number has an owner, and a ticket on it is the owner's to answer for.**
   The ticket records whom its SLA counts against, beside who is working it, and
   every report reads that.
3. **The ticket page names the number** and who is accountable.

## What production held

Read on 2026-10-21, read-only.

- Four WhatsApp rows: "WhatsApp Customer Bot" (`whatsapp_bot`), "WhatsApp
  Support" (plain Cloud API), and two coexistence numbers. "ShipBlu Admin"
  (+20 10 40204380) had no tickets. "Nayera Mohamed" (+20 12 78707918) held 89
  open native tickets, 8 resolved and 47 copied histories, every one unassigned.
- Nayera is an `agent`, active, not accepting tickets and in no group. 84 of the
  89 sat in `Merchant Care`, which has no members, so the rota could never reach
  her: their timelines held 1,220 `assignment_skipped` events, and 24 had
  breached their first response.
- Threading was on the person (`findLiveConversation(contactId, 'whatsapp')`). It
  had not yet mixed two numbers on a live ticket, because no customer had
  written to two numbers while a ticket was open (`docs/PROJECT-STATE.md`
  §6.99). Every number connected makes that likelier.
- Four contacts held two live tickets each on Nayera's number, created 36–121 ms
  apart: a race between finding the live conversation and inserting one (§6.100).
- Four `whatsapp` tickets had a null `channel_id`, all filed before "WhatsApp
  Support" had a row.
- Reports filed SLA met and breached under `conversations.assignee_agent_id` at
  rollup time (`lib/reports/rollup.ts`).
- The SLA policies compare `group.id` with group _names_, so none matches on
  group. That is configuration, and is left to the team
  (`docs/PROJECT-STATE.md` §5.1).

## Decisions taken with the person who asked for it

Each was put as a question with the alternatives below, and answered.

1. **Reassignment moves only the work.** The number's owner stays accountable
   for a ticket's SLA whoever it is reassigned to. "Unassign" on an owned ticket
   hands it straight back to the owner while they are active. The owner can
   always see the tickets on their number and the tickets they are accountable
   for. Reason: the requirement says only the person responsible for the number
   is accountable. Only the phone can answer a WhatsApp ticket — the console
   does not reply on WhatsApp (LHFTeam/shipblu-support#357) — so handing an
   unassigned owned ticket to the rota gives it to somebody who cannot answer
   it. And an owner who cannot open a ticket would be measured on work hidden
   from them.
2. **A handover moves the open and pending tickets now.** That covers a first
   owner, a change of owner, and cover for leave, which is a handover and a
   handover back. The number's open and pending native tickets become the new
   owner's to answer for, and their assignee moves too where the previous owner
   or nobody held them. A resolved ticket follows only if its customer writes
   again — or, as review added, when an agent or a rule reopens it first, since
   the customer's next message then continues an open ticket and would never
   move it. Closed tickets and copied history stay where they are. Every handover
   is recorded. Reason: the chats go with the phone, so the previous owner
   cannot stop a breach on a ticket still in progress. Finished work keeps its
   history, which also leaves the last three days of resolution figures where
   they were.
3. **A deactivated owner stays on the number and counts as nobody.** New
   tickets and reopens treat it as a team number: the group's rota assigns, and
   a breach counts against whoever holds the ticket. The tickets the owner
   already had stay with them until an admin hands the number over.
   Reactivating them undoes it. Reason: it can be undone, it never blocks an
   urgent offboarding, and it is how deactivation treats every other reference
   to an agent. `/admin/channels` shows a warning, which is what prompts the
   handover. Asked in review whether those tickets' breaches should show on
   the live board under the colleague working them instead, the team kept them
   with the owner: the business process is to hand a departed owner's number
   to a new owner straight away, so the gap is short, and one person stays
   accountable on the board and in the report alike.
4. **Breaches count against the owner from the day ownership is set.** There
   is no historical rebuild. Reason: the requirement starts accountability
   "once they do" own the number. With the policies misconfigured today,
   charging past days would record that misconfiguration as her performance.
   The nightly rollup rebuilds three days, and it reads accountability as of
   each figure's own instant (`accountableOrAssigneeAt`), so a handover does
   not re-file the days before it onto the new owner.

## Shape

| Piece                                                                       | Where                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| The thread key, the finders, the lock                                       | `lib/tickets/live-conversation.ts` — `ThreadKey`, `lockThread`             |
| Threading and stamping at ingest                                            | `lib/tickets/ingest-whatsapp.ts` — `threadKey()`, `resolveWhatsAppChannel` |
| Tickets filed before their number had a row                                 | `db/sql/009_whatsapp_channel_backfill.sql`                                 |
| The columns and the record                                                  | `db/schema/config.ts`, `db/schema/conversations.ts`, migration 0044        |
| Only a WhatsApp row (plain or coexistence, never the bot) may have an owner | `channels_owner_only_whatsapp`, `db/sql/003_constraints.sql`               |
| Every write of ownership and accountability                                 | `lib/whatsapp/number-owner.ts`                                             |
| The owner outside the rota                                                  | `assignConversation`, `lib/assignment/index.ts`                            |
| The reclaim exemption                                                       | `reclaimAbandoned`, `worker/handlers/assign-sweep.ts`                      |
| Whose breach it is                                                          | `lib/tickets/accountable.ts` — `accountableOrAssignee()`                   |
| Reports, live board, hourly sample, the event                               | `rollup.ts`, `live.ts`, `snapshot-backlog.ts`, `sla-sweep.ts`              |
| Who sees what                                                               | `lib/tickets/assignment-scope.ts`, `visibility.ts`, `inbox-views.ts`       |
| The ticket page                                                             | `lib/tickets/conversation.ts`, `header.tsx`, `sidebar.tsx`                 |
| The line under "Accountable"                                                | `lib/tickets/accountable-note.ts`                                          |
| The handover                                                                | `setNumberOwner` and `OwnerEditor`, `app/(console)/admin/channels/`        |
| The timeline's words                                                        | `lib/tickets/event-labels.ts`                                              |

## Threading on the number

`ThreadKey` is `{ channel: 'whatsapp'; channelId }` for an ordinary number, and
the person alone for the widget and the bot. One private `threadConditions()`
builds the statement for both finders, so the live conversation and the newest
one cannot be asked of different keys. The widget's and the bot's SQL is
exactly what it was, pinned by `live-conversation.test.ts`. All 68,474 bot
conversations already sit on the bot's row, so keying the bot on it too would
have changed nothing but the diff.

A null `channel_id` matches only another null. A wildcard would let a ticket
with no row take its customer's messages to every number, which is the bug the
key exists to close. The four tickets that had one were placed by
`db/sql/009`: each gets the `whatsapp` row of its newest inbound, non-reaction
message that names one. It is driven from the tickets still null, so its replay
on every deploy reads only those, and a second run changes nothing.

The message, the echo and the reaction all build the key through one
`threadKey()`. The message and the echo take `lockThread` first, and then look
for the live conversation inside their transaction (§6.100). The reaction takes
no lock, because it never creates a conversation.

`resolveWhatsAppChannel`'s fallback, for a number no row names, now files the
event under no row, borrowing only a row's default group — the plain support
row's, else the first WhatsApp row's, so a deployment with no plain row still
routes it. With
the row in the key, a coexistence row's id would land an unknown number's
traffic on somebody's phone, its tickets and their clocks. The support row's id
was the first version, and review found it inconsistent: ingest stamped nobody,
while visibility, a handover and a reopen by hand — all keyed on `channel_id` —
treated the ticket as the support owner's. Under no row it is nobody's on every
path. Once its number's row is added, the customer's next message continues
it and files it under the row (`findOrAdoptLive`) rather than opening a second
ticket beside it, and `db/sql/009` places any left on the next deploy — under
active rows only, since the resolver threads on nothing else. Each message so
filed logs `[whatsapp_ingest] no channel row for this number, filed under no row phone_number_id=…`, with its key last as every
`logger` line has it; an echo on such a number, which ingest ignores, logs
nothing.

Everything that was already per number is now right per ticket with no change
of its own: `sendingNumberFor`, the 24-hour window, `send_whatsapp`,
`automatedReplyBlocked` and an echo's `onAgentReply`.

## Two columns, and who writes them

`channels.owner_agent_id` is who owns the number now. It is a column rather than
a key in `config` for two reasons. It is a foreign key, so a deleted agent does
not leave an id that resolves to nobody. And `saveChannel` rebuilds a plain
number's `config` on every edit, so a rename would drop it.

`conversations.accountable_agent_id` is whom the ticket's SLA counts against.
It is frozen onto the ticket rather than read off the number when a report runs.
Ownership changes, and `rollup_metrics` rebuilds the last three days from
current state, so a live read would re-file the days before a handover onto
somebody who did not hold the phone then. Null means nobody owned it: a team
number, a deactivated owner, any other channel, or a ticket from before owners
existed. Reports then fall back to the assignee, exactly as before.

Both are written only in `lib/whatsapp/number-owner.ts`. A ticket's
accountability is set or moved at three moments:

- **Ingest creating a ticket on an owned number.** `lockedOwnerId` reads the
  owner inside the ingest transaction, under `FOR KEY SHARE` on the channel row.
  That is the lock the ticket's own foreign key check takes anyway, and it waits
  only for a handover's `FOR UPDATE`. `ownerStamp` then puts the owner in the
  insert as both assignee and accountable. This covers a ticket the business
  opened from the phone, too, which is created resolved and never reaches
  assignment. `recordOwnerAssigned` writes the `assigned` event.
- **`handOverNumber`**, in one transaction. It locks the channel row, refuses
  any type but `whatsapp` and an unknown or deactivated agent, and does nothing
  for a no-op. Then it selects the number's open and pending native tickets
  `FOR UPDATE`, through a status subquery so the status rows stay unlocked. It
  moves accountability on all of them, and the assignee where the previous owner
  or nobody held the ticket. It writes `accountable_changed` and `assigned`
  events and one `channel_owner_changes` row with both counts.
- **`alignAccountable`**, when a ticket comes back out of resolved or closed
  and the number has changed hands since. It runs inside `reopenWithOwner`,
  which every status writer goes through: `changeStatus`, the `set_status`
  action and `reopenResolved`, which every customer's reopen uses — WhatsApp,
  the portal and any later path. Review moved it there from four call sites,
  each of which had been found missing in turn: a ticket an agent reopened by
  hand was then continued by the customer's message as an open ticket, which
  never realigns, so it stayed with the previous owner for good. It realigns
  only when the write happened, and is a no-op on nearly every reopen.

Nothing else writes accountability: not assignment, reclaim, a supervisor's
reassignment, an automation or a merge. That is what lets a reassignment move
the work and leave the breach where it was.

The events carry no `actorAgentId`. The agent rollup counts every event an
agent acted in as a ticket they touched, and an admin handing over ninety
tickets has worked none of them. The admin is named in `data.by` and in the
record. `channel_owner_changes` is append-only, with a bare `channel_id` and the
names frozen beside each agent's foreign key. It still answers "who owned this
number on the day it breached?" after the channel, the agents and any purged
ticket are gone.

## The owner and the rota

`assignConversation` checks the owner after `already_assigned` and
`not_assignable`. An unassigned ticket whose accountable agent is active goes
straight back to them. The write is conditional on `assignee_agent_id is null`,
and it does not ask about the group, its strategy, its hours, or the owner's
presence, capacity and skills. Every one of those gates measures who is at the
console, and the owner answers from the phone with it closed. The group's
round-robin cursor does not move. A caller that named a group, an `auto_assign`
rule, still moves the ticket there first, through `moveToGroup`. That function
is shared with the rota and applies only if the group still exists. This is how
"Unassign" hands an owned ticket back in the same request:
`afterTicketUpdate` → `autoAssign` → `assignConversation`.

The sweep's `assignWaiting` inner-joins routing groups, so it never sees an
owned ticket in no group or in a manual one. It does not need to: ingest stamps
the ticket, and "Unassign" hands it back at once.

`reclaimAbandoned` never takes a ticket from an active owner who holds their own
number's ticket. Presence says nothing about somebody answering from a phone,
and reclaiming would only hand the ticket back to them. A deactivated owner's
tickets, and an owned ticket held by somebody else, are reclaimed as before.

## Reports, the live board and the sample

`accountableOrAssignee()` is `coalesce(accountable_agent_id,
assignee_agent_id)`, and every reader that says whose breach a ticket is reads
it:

- the four agent reads in `computeDay` — created, first response, resolved and
  reopened — as `accountableOrAssigneeAt(instant)`: the `from` of the first
  `accountable_changed` event after the figure's instant, and the column when
  nothing moved it since. Read from the column alone, a handover on Tuesday
  re-filed Monday's late answer onto the new owner when Tuesday night rebuilt
  Monday;
- the live board's Breached, in `agentLoad`;
- `agent_backlog_snapshots.breached_count`;
- `sla_breached.data.accountableAgentId`, read by the same `UPDATE` that sets
  the flag.

So the dashboard and the next morning's report name one person. Breached on the
board and in the sample comes from one grouped subquery, `breachedByAccountable()`,
joined onto `agents`. No index serves the `coalesce`, so a correlated count per
agent would walk the backlog once for every agent, on a page that refreshes
every twenty seconds.

What somebody is carrying stays on the assignee: Open, Awaiting reply, the
oldest wait, and the capacity check. Breached can therefore exceed Open, and the
copy beside it says so. The agents CSV's `resolved_while_assigned` column is
renamed `resolved_accountable`: it now counts resolutions accountable to the
agent as well as those they held, and its old name would have been read in the
old sense. The team confirmed nothing reads the export by that header yet. The
hint on `/reports/agents` says what it counts.

## Who sees what

`heldByOrInGroupsOf` ORs in `answerableBy(agent)` on both of its branches:
accountable to them, or on a channel they own. The inbox list and counts, the
ticket page, the console guards, the attachments route and the shipment read
model all read that one predicate, so they all inherit it. The halves cover
different tickets. The number's half covers what arrives on it now, including
its copied history, which nobody is accountable for. The accountable half covers
a ticket that stays theirs after the number moves on.

An agent in no group used to be offered Mine alone, since their Unassigned was
always empty. The shell now asks `ownsANumber`. An owner in no group is offered
Unassigned and All open, and their bare inbox reads as All rather than Mine.

## The pages

**The ticket.** The header carries a neutral badge reading "Our number: <name>
(<number>)" on every width. The header is the one place that tells a customer's
two tickets apart on the phone the owner answers from, and the sidebar is
desktop-only. The display number comes from `parseCoexistence(config)`, and
`config` never reaches the client.

Above Assignee, the sidebar has a read-only "Accountable" field. It shows the
name, or "Whoever holds it", with an `InfoTip` stating the rule and a
"Deactivated" warning badge where it applies. Below it, `accountableNote` adds a
line when the ticket's frozen agent and the number's current owner tell
different stories. Examples: a resolved ticket from before a handover, a
deactivated owner, a team number whose ticket still names a former owner. It
compares by id, because production has two active agents with one name.

**The channels page.** Each WhatsApp row, plain or coexistence, gains a line: "Owner: <name>" or
"Team number", an "Owner deactivated" warning, "since <date>, set by <admin>",
and the earlier owners in a `<details>`. Then `OwnerEditor`'s Set owner /
Change owner opens a form: a select of "Nobody — team number" and the active
agents as "name — email", a hint that says how many open and pending tickets
will move, and a `ConfirmSubmit` reading "Hand over with N tickets?". It is a
form of its own, posting to `setNumberOwner` behind `admin.channels`.
`numberOwnership()` feeds the whole line from one read, so the badge, the
"since" and the count cannot disagree. Its `current` is the newest record only
while that record still names the row's owner. An owner written by hand, or
deleted since, would otherwise get a false "since".

## Alternatives rejected

- **Accountability follows the assignee.** This needs no new column, but it
  makes a reassignment move the breach, which is the opposite of the
  requirement.
- **Reading the number's current owner at report time.** The rollup rebuilds
  three days from current state, so a handover would re-file the days before it
  onto the new owner.
- **"Unassign" leaving an owned ticket to the rota.** The rota can only pick
  console agents, and none of them can reply on WhatsApp.
- **At a handover, moving every live ticket, resolved ones included.** That
  moves breaches that already happened, and rewrites finished work the rollup
  may still recompute.
- **At a handover, moving only tickets created after it.** That leaves the 89
  open tickets with somebody who no longer has the phone.
- **Deactivating an owner clears their ownership, or is refused until the number
  is handed over.** The first cannot be undone by reactivating them. The second
  blocks an urgent offboarding.
- **Rebuilding the reports since the owner was set.** It would charge
  breaches measured against misconfigured policies.
- **The owner as a field `saveChannel` reads.** Three forms post to that action,
  and each would have to carry the owner through: a rename would be one
  forgotten hidden field away from moving ninety tickets. The editor also holds
  a text box, and `ConfirmSubmit` must not share a form with one.
- **The owner as a key in `channels.config`.** There is no foreign key, and
  `saveChannel` rebuilds the object.
- **A null `channel_id` matching any number**, and **the fallback keeping its
  last-resort coexistence row.** Each would thread one number's traffic onto
  another's tickets.
- **Leaving the race for later.** Under ownership, each duplicate is a breach
  charged to the owner for a reply that was sent.
- **A session advisory lock, or a row lock.** The transaction pooler hands the
  backend on when each transaction ends. The row to lock does not exist yet.
- **Reading the owner before the ingest transaction.** A message arriving during
  a handover was stamped with the previous owner after the handover had already
  selected the number's tickets. Nothing could correct it, because handing the
  number to the person who already owns it is a no-op. The race test reproduces
  it.
- **Joining `agents` in the locked owner read.** A table joined to the locked
  row and not itself locked keeps the version the first look found. After
  waiting for a handover, the new owner read as nobody.
- **Handover events with the admin as actor.** Every handed-over ticket would
  count as one the admin touched that day.
- **A correlated count per agent for the live Breached.** See above.
- **Renaming the CSV column.** It breaks anybody reading the export by header.
- **Changing the bot's key.** It changes nothing in production and widens the
  diff.

## Not done, deliberately

- An inbox filter by number, "Numbers" views, and a number on each inbox row or
  in the contact's ticket table. The header badge and the visibility rule meet
  the requirement; these are a follow-up if the team asks.
- `from` on reassignment events, and counts of transfers.
- Changing the first-response read for tickets the business started (below).
- Any production write. The steps are in `docs/PROJECT-STATE.md` §5.1.

## Known gaps

These are in `docs/PROJECT-STATE.md` §5.5 with their detail:

- Next-response breaches are recorded nowhere: the sweep finds first-response
  and resolution breaches only.
- A conversation the business starts from the phone gets no SLA policy
  (LHFTeam/shipblu-support#352).
- Such a conversation reads as a 0-second first response, which now lands in
  the owner's slice.
- A breach from before a handover is measured against the new owner, on the day
  the ticket is answered.
- Deleting a channel row strands its tickets' thread until `009` can place them
  again.

## Deploying it

- Migration 0044 adds `channel_owner_changes`, a column and a foreign key on
  `channels` and on `conversations`, and an index. Drizzle applies a deploy's
  migrations in one transaction, so `conversations` is held `ACCESS EXCLUSIVE`
  until its key has validated every row. They are all null, so it is short.
  Check for a held lock first (§5.5's `pg_stat_activity` query). Deploy web
  first, for the migration, then the worker.
- Migration 0045 adds `conversations_accountable_idx`, partial on a non-null
  `accountable_agent_id`. Every restricted agent's visibility ORs
  `accountable_agent_id = me` beside indexed arms, and Postgres combines an
  OR's arms only when each has an index; without it the inbox, its counts and
  the stream's authorisation scan the whole table on every render. It is built
  in the same transaction, over a column that is all null, so it is quick.
- `db/sql/003` adds the CHECK, and `db/sql/009` places the null tickets. Both
  replay on every deploy and change nothing the second time. `db/sql/001`'s
  queue trigger now also fires on `accountable_agent_id`, so a handover that
  moves only accountability refreshes the new owner's inbox live.
- Rolling back the code leaves the columns and the table unread, and every
  report falls back to the assignee. Undoing a handover is a handover to
  "Nobody — team number": accountability clears, and the assignees keep what
  they hold.

## How it was verified

Locally, against Postgres with the migrations and `db/sql` applied:

- **Unit tier.** `ThreadKey`'s SQL, with the widget's and the bot's unchanged;
  `effectiveOwnerId` and `ownerStamp`; `handoverNotice` in each case;
  `accountableNote`; the timeline's wording; and the inbox views for an owner in
  no group.
- **Database tier.**
  - Threading: two numbers give two tickets; an echo and a reaction stay on
    their own number; and four customers' inbound messages and echoes at once
    give four tickets. With the lock removed, the same test gave seven or eight,
    every run.
  - `009`: the right row each time, never the bot's, and idempotent.
  - The CHECK, and the foreign keys going null when an agent is deleted.
  - `handOverNumber`: what moves and what does not; both events with no actor;
    the counts; the refusals; the no-op. A computed agent day gives the admin no
    touched tickets.
  - Stamping at ingest; the reopen after a handover; and a handover racing a
    message, where the message takes the new owner.
  - The owner's branch in `assignConversation`, with and without a named group,
    and the reclaim exemption.
  - Every reader of `accountableOrAssignee()`: the rollup, the board, the
    sample and the event.
  - The visibility arm through every reader, before and after a handover.
  - `getConversation` never shipping the number's ids.
  - `setNumberOwner`'s permission, refusals, notice and revalidation.
- **Negative controls.** Each guard was removed in turn and a test failed every
  time:
  - the lock;
  - the CHECK;
  - the reclaim exemption;
  - the owner branch;
  - the reopen alignment;
  - a handover's events with no actor;
  - `FOR KEY SHARE` on the owner read;
  - `accountableOrAssignee()`, made to return the assignee alone;
  - each half of the visibility arm;
  - the owner's inbox views;
  - the type filter in the ticket page's join;
  - `revalidatePath`.
- **In a browser.** Production builds were served locally:
  - `/admin/channels` drew an owned number with its history, a deactivated owner
    and a team number.
  - The ticket page was checked in Chromium at 320, 375 and 1440 px. There was
    no horizontal overflow. A long number name truncated while the number stayed
    whole. Neither the page's HTML nor its RSC payload held the phone number id,
    the WABA id or `onboardedAt`.
