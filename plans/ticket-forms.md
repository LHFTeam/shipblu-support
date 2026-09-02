# Ticket forms

## Context

Every ticket this helpdesk could open was opened by somebody writing a sentence.
Email, WhatsApp, Meta and the widget all arrive as free text, and the one place a
customer filled in a _form_ — `/{locale}/portal/new` — asked everybody the same
questions: a subject, a message, and every custom field marked both visible and
editable, in one fixed order.

A damaged parcel and a refund request are not the same interview. An admin had no
way to say so, no way to ask a follow-up only when the first answer warranted it,
and no way to have the answers route the ticket without writing an automation
rule per form. `ticket_fields` had existed since the first migration and, until
recently, nothing wrote to it at all.

So this adds forms: named, published question sets that create tickets, on the
help centre and in the console.

## The model

One table, `ticket_forms`, whose layout is **one jsonb document** rather than a
`ticket_form_fields` join.

The join is the obvious answer. It is the wrong one for the reason
`automation_rules.actions` is also jsonb: the layout is edited, validated and
stored as a single document by a single builder, so a join spreads one save
across N inserts, N updates and M deletes — and still needs a `position` column
to put the rows back in order.

What a join buys is a foreign key onto `ticket_fields`, and the codebase had
already settled that question elsewhere. `lib/rules/conditions.ts` says a rule
naming a deleted custom field "should quietly stop matching rather than break the
sweep"; an element naming one is dropped by `parseFormElements` at read time, so
retiring a field degrades a form instead of breaking a page. What is owed in
exchange is a warning on the way out, so `deleteField` now refuses while a form
still asks for the key, and `saveTicketForm` refuses a save that _would_ drop a
question rather than dropping it silently.

An element is one of four things — a custom field, a built-in question, a
heading, a note — referenced by `ticket_fields.key` and not by id, because the
key is already the immutable identifier every automation and every ticket's
`custom_fields` uses, and a second way to name the same field is how the two
drift.

## Conditional fields, and the direction that matters

Conditional questions are two problems wearing one name. In the browser it is a
rendering question. On the server it is a security question, because the
browser's answer arrives as a POST anybody can write by hand.

Both sides run `resolveVisibility`, which is pure and evaluates the same
condition language SLA policies and automations already share — an admin who can
write "priority is urgent" for a rule writes the identical thing to reveal a
field.

**It builds up from nothing rather than paring down from everything**, and that
is the whole argument. Starting with every element visible and removing the ones
whose conditions fail lets an answer to a question that was never asked sit in
the facts for a pass and reveal a second question — the crafted POST getting one
free move. Starting from nothing means an element is visible only when the
answers justifying it come from elements that are themselves visible, which is
also the order a person fills a form in: answer one, the next appears.

Two consequences the callers rely on, both covered by tests and both exercised
against a real database:

- An answer submitted for a hidden field is **discarded**, so a hand-made request
  cannot write to a field the form never showed — including one an automation
  routes on.
- A required field behind a condition that never fired is **not required**, so a
  valid submission is not refused over a question nobody was asked.

A cap of twelve passes stops a pair of contradictory conditions spinning. Twelve
is past any form a person builds by hand.

## Who may be asked what

`elementsFor` is the single filter, called by the renderer and again by the
submit path, so a question the page did not ask cannot be answered by a request
claiming it was.

Placing a field on a form does **not** override `visible_to_customer` /
`editable_by_customer`. Those flags are the field's own answer to whether a
customer may read and write it; a form placing "Root cause" would otherwise
publish an internal question to the help centre, which is the exact thing the
pair exists to prevent. An agent sees every placed field — the flags were never
about them — and the builder marks such fields _(agents only)_ so nobody is
surprised by a question the help centre leaves out.

`requester_name` and `requester_email` are asked only of somebody who is not
signed in; a signed-in customer retyping their address is one typo away from
filing the ticket against somebody else's record. `priority` is offered to agents
only, because customers grading their own urgency produce a queue that is
entirely urgent.

## Anonymous submission

An anonymous form resolves the address it was given onto whatever contact already
owns it, exactly as inbound email does. That is what makes the unified inbox
real, and it is also the exposure: a web form has no SPF or DKIM behind it, so a
stranger can open a ticket that lands on a real customer's record.

Confirming the address before creating the ticket loses every customer who could
not be bothered, and no helpdesk in this category does it. So the ticket says so
instead: an `unverified_submitter` event carries the claimed address and the
client address, and the console badges it — an agent reading the ticket
differently is the actual defence. A stranger still cannot rename a known
customer, because `resolveContact` only sets a display name when it creates the
row, and the identity it may create is unverified, so it grants no portal
sign-in.

## Per-locale wording

Two additive columns beside `ticket_fields.label`, not the knowledge base's
row-per-locale model: a field is one thing with one key and one stored answer
that happens to be _asked_ in two languages, and two rows would mean two keys on
a table whose whole point is that the key is unique.

`localised` resolves the reader's language, then the neutral label, then the
other language. The middle step is the one worth knowing: without it, translating
a field into Arabic would start showing that Arabic to every English customer,
which is the opposite of what translating it was for. Pass a blank fallback — a
form's name has only a slug behind it — and the other language is reached, which
is the `auto_responses` rule kept intact.

## Attachments

Files ride in the server action's own multipart body. There is deliberately **no
upload endpoint**: on a form that does not require signing in, an endpoint
accepting bytes before a ticket exists is an unauthenticated write to the storage
bucket — a free file host — needing its own session, its own rate limit and its
own sweep for objects whose form was never submitted.

They are checked _before_ the ticket is created, so a refused photo comes back
with the answers still in the boxes, and stored _after_ it commits, so a storage
failure loses the file rather than the ticket. A failure is written onto the
ticket as a system message: the customer is already told their file did not
arrive, and without this the agent is not.

`next.config.ts` sets `serverActions.bodySizeLimit` just above
`MAX_FORM_TOTAL_BYTES`, so the limit a customer actually meets is the one that
can explain itself rather than Next's own rejection, which says only that the
request failed. It is not larger, because the body is buffered in memory before
any application code runs — that number is also how much RAM one hostile request
can ask an instance for.

## Two things found on the way

**`Toggle` could not turn anything off.** An unchecked checkbox submits nothing
at all, which is invisible to a reader written as `get(name) !== 'off'` — the
shape every "on by default" setting here uses. Unticking Active on an SLA policy,
an automation, a status or a field saved it as active again. A hidden field
_after_ the checkbox makes an unticked box submit `off` while a ticked one still
reads as `on`, so both reader shapes agree and it is fixed in one place. This was
in the way because `deleteTicketForm` tells an admin to deactivate a form
instead, and that advice did not work.

**`lib/tickets/queries.ts` and `lib/forms/queries.ts` want to import each other.**
The ticket detail needs a form's name; the form query needs `listTicketFields`. A
cycle here fails as an undefined function at runtime rather than as a build
error, so the naming helpers live in `lib/forms/naming.ts`, which touches no
database and both sides can have.

## How it was verified

Beyond `tsc`, `eslint`, `vitest` and `npm run build`: the migration was applied
to an empty Postgres 17, `db/sql/` replayed twice to prove idempotency, and the
RLS loop confirmed to have picked `ticket_forms` up on its own.

Then the submit path itself, against that database, through a form with a
conditional field, a validation rule, an internal field and an on-create
automation matching `form.slug`:

- A submission answering the hidden `damage_kind` **and** the internal
  `root_cause` stored neither.
- The same form answered honestly revealed `damage_kind` and stored it.
- The required field behind a condition that _had_ fired was enforced.
- `SB1234` passed the pattern; `call me on SB1234 please` did not — the anchoring
  works.
- Group, priority, type and tags came from the form; the automation matched
  `form.slug` and added its tag; the subject interpolated; the answers landed in
  the first message with the dropdown rendered as its label rather than its
  stored value.
- Both anonymous submissions resolved to **one** contact, whose identity is
  unverified, and each ticket carried an `unverified_submitter` event.
- The agent path stored `root_cause` and produced no such event.

## What is deliberately not here

Embeddable forms on shipblu.com and offering a form from the chat widget. Both
were raised and both were deferred. The `elements` document and `submitForm` are
shaped so neither needs a schema change to add.
