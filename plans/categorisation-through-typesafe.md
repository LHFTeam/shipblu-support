# Categorisation through TypeSafe, in shadow

`lib/categorise/` files inbound tickets with compiled regex and phrase rules.
This adds a second, entirely separate categoriser that asks TypeSafe's Jev the
same question, records the answer in its own table beside what the rules said,
and changes nothing else. It is a measurement, not a switch.

## Why this is not the decision `plans/ticket-categorisation.md` already took

That plan's "What is deliberately absent" section rules out an LLM, and the
argument it gives is good:

> **No LLM.** Rules are inspectable, free, deterministic, and — this is the
> argument that decided it — a rule that fires wrongly can be turned off by name
> in an environment variable while somebody fixes it.

Three of those four still hold and are not disputed here. What has changed is the
fourth premise and the evidence.

**Jev is not a text model.** It answers a `choice` question over an option list
the request supplies and returns a probability for each option. It cannot emit a
category that was not offered — and `lib/categorise-ai/map.ts` checks that anyway,
because "should never happen" is the reason to assert rather than the reason not
to. The failure the plan was guarding against — a generative model producing
labels nobody defined, unreviewable and unturnoffable — is not available to it.

**The rules leave most of the live archive unread.** Measured against production
on 2026-09-21: `conversation_categories` holds 186 rows, **101 of them
`meta.unclassified`**. Under those sit 330 inbound messages, **224 of which are 24
characters or shorter**, and 213 of which contain Arabic. That is the shape of the
corpus rather than a shortcoming of the rule table: a regex over a 22-character
Egyptian-Arabic fragment has very little to work with, and `anchored()` already
squeezed what there was.

So the question worth asking is narrow and empirical — does a model read those 330
messages better than the rules do — and it is answerable for about six cents. This
change answers it and stops there.

## Shadow, and why that is the design rather than a first step

Nothing here writes to `conversation_categories`, and the reason is not caution.

That table's `confidence` column is an **evidence grade**: hand-assigned 0.90 /
0.70 / 0.55 rule weights combined by noisy-OR under a ceiling chosen by the
strongest contributor, documented as "not a probability", explained that way on
the review page, and constrained by a `_manual_is_certain` CHECK. TypeSafe
returns an actual probability, plus a confidence statistic computed from the
distribution. Writing either into that column would put two different quantities
in one place that three screens describe as a third, and nothing downstream could
tell which it was holding.

`ai_category_runs` therefore stands alone. No rollup reads it, no review queue
shows it, and the primary ladder cannot see it. Promoting a result later is a
separate change that has to argue for itself; it is not something a threshold can
drift into.

## What is recorded, and why each column earns its place

- **The full probability distribution**, not the winner. The whole value of a
  shadow run is sweeping a threshold afterwards. A truncated distribution cannot
  answer "what would auto-apply at 0.8 have done" without paying for the corpus
  again.
- **The rules' answer, computed in the same call.** `detectCategories` is pure and
  needs no database, so the baseline costs nothing — and it is the only version
  that is about the detector. Reading `conversation_categories` instead would
  compare against rows agents have since confirmed, rejected or added, which
  measures the team's curation rather than the rule table.
- **The model id from the response**, not from the request. `jev-latest` is an
  alias and moves; a row recording the alias cannot say what produced it a month
  later.
- **Whether context was sent.** These messages average 22 to 39 characters, so
  three preceding inbound messages ride along by default. That is a real advantage
  over a regex and it is also a difference between runs, so it is a column rather
  than a convention.
- **A failed call.** A run that quietly covered 600 of 640 messages and one that
  covered all of them print the same summary otherwise.

## The corpus, and its limits

The bot channel is excluded, through the same `readOnlyChannels()` the live
categoriser uses — its menu is a self-service funnel, and measuring a classifier
on it would be measuring the menu. What remains, measured 2026-09-21:

| channel   | inbound reply messages | conversations | avg chars |
| --------- | ---------------------- | ------------- | --------- |
| facebook  | 569                    | 142           | 33        |
| instagram | 45                     | 19            | 39        |
| whatsapp  | 13                     | 6             | 17        |
| webchat   | 8                      | 5             | 18        |
| email     | 5                      | 4             | 320       |
| **total** | **640**                | **176**       |           |

**640 messages, 89% of them Facebook.** A headline accuracy number over that is a
statement about one channel that reads as a statement about the product, which is
why `formatReport` prints the per-channel and per-script breakdown above every
figure and why nothing here computes a single score. The 97,507 bot-channel
messages remain reachable with `channels=whatsapp_bot` for anyone who wants
statistical power and is willing to say what they are measuring.

Accuracy is also not self-certifying. TypeSafe's own 75-class benchmark reports
90% accuracy above 0.9 confidence and **40% below it**, so the report bands by
confidence and somebody has to read a sample before quoting anything.

## Shape

| Piece                                       | What it is                                                          |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `lib/typesafe/client.ts`                    | The provider. Timeout, `isTransient` taxonomy, zod, **no retries**. |
| `lib/categorise-ai/request.ts`              | Pure. The question and the state, asserted in a unit test.          |
| `lib/categorise-ai/map.ts`                  | Pure. The answer, refused if it names a category nobody offered.    |
| `lib/categorise-ai/options.ts`              | The option list, from the registry rather than from `TAXONOMY`.     |
| `lib/categorise-ai/run.ts`                  | One message: ask, record, and record the rules' answer beside it.   |
| `lib/categorise-ai/report.ts`               | The comparison.                                                     |
| `worker/handlers/backfill-categorise-ai.ts` | The hand-run job.                                                   |

Three decisions inside that are worth stating, because each closes something:

- **Raw `fetch`, not `@typesafe-ai/sdk`.** The SDK retries internally, which is
  the one behaviour this repo deliberately puts in the queue — `postmark.ts` says
  why, and a dead job is the visible record of a call that never succeeded. It
  also brings an error taxonomy when the only thing a handler reads is
  `isTransient`.
- **The option list comes from `ticket_categories`, not `TAXONOMY`.** A category
  retired in the console vanishes from the rules path immediately. If it did not
  vanish from here too, the two detectors would be answering over different
  vocabularies and every disagreement would be an artefact.
- **`meta.unclassified` is offered as a real answer**, and the instructions say so.
  Given 55 options and no way out, a model asked about "؟" will name something,
  and a forced guess at a low probability is precisely the over-detection the
  original plan warns about.

Presence of `TYPESAFE_API_KEY` is the feature flag, the device
`instagramLoginConfigured()` already uses, so this ships inert. The key is in the
production group rather than the shared one for a reason that is not the Meta one:
the job sends real customer message text to a third party, and a key staging could
inherit is a key a stray run there could copy the archive out with.

## Verified

Postgres 16 locally, because Vitest runs no SQL and `tsc` type-checks the drizzle
builder rather than the statement it emits — the §6.46 lesson.

- Migrations apply; `db/sql/` replays.
- Selection: three inbound replies scanned from a fixture set containing an
  outbound reply and a `whatsapp_bot` ticket, neither selected.
  `onlyUnclassified=true` narrows it to two. `channels=facebok` throws rather than
  measuring nothing.
- Write path, against a stubbed provider: a 429 writes a row carrying the error
  and reports `failed`; re-running replaces that row with a real measurement;
  running a third time **does not** overwrite the measurement, which is the
  `setWhere` on the upsert; an answer naming a category nobody offered is refused
  permanently and writes nothing.
- Report: every branch, including the Arabic-script split (`~ '[؀-ۿ]'`), the two
  `= any(<array column>)` fragments, the rules-gave-up counter and the
  disagreement pairs.
- `tsc`, `eslint`, `prettier`, 1,608 Vitest tests, `knip`, `next build`,
  `repo-rules.mjs` (20 checks) all clean.

Not verified against production: no API key exists yet, so no real Jev response
has ever been parsed by this code. The response shape is taken from TypeSafe's
published API reference and asserted in `lib/typesafe/client.test.ts`; the first
real run should be `limit=5` under its own label, read back by hand before
anything larger.
