# Canned-response suggestions through TypeSafe, in the reply box

When an agent clicks into an empty reply box, the composer asks TypeSafe's Jev
which of the team's canned responses fits the conversation so far — or none. The
answer appears as grey placeholder text; **Tab** (or **Use**, on a phone) puts it
in the box to send or edit, **Esc** (or **×**) waves it away. Every suggestion,
and what the reply that followed actually carried, is recorded, so
`/reports/canned-suggestions` can say how often a suggestion is taken and which
ones are right.

It is the second thing TypeSafe touches here, and the first that is shown to a
person. The shadow categoriser (`plans/categorisation-through-typesafe.md`)
writes only to its own table; this one puts a model's answer in front of an
agent. What keeps that safe is the same property that made the categoriser
comparable to the rules: Jev answers a `choice` over options the request
offered, so it can name a stored response or `none` and nothing else. The text
that lands in the box is the stored body, chosen through the same code path as
the picker, and nothing reaches a customer until the agent presses Send.

## Decisions taken with the person who asked for it

- **One admin switch, off by default** (`canned_suggestion_settings`, on
  `/admin/canned`). Production already holds `TYPESAFE_API_KEY` for the shadow
  run, so the key could not be the flag the way it is for the categoriser — it
  would have turned suggestions on for every agent the day this deployed.
- **Correct means the reply carried the suggested response** — by Tab or by the
  picker, edited or not — and a reply carrying none after Jev said `none` is
  correct too. How much of the text survived is reported beside it
  (`unchanged`, `extended`, `reworded`), not folded into it.
- **The history is the last ten replies, both directions, labelled by author.**
  Never internal notes, `system` lines or forwards, and always read on the
  server from the ticket — the route accepts a ticket id and nothing else.

## Shape

| Piece                        | Where                                                           |
| ---------------------------- | --------------------------------------------------------------- |
| The question, pure           | `lib/canned-suggest/request.ts` — criteria, instructions, state |
| The answer, pure             | `lib/canned-suggest/map.ts` — `rN` back to a canned id          |
| The edit grade, pure         | `lib/canned-suggest/edit.ts`                                    |
| Tab / Esc, pure, client-safe | `lib/canned-suggest/keyboard.ts`                                |
| The history                  | `lib/canned-suggest/history.ts`                                 |
| The switch                   | `lib/canned-suggest/settings.ts`                                |
| Ask, cache, record           | `lib/canned-suggest/suggest.ts`                                 |
| Shown / taken / waved away   | `lib/canned-suggest/events.ts`                                  |
| The grade at send            | `lib/canned-suggest/outcome.ts`, from `sendReply`               |
| The report's queries         | `lib/canned-suggest/report.ts`                                  |
| Routes                       | `app/api/canned-suggestions/route.ts`, `…/[id]/route.ts`        |
| The composer                 | `reply-form.tsx` + `use-canned-suggestion.ts`                   |
| The switch's form            | `app/(console)/admin/canned/forms.tsx`                          |
| The report                   | `app/(console)/reports/canned-suggestions/page.tsx`             |

**Options.** Exactly the agent's own `listCannedResponses(agent)`, keyed `r1…rN`
in list order, plus `none`, added in code on every request and named in the
instructions. Positional keys rather than uuids, because sixty-odd uuids would
ride along twice (criteria and distribution) for nothing; `map.ts` translates
back before anything is stored, and the row keeps `offered_ids` in key order.
One under TypeSafe's 255-option ceiling, since `none` takes a slot; past it the
call fails permanently and says so, rather than trimming the library silently.

**Criteria.** `folder › title: body`, the body in English (falling back to
Arabic), cut at 600 characters. The library is translation pairs, so the meaning
is the same either way; English is cheaper per token and keeps the criteria
identical from one ticket to the next. The instructions say the saved replies are
shown in English but sent in the customer's language.

**Anchor and cache.** The anchor is the newest reply on the ticket, either
direction — the last message Jev is shown, so the same anchor is the same input.
`canned_suggestions` is unique on `(conversation_id, agent_id, anchor_message_id)`:
that index is the cache (a second click is answered from the row), the race guard
(two tabs: the second insert finds the claim and is told to wait) and the cap on
spend (one call per agent per new message).

**Transport.** A route with a `fetch`, not a server action: Next dispatches a
client's actions one at a time, so a provider call made as one would hold the
agent's Send behind it. `SUGGEST_TIMEOUT_MS` is five seconds. Nothing retries —
an answer that arrives after the agent has typed is never shown, so a retry has
nothing to rescue.

**Recording.** A row per question, settled with the model id from the response,
the choice (frozen as text, since canned responses are hard-deleted), the full
distribution keyed by canned id, input tokens and latency — or with the error.
Then `shown_at`, `accepted_at`, `dismissed_at` from the composer, and at send
`message_id`, what the reply carried (`sent_canned_response_id`, title, language),
`sent_matches` and `sent_edit`. `db/sql/003_constraints.sql` holds the two
invariants a request could otherwise break: a row is an answer or a failure, and
taken or waved away, never both.

The reply posts the suggestion's id whether or not it was ever shown. Those that
came back after the agent had started typing give the report its anchoring check:
if suggestions nobody saw are right far less often than ones people saw, agents
are taking what they are shown rather than what fits.

## The report's definitions

| Figure                 | Numerator                                     | Denominator                      |
| ---------------------- | --------------------------------------------- | -------------------------------- |
| Taken                  | taken (Tab or Use)                            | shown                            |
| Right                  | shown, replied to, reply carried Jev's choice | shown and replied to             |
| Right when never shown | the same, unseen                              | unseen and replied to            |
| Said none fits         | `none`                                        | answered                         |
| Missed                 | `none`, then a canned response sent           | `none` and replied to            |
| Sent as it stood       | `unchanged`                                   | right replies with an edit grade |
| Failed                 | errored                                       | asked                            |
| Seen by suggestions    | agent replies linked to a suggestion          | agent replies                    |

Per response: suggested, shown, taken, right, Tab vs list, unchanged vs edited,
replaced by another response, own words, and **missed** — replies that carried
this response when Jev chose something else or none, which is how a response Jev
never picks shows up at all. Below ten, a rate prints as "3 of 4".

## What was measured before building it

From production, read-only:

- The 647 shadow categorisation calls of 2026-09-21: p50 234 ms, p90 274 ms,
  max 607 ms, no errors, about 2,340 input tokens each.
- The library: 62 responses, all `global`, both languages, bodies averaging
  278 Arabic / 297 English characters; `usage_count` 0 on every one.
- Social messages average 32–46 characters; agent replies 25–109.

So a suggestion is expected to cost about 5–6k input tokens — roughly 2.5 times a
categoriser call — and to answer well inside a second. Neither is verified yet:
the first call with the switch on measures both, and every row stores its tokens
and latency.

## Not done, deliberately

- **No threshold.** Every suggestion is shown whatever its probability. The
  report's probability bands are the evidence for hiding unsure ones, if that is
  ever wanted.
- **No per-agent breakdown.** How each person treats suggestions is a question
  about people (`report.agents`), and not one this set out to answer.
- **No suggestion on notes, templates or side conversations.** The reply box only.

## Before switching it on in production

- TypeSafe's data-processing and retention terms: agent replies and agents'
  personal canned responses now go to it, as well as customer text.
- Real human traffic is not live yet, so the report will say it has nothing until
  agents reply. Turn it on at cutover and read the report after the first couple
  of hundred replies.
- Rollback is the switch: off takes effect within thirty seconds per instance.
