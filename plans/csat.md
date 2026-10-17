# Customer satisfaction surveys on every channel the team answers

Email, web chat, Facebook, Instagram and the myBlu app, with the controls an
admin needs to switch it on without a deploy and the report a manager needs to
read it. WhatsApp is out, and the _Scope_ section says why.

## Context

Most of the machinery already exists, and almost none of it has run.
`csat_surveys` holds one row per survey with the token's hash, the rating, the
comment and a snapshot of who handled the ticket; `send_csat` goes out thirty
minutes after a ticket reaches a `resolved` status, re-checks that it still is,
writes the survey as an outbound `messages` row and hands it to the channel's
carrier; `/{locale}/csat/{token}` on the help centre records the answer; and the
nightly rollup folds the ratings into `metrics_daily`, which `/reports`,
`/reports/agents` and the admin dashboard print as an average.

Production on 2026-10-16, read with `execute_sql`:

| Figure                                    | Value         |
| ----------------------------------------- | ------------- |
| Surveys ever created                      | 1             |
| Surveys ever answered                     | 0             |
| `csat_received` events                    | 0             |
| Tickets resolved in the last 90 days      | 66            |
| … of which WhatsApp                       | 57            |
| … Facebook / email / Instagram / web chat | 4 / 3 / 1 / 1 |
| Conversations on the `api` channel, ever  | 0             |

Sixty-six resolutions and one survey is not a response-rate problem. It is the
surveys not going out, and the code says why before the data does:

1. **A ticket is surveyed once in its life, not once per resolution.**
   `scheduleSurvey` enqueues with `dedupeKey: csat:<conversationId>`, and
   `jobs_dedupe_idx` is a plain unique index over the whole table, so the key is
   spent for good (AGENTS.md, _Background work_). A ticket reopened and resolved
   again never schedules a second survey, and the fourteen-day `recentlySurveyed`
   check that was written to govern exactly that case is unreachable.
2. **The survey is in English for every customer.** `send-csat.ts` reads
   `contacts.locale`, which nothing writes, so all 28,661 contacts read `'en'`
   (`docs/PROJECT-STATE.md` §6). The out-of-hours reply and the automation
   engine moved to `requesterLocale()` for this reason; the survey did not.
3. **The link names a host that does not serve this app.** `publicBaseUrl()`
   returns `support.shipblu.com`, which still answers from Freshdesk
   (`docs/PROJECT-STATE.md` §5). The one survey ever sent carried a dead link.
4. **On Facebook and Instagram it is a text link that mostly cannot send.** Half
   an hour after a resolve the Meta window is usually still open, but a survey
   sent as a plain DM is blocked at 24 hours by `automatedReplyBlocked`, rightly,
   because past that only `HUMAN_AGENT` sends and the survey is not a person's
   message. Meta's own answer to this is the Customer Feedback Template, which
   is what this plan uses.
5. **On web chat it is a link out of the widget.** The visitor is in a chat box;
   the survey asks them to open the help centre in a new tab.
6. **A skipped survey leaves no trace.** Every `return` in `send_csat` logs a
   line and writes nothing, so "why was this customer not asked?" has no answer
   in the console, and the report cannot say how many resolutions were surveyed.
7. **There is nothing for an admin to touch.** No switch, no wording, no delay,
   no per-channel choice; the English and Arabic sentences are constants in the
   handler.
8. **The `api` channel is an enum value and nothing else.** No endpoint creates
   an `api` ticket, so there is nothing yet for a myBlu survey to hang off.

Items 1–3 are bugs and go first, whatever else ships; they are a one-PR fix and
they are what stands between the figures above and any figure at all.

## Scope

In: email (and `portal`, which rides the email carrier), web chat, Facebook,
Instagram, and the myBlu app through an API. One question, one 1–5 scale, one
optional comment, on every channel, so the score means the same thing in every
column of the report.

Out, and deliberately:

- **WhatsApp.** `NO_CONSOLE_REPLY` says WhatsApp customers are not answered from
  this platform; a survey would be the only message this system ever sent from
  the number, outside a window that is by then usually closed, and an approved
  template is a paid send. The model below leaves the slot,
  `delivery: whatsapp_template`, and the day WhatsApp replies come back to the
  console the survey is a template picked on the admin page like any other.
- **`whatsapp_bot`.** Read-only; someone else's conversation.
- **NPS and CES.** Meta's template offers them, and nothing here forbids adding a
  second question type later. Today the column is a 1–5 CSAT rating and every
  report assumes it; a second scale is a second column and its own change.
- **A full ticket API for myBlu.** The _myBlu_ section below sizes exactly what
  the survey needs and names the rest as its own plan.

## Decisions to take with the person who asked for it

Each has a default below so the work can start; each changes something a
customer sees.

- **The Facebook template is marked "in development" by Meta** — "Meta can
  change or remove this functionality at any time", on a page last updated
  2026-03-23. The plan builds it as asked and keeps the quick-reply survey
  (Instagram's path) as Facebook's fallback, chosen automatically when Graph
  refuses the template with a permanent error. Default: template first,
  fallback on refusal, and the admin page shows the last refusal.
- **The template needs a privacy policy URL** (`business_privacy.url`,
  required). There is no privacy page on the help centre today. Default: a
  URL field on the admin page, and the Facebook channel stays off until it is
  filled in — the page says so rather than sending a template Graph rejects.
- **Should a `closed` status survey too?** Only `resolved` does today, and a
  ticket an automation closes after a week of silence was resolved a week
  earlier. Default: `resolved` only, unchanged.
- **Should a rule-resolved ticket be surveyed?** An automation that resolves
  "thanks, bye" tickets resolves tickets nobody worked. Default: yes, with a
  switch to turn it off, because the alternative hides the rule's effect.
- **Survey links will carry `publicBaseUrl()`**, so unsetting
  `PUBLIC_BASE_URL` on production (falling back to `APP_URL`) is a precondition,
  not part of this work. It is the one-variable change §5 has been asking for
  since August.

## The model

### One row per decision, not per send

`csat_surveys` becomes the record of every time the system decided whether to
ask, and every row says what happened:

| Column          | Change                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | new enum `csat_status`: `sent`, `answered`, `skipped`, `expired` — all four from stage 1, `expired` being a survey a newer one superseded; a later stage that lets a link or a Messenger card lapse writes the same value, and adds no enum value, since Postgres cannot drop one                                                                                         |
| `skip_reason`   | new, text, null unless `skipped`: `reopened`, `read_only_channel`, `no_address`, `window_closed`, `agent_suppressed`, `contact_opted_out`, `rule_resolved`, `no_customer_message`, `channel_off`, `csat_off`, `comment_thread`, `no_privacy_url`. Not "surveyed recently": a ticket already carrying its survey needs no second row saying so, and that row is the answer |
| `channel`       | new, `channel` enum, snapshotted like `agent_id` — a merged ticket keeps the channel it was surveyed on                                                                                                                                                                                                                                                                   |
| `delivery`      | new enum `csat_delivery`: `email_link` and `text_link` (stage 1 — the link in a mail, and in a plain message on web chat or inside a Meta window); `widget_card`, `meta_template`, `meta_quick_reply`, `api_pull` and `whatsapp_template` join it as their stages land                                                                                                    |
| `locale`        | new, `ar` / `en`, what it went out in                                                                                                                                                                                                                                                                                                                                     |
| `message_id`    | new, the outbound `messages` row that carried it, null for `api_pull` and `skipped`                                                                                                                                                                                                                                                                                       |
| `rule_id`       | new, the `csat_rules` row whose wording it used, `set null` on delete                                                                                                                                                                                                                                                                                                     |
| `answer_source` | new, null until answered: `page`, `widget`, `meta_feedback`, `meta_quick_reply`, `api`                                                                                                                                                                                                                                                                                    |
| `expires_at`    | new; the template's `expires_in_days` for Meta, the link's life elsewhere                                                                                                                                                                                                                                                                                                 |
| `token_hash`    | **nullable**: a skipped row never had a link, and a widget or Meta survey needs none                                                                                                                                                                                                                                                                                      |

A skipped row is cheap and it is the whole answer to item 6: the ticket's
timeline shows "not surveyed — the customer opted out", and the report can
print "surveyed 41 of 66 resolutions" and a table of why not. The nightly
`cleanup` job expires `sent` rows past `expires_at`.

**The rating stays a 1–5 integer whatever carried it.** Messenger's `csat`
question with `score_option: one_to_five` posts `"1"`–`"5"`; a quick reply
carries its number in the payload; the page, the widget and the API post the
number. One scale means `rollup_metrics` and every column already drawn from
it need no new arithmetic, only new counts.

### `csat_settings` — the one-row switch and the numbers

Modelled on `canned_suggestion_settings`: one row, `id = 1`, off on a fresh
install. The resolve, the job and the admin form read it uncached through
`readCsatSettings`, which throws on a failed read, so switching off — the
rollback — reaches the next resolve at once. Only the ticket sidebar reads the
thirty-second memo (`loadCsatSettings`), where a failed read is reported as not
known rather than as off.

| Field                               | Default | What it does                                                                      |
| ----------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `enabled`                           | false   | Nothing is scheduled while off; a ticket resolved while off is not surveyed later |
| `delay_minutes`                     | 30      | Resolve → send, the reopen grace `SURVEY_DELAY_MS` is today                       |
| `meta_delay_minutes`                | null    | The same, for Facebook and Instagram only; null means `delay_minutes`             |
| `resurvey_after_days`               | 14      | `RESURVEY_AFTER_DAYS`, configurable                                               |
| `channels`                          | all off | One boolean per deliverable channel: email, webchat, facebook, instagram, api     |
| `survey_rule_resolved`              | true    | Whether an automation's resolve schedules a survey                                |
| `meta_expires_in_days`              | 3       | Meta's `expires_in_days`, 1–7                                                     |
| `privacy_url`                       | null    | Meta's `business_privacy.url`; Facebook stays off while null                      |
| `api_email_fallback`                | false   | Whether an `api` ticket whose contact has an address is also emailed              |
| `last_template_refusal`             | null    | What Graph last said when it refused the Facebook template, shown on the page     |
| `updated_at`, `updated_by_agent_id` |         | Who flipped it last, shown on the page                                            |

### `csat_rules` — the wording, scoped like the out-of-hours reply

The same two nullable columns as `auto_responses` — `group_id`, `channel` —
with the same resolution (most specific wins, both beat one, a channel beats a
group) and the same `unique nulls not distinct (group_id, channel)` identity,
for the reasons `plans/out-of-hours-auto-response.md` gives. No row matching
is the built-in wording in `lib/csat/wording.ts` — today's sentences, in code
rather than seeded as a row, so there is one copy of them, the switch works
before anybody has written a word, and a deleted rule falls back to something
rather than to nothing. The admin page shows the built-in as the row that
answers when none does, with "Customise" opening a rule pre-filled from it.

Every customer-facing string is an `*_ar` / `*_en` pair, both `not null default
''`, one required, either covering the other (AGENTS.md, _Bilingual_):

| Pair             | Used as                                                                                               | Meta limit   |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `question`       | the email's heading, the widget card's question, Messenger's `question.title`, the quick-reply prompt | 5–85, no URL |
| `intro`          | Messenger's `title`; the email's first line; the widget card's lead                                   | ≤ 65, no URL |
| `subtitle`       | Messenger's `subtitle`; the email's second line                                                       | ≤ 80, no URL |
| `button`         | Messenger's `button_title`; the email's and widget's confirm button                                   | ≤ 20, no URL |
| `comment_prompt` | the follow-up's `placeholder`; the comment box's label                                                | ≤ 65, no URL |
| `thanks`         | after an answer, on the page and the card                                                             | —            |

The limits are Meta's and they are enforced on every rule, not only one scoped
to Facebook: a group rule with no channel applies to Facebook tickets too, and a
wording that saves must be a wording that sends. `lib/csat/wording.ts` holds
the limits as data; the save action and `lib/meta/feedback-template.ts` read
the same table, so the two cannot disagree. The five rating labels stay the
locale strings they are (`csatRating1`–`5`), because a quick-reply label is 20
characters and "Very bad … Great" is already the vocabulary the page uses.

### Suppression, by a person

- **Per ticket.** `conversations.csat_suppressed` (boolean, default false), a
  toggle in the ticket sidebar — "Don't survey this ticket" — for the agent
  who knows the customer is a colleague, or furious, or the ticket was a test.
  Written with a `csat_suppressed` / `csat_unsuppressed` event. The job reads
  it at send time, so it works until the moment the survey goes.
- **Per contact.** `contacts.csat_opt_out` (boolean, default false), a control
  on the contact page, for the customer who asked not to be asked. The merge
  path ORs it, as it does the other flags, so merging into a contact who
  opted out keeps the opt-out.

### What the job does, in order

`send_csat` keeps its shape and gains the decisions above. It enqueues
**without a dedupe key** and is idempotent instead, which is what AGENTS.md
prescribes for work that must be able to run again for the same subject: the
handler refuses, under a lock on the ticket row, when a survey exists inside
`resurvey_after_days`, and a partial unique index
`csat_surveys_open_idx (conversation_id) where status = 'sent'` stands behind
the lock.

1. Settings off, or the channel off → `skipped: csat_off` / `channel_off`.
2. Ticket gone, deleted, spam, merged away → nothing (as today).
3. Not resolved any more → `skipped: reopened`.
4. Read-only channel → `skipped: read_only_channel`.
5. No inbound `reply` carrying customer words (an agent-opened ticket nobody
   answered) → `skipped: no_customer_message`.
6. `csat_suppressed` / `csat_opt_out` → the matching reason.
7. Resolved by a rule and `survey_rule_resolved` off → `skipped: rule_resolved`.
8. Pick the rule (`csat_rules`, most specific) and the locale
   (`requesterLocale()`'s two ingredients — the fix for item 2).
9. Deliver per channel, below: one transaction, under a lock on the ticket row,
   that refuses when the ticket already carries a survey inside the window
   (writing nothing — the row it would sit on top of is the answer), retires
   the last unanswered survey, writes the survey row, the message and the
   event, and commits; the carrier is queued after, keyed on the message, so a
   run stopped between the two is finished by the next. Or `skipped` with the
   channel's own reason.

A `csat_sent` or `csat_skipped` event lands on the timeline either way, so the
agent sees the decision where they resolved the ticket.

### Receiving an answer: one door

`recordAnswer(survey, rating, comment, source)` in `lib/csat/` replaces
`recordResponse`'s token-only shape. The page, the widget route, the Meta
feedback handler, the quick-reply handler and the API route all call it. First
answer wins (`responded_at is null`), a later comment attaches to an answered
row whose comment is empty, anything else is ignored — the existing rules, kept
because they were right. It writes `csat_received` with `{rating, source}`, and
`describeEvent` gets the case it never had: "rated the support 4 / 5 (from
Messenger)".

## Delivery, channel by channel

### Email, and portal

An HTML mail through `send_email`, as today, with one change the mail client
can use: five rating links, `…/{locale}/csat/{token}?rating=n`, worded as the
five labels. The landing page **pre-selects** the rating the link named, opens
the comment box, and records on the customer's tap of the button — never on
the GET. Mail scanners (Safe Links, Proofpoint) fetch every link in a mail
before the person sees it; a page that recorded on load would file a
five-star rating from Microsoft. The tap count is unchanged from today's page
(open, tap), the customer just arrives with their choice made. `Reply-To` stays
the ticket's address, so a customer who answers the mail with words instead
threads onto the ticket, as any reply does.

`lacksEmailRecipient` keeps its job: no address, `skipped: no_address`.

### Web chat

The survey row is still an outbound `reply` message, because the widget's
stream already reads those and the console timeline draws it, but the widget
draws it as a **card**, not a line of text with a link. `listMessages` carries
`survey: { id, rating, expired }` for a message whose `meta.csatSurveyId` is
set, resolved server-side so the hash never leaves the database. The card
shows the question, five buttons, then the comment box and the thanks line.
The visitor needs no link token: their session token is already the credential
that reads this conversation, and `POST /api/widget/csat {token, surveyId,
rating, comment}` resolves the visitor through `resolveVisitor()` and checks the
survey belongs to one of that contact's conversations before `recordAnswer`.
Rate-limited in memory like the other widget routes. The text body keeps the
link, for an embedded widget on an old snippet and for the console.

### Facebook — the Customer Feedback Template

Meta's reference (Messenger Platform → Send Messages → Templates → Customer
Feedback Template) is the source for every shape below; `docs/meta-endpoints.md`
gains the two endpoints. What it says that shapes the design:

- Messenger only. The `messaging_feedback` webhook field is "only available for
  Messenger conversations". Instagram gets a different path, next section.
- One screen, one question, optionally one free-form follow-up (≤ 400
  characters), a required `business_privacy.url`, `expires_in_days` 1–7.
- Inside the 24-hour window it sends as any message; past it, **the
  `CUSTOMER_FEEDBACK` tag** sends it up to 7 days after the customer's last
  message, and that tag is valid only on this template.
- Question ids are alphanumeric and underscores, **no hyphens** — a UUID will
  not do as it stands. The id is `csat_<survey id without hyphens>`, which is
  what pairs the answer with the row.
- The answer arrives as
  `entry[].messaging[].messaging_feedback.feedback_screens[0].questions[<id>]`
  with `payload: "1"–"5"` and an optional `follow_up.payload`.

Three things in the codebase change, each in the module that owns that
knowledge:

- **`lib/meta/feedback-template.ts`**, pure, beside `send.ts`, builds the
  request from a rule's wording and a survey id and is asserted in a unit test
  against the reference shape, for the reason `send.ts`'s header gives: a wrong
  shape is invisible in Graph's answer. `send_meta` gains a `feedback_template`
  send kind; the row's `meta` carries the survey id.
- **`automatedReplyBlocked` learns a second tag.** The `HUMAN_AGENT` rule is
  untouched — the survey is not a person's message and never carries that tag.
  But `CUSTOMER_FEEDBACK` is Meta's own sanctioned way to send exactly this
  thing up to 7 days out, so the guard takes the sender's kind: a
  `feedback_template` on `facebook` is blocked at 7 days, everything else at
  24 hours as today. `messagingTag()` returns `CUSTOMER_FEEDBACK` for that kind
  past 24 hours, with `messaging_type: MESSAGE_TAG`, and refuses rather than
  sends past 7 days (`skipped: window_closed`).
- **`messaging_feedback` joins `REQUIRED_PAGE_FIELDS`** in
  `lib/meta/subscriptions.ts`, `parseWebhook` reads it into a new
  `feedbacks: NormalisedFeedback[]` array beside `interactions` — not as a
  message, for the reasons `applyMetaInteraction` gives: it is not something an
  agent can answer, it must not reopen the ticket, restart the SLA clock, be
  categorised or become the customer's last words — and
  `process-meta-webhook` hands each one to `recordMetaFeedback`, which finds the
  row by question id, checks the sender is the ticket's requester, and calls
  `recordAnswer(…, 'meta_feedback')`. An answer to an expired or unknown id is
  logged and dropped.

A comment ticket (`external_id` of the `…:comment:…` shape) has no DM thread to
put a template in; it is `skipped: comment_thread`. When Graph refuses the
template with a permanent error — `(#100) Unsupported post request` is what an
unsupported template type answers — the job records the refusal on the row and
on the settings page (`last_template_refusal`), and sends the quick-reply
survey instead if the 24-hour window is still open. The template is marked "in
development"; the fallback is what keeps Facebook surveyed the day it is
removed.

### Instagram — quick replies inside the window

No feedback template and no `messaging_feedback` on Instagram, on either
connection. Instagram's messaging API supports quick replies: up to 13 text
buttons of 20 characters, sent with a prompt, the tap returned to the webhook as
a message whose text is the label and whose `message.quick_reply.payload` is
ours. Five buttons, the five rating labels in the customer's language, payload
`csat:<survey id>:<n>`.

What makes this safe is the parser: a message carrying `quick_reply.payload` of
that shape is filed as a feedback, **not** as an inbound reply — the same
discipline as reactions (`docs/PROJECT-STATE.md` §6.94). Filed as a reply, the
word "Great" would reopen the ticket, restart the next-response clock, be
categorised, be the inbox preview and the language the next automated reply
went out in. The comment is asked for only after the rating, as a second plain
message ("Anything to add? Just reply here."), and whatever the customer types
next is an ordinary inbound message — on a resolved ticket, that reopens it,
which is right: a customer with more to say has more to say.

Quick replies send only inside the 24-hour window, and no tag extends them. A
survey that reaches its `runAt` with the window closed is `skipped:
window_closed`, visibly, so the admin can read on the report that the Meta
delay should be shorter — which is why `meta_delay_minutes` exists for exactly
the two Meta channels.

Quick replies are also Facebook's fallback (previous section), built by the
same `lib/meta/quick-reply-survey.ts` with `messaging_type: RESPONSE`, through
the platform split `send.ts` already keeps.

### myBlu — the `api` channel

myBlu is the recipient app (sign-in by the phone number the shipment's text
message went to). It owns its own screens, so a survey for an `api` ticket is
**pulled and answered by the app**, not delivered as a message:

- **`GET /api/v1/tickets/{id}/survey`** — `404` while there is none, else
  `{ id, question, labels[5], commentPrompt, expiresAt, status, rating }` in the
  ticket's locale.
- **`POST /api/v1/tickets/{id}/survey`** `{ rating, comment? }` →
  `recordAnswer(…, 'api')`; `204`, outcome deliberately not reflected in the
  status for the reason `app/api/kb/csat/route.ts` gives.
- **An outbound webhook, `survey.created`**, posted to a URL myBlu registers
  (`MYBLU_WEBHOOK_URL`, signed with `MYBLU_WEBHOOK_SECRET`, both in `lib/env.ts`
  and `render.yaml`, values in the production group), carried by a job
  (`notify_myblu`) with a deadline and the queue's retries, so the app can show
  a prompt or a push. The pull endpoint works without it.

Delivery is `api_pull`: no `messages` row, a `csat_sent` event and the survey
row. With `api_email_fallback` on and an address on the contact, the email
survey goes too, with one row and one token, so the first answer wins whichever
door it comes through.

**What this depends on, and is not in this plan:** there is no authenticated
API that creates an `api` ticket today. The survey endpoints assume a
`lib/api/auth.ts` that resolves a bearer token in `Authorization` to a named
integration (`MYBLU_API_TOKEN` to start, a table when there is a second
caller), and a ticket resource under `/api/v1/tickets` that myBlu creates
tickets and replies through. That is `plans/myblu-ticket-api.md`, to be written
with whoever owns myBlu's backend; the survey endpoints are the first consumer
of its authentication module and ship in the same release as its ticket
creation, because a survey on a channel with no tickets measures nothing.

## Admin — `/admin/csat`

A new permission, `admin.csat`, granted from `admin` up, separate from
`admin.automations` because surveys reach customers in their own voice and a
supervisor allowed to edit routing rules is not thereby somebody who should
rewrite what the company says after every ticket. Under _Workflow_ in
`admin/nav.tsx` as "Satisfaction surveys".

Sections, top to bottom, every control an `InfoTip` away from its reason:

1. **The switch**, with who flipped it and when, and a readiness line beside it
   in the shape `coexistenceReadiness()` uses: "Facebook: off — no privacy URL";
   "Surveys will link to `https://…` — `PUBLIC_BASE_URL` names a host that does
   not serve this app" (reads the same check `publicBaseUrl()` makes).
2. **Timing.** Delay, the Meta override, the resurvey window, the Meta expiry.
   Plain numbers with their units.
3. **Channels.** One row per deliverable channel with its switch and a sentence
   on how it is delivered ("Facebook: Messenger's feedback card, up to 7 days
   after the customer's last message"), the last template refusal on Facebook's
   row, and the API email fallback on the API row.
4. **Wording.** The `csat_rules` table — scope, both languages, which rows are
   complete — with the form the out-of-hours page has, the Meta length limits
   printed under each field and counted live, and a **preview** that renders
   the rule three ways: the email, the widget card, and a description of the
   Messenger card (Meta renders that one; the preview shows the strings in
   their slots with the limits).
5. **Behaviour.** Survey rule-resolved tickets; the privacy URL.
6. **Recent surveys.** The last fifty rows live from `csat_surveys` — ticket,
   channel, delivery, status, skip reason, rating — because the first thing an
   admin does after switching it on is wait half an hour and look.
7. **Send a test.** A button that emails a rule's wording, in one language, to
   the signed-in admin's own address through the ticket-less email job
   (`send_notification_email`) — no survey row, so nothing for the rollup to
   ignore — with its five links landing on `/{locale}/csat/preview`, the survey
   page as a customer sees it, recording nothing. The one way to see the email
   in a real client without resolving a real ticket.

Actions follow the repo shape: `requirePermission('admin.csat')`, write,
`revalidatePath`, `SettingsState`; the wording save validates through
`lib/csat/wording.ts`; every form submits through `useActionForm`.

Elsewhere in the console:

- **Ticket sidebar**, a "Satisfaction" `DetailsSection`: the rating and
  comment with the source and time; "not surveyed — _reason_" for a skipped
  row; the "Don't survey this ticket" toggle; and "Send survey now" on a
  resolved ticket with no `sent` row, which enqueues with `runAt: now` and is
  subject to every check the job makes.
- **Contact page**: the opt-out toggle.
- **Automations**: a `suppress_survey` action, so a rule can keep surveys off a
  class of ticket (a group's internal queue, a form) without an agent clicking.

## Reporting

### The rollup

`metrics_daily` gains, per existing dimension (day, group, agent, channel):

| Column                 | Keyed on       | For                                                  |
| ---------------------- | -------------- | ---------------------------------------------------- |
| `csat_sent_count`      | `sent_at`      | response rate, coverage                              |
| `csat_skipped_count`   | `created_at`   | coverage                                             |
| `csat_rating_1` … `_5` | `responded_at` | the distribution; % positive (4–5), % negative (1–2) |

`csat_rating_sum` and `csat_response_count` stay and keep the three existing
pages exactly as they are. A survey's own `channel` column feeds the channel
dimension rather than the conversation's, so a merged ticket does not move a
score between channels.

Two things the page has to say, per AGENTS.md's _say what the window holds_:
the response rate divides answers in the window by sends in the window, and a
link answered three weeks after it was sent counts in its own week — it is a
rate, not a cohort, and the hint says so. And the rollup recomputes three days,
so an answer that lands later than that on an older survey is picked up by a
`rollup_metrics days=…` backfill the plan ships with.

### `/reports/csat`

Behind `report.view`; the named-agent table behind `report.agents` as on
`/reports/agents`. The window through `rangeIn()` and `range-nav.tsx` like the
other pages. Sections:

1. **Headline tiles**: average, % positive, response rate, surveys sent,
   resolutions surveyed (sent ÷ resolved), each with its count as the hint.
2. **Distribution**: five bars, through `components/charts` on the dataviz
   rules, because an average of 3.0 over a bimodal week is the one number that
   hides the problem.
3. **By channel**, **by group**, **by agent**: the same five figures per row.
4. **By day**: the series.
5. **Why not surveyed**: skip reasons in the window, live from `csat_surveys`
   — this is the table that tunes the delay and shows a channel switched off.
6. **Comments**: the latest fifty answered surveys with a comment, rating,
   channel, agent, and a link to the ticket, newest first, read live. The
   rating alone is a number; the comment is what a supervisor opens.
7. **CSV**, the shape `reports/agents/export` uses, per row of sections 3–4.

`/reports`, `/reports/agents` and the dashboard keep their CSAT columns and
gain the response rate in the hint, and a link to the new page from the tile.

## Stages

Each is one pull request, verified before the next starts; the first stands on
its own and is worth shipping even if nothing else is.

**0. Preconditions, no code.** Unset `PUBLIC_BASE_URL` on production (§5).
Choose the privacy URL. Subscribe the Page to `messaging_feedback` (the
`check_meta_subscriptions` job reports the gap once the field is in the list).

**1. Make what exists work.** Items 1–3 and 6–7's minimum: enqueue without a
key and make the handler idempotent; `requesterLocale()`; `status`,
`skip_reason`, `channel`, `delivery`, `locale`, `message_id` and the nullable
token; `csat_settings` with the switch, the numbers and the channel switches;
`/admin/csat` sections 1–3 and 6; the timeline events and `describeEvent`'s
case; the sidebar section with the suppression toggle. Verified by a
`send-csat.db.test.ts` that drives every skip reason and the idempotency
against Postgres, and by resolving one email ticket on production with the
switch on and watching the row, the job and the mail.

**2. Wording and the email.** `csat_rules`, the built-in wording, the admin wording
section with preview and limits, the five-link email, the pre-selected landing
page, "send a test". `csat/wording.test.ts` holds the limits.

**3. Web chat.** The card, `/api/widget/csat`, `listMessages`' survey field.
Verified in a browser against the local widget, both locales, and on a phone,
where the widget is read.

**4. Facebook and Instagram.** `feedback-template.ts` and its shape test,
`sendKind: 'feedback_template'`, the second tag in `automatedReplyBlocked` and
`messagingTag`, `messaging_feedback` parsing and `recordMetaFeedback`; the
quick-reply survey and its parser rule; the fallback. Verified with a test
account on production, the way §5.2 did the first Instagram send: one Facebook
survey inside the window, one past 24 hours with the tag, one answered through
Messenger and read back from the row; one Instagram quick-reply survey tapped
and shown **not** to reopen the ticket.

**5. Reporting.** The rollup columns, the backfill, `/reports/csat`, the CSV,
the hints on the three existing pages. Verified by `rollup.db.test.ts` on
fixtures with known distributions.

**6. myBlu.** After `plans/myblu-ticket-api.md` lands its authentication and
ticket creation: the two survey endpoints, `notify_myblu`, the env vars, the
API row's fallback switch. Verified with the app's staging build against
staging.

**7. Follow-ups, each its own small change.** `suppress_survey` as an
automation action; a `csat_low_rating` event and a supervisor notification on
a 1 or 2; an inbox view "Rated 1–2 this week".

## Risks and what is deliberately not solved

- **Meta may withdraw the template.** Covered by the fallback and by the
  refusal surfacing on the admin page rather than in a worker log — the lesson
  of §6.27.
- **The `CUSTOMER_FEEDBACK` tag is a usage promise.** The template's allowed
  use is post-service feedback on a prior interaction, which is exactly and
  only what sends it: a `resolved` ticket the customer wrote on. Nothing here
  sends it from an automation's own initiative, a form, or a campaign.
- **Instagram outside 24 hours is not surveyed**, and the report says so by
  count. The honest number beats a `HUMAN_AGENT` tag on a message no human
  wrote.
- **Response rates will be low on email and higher on chat**, and the
  by-channel table is why the figures are not pooled on the headline tile
  without their counts beside them.
- **`contacts.locale` stays unwritten.** `requesterLocale()` is the workaround
  every automated sender now shares; the fix is at ingest and is its own
  change (`docs/PROJECT-STATE.md` §6).
- **A skipped row per resolution grows `csat_surveys` at the rate tickets
  resolve**, which is 66 a quarter today and a few hundred a day at the volume
  the bot archive suggests; `cleanup` retains skipped rows for 180 days.

## Sources

- Customer Feedback Template, Messenger Platform:
  `developers.facebook.com/docs/messenger-platform/send-messages/templates/customer-feedback-template`
  — shape, limits, the `CUSTOMER_FEEDBACK` tag, `messaging_feedback`, the
  "in development" notice.
- Webhook events reference, Messenger Platform — `messaging_feedback` "only
  available for Messenger conversations".
- Quick Replies, Instagram Messaging — 13 buttons, 20 characters, text only,
  `quick_reply.payload` on the webhook.
