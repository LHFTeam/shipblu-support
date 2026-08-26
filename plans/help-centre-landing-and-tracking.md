# The help centre front page, and a public tracking page

## Context

Two designs arrived together: a redesigned help-centre landing page, and a
customer-facing tracking result page that did not exist. Both were drawn against
a **proposed** ShipBlu design system, shipped alongside them as a set of token
files and a component bundle.

The structure and the palette both come from those designs. `.kb-shell` in
`app/globals.css` used to carry the live Freshdesk portal's hex, and now carries
the design system's `tokens/colors.css` instead — so the swap reaches every page
under `app/help/`, not only the two the redesign covered. What that costs is
named in §1 below; the alternative, two palettes in one site, is the drift this
codebase is otherwise careful about.

Two layers in that block, deliberately. The system's primitives and semantic
names are transcribed first, verbatim, so a token can be checked against the
system by reading it rather than by tracing a conversion. The `--kb-*` names the
existing pages already speak are then pointed at them. A page written against
`--kb-muted` keeps working and now means the system's secondary text.

What did **not** come across:

- **Typography.** The system substitutes Geist and Rubik and says so — no brand
  fonts were supplied to whoever drew it. Lato and Tajawal are this site's, from
  the live portal, and they are the ones customers already read.
- **Radii, spacing and elevation**, beyond `--elevation-card`. The ask was the
  palette, and geometry is where a token swap turns into a layout change.
- **`[data-theme="dark"]`.** This site has no theme switch, so its dark values
  live under the `prefers-color-scheme` query the site already answers.
- **Its component bundle.** These are server components reading from Postgres;
  a client-side bundle of React components is a different thing entirely.

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

### The service notice

The design's banner is built and sits above the content on **every** help centre
page, not only the front one: the visitor a delay notice is for is as likely to
have arrived on an article from a search engine, and a notice that only appears
at the front door is not much of a notice.

Its text is an environment variable — `KB_NOTICE_EN`, `KB_NOTICE_AR`,
`KB_NOTICE_HREF`, `KB_NOTICE_TONE` — because there is nowhere else for it yet.
That is the cheapest seam that is still real: ops can put a delay warning in
front of every customer from the Render dashboard, and when a `service_notices`
table with a start, an end and an author lands, `lib/kb/notice.ts` is the one
file that changes. **Unset is no banner**, which is the only safe default: an
operational claim about ShipBlu's network has to be one somebody actually made,
so there is no placeholder text to go stale.

One decision in it is uncomfortable and deliberate. A notice written in only one
language is shown to **everyone**, carrying its own `lang` and `dir`, rather than
withheld from the readers it does not cover. The failure that avoids is an ops
person filling in the English box, walking away, and every Arabic reader — the
majority of this site — silently getting no warning about a delay affecting their
parcel. A banner in the wrong language is visibly wrong and gets translated; a
banner nobody sees is invisibly wrong and does not.

### Two things the design offered that are not here

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

The tone it maps onto is the design system's **canonical logistics taxonomy** —
`in-transit`, `out-for-delivery`, `delivered`, `attempted`, `returned`,
`exception` — rather than a generic four. That is worth the extra names for one
reason: the system gives `out-for-delivery` violet of its own instead of sharing
blue with `in-transit`, and that is exactly the distinction a recipient checking
their phone is looking for. There is a test asserting the two never collapse.

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
- `Hero` was deleted from `chrome.tsx`, and `Band` gained a `subtle` tone. The
  system is explicit that blue is the action colour and never a page background
  outside an auth or marketing panel, so a full-bleed blu-500 slab with a title
  on it is the loudest thing on a page and says nothing. The front page has its
  own pale hero and the tracking page is on `subtle`; the other four page types
  still wear the solid band, because moving them is a change to their layout
  rather than to their colours. That is the obvious next piece of work and it is
  not this one.
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
carrying `Out for delivery` and one bare stub.

Because the palette is site-wide, the check was too: the front page, the tracking
page in all its states, a category, an article, a search result and the sign-in
form, in both locales, at 1280px and 390px, light **and** dark, rendered in
Chromium with no console errors and no failed requests. The Arabic pages mirror
correctly, including the progress line and the notice banner, which run right to
left without a second stylesheet. The banner was then verified absent on every
page with its variables unset.

`tsc`, `eslint`, `vitest` and `next build` are clean.

---

## 5. Left open

- **The real status vocabulary.** `lib/shipments/status.ts` matches keywords in
  English and Arabic and falls back to `unknown`. When the shipping team says
  what the labels actually are, that file is the one place to correct — and its
  test file is where a regression would be caught.
- **A public WhatsApp number**, if there is one. The contact panel has a slot for
  it the moment somebody can say what it is.
- **Somewhere to write a service notice.** The banner is built; a
  `service_notices` table with a start, an end and an author is what turns four
  environment variables into something ops owns.
- **The remaining four page types.** They still wear the solid blue band the
  design system would not have given them.
- **Shipment history.** The page shows one update because the schema holds one.
  A real timeline arrives with the platform sync, and `TrackingTimeline` in the
  design is the shape to build then.
