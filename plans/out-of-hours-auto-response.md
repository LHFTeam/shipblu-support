# The out-of-hours reply

## Context

The helpdesk knows when it is shut — `business_hours` carries a weekly schedule
per calendar, `holidays` the days it is closed regardless, and every SLA due date
is already counted in working time through `lib/hours`. What it did not do is
say anything. A customer writing at 22:00 got silence until somebody opened the
ticket the following morning, and on the bot archive — the only real traffic this
system has seen — **11,402 of 18,417 inbound messages arrive outside the schedule
production actually runs** (Sun–Fri 10:00–18:00, Africa/Cairo). Whatever the
figure turns out to be for the human queue, the shape is not in doubt: most of
what comes in arrives when nobody is there to read it.

So this adds one thing: an acknowledgement, sent once, when a customer writes in
and the office is shut.

## The model

One table, `auto_responses`, and the scope is **two nullable columns** rather
than a `scope` enum:

| `group_id` | `channel`  | Means                              |
| ---------- | ---------- | ---------------------------------- |
| null       | null       | every ticket                       |
| null       | `whatsapp` | every group, on WhatsApp           |
| Returns    | null       | the Returns team, on every channel |
| Returns    | `whatsapp` | that team, on that channel         |

A rule matches when every column it _sets_ matches. The most specific match
wins — both beat one, and a channel beats a group. That last one is the only
arbitrary call in the design: either could be defended, and it goes this way
because the two are reached for at different moments. A group rule is set up once
when a team is created; a channel rule gets written _later_, when somebody reads
the company message on a phone and decides WhatsApp needs two lines rather than
three paragraphs. The later, narrower intent is the one that should win — and an
admin who disagrees can say so precisely by setting both columns on one rule.

The scope is also the identity: `unique nulls not distinct (group_id, channel)`.
Two rules for the same scope would make the winner depend on row order, so the
rows carry no name of their own and a duplicate is refused in the action with a
sentence rather than a constraint error.

### The holiday override

Every rule carries a second pair of bodies used on any day the calendar marks a
holiday. Empty falls back to the ordinary out-of-hours body, which is what makes
it an override rather than something every rule has to fill in twice.

One body covers every holiday in the year because `{{holiday}}` interpolates the
name off the calendar. Per-holiday wording was the obvious alternative — a
message column on `holidays` — and it means re-typing a message for each of a
dozen public holidays, in two languages, every year, for a sentence that differs
only in the name.

### Which hours count as "out"

**Not configured here.** A rule sends when the ticket's group is outside _its_
calendar, resolved through `groupHours()` in `lib/hours/resolve.ts` — the same
function the SLA engine and the nightly rollup use. Attaching a schedule to the
message would be a second answer to "are we open?", and the two would disagree
the first time somebody edited one.

That also means a deployment with no default schedule sends nothing at all,
rather than acknowledging every ticket at every hour of the day. The admin screen
says so rather than leaving it to be discovered at 22:00, and says the same about
a holiday message written when no calendar has a single holiday on it — which is
production's state today.

## Once per closed stretch

The hard part of an autoresponder is not sending it, it is not sending it six
times. Two things do that work.

**How often.** A ticket gets one acknowledgement per _closed stretch_, not per
message: after one goes out, the next is only due once the office has opened in
between. That question is asked of the calendar — `nextOpeningAt()` scanning
forward from the last one — rather than of a cooldown in minutes, because a fixed
window is either too short for a weekend or too long for a Tuesday evening, and
Eid is four days.

**Concurrency.** Six messages at 23:00 are six ingest jobs running in parallel on
the worker, and every guard passes in all six. So `conversations.auto_responded_at`
is _claimed_ with a conditional update — set it only if the row still holds the
value we read — and the reply is sent only if that update matched. Three parallel
sends produce one message; verified below.

## What it deliberately does not do

**It does not count as a first response.** The automation engine's canned reply
stops the SLA clock, on the reasoning that an automated answer is still an answer
and a team that dislikes it should not be auto-replying. This is the case where
that reasoning inverts: the acknowledgement goes out precisely because nobody is
working, and the SLA is counted in working time. Marking first response at 02:00
would report a first response of zero minutes on every ticket that arrives
overnight, and the team's headline figure would measure the autoresponder instead
of the team. It does not move `lastAgentMessageAt` either — the live backlog, the
unanswered sweep and `hours_since_last_agent_message` all read that as "somebody
has been in here".

**It does not answer machines.** An out-of-office answering our acknowledgement,
which answers it back, is the loop RFC 3834 exists to prevent. The classification
is already made at ingest by the parser that had the headers; this reads it back
off the message rather than re-deriving it.

**It does not touch the bot channel.** Those conversations belong to a bot
running outside this platform, on a number whose replies we never receive.

## Language

Bodies are per language, and the requester's `contacts.locale` picks — except
that nothing in this product ever sets that column, so all 6,244 contacts in
production sit at its `'en'` default. `lib/contacts/merge.ts` already names the
problem: `'en'` means either "reads English" or "nobody has ever said", and the
column cannot tell them apart.

Taking it at face value would answer an Arabic-first customer base in English on
every channel — a silent success, the failure mode this project keeps finding.
So an explicitly Arabic contact is honoured and everybody else is read from the
script of what they actually wrote, counting letters rather than looking for the
first Arabic character: "SB123456 فين شحنتي" is Arabic, "my order to شبرا" is
English. The real fix is to set `contacts.locale` at ingest; that is recorded in
`docs/PROJECT-STATE.md` §5 rather than done here, and it is what CSAT needs too —
every survey is going out in English for the same reason.

## Plain text, not HTML

Bodies are stored as text and the email HTML is built at send time by
`textToHtml()`, after substitution. An acknowledgement is three sentences; a rich
text editor buys formatting nobody needs and an HTML sanitisation surface around
every interpolated value. Building the HTML last means escaping is not a step
anybody can forget — which matters because `{{customer_name}}` is a display name
the customer chose.

## Shared delivery

`lib/tickets/outbound.ts` is new and holds what the automation engine's canned
reply and this share: which body a channel takes, which delivery status it starts
in, which job carries it, which timestamps move. It was about to be a third copy
of the same thirty lines.

It also fixes something on the way past: both automated senders routed everything
that was not WhatsApp to `send_email`, so an automated reply on a Facebook or
Instagram ticket was queued as an email to a contact who usually has no address,
and failed in the worker where nobody was looking. `carrier()` sends those to
`send_meta`, which is what the console has always done.

## How it was verified

Against a local Postgres 16 with the migrations applied, driving
`maybeSendAutoResponse` directly — 22 assertions, all passing:

- silent during working hours; one message outside them, with `{{next_opening}}`
  resolved to the next working day in the office timezone
- `first_responded_at` and `last_agent_message_at` untouched; `auto_responded_at`
  claimed; an `auto_replied` event on the timeline
- a second message the same evening sends nothing; the next closed stretch sends
  again
- an Arabic message gets the Arabic body; WhatsApp carries no HTML
- a holiday gets the holiday body, with the name interpolated and the next
  opening skipping the holiday
- an inbound message flagged automated gets no reply; spam gets none
- a channel rule beats the company rule; a silent scope sends nothing
- three parallel sends on one ticket produce exactly one message
- a group on its own Saturday calendar is open when the company is shut
- every queued job is the right carrier for its channel, with a `send:` dedupe key

Then through the browser against `next dev`: the screen renders, a rule is created
through the real form and server action, RTL Arabic fields lay out correctly, the
"send nothing" tick hides the bodies, the holiday warning appears when a holiday
message is written with no holidays on any calendar, and a duplicate scope is
refused with a sentence.

Not verified: a real send. No message has gone to Meta, to the email provider or
to a real customer from this code — the delivery half is the same queue path
every other reply uses, but it has been exercised as far as the job row and no
further.
