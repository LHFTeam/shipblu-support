# The help centre on the v02 design

## Context

The help-centre design moved on after `plans/help-centre-landing-and-tracking.md`
built the front page and the tracking page. The Claude Design project "ShipBlu
support landing page v02" draws four screens for the public site: the front page
in both languages, a topic (category) page, an article page and a tracking result.
This change moves the help centre's knowledge-base pages onto the first three.
The tracking result is not part of it (see §5).

That earlier plan left one obvious next piece of work: four page types still wore
the solid blue band. The v02 design is the answer to it, so every page below the
front door now shares one header shape.

What came across: the layout and component shapes of all three screens, the
illustrations, and the interaction details (the accent word in titles, the
sticky Topics list and article rail, the feedback card, the next-article cards).

What did not: sample copy that makes promises nothing here keeps, the data the
design assumes and the schema does not hold, and the design system's typography.
Lato and Tajawal stay, for the reason the earlier plan gives. §4 lists each one.

---

## 1. One shape for every page

`app/help/[locale]/chrome.tsx` holds it, so a public page is still composed rather
than styled:

- **`PageHeader` is one pale band.** The trail, the title, a lede, a meta row, an
  optional illustration at the band's end, and an optional field under the title.
  The trail used to sit on a white strip of its own above a separate title band.
  Folded into the band, the header reads as one object. The compact search stays
  at the trail's end unless a page brings its own: the topic pages bring a
  "Search in …" field, and the search page moves its field under the title.
- **`AccentTitle`** draws one word of a title in the brand blue, as the design
  does on the front page and on topic titles. On a page header that is the last
  word in English and the first in Arabic, the head of the phrase, since the last
  word of «شركاء شيب بلو» is half the brand name (§4). The front page's hero
  keeps the last word in both languages: «كيف يمكننا مساعدتك؟» ends on the word
  the sentence is about. A one-word title is drawn plain, because colouring all
  of it would make the whole heading the accent.
- **`ArticleRow`** is the design's row: book icon, title in link blue, excerpt,
  chevron, with the whole row as the link.
- **`HelpCta`** is the pale "Didn't find your answer?" / "Stuck on a step?" band
  at the foot of topics and articles: the headset drawing, one sentence, the
  real `Availability` line, and a Contact support button that opens the chat.
- **Header and footer** (`layout.tsx`):
  - Header: Knowledge base and Contact (the front page's `#topics` and
    `#contact`), Track a shipment, an EN | ع switch, and Sign in as a secondary
    button. On a switch only the other language is a link. The current one is a
    selected label, not a link to the page already open.
  - Footer: light, as the design draws it, where it used to be the navy inverse
    surface.

## 2. The illustrations

The design's eight drawings live in `app/help/[locale]/art/` and are imported
statically (`art.tsx`). They are not in `public/` because the help-centre host
rewrites every path except Next's own under `/help`, and a file at `/art/x.webp`
would be rewritten out of existence. A static import is served from
`/_next/static/media` with a content hash, which the proxy passes through on
every host. It also gives the image's own size, so nothing jumps. They are plain
`<img>` elements, because the optimiser would spend a request re-encoding 5–32 KB
drawings at the size they were exported.

`lib/kb/art.ts` matches a topic to its drawing by the topic's own name, in either
language, most particular subject first ("Lost shipments" is a claim before it is
a shipment). The design's sample topics are six subjects. Production's top level
is two audiences, so those are named too:

- "ShipBlu Partners" / "شركاء شيب بلو" → the store drawing
- "ShipBlu Customers" / "عملاء شيب بلو" → the parcel

An unrecognised name, such as "FAQs", gets no drawing, and the layouts close up
around its absence. A folder with no drawing of its own borrows its category's.
The payments drawing has Arabic text in the artwork itself. It is the design's own
asset and is shown on the English page too.

## 3. What the pages read

- `getCategory` returns every readable article per folder, with its excerpt.
  This replaces three titles and a "View all", because the design lists a topic
  in full. It also returns the newest edit among them for "Last updated".
  `getFolder` returns the same date. Every count and list is in the page's own
  locale, so a topic never says "12 articles" over six rows.
- **An edit date is read from the versions, never from `updated_at`.**
  `touch_updated_at` moves `kb_articles.updated_at` on every view and every
  feedback tap (PROJECT-STATE §6.51), so the date there follows readers. The
  pages read `editedAt` in `lib/kb/queries.ts` instead: the newest
  `kb_article_versions` row, cut only when a title or body changes, or the
  publication date, or the creation date. "Last updated", "Recently updated",
  the folder and topic dates and the sitemap's `lastmod` all read it.
- `folderNeighbours` reads the folder once and answers both "Next article", the
  article after this one in the folder's own order (null on the last rather than
  wrapping round), and the rail's related list, the rest of the folder by
  helpful votes.
- `searchArticles(…, withinCategory)` backs a topic's "Search in …". The field
  is a plain GET form to `/search?q=…&c=<slug>`, so it works before React has
  hydrated. The search page resolves `c` only among the categories the reader can
  see, so a guessed slug cannot print an internal category's name.
- `lib/kb/outline.ts` gives the article page its "On this page" and reading
  time:
  - It adds an `id` to each `<h2>` that has none, numbering around every id the
    body already uses.
  - It reads each heading as text.
  - It never touches a text node.

  This is not sanitising on read. The stored body is sanitize-html's output and
  stays the source of truth; the outline only adds anchors.

## 4. Where the pages differ from the design, and why

| The design has                                                  | This has                                                            | Because                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A WhatsApp card with a number, "replies in about 15 min"        | The contact form, email, and sign in / my tickets                   | No public WhatsApp number exists. A channel printed on a help centre has to answer, and a reply time nobody measures is a promise. |
| Printed opening hours                                           | `Availability`, from the schedule the chat widget is gated on       | Printed hours would disagree with the launcher the day the schedule changed.                                                       |
| "84 articles, updated weekly"; "answered in under a minute"     | The count alone; the existing lede                                  | Neither cadence nor speed is measured.                                                                                             |
| "It starts with SB"; placeholder `SB-4820-1193`                 | The existing hint; a 13-digit placeholder that is not a real number | Tracking numbers are thirteen digits. A live one as a placeholder would publish that parcel's recipient (PROJECT-STATE §6.38).     |
| Audience chips and "Merchants"/"Recipients" on each article     | Nothing                                                             | Articles carry no audience. In production the two categories already are the two audiences, and the Topics list offers them.       |
| Topic search filtering the list in place                        | A GET form to the scoped search page                                | It works without JavaScript, and the empty state lives where the search does.                                                      |
| The current page at the end of the breadcrumb                   | The trail ends at the parent                                        | The title is immediately below it (an earlier, deliberate decision).                                                               |
| Merchant portal, Service status, Coverage, Terms, Privacy links | Help centre, Track a shipment, Contact support, the support address | None of those pages has an address this system knows, and a dead link is worse than none.                                          |
| No tracking link in the header                                  | Track a shipment in the header                                      | The visitor who needs it most arrived on an article from a search engine.                                                          |
| No search on the article page                                   | The compact search at the trail's end                               | A reader on the wrong article can try again without going back to the front page.                                                  |
| "No, I still need help" offering Contact support at once        | A comment box first, then Contact support                           | Asking only the readers an article failed is where the useful sentence comes from.                                                 |
| Three topic cards a row                                         | Two, for production's two topics                                    | Two cards in a row of three leave a hole that reads as a card that failed to load.                                                 |
| Semibold (600) headings in Geist                                | Bold in Lato                                                        | Lato ships 400/700/900, and the help centre keeps the typefaces customers already read.                                            |
| Tertiary meta text on the pale band                             | Secondary                                                           | Contrast on the tint.                                                                                                              |
| Contact support → the front page's list of channels             | Opens the chat (`AskSupport`), with `/forms` as the link underneath | Production has no ticket form, so `/forms` redirects to a sign-in most readers cannot pass; the chat needs no account.             |
| The title's last word in blue, in Arabic too                    | The head of the phrase in Arabic (`lib/kb/accent.ts`)               | Arabic puts the topic word first: the last word of «شركاء شيب بلو» is half the brand name.                                         |

## 5. Left open

- **The tracking result screen.** The design's tracking result is a separate
  screen with a gate on the recipient's phone digits and actions that change a
  delivery. The earlier plan explains why neither is built. The tracking page
  keeps its current layout under the new chrome.
- **`updated_at` itself still moves on every view.** The help centre no longer
  reads it (§3), but the console's article list and anything else that does
  still follows readers once the help centre is live. The fix is a trigger
  change in `db/sql/`, with its locking care, queued as its own task.
- **An audience on the article**, if the design's chips are wanted beyond what
  the two categories already give.
- **The addresses** of the merchant dashboard, the status page and the terms and
  privacy pages, which would let the header and footer carry the design's
  remaining links.

## 6. Verified

Verified against a local Postgres seeded in production's shape: two audiences
with their folders, in both locales, with excerpts, headings and tags. The
checks:

- Every page type in English and Arabic, at 1280, 1024, 390 and 360: no
  horizontal overflow, no console errors and no failed requests.
- The article page in print: the rail, feedback, pager, band and search stay out
  of the printout.
- `tsc`, `eslint`, `lint:strict`, `prettier`, `vitest`, `knip`, the repo rules
  and `next build` are clean.
