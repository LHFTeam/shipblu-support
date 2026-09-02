# Ticket categorisation

## Context

This helpdesk could not answer the first question anybody asks of one: what are
customers contacting us about, and why does it keep happening.

The dimensions existed and were empty. `conversations.tags` was `{}` on all
13,748 rows and `conversations.type` was null on every one of them — the same
shape of dead scaffolding `agents.presence` and `conversations.custom_fields`
were before something finally wrote to them. There was nothing to group a report
by, nothing to route on, and no way to tell a repeated failure from a busy week.

So this adds categorisation: a taxonomy for ShipBlu's industry, a rule detector
that files an incoming complaint against it as the message lands, and a second
dimension — the **cause** — that an agent records when they close.

## The scope correction, because it changed everything

The first draft of this mined the `whatsapp_bot` archive and built a taxonomy out
of its button labels. That was wrong, and it is worth writing down why, because
the archive is the largest thing in this database and the next person will be
drawn to it for exactly the same reason.

The bot's menu is a **self-service flow, not a ticket stream**. A customer
pressing "confirm my details" has no support need at all, and a third of that
archive is precisely that. Categorising it would measure the bot's funnel and
report the result as support demand.

Categorisation therefore **excludes `whatsapp_bot`**, through the
`readOnlyChannels()` helper that already exists in
`lib/tickets/channel-policy.ts` and already means exactly this. No carve-out was
added.

The archive keeps one narrow use, and it is real: **3,159 bot conversations
contain free text the bot never answered**. Those customers bring the same
complaint to an agent on another channel, which makes that text the best
available proxy for agent-bound traffic — a corpus to _validate rules against_,
never a set of tickets to categorise. It is also, separately, a leading
indicator of inbound volume and the business case for widening the bot's menu.

## Four dimensions, not one label

The mistake worth avoiding is expressing everything as one field.

| dimension          | answers               | set by                | when       |
| ------------------ | --------------------- | --------------------- | ---------- |
| **Requester**      | who is asking         | auto                  | on arrival |
| **Topic**          | what they asked about | auto, agent-corrected | on arrival |
| **Root cause**     | why it happened       | **the agent**         | on resolve |
| **Accountability** | who owns the fix      | derived from cause    | on resolve |

**Root cause is not auto-detected, and never should be.** The customer does not
know the cause. "Where is my order" is one sentence with at least six causes
behind it: the pickup never happened, the hub mis-sorted it, the merchant gave a
wrong address, the courier never called, the zone is unserviced, or the parcel is
not late at all and the expectation is wrong. Inferring a cause from complaint
text would manufacture confident, wrong data in the exact place the team is
trying to reason from. So the detector names the **symptom** and the agent
records the **cause**, having actually looked.

**Accountability is derived, never typed.** `ticket_root_causes.owner` maps each
cause to exactly one accountable party, so the agent fills one field and the
report gets two dimensions. Offering both invites them to disagree, and a report
where the cause says `hub.missort` and the owner says `courier` is worse than no
report.

## The taxonomy

12 areas, 55 categories, 27 causes, bilingual throughout, in
`lib/categorise/taxonomy.ts` and reconciled into the database by `syncTaxonomy()`.

It is deliberately aligned to `lib/shipments/status.ts`, which already holds the
27 canonical parcel states with their Arabic phrasing. A support category that
maps onto what the parcel was actually doing is what lets a report ask "of the
tickets about a late delivery, what state was the parcel really in" — and
`conversation_shipments` already carries that join. A taxonomy invented
independently of the operational vocabulary would have made that question
unanswerable for no benefit.

The areas: `delivery` (11), `condition` (4), `pickup` (4), `return` (4),
`payment` (5), `billing` (5), `account` (3), `integration` (3), `commercial` (6),
`service` (5), `other` (4), and `meta` — which holds only `meta.unclassified`,
the one bucket meant to shrink.

Causes are prefixed by their owner — `courier.*` (5), `hub.*` (4), `merchant.*`
(6), `recipient.*` (4), `platform.*` (3), `external.*` (3), `none.*` (2) — and a
CHECK holds the prefix and the `owner` column together, so the two cannot drift.

`platform.self_service_gap` earns its place from real evidence: a customer who
wrote `بحاول الغي الشحنه لإن تم تعديلها بس مش نافع` — _I am trying to cancel the
shipment because it was changed, and it will not work._ Every ticket carrying
that cause is one the product could have prevented, which makes it the most
actionable number the whole system produces.

## Why the registry is in the database

`ticket_categories` and `ticket_root_causes` are rows, not constants, so an
admin can rename a label without a deploy — and, more importantly, so an
assignment can point at a category that later gets retired.

Nothing is ever deleted. A category is deactivated, or merged by setting
`superseded_by_key`, and `conversation_categories` freezes `category_key` at
assignment time. The rollup tables key on the same text. A report drawn last
quarter has to stay readable after somebody tidies the taxonomy, and every one of
those choices exists for that sentence.

The tables live in `db/schema/config.ts` beside `ticket_statuses` rather than in
`categories.ts` with the join table. `conversations` references them and
everything references `conversations`, so a registry in a leaf module makes the
import graph circular.

## The detector

`lib/categorise/` is pure — no database, no I/O — following `lib/shipments/detect.ts`.

**Arabic is the hard part, and none of the difficulty is in the taxonomy.**

`\b` is defined over ASCII `\w`, so it does not exist for Arabic: `/لا/` matches
inside `الغاء` and inside `ولا`, which is how a "no" rule files a reschedule as a
refusal. Every pattern therefore goes through one `anchored()` helper built on
Unicode property lookarounds, so it cannot be forgotten in one rule.

Text is folded before matching — NFKC, Arabic-Indic digits, invisibles, tashkeel,
then the orthographic variants (`أإآٱ→ا`, `ى→ي`, `ة→ه`, `ؤ→و`, `ئ→ي`). This is
the opposite of what `lib/kb/seed.ts` does, and deliberately: that module compares
against an unfolded tsvector and folding would break the match. This matcher owns
both sides of its comparison, and the corpus carries `إلغاء الشحنه`,
`الغاء الشحنة` and `الغي الشحنه` for one intent. Proclitics (`و ف ب ل ك` plus
`ال`) are handled by an `ar()` helper rather than by writing five spellings.

**Confidence is an evidence grade, not a probability.** 0.90 for a whole message
that reads as a known phrase, 0.70 for a multi-word anchored match, 0.55 for a
single keyword inside a longer sentence; independent hits combine noisy-OR and
cap at 0.95. Nothing here claims a percentage chance of being right, and the
console says so where the number is shown.

Two thresholds, both overridable through `process.env` without a deploy:
`CATEGORISE_AUTO_MIN` (0.90) applies outright, `CATEGORISE_RECORD_MIN` (0.35)
suggests into the review queue, and below it nothing is written at all.
`CATEGORISE_DISABLED_RULES` kills a single over-firing rule by key.

**The error philosophy is asymmetric on purpose.** A missed category shows as
`meta.unclassified`, tops the review queue, and a re-run repairs it. A wrong
category silently moves a number a manager staffs a team from. Under-detection is
cheap; over-detection is not.

## Reading the corpus, which is the part that cannot be designed

The detector was measured against 769 real free-text messages, not asserted
against imagination. It went 59.6% → 80.9% → **85.3% classified**, with 8.2%
`meta.unclassified` and 6.5% carrying nothing to classify.

Four gaps came out of reading the corpus that no amount of design would have
produced:

- **Franco-Arab** — Arabic written in Latin script (`Fen el order???`,
  `El order ha eegy emta`, `Ana msh ayza el order daaa`). A whole register of
  customer writing, invisible to every Arabic-script pattern, and invisible to
  design too: none of it appears in a dictionary or a phrasebook.
- **Ordinary English sentences**, which the plan had quietly assumed were rare.
- **Maps links and pasted addresses**, which are an address change and read as
  nothing else.
- `شحنه ايه` — _what shipment?_ — frequent enough to earn its own category,
  `delivery.unrecognised`.

And two categories were added outright because the corpus insisted:
`service.acknowledgement` (`تمام` alone is the single most common free-text
message in the archive, 61 occurrences) and `payment.method`.

The precision pass then made three rules **less** eager, and the important one is
worth stating: `لم استلم` — "I did not receive it" — had mapped to
`delivery.not_received_marked_delivered`, which accuses a courier of a false
delivery scan on the strength of a plain non-delivery. Only the conjunction with
a tracking claim carries that. A rule that files a false-scan accusation from an
ordinary complaint is exactly the kind of confident wrong data the asymmetry
above exists to avoid.

## The live path

Categorisation runs in `afterMessageStored`, on **inbound `reply` messages
only** — not on our own replies, which would categorise every ticket where an
agent pasted a canned answer, and not on notes, which would launder an agent's
opinion into the `detected` column the tuning pass trusts.

That required widening the seam's payload with a **required, nullable**
`direction` across all eleven call sites. An optional field would have silently
no-opped on whichever path nobody updated, which the seam's own docstring warns
about; a required one made the compiler enumerate the list.

`conversation_categories` is multi-label with exactly one primary, and that is a
database guarantee rather than a convention — a partial unique index on
`(conversation_id) where is_primary`. The primary is recomputed from the whole
set on every change, with a ladder that puts a human's choice above any rule's.

## Reporting

`category_metrics_daily` and `root_cause_metrics_daily`, folded into the existing
`rollup_metrics` transaction rather than a second nightly job — two jobs would be
two answers to "which day is this".

**Not a dimension on `metrics_daily`.** That table's `reconciles()` assertion
checks a day's totals row equals the sum of its channel slices, and its own
comment calls it the only thing standing between a double-counting bug and a
report that merely looks busy. Categories are multi-valued — a ticket routinely
carries three — so category slices can never sum to the total. Adding the
dimension there would mean deleting that guard.

The two tables are counted from **different timestamps**, which is the design and
not an inconsistency. A category comes off `created_at`: it describes demand,
what arrived that day. A cause comes off `resolved_at`: it describes what was
understood that day, because a ticket that arrives in one month and is worked out
in the next belongs to the month somebody worked it out. Counting a finding on
the day of arrival would put it on a day when nobody had it.

`owner` is denormalised into the cause rows — the one denormalisation here — so
that correcting a cause's owner today does not silently re-attribute last
quarter.

`/reports/categories` states its own honesty line before any cause number: how
many resolved tickets in the window have no cause recorded. That figure is read
**live** rather than from the rollup, because somebody can still go back and fill
one in, and a rolled-up copy would freeze the gap as it was on the night.

## What is deliberately absent

- **No LLM.** Rules are inspectable, free, deterministic, and — this is the
  argument that decided it — a rule that fires wrongly can be turned off by name
  in an environment variable while somebody fixes it.
- **No backfill job.** It was in the plan and is now close to pointless:
  categorisation excludes `whatsapp_bot`, so there are 55 conversations in the
  entire archive to backfill. Worth revisiting only if the human channels grow.
- **No "suggestions still open at day end" column** in the rollups. That is
  current state, and a nightly rebuild would write today's answer onto an old
  date — surfacing only on the third night, when the recompute window reaches
  back, which is the hardest possible failure to notice. The review queue asks
  that question live.

## Verification

Vitest runs without a database, so **no SQL executes there**, and CI's `database`
job only exercises job handlers. A Postgres 16 was therefore stood up locally and
the whole thing run against it: the migration applies, `db/sql/002_categories.sql`
replays twice, all eight CHECKs bite, the partial unique index holds one primary,
the bot channel is excluded, outbound messages and notes are refused, re-running
writes nothing, the resolve gate demands a cause for a delivery failure and not
for an enquiry, and every read query returns rows. The console screens and
`/reports/categories` were each rendered on a full navigation, not an RSC
prefetch.

That is also what caught the one real bug in the work, now `docs/PROJECT-STATE.md`
§6.44: `sql\`${column} = any(${values})\`` reads like working SQL, type-checks,
passes ESLint and Prettier, and dies on first execution because drizzle
interpolates a JS array as separate bind parameters. It was in a page query,
which is precisely the position no automated check in this repo covers.
