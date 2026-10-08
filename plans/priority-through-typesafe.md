# Ticket priority through TypeSafe

`conversations.priority` has four levels, every SLA policy prices its targets per
level, and nothing sets it. Measured against production on 2026-10-07: of 273
non-bot tickets, 272 are `medium` — the column default — and one is `high`. One
`priority_changed` event exists in the whole archive. No automation rule mentions
priority. So the SLA's per-priority table, which in production gives a high or
urgent ticket a first response in half the time a medium one gets (1 minute
against 2 on live support, 60 against 120 offline), has never once applied
anything but its medium row.

This asks TypeSafe's Jev — already called by the shadow categoriser — how urgent
each inbound customer message is, and writes the answer when it is confident and
nobody else has chosen the ticket's priority.

## Why this one writes, when the categoriser does not

`plans/categorisation-through-typesafe.md` keeps every answer in its own table
because `conversation_categories.confidence` is an evidence grade, and a
probability written beside it would be two quantities in one column that three
screens explain as a third. Priority has no such neighbour: the column is a
level, and the level is the whole of what is written. The probability goes on
the run row and on the timeline event, where it is labelled as one.

What priority does have is people. An agent can set it, a rule can set it, a
form can default it, an agent opening a ticket chooses it. An automated writer
of the same column has to lose every one of those arguments, and has to do it
without a column that records who won — `conversations.priority` does not say
who set it. Those rules are `lib/priority-ai/decide.ts`, which is pure, and its
tests.

## The rules, and what each closes

- **Somebody else's priority is never touched.** Any `priority_changed` event not
  written by the classifier, or an `opened_by_agent` event. A form's default
  priority, or a customer's answer to a form's priority question, is recorded as
  a `priority_changed` by `form:<slug>` when the ticket is created — the form is
  not read as it stands now, or a default added later would claim every ticket
  the form had ever filed. And because anything else that writes the column
  without an event is still somebody's choice, the classifier also refuses
  whenever the column does not hold what it expects — what it last wrote, or
  `medium` if it never has. The check runs inside a transaction holding the
  ticket row `FOR UPDATE`, so an agent's change cannot land between the read and
  the write.
- **A threshold, on the winner's own share.** `PRIORITY_AI_MIN_PROBABILITY`,
  default 0.6. It is a guess: there was nothing to calibrate it against, which is
  the next point.
- **Down only on the opening message; up at any time.** The answer to the
  customer's first message may set any level, `low` included. Later messages may
  raise it and never lower it — the customer who threatened legal action and
  then wrote "ok" is still the customer who threatened legal action. The first
  draft said "the first _confident_ answer", and review found what that does: a
  real complaint splits its probability between urgent and high and falls below
  the threshold, while "thanks" is the most confident answer a four-way
  classifier gives, so the first confident answer was most often a `low` for
  content-free text. Lowering is a judgement about the whole ticket, and only
  the opening message is the whole ticket.
- **Autoresponders and bounces are skipped.** Neither is the customer, and a
  bounce's "delivery failed: permanent error" reads as urgent to anything not
  told what it is. Not the broader `isAutomated` flag: a `List-Id` header sets
  it, so a merchant writing from a Google Group carries it, and a skip writes no
  run row that would show the gap.
- **"Opening message" is judged by evidence as well as by timestamp.** Jobs run
  concurrently and retry out of order, so the opening message can be answered
  after a later one has already raised the ticket. Lowering therefore also
  needs no other message on the ticket to have set or confirmed its level yet —
  `applied`, `would_apply` or `unchanged`. Not `not_raised`: a later message
  refused the lowering it asked for moved nothing, and counting it made the
  opening's answer depend on which job ran first. The timestamp test is `<=`
  and not `<`, because WhatsApp stamps a message to the whole second: in a
  burst sharing one, no message is the opening, so none may lower.
- **A photo or voice note with no words is not asked about.** Ingest stores it
  as our own label — `[image]`, `[voice note]`, `[2 attachments]` — and the
  model, told to answer `low` for a message too short to judge, did; on an
  opening message that lowered a ticket whose photo might be of the damaged
  parcel. It still counts as the opening, so the words after it only raise.
- **Only the ticket's own customer is asked about.** On a public comment
  thread anybody may reply under the customer's comment, and ingest files the
  reply on the customer's ticket; a passer-by's threat would otherwise raise it.
  A colleague copied on an email is left out by the same rule, and their
  earlier messages are left out of the context sent as the customer's.
- **`low` is the answer for a message too vague to judge.** The categoriser
  offers `meta.unclassified` for the same reason: most of this archive is a
  22-to-39 character fragment, and a model with no way out pushes "؟" upwards.
  Under-ranking costs little, because a later message can still raise it.

## Every answer is recorded

`ai_priority_runs` holds every answer, applied or not, with the full
distribution and an `outcome`: `applied`, `would_apply` (shadow), `unchanged`,
`not_raised`, `below_threshold`, `set_by_person` or `failed`. There were no
labelled tickets when this shipped, so these rows are the first: an `applied`
row followed by an agent's `priority_changed` on the same ticket is a
disagreement, and the threshold is tuned from those.

A `failed` row is a gap rather than an answer: the job's dedupe key is spent, so
after a wrong key is fixed the message is re-run by hand
(`npm run job -- classify_priority messageId=…`), and its first real answer
replaces the failure. A purge cancels the job if it is still pending.

Shadow mode weighs each answer against its own last `would_apply` as though it
had been written. Otherwise every later message on a shadowed ticket is compared
with `medium`, and the shadow measures a classifier that cannot ratchet — not
the one `apply` turns on.

## The SLA follows the priority — every writer's, not only this one's

Due dates were computed once, in `applySlaOnCreate`, and nothing recomputed them
when priority changed later. An agent raising a ticket to urgent changed the
badge and kept medium's deadline, and the classifier's answer would have done
the same. `onPriorityChanged` in `lib/sla/index.ts` re-times the clocks still
owed, sharing the recompute `onGroupChanged` already had, and the console, the
`set_priority` automation and the classifier all call it. A raise can put a due
date in the past; that is the honest answer, and the breach sweep reports it.

The job is queued in `afterMessageStored`, which every ingest path runs
_before_ `afterInboundMessage` applies the SLA — so on a new ticket the
classifier can answer before, during or after `applySlaOnCreate`. Before: that
function reads the raised priority. After: `onPriorityChanged` re-times. During
is the case that needed code: `applySlaOnCreate` and `onCustomerReply` now write
only if the priority still holds the value they computed from, and recompute
when it does not, where an unconditional write stored the old targets under the
new badge for good.

Review also found two faults in the shared recompute that predate this change
and that every priority change would now have reached. It added the ticket's
lifetime of paused minutes to the next-response clock, which is anchored at the
customer's latest message and owes nothing for a pause that ended before it —
raising a ticket parked for two days last week pushed its reply deadline back two
days. And it credited a pause still open, which the resume credits again in
full. Both are fixed, with tests that fail on the old code.

## Rollout

`PRIORITY_AI` is `off` until set. `shadow` asks and records and changes nothing;
`apply` also writes. Both need `TYPESAFE_API_KEY`. The switch is read through
`process.env` and a value that will not parse reads as `off`, because it is read
on every ingest path and `env()` would otherwise throw for the whole application
over a typo.

1. Deploy with it unset. Nothing changes; `afterMessageStored` returns before
   any query.
2. `PRIORITY_AI=shadow` in the production env group, which web and worker
   both link — not on either service, whose value would silently win. Read the
   first twenty rows by hand, per channel — no real Jev response has been parsed by this code yet.
3. `PRIORITY_AI=apply`. Setting it back to `off` stops it with no deploy.

## Shape

| Piece                                  | What it is                                                      |
| -------------------------------------- | --------------------------------------------------------------- |
| `lib/priority-ai/request.ts`           | Pure. The question and the four drafted criteria.               |
| `lib/priority-ai/decide.ts`            | Pure. Whether an answer may be written.                         |
| `lib/priority-ai/settings.ts`          | The switch and the threshold, read leniently.                   |
| `lib/priority-ai/enqueue.ts`           | Called from `afterMessageStored`; never queues the bot channel. |
| `lib/priority-ai/run.ts`               | Ask, decide, record and write, in one transaction per message.  |
| `lib/categorise-ai/context.ts`         | The earlier-messages query, now shared by both questions.       |
| `worker/handlers/classify-priority.ts` | The queue's side.                                               |
| `lib/sla/index.ts`                     | `onPriorityChanged`, called by every writer of priority.        |

The job is skipped in CI's handler loop because it needs the provider;
`lib/priority-ai/run.db.test.ts` runs every statement against Postgres with the
provider stubbed instead.
