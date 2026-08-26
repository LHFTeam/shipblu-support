# The help centre front page, and a public tracking page

## Context

Two designs arrived together: a redesigned help-centre landing page, and a
customer-facing tracking result page that did not exist. Both were drawn against
a **proposed** ShipBlu design system whose own readme says, in as many words, to
treat a real implementation as ground truth where one exists.

One does. `.kb-shell` in `app/globals.css` carries the live Freshdesk portal's
palette as verbatim hex, deliberately, so that this site and the one customers
already use do not look subtly unlike each other during the cutover. So this
change takes the designs' **structure** and leaves the **tokens** alone. Where
the design reached for a token this codebase has no equivalent of, the nearest
existing one is used — `--color-background-brand-subtle` is `--kb-band-soft`,
which is the same pale blue for the same reason.

The one place new tokens were added is delivery status: four tone pairs
(`--kb-status-*`), because a status badge needs a text colour and the tint it
sits on, and neither `--kb-yes` nor `--kb-no` — which the article feedback
buttons own — means "warning".

---

## 1. What the landing page is now

The old front page was `Hero` from `chrome.tsx`: a full-bleed blue band with one
search field on it, then a grid of category cards. It answered one of the two
questions people arrive with.

The new one answers both, side by side rather than stacked, because they are
asked by different people — a merchant wanting to know how settlement works, and
a recipient wanting to know where their box is. Stacking them makes the second
look like a footnote to the first.

Below that, four blocks, each of which **removes itself when it has nothing to
say**:

| Block            | Read from                                      | Empty when                      |
| ---------------- | ---------------------------------------------- | ------------------------------- |
| Common searches  | `popularTags` — the tags on published articles | no article carries a tag        |
| Browse by topic  | `listCategoryPreviews` — categories + 3 titles | nothing published               |
| Most read        | `popularArticles` — `view_count > 0`           | nobody has opened anything yet  |
| Recently updated | `recentlyUpdatedArticles` — `updated_at`       | nothing published               |
| Still need help  | three routes that exist, plus `widgetHours()`  | never; hours line may be absent |

A freshly imported knowledge base therefore renders as the front page it can
honestly be rather than as a page of empty furniture. All six reads go out in one
`Promise.all` — they are independent and hit different indexes, and this is the
most requested page on the site.

### Three things the design offered that are not here

- **A network-status banner.** There is no table an admin could write one into,
  and inventing one for a banner is a feature, not a redesign.
- **A WhatsApp contact card with a phone number on it.** No public ShipBlu
  number exists in this codebase or its configuration. `whatsapp_accounts` holds
  a WABA id and a token variable name, not a number anyone should ring. A support
  channel printed on a help centre has to be one that answers.
- **"84 articles, updated weekly."** The count is real and is rendered; the
  cadence is a claim nobody can keep.

### Why `popularTags` and not a search log

The design's row of one-tap searches wants to know what visitors type. Nothing
records that, and adding a table that does — collecting customer text to
decorate a page — is not a thing to do quietly inside a redesign. Tags are the
nearest true source: editors write them on articles as the words a customer would
use, and they already feed the search index, so a chip built from one cannot
return nothing.

---

## 2. The tracking page

`/{locale}/track`, a `GET` form and a server component, for the same reason
`SearchBox` is one: this is what a recipient standing on a pavement with one bar
of signal is trying to do, and it has to work before React has hydrated. The
number lands in the query string, so the result has a URL that can be
bookmarked, reopened and pasted to support.

### It shows almost nothing today, on purpose

`shipments` carries `tracking_number`, `status_label`, `status_at`, `sync_state`
and a `data` jsonb that nothing reads. **Nothing in this system writes
`status_label`** — the detector creates stubs, and the platform sync that would
fill them in is designed in `plans/shipment-customer-tracking.md` §7 and not
built. So every lookup today lands on "no delivery status for this number yet".

The page is written for both answers rather than for the one it currently gets:
`lib/shipments/status.ts` maps whatever label eventually arrives onto a stage, a
tone and a step, and the badge, the four-step line and the timestamp appear the
day the sync lands, with no change to this route. The mapping is
**presentation only** and never written back, which is what keeps the "no enum
for delivery status" decision in the earlier plan intact.

An unrecognised label draws the label alone, with no stepper and no tone. That
asymmetry is the whole design of the file: the person reading this page is
standing somewhere waiting for a box and will believe what it says.

### What is deliberately not on it

The design put the recipient's name, address, phone and the cash-on-delivery
amount behind a gate asking for the last four digits of the phone on the
shipment, plus one-tap actions that change a delivery.

- **The gate is not an identity check.** Four digits on a page anyone can reload
  is a few thousand guesses, and the phone number it checks against is the thing
  being protected. Anyone who has seen the outside of the parcel — a neighbour,
  a doorman, whoever the merchant forwarded the number to — can open this page.
  Signing in, where the ticket already carries the shipment, is the honest
  version of that screen, and it already exists.
- **The actions need write APIs that do not exist.** "Change the delivery
  address", "call the courier on a masked line" and "leave it with reception" are
  operations on the shipping platform. There is no client for it, in either
  direction.

What is there instead is what this system can actually do: ask support about
this shipment, with the number already in the subject — which is what
`lib/shipments/detect.ts` reads, so the ticket links itself to the parcel — and
an email link for the visitor who has no ShipBlu account, which is most of the
people who reach this page.

### Enumeration

The lookup is the only unauthenticated endpoint on the site that answers a
question about a specific identifier, so it is rate limited per address through
the same in-memory counter the KB feedback endpoints use — 40 a minute, generous
because a family checking one parcel from behind an office NAT is the normal
case. "Found" and "not found" are also rendered identically, under one message
that covers both, so the page is not an oracle for which numbers exist.

The page sends `noindex, nofollow` and `robots.txt` disallows `/*/track`: every
useful URL here carries somebody's parcel number, and a crawler that fetched one
would put it in a log even if it kept it out of an index.

---

## 3. Smaller things this touched

- `SectionHeading` gained a `meta` slot, so a count sits on the heading's
  baseline instead of on its own line.
- `SearchBox` gained a `placeholderKey`, so the front page can afford a
  placeholder that names an example question and a page header cannot.
- `Hero` was deleted from `chrome.tsx`. The band it used is still there for every
  page below the front door; the front page is the one page a visitor can tell
  apart by its layout, so it does not need the colour to say where they are.
- `clientIp` was split so a server component can pass `await headers()` — Next's
  `ReadonlyHeaders` is not a `Headers` and a page has no `Request` to reach for.
- `/portal/new` accepts `?subject=`, seeded from the tracking page. It is a
  default value on an editable field; the server still reads what was submitted.
- Six parcel icons were added to `components/icons.tsx`, chosen per topic by
  keyword against the category's own name in either language. An unrecognised
  name gets the generic tile: this is decoration, and decoration that misleads is
  worse than none.

---

## 4. Verified

Against a local Postgres with the migrations, the seed and a synthetic knowledge
base of 36 articles across six categories in both locales, plus one shipment
carrying `Out for delivery` and one bare stub. Both locales, both pages, at
1280px and 390px, rendered in Chromium with no console errors: the Arabic pages
mirror correctly, including the progress line, which runs right to left without a
second stylesheet.

`tsc`, `eslint`, `vitest` and `next build` are clean.

---

## 5. Left open

- **The real status vocabulary.** `lib/shipments/status.ts` matches keywords in
  English and Arabic and falls back to `unknown`. When the shipping team says
  what the labels actually are, that file is the one place to correct — and its
  test file is where a regression would be caught.
- **A public WhatsApp number**, if there is one. The contact panel has a slot for
  it the moment somebody can say what it is.
- **A network-status banner**, if operations want one. It needs somewhere for an
  admin to write it.
- **Shipment history.** The page shows one update because the schema holds one.
  A real timeline arrives with the platform sync, and `TrackingTimeline` in the
  design is the shape to build then.
