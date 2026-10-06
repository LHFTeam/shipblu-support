# Merging contacts, and the register of ShipBlu locations

## Context

Two unrelated gaps, built together because they are both small and both about
saying out loud something the system already half-knows.

**Duplicate contacts.** `resolveContact()` creates a contact per channel
identity, and it is right to: at the moment a message arrives, nothing proves
that `ali@work.com`, `ali.h@gmail.com` and `+2010…` are one human. So one person
becomes two or three records — and there has never been a way to say they are the
same person. The console got its first contact page only in the shipment work;
this is the write that page was missing.

**Locations.** ShipBlu works out of hubs, warehouses and offices, and this
database has never been able to name one. A hub was whatever an agent typed into
a ticket.

Both are also a **terminology fix**: the console said "Customers" for a table
that has been called `contacts` since the first migration. It now says contacts,
on every screen and in the URL.

---

## 1. Contacts, not customers

`/customers` → `/contacts`, with `[id]`, `accounts/[sbid]` and
`shipments/[tracking]` beneath it as before. The nav item, page titles and copy
follow. `searchCustomers` → `searchContacts`, `CustomerActionState` →
`ContactActionState`, `CustomerSearch` → `ContactSearch`.

What deliberately did **not** change:

- **`db/schema/customers.ts`** keeps its name. The module holds companies,
  contacts, portal sessions and portal tokens — the customer-facing side of the
  schema — and every table in it is already named for what it is.
- **The word "customer" where it means the person on the other end of a ticket**:
  the customer portal, `last_customer_message_at`, "from customers" on the
  dashboard, a status's `customer_label`. A contact is a row; a customer is who
  writes in. Renaming those would have been a search-and-replace pretending to be
  a decision.
- **`plans/shipment-customer-tracking.md`**, which describes routes as they were
  when it was written. It is a record, not documentation.

---

## 2. Merging contacts

### The shape

One direction, fixed by the page: you are on the record you mean to keep, and
you fold a duplicate into it. A form that could merge either way is a form that
will one day retire the wrong record.

Three rules, and every awkward case follows from them:

**The loser survives as a tombstone.** `deleted_at` is set and
`merged_into_contact_id` points at the survivor; the row stays. A hard delete
would take its `(source_system, external_id)` with it, so the next importer run
would recreate the duplicate that was just merged away — and every bookmarked
link, quoted id and imported reference would 404 instead of landing on the
person. `/contacts/<old-id>` now **redirects** to the survivor.

**Nothing is copied; things move.** Identities, conversations, messages, account
memberships and parcel roles are re-pointed. Copying would leave two rows
claiming one fact, and they would diverge the first time anybody edited either.

**The survivor's own facts win.** A merge fills blanks and overwrites nothing.
Being told that two records are one person is not being told which name is
right.

### Schema (`db/schema/customers.ts`, migration `0006`)

- `contacts.merged_into_contact_id` — self-referential, `on delete set null`,
  indexed. The precedent is `conversations.merged_into_id`, which every read in
  the system already filters on.
- `contact_merges` — the audit row: survivor, loser, agent, and a `moved` jsonb
  of counts. Unique on `merged_contact_id`, so a contact can be merged away
  exactly once; the index is the guard, not the check in application code.

Counts rather than the ids of everything that moved: the row answers "this
happened, by whom, and how big was it", and the ids are recoverable because they
all point at the survivor now.

### Reconciliation (`reconcileContact`, pure and tested)

| Field                         | Rule                                                      |
| ----------------------------- | --------------------------------------------------------- |
| name, email, phone, timezone  | survivor's kept; adopted only if the survivor's is blank  |
| company                       | adopted only if the survivor has none                     |
| locale                        | adopted only if the survivor is still at the `en` default |
| custom fields                 | union, survivor's keys win                                |
| `is_shipper` / `is_recipient` | union                                                     |
| `is_blocked`                  | **never moves, in either direction**                      |

Two of those are worth the words:

- **Locale.** `contacts.locale` is `not null default 'en'`, so `en` means either
  "reads English" or "nobody ever said" — the column cannot tell them apart.
  Treating it as the second is what lets a merge pick up an Arabic preference
  without ever overwriting one.
- **Blocked.** Blocking is a decision about a _record_, not a fact about a
  person. An agent who blocked an obvious duplicate must not silently block the
  real customer by merging it away; a blocked survivor stays blocked. Whoever
  merges can block, in one click, on the page they are already on.

The role flags are a union rather than a re-derivation: every row behind them
has just moved to the survivor, so `refreshContactRoles()` would compute exactly
the same answer with two more `EXISTS` queries.

### The write (`mergeContacts`)

One transaction. The two contact rows are locked **in id order, not in role
order**, so two agents merging the same pair in opposite directions block each
other instead of deadlocking. `refuseMerge()` then runs against the locked rows —
the pure version is also used to render the page, but every one of its refusals
is a race as well as a mistake, and this is the check that counts.

Then, in order:

1. identities → survivor (no conflict possible; `(channel, identifier)` is
   already globally unique);
2. conversations → survivor, `returning` the ids, and a `requester_merged` event
   on each one. On the ticket, because that is where "why is this person's name
   different from yesterday?" gets asked. The same update fires the existing
   notify trigger, so an agent with one of those tickets open sees it;
3. messages → survivor;
4. account memberships: read, re-insert against the survivor
   `onConflictDoNothing`, delete the loser's. The composite primary key means
   both contacts holding one account is an ordinary collision — and in fact
   evidence they are the same person;
5. shipments: both `shipper_contact_id` and `recipient_contact_id`. A parcel
   naming the loser at both ends counts once;
6. tombstones already pointing at the loser are re-pointed at the survivor, so
   every chain stays one hop long and following one is a lookup, not a loop;
7. the survivor's patch, the loser's tombstone, the audit row.

`contact_sessions` and `contact_tokens` need no work: they hang off the
identity, which moved — so a merged customer stays signed in to the portal and
finds the combined ticket list there.

### Finding the duplicate

`mergeCandidates()` suggests contacts sharing an email, a phone or a name, and
says which. A shared address is a strong hint and a shared name is a weak one —
an Egyptian support desk sees the same common name several times a week — so the
reason is shown and the decision stays with the agent. `searchMergeCandidates()`
is the same list from a typed query, behind a `?merge=` parameter so it runs in
the same server query as the suggestions rather than through a second code path
that could show a contact this agent may not see.

Both exclude tombstones and soft-deleted contacts: merging a tombstone moves
nothing, and folding in a deleted contact would resurrect its tickets silently.

### Permission

New `contact.merge`, granted to supervisors and above — the same roles as
`ticket.merge`, for the same reason. An agent can correct a contact
(`contact.edit`); moving somebody else's tickets and retiring a record is a
heavier thing, and undoing it is not a click.

### What is not built

**Un-merge.** The tombstone says where the rows went but not which of them came
from where, so splitting them again would need per-row provenance on five
tables. The counts in `contact_merges` are what a mistaken merge is diagnosed
from; repairing one is a hand-written query today. Worth revisiting only if it
happens.

**Merging companies.** Duplicate companies are much rarer — `companies.name` is
already unique — and the same three rules would need a different fourth for
`domains`.

---

## 3. Locations

`locations`: `name`, `code`, `email`, `is_active`. Code and email are both
unique, because both are used as identifiers — one in conversation, one in a mail
client. `normaliseLocationCode()` uppercases and collapses spaces and
underscores onto a single hyphen before every write and lookup, so `cai-1`,
`CAI 1` and `CAI_1` are one hub and a plain unique index is enough. Same
discipline as agent emails and `contact_identities`.

**Deliberately joined to nothing.** No agent carries a location, no ticket is
attributed to one, nothing routes on one. This is the register of what exists,
entered once, so that whichever of those lands first has a real row to point at
instead of a free-text hub name typed a different way by every agent. Guessing
which to build now would mean guessing the column that carries it — and the
cardinality question ("can a supervisor cover three hubs?") is exactly the one
that is cheap now and a migration later.

**The email is on the record, not in the mail path.** It is the address an agent
escalates to or copies by hand. It is not a `channels` row, nothing routes
inbound mail by it, and mail arriving from it is treated like any other sender —
so a customer's reply cannot end up in a mailbox nobody is watching.

The admin screen is at `/admin/locations` (permission `admin.locations`, admins
and above) and states how many locations are entered and how many are
operating. No number of locations is expected; the settings overview flags only
an empty register, because then the side-conversation picker offers no hub.

A closed hub is marked not operating rather than deleted, so its code still
reads in the tickets that mention it. Deleting is for one entered by mistake.
Side conversations were the first thing to reference a location, and the delete
gained its in-use guard after them: one a thread has gone to is marked not
operating instead (`lib/locations/remove.ts`), because
`side_conversations.location_id` is `on delete set null` and an unguarded delete
would strip the hub off the thread without a word.

**No seed data.** Nobody had given us the names, codes and addresses, and
inventing them would put plausible-looking wrong codes in every environment.

---

## 4. Verification

`npx tsc --noEmit`, `npx eslint .`, `npx vitest run` and `npm run build` are all
clean.

Unit tests cover the parts where the reasoning lives, not the glue:
`reconcileContact` and `refuseMerge` (every rule in the table above, including
that the patch can never carry `id`, `deleted_at`, `merged_into_contact_id` or
`is_blocked`), `normaliseLocationCode` / `isValidLocationCode`, `looksLikeEmail`,
and the two new permissions.

The SQL those rules are wrapped in was exercised end to end against a throwaway
PostgreSQL 16 cluster: the full migration chain plus `db/sql` replay applies
clean (and `locations` picks up the `touch_updated_at` trigger from the loop that
scans for `updated_at` columns), and a merge of a fixture pair — two identities,
a ticket each, a shared shipping account, a parcel naming the loser at both ends,
and an older tombstone already pointing at the loser — moved exactly what it
reported, re-pointed the chain one hop, wrote one timeline entry on the one
ticket that moved, and refused the second attempt.
