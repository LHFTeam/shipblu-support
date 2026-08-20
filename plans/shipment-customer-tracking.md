# Shipments, shipping accounts and customer roles

## Context

Nearly every ticket in this system is about a parcel, and the system has no idea
parcels exist. A grep of the whole repo for `shipment|tracking|sbid|shipper|
recipient|merchant` turns up only prose: KB article titles, the widget's "Ask us
anything about your shipments", and test fixtures reading "Where is my
shipment?". Meanwhile `lib/tickets/queries.ts` already carries the comment that
the tracking number an agent half-remembers "is in the messages, which is where a
search of a chat has to look" — the team is searching free text for the one
identifier the business runs on.

What this adds:

- a **shipment** identified by its tracking number, that one or many
  conversations can be attached to;
- the **customer's side** of that shipment — shipper or recipient — because the
  same ticket reads completely differently depending on which they are;
- a **ShipBlu shipping account (SBID)**, which has many users, and users who
  belong to many accounts;
- **search and navigation** by shipment and by customer;
- a seam for the eventual **read API**, so the shipping platform can ask "what
  conversations exist for this tracking number / this SBID?" without that
  endpoint having to invent the query when it is built.

The API endpoint itself is explicitly **not** built here. It is designed for: the
queries it would call are written and used by the console today, and they take no
`SessionAgent`, which is what keeps the seam real.

### The one open unknown

**ShipBlu's real tracking-number and SBID formats are not settled here.** The
default pattern requires letters _and_ digits, which is deliberately
conservative: it will under-detect until the real shape lands. That asymmetry is
the point — under-detection is repaired by one agent click and one backfill
re-run, while over-detection puts junk shipments on real tickets, in front of
agents, and eventually out over an API. The pattern lives in one tested file and
is overridable by environment variable without a deploy.

---

## The shape, in one paragraph

A `shipment` is a tracking number plus whatever we know about it. A
`shipping_account` is an SBID. Contacts link to shipping accounts many-to-many.
Conversations link to shipments and (separately) to shipping accounts, both
many-to-many. A contact carries `is_shipper` / `is_recipient`, maintained
additively from the relationship tables and also settable by an agent. The
customer's role _on a given conversation_ is **derived** from the shipment's
parties, never stored — so it cannot disagree with the shipment it describes.

---

## 1. Schema

New file `db/schema/shipments.ts`, exported from `db/schema/index.ts` after
`./conversations`. It imports from `./customers`, `./conversations`, `./agents`
and `./enums`; nothing imports back, so every FK can be declared in Drizzle
normally — the opposite of `groups.business_hours_id`, which needed a deferred FK
in `db/sql/` because `config.ts` and `agents.ts` genuinely reference each other.

Both new enums are `CREATE TYPE` on brand-new types, so none of the
`ALTER TYPE ... ADD VALUE` transaction awkwardness that `0004_tired_namora.sql`
had to respect applies here.

### Enums (`db/schema/enums.ts`)

- `shipment_sync_state`: `stub | synced | not_found`. `stub` says out loud that
  the row exists only to hang links off and every other column is null.
  `not_found` is what a detection false positive becomes once the platform is
  asked, and it is what makes them cleanable.
- `link_source`: `detected | manual | platform`. Only `detected` is ever removed
  in bulk when a pattern turns out to have been wrong.

**No shipment-status enum.** The delivery-status vocabulary belongs to the
shipping platform and will be renamed without telling us; an enum makes every ops
rename an `ALTER TYPE`. `status_label text` + `status_at` instead.

### Tables

| table                            | key columns                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shipping_accounts`              | `sbid` (unique, normalised), `name`, `company_id → companies` set null, `sync_state`, `last_synced_at`, `(source_system, external_id)` unique                                                                                 |
| `contact_shipping_accounts`      | PK `(contact_id, shipping_account_id)`, `link_source`, `linked_by_agent_id`; extra index on `shipping_account_id`                                                                                                             |
| `shipments`                      | `tracking_number` (unique, normalised), `shipping_account_id`, `shipper_contact_id`, `recipient_contact_id`, `status_label`, `status_at`, `sync_state`, `last_synced_at`, `data jsonb`, `(source_system, external_id)` unique |
| `conversation_shipments`         | PK `(conversation_id, shipment_id)`, `link_source`, `detected_in_message_id`, `linked_by_agent_id`; extra index `(shipment_id, created_at)`                                                                                   |
| `conversation_shipping_accounts` | PK `(conversation_id, shipping_account_id)`, same link columns; extra index `(shipping_account_id, created_at)`                                                                                                               |

`contacts` gains `is_shipper` / `is_recipient` booleans.

`(source_system, external_id)` goes on `shipping_accounts` and `shipments` — the
platform is the authority and a sync must be re-runnable against its own ids, the
same reason every other customer-facing table carries them. The join tables get
none: their natural key _is_ the composite PK, so a sync is already idempotent,
and inventing a stable platform id for a membership would be a unique index that
lies.

The join tables also get no `updated_at`, which means the `touch_updated_at` loop
in `db/sql/001` skips them — fewer tables needing DDL on a future deploy (§6.15).
`shipments` and `shipping_accounts` do have it and pick the trigger up for free.

### Why `conversation_shipping_accounts` exists

Three reasons, all about honesty:

1. Seeing "my account is SB-4471" in a message does **not** prove the sender
   belongs to that account — a recipient quoting the merchant's SBID is common.
   Writing `contact_shipping_accounts` from a mention would be exactly the
   guessed role this design forbids. The conversation-level link asserts only
   what is true: this SBID was mentioned in this ticket.
2. "Conversations by SBID" becomes one indexed query instead of a UNION, and a
   ticket that mentions an SBID with no tracking number is otherwise invisible to
   it.
3. Unlinking a false positive is a row delete, not the unpicking of a claim about
   a person's identity.

### Why the conversation↔shipment link has no `customer_role`

The requester's role is a fact about _(contact, shipment)_, and `shipments`
already holds it in `shipper_contact_id` / `recipient_contact_id`. Storing it on
the link duplicates it and creates a pair that can disagree the first time a sync
corrects the shipment.

So it is derived, by a pure function in `lib/shipments/roles.ts`:

```ts
export type RequesterRole = 'shipper' | 'recipient' | 'both' | 'other' | 'unknown';
```

- `stub`, `not_found`, or both party columns null → `unknown` (**not** `other` —
  we have not asked)
- requester matches both → `both` (real: returns, and merchants shipping to
  themselves)
- matches one → that one
- `synced`, parties known, requester matches neither → `other`

That last value is why deriving is correct. A third party genuinely does write
in — the merchant's ops person, a 3PL, a family member collecting a parcel, or an
agent who linked the wrong number. A stored two-valued column would print a
confident falsehood on exactly the tickets where an agent most needs to slow
down.

### Contact-level designation

`is_shipper` / `is_recipient` are maintained by `refreshContactRoles()` from the
relationship tables — a person is a shipper because they hold a shipping account,
a recipient because a shipment names them — and are also settable by an agent on
the contact page. Automatic maintenance is **additive only**: it turns a flag on
when it can prove it and never off, so a sync can never silently undo a
designation a human made.

### `db/sql/001_extensions_and_triggers.sql`

Three trigram indexes appended to the fuzzy-search block:
`shipments (tracking_number)`, `shipping_accounts (sbid)`,
`shipping_accounts (name)`. These carry the _partial_ search an agent types from
memory; every exact lookup goes through the unique btree.

**Trap to record:** do not reach for `CREATE INDEX CONCURRENTLY` in `db/sql/`.
`db/migrate.ts` sends each file as one `sql.unsafe(contents)`, which wraps it in
an implicit transaction, and `CONCURRENTLY` cannot run inside one. These three
build on empty tables today; a future index on `messages`-scale data needs its
own migration.

---

## 2. Detection — `lib/shipments/`

Pure modules, no `db` import, so they are safe to import from `lib/tickets/search.ts`
and testable with no database.

**`format.ts`** — `normaliseDigits` (Arabic-Indic U+0660–0669 and Extended
Arabic-Indic U+06F0–06F9 → ASCII), `normaliseTrackingNumber`, `normaliseSbid`.
Arabic-Indic digits matter because half the inbound volume is Arabic WhatsApp;
bidi and zero-width marks matter for the same reason `lib/kb/slug.ts` had to
handle them — a number pasted out of an RTL message carries U+200F, and
`'SB123‏' !== 'SB123'` silently defeats the unique index.

**`detect.ts`** — `detectShipmentRefs(text, patterns)`. Defaults live in the file
(reviewed, versioned, tested); `SHIPMENT_TRACKING_PATTERN`,
`SHIPMENT_SBID_PATTERN` and `SHIPMENT_IGNORE` in `lib/env.ts` are the escape
hatch. Patterns compile once into a module cache and **fall back to the default
with a loud error if an env pattern does not compile** — a malformed regex in an
environment variable must never take down ingestion.

False-positive guards, each tested:

1. neighbouring `[A-Za-z0-9_]` rejects the middle of a longer token
2. a leading `#` is a ticket reference — `parseSearchTerm` already owns that
   namespace and the two must not collide
3. adjacency to `@` means an email address
4. a 10–13 digit run beginning `01` or `20` is an Egyptian mobile
5. an ignore list, for the canned response or signature containing a worked
   example that would otherwise link every ticket that used it
6. dedupe on the normalised value, then cap at 25 per message, so a pasted
   900-row CSV does not create 900 stubs

---

## 3. Auto-linking

`lib/tickets/lifecycle.ts` gains a **new** seam rather than a fourth argument on
`afterInboundMessage`:

```ts
afterMessageStored({ conversationId, messageId, bodyText, kind, direction });
```

Two reasons it is separate. `afterInboundMessage` is deliberately **skipped** for
the `whatsapp_bot` channel, because SLA clocks, automations and CSAT must not run
on a conversation nobody is working — but none of those reasons apply to linking,
and bot transcripts are exactly where tracking numbers appear in bulk and exactly
what the platform's query wants to find. And an optional parameter that silently
no-ops at the call sites nobody updated is the §6.14 failure shape.

It runs **before** `runAutomations` so a future rule can ask "does this ticket
have a shipment", and is wrapped in try/catch that logs and swallows: a detection
bug must never fail an ingest job, which would retry everything downstream of it.

After a successful link it touches `conversations.updated_at`, which fires the
existing `notify_change` trigger and makes the sidebar appear on the current SSE
refresh rather than the next one — the message's own NOTIFY fires at commit time,
before the link exists.

**Call sites (10).** Inbound: `ingest.ts`, `ingest-whatsapp.ts` (outside the
read-only-channel guard), `ingest-meta.ts` ×2, `widget/conversation.ts`,
`portal/tickets.ts` ×2. Outbound: `sendReply`, `addNote`, `sendTemplateReply` in
`app/(console)/actions.ts`.

**Outbound is included** for `reply` and `note` and template sends. The common
sequence is: customer asks where their parcel is, agent looks it up on the
platform, pastes the number into the reply or a note. Skipping outbound loses a
large share of exactly the tickets worth linking. `sendTemplateReply` matters
most — the `shipment_update` template's body is literally
`"Hi {{1}}, your shipment {{2}} is out for delivery today."`

**Not** `system` (generated bodies) or `forward` (by definition someone else's
thread; linking from it attributes another conversation's shipments to this one).
The kind filter lives inside `linkShipmentsFromMessage` so the live path and the
backfill cannot drift.

**What it writes.** Race-safe stub upserts on the unique index (the same
adopt-the-winner shape as `resolveContact`), then the link with
`onConflictDoNothing`, and **only if the link insert returned a row** does it
write the audit event. That one condition is the whole idempotency story: a
re-ingested message writes nothing, and a customer who repeats the number in
eleven replies produces one link and one audit entry.

Audit types: `shipment_linked` / `shipment_unlinked` /
`shipping_account_linked` / `shipping_account_unlinked`, with
`actorLabel: 'shipment-detector'` for automatic ones and `actorAgentId` for
manual, following the existing system-actor convention.

**Never:** create a contact; set `shipper_contact_id` / `recipient_contact_id`;
write `contact_shipping_accounts` from detected text; overwrite a `synced`
shipment; delete a link; throw.

---

## 4. Search

**Explicit prefixes, plus inference.** `track:` / `tracking:` / `awb:` and
`sbid:` / `account:` narrow to a single clause — which is what keeps
`track:SB123456789` one index lookup instead of a trigram scan of every message
body. A prefix with an empty rest degrades to an ordinary text search rather than
returning nothing. Without a prefix, a query that is _exactly one_ reference also
sets the field, but `scope` stays `'any'` so the existing five clauses still run.

Inference reuses the detector — one definition of "what a tracking number looks
like", shared by ingest, search, backfill and the future API.

`listInbox` gains two clauses written as `IN (…)` so the plan starts at the
selective side: one unique-index probe for the shipment or account, then a
handful of conversation ids. The SBID clause has two branches — conversations
that mention the account, and conversations whose _requester belongs to_ it —
and the second is what finds a merchant's tickets that never quoted the number.

The SBID clause joins its two branches with a `UNION` inside one `IN`, not an
`OR` of two `IN`s. The `OR` was written first and measured second: an `OR`
across two different columns of `conversations` cannot be answered from an
index, so the planner hashed both subqueries and sequentially scanned the whole
table — 9.7 ms and 50,001 rows discarded at 50k conversations, against 0.37 ms
and no scan for the `UNION`. Check this with `EXPLAIN ANALYZE` against the SQL
the app actually emits, not a hand-written approximation of it.

**No new URL parameters:** the prefixes live inside `q`, so `parseFilters` and
`list.tsx`'s ref-held debounce (which exists because putting `onSearch` in the
deps array broke search entirely — commit `f43a113`) are untouched. The only UI
change is the placeholder.

Restricted-channel behaviour is unchanged: with `channel=all` the bot channel is
still excluded, so finding a bot transcript by tracking number still means
filtering to the channel first.

---

## 5. Console

**Ticket sidebar** gains a Shipments section (tracking number, status or
"not synced yet", the derived role in plain words, an `auto` marker for detected
links, two-click unlink) and a Shipping accounts section, plus a `TagField`-style
add control — no modals, because this codebase has none.

**Four routes under `/customers`** so one nav item lights up correctly:
`/customers`, `/customers/[id]`, `/customers/accounts/[sbid]`,
`/customers/shipments/[tracking]`. All gated on `contact.view` / `contact.edit`,
which have existed in `lib/auth/permissions.ts` since the start and are checked
nowhere — this is what finally uses them.

Two traps these must respect: **§6.6**, Next hands dynamic params over
percent-encoded, so `[tracking]` and `[sbid]` need `decodeSlugParam()` _and_ then
normalisation; and **visibility is enforced in SQL, never the template**, so the
conversation lists share one exported `conversationVisibility(agent)` helper with
`listInbox` rather than re-implementing the rule in four new files.

New server actions in `app/(console)/actions.ts`: `linkShipment`,
`unlinkShipment`, `linkShippingAccount`, `unlinkShippingAccount` (permission
`ticket.edit_fields`), plus `setShipmentParty` and `setContactRoles` on the
customer pages (`contact.edit`). `linkShipment` normalises but deliberately does
**not** validate against the detection pattern — an agent reading a number off a
label is more authoritative than our guess at the format.

---

## 6. Backfill

`worker/handlers/backfill-shipment-links.ts`, job type
`backfill_shipment_links`. Cursor-paged over `messages` by `(created_at, id)`,
500 a batch, served by the existing `messages_created_idx`. Applies the same
kind/direction filter as the live path by calling the same function. Idempotent
by construction; re-running after widening a pattern picks up new matches and
touches nothing else. **Does not delete** — narrowing a pattern is a separate
deliberate prune, and one that must filter on `link_source = 'detected'` so it
can never remove an agent's work.

Reporting follows §6.14. The dimension that can fail here is **channel**:
`body_text` is populated by five ingest paths with different quirks, and a total
of "4,812 links created" would hide "zero from Instagram, ever". So the handler
always prints a per-channel matrix — messages, with_body, tracking hits, sbid
hits, links created — and names any channel that had messages but no matches at
all.

Because `npm run job -- <type>` passes `{}`, a bounded or dry run is enqueued as
a row, the same route PROJECT-STATE §5.4 documents for `rollup_metrics`.

---

## 7. The platform API seam

`lib/shipments/queries.ts`, written now and used by the console today:

```ts
conversationsForTrackingNumber(trackingNumber, scope?)
conversationsForSbid(sbid, scope?)
getShipmentByTrackingNumber(trackingNumber)
getShippingAccountBySbid(sbid)
contactsForSbid(sbid)
shipmentsForConversation(conversationId)
shippingAccountsForConversation(conversationId)
```

Note what is absent: no `SessionAgent`. The console wraps them with the agent's
permissions, the future endpoint with the key's. Baking `can()` in would force
the endpoint to invent a fake agent — which is how an API ends up with an account
that has more reach than any human. `ReadScope` is passed in instead.

The eventual endpoint: `GET /api/platform/conversations?tracking=…|sbid=…` under
a prefix registered in `proxy.ts`'s `PUBLIC_PREFIXES`, authenticated by an opaque
bearer key stored only as a SHA-256 — `generateToken` / `hashToken` / `safeEqual`
already exist in `lib/auth/tokens.ts` and the widget's visitor token is the
working precedent. It returns conversation summaries and a deep link, **never
message bodies**, on the same reasoning as the deliberately tiny `pg_notify`
payload.

---

## 8. Order of work

1. Schema, migration, trigram indexes
2. `format.ts`, `detect.ts` + tests, env vars
3. `roles.ts` + tests, `links.ts` write layer
4. `afterMessageStored` seam and its ten call sites
5. `queries.ts` read model, sidebar, link/unlink actions
6. Search prefixes and clauses
7. Customer / account / shipment pages, nav
8. Backfill job and its admin entry point
9. Docs

---

## 9. Decisions taken, and what is left open

Taken here, with reasons above: the fifth table; deriving the per-conversation
role rather than storing it; additive-plus-manual contact flags; linking from
outbound replies and notes; linking bot transcripts in the data while keeping
them out of every UI list.

Left open, and worth answering before this carries real traffic:

- **The real tracking-number and SBID formats.** Everything else works without
  them; detection does not.
- **Recipient identity matching.** Auto-setting `recipient_contact_id` from a
  phone match is the most dangerous guess available — shared household phones,
  call-centre numbers, merchants using their own number. Not done, in v1 or in
  the sync.
- **Who wins when a platform sync and an agent disagree** about a shipment's
  parties. Cheaper to decide before the sync is built than after.
- **API blast radius:** one server-to-server platform key, or per-merchant keys?
  It determines whether `shipping_account_id` belongs on the key row, which is
  much cheaper to decide than to retrofit.
- **Merges.** `conversations.merged_into_id` exists but no merge action is
  implemented. When one is, shipment links must follow the merge or the platform
  endpoint silently misses conversations.
