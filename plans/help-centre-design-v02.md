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

What did not: sample copy that makes promises nothing here keeps, and the data
the design assumes and the schema does not hold. §4 lists each one. A second
pass (§6) brought the front page's topic cards and the design's typeface across
once the owner had compared the live page with the design.

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

The design's drawings live in `app/help/[locale]/art/` and are imported
statically (`art.tsx`). They are not in `public/` because the help-centre host
rewrites every path except Next's own under `/help`, and a file at `/art/x.webp`
would be rewritten out of existence. A static import is served from
`/_next/static/media` with a content hash, which the proxy passes through on
every host. It also gives the image's own size, so nothing jumps. They are plain
`<img>` elements, because the optimiser would spend a request re-encoding 5–32 KB
drawings at the size they were exported.

`lib/kb/art.ts` matches a topic to its drawing by the topic's own name, in either
language, most particular subject first ("Lost shipments" is a claim before it is
a shipment), and only at the start of a word. The design's sample topics are six
subjects. Production's top level is two audiences, and its subjects are the
folders under them, so both are named:

- "ShipBlu Partners" / "شركاء شيب بلو" → the store drawing
- "ShipBlu Customers" / "عملاء شيب بلو" → the parcel
- Partners' six folders, each with its own drawing: FAQs → the questions
  drawing, Financials → payments, Integrations → the store, Policies and
  Regulations → the claims shield, ShipBlu Unique Products → the account
  drawing, Shipping Services → the parcel
- Customers' two: FAQs → the questions drawing, myBlu Support → the account
  drawing

An unrecognised name gets no drawing, and the layouts close up around its
absence. On its own page a folder with no drawing of its own borrows its
category's; its card on the front page draws none.
The payments drawing has Arabic text in the artwork itself. It is the design's own
asset and is shown on the English page too.

## 3. What the pages read

- `getCategory` returns every readable article per folder, with its excerpt.
  This replaces three titles and a "View all", because the design lists a topic
  in full. It also returns the newest edit among them for "Last updated".
  `getFolder` returns the same date. Every count and list is in the page's own
  locale, so a topic never says "12 articles" over six rows.
- **An edit date is read from the versions, never from `updated_at`.** When
  this was written `touch_updated_at` moved `kb_articles.updated_at` on every
  view and every feedback tap (PROJECT-STATE §6.51), so the date there followed
  readers. That is fixed since (§5), but the column still moves for a change of
  folder, status, visibility or tags, which is not a revision a customer reads.
  The pages read `editedAt` in `lib/kb/queries.ts` instead: the newest
  `kb_article_versions` row, cut when a title or body changes or a version is
  restored, or the publication date, or the creation date. "Last updated",
  "Recently updated", the folder and topic dates and the sitemap's `lastmod` all
  read it.
- `listTopicFolders` gives the front page its cards: each audience with its
  folders, and each folder's count, description and first three titles, in the
  folder page's own order. A folder with nothing the reader may open in the
  page's locale has no card, and an audience with no card has no group.
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
| "84 articles, updated weekly"; "answered in under a minute"     | The count alone; the lede's first sentence                          | Neither cadence nor speed is measured.                                                                                             |
| "It starts with SB"; placeholder `SB-4820-1193`                 | The existing hint; a 13-digit placeholder that is not a real number | Tracking numbers are thirteen digits. A live one as a placeholder would publish that parcel's recipient (PROJECT-STATE §6.38).     |
| Audience chips and "Merchants"/"Recipients" on each article     | Nothing                                                             | Articles carry no audience. In production the two categories already are the two audiences, and the Topics list offers them.       |
| Topic search filtering the list in place                        | A GET form to the scoped search page                                | It works without JavaScript, and the empty state lives where the search does.                                                      |
| The current page at the end of the breadcrumb                   | The trail ends at the parent                                        | The title is immediately below it (an earlier, deliberate decision).                                                               |
| Merchant portal, Service status, Coverage, Terms, Privacy links | Help centre, Track a shipment, Contact support, the support address | None of those pages has an address this system knows, and a dead link is worse than none.                                          |
| No tracking link in the header                                  | Track a shipment in the header                                      | The visitor who needs it most arrived on an article from a search engine.                                                          |
| No search on the article page                                   | The compact search at the trail's end                               | A reader on the wrong article can try again without going back to the front page.                                                  |
| "No, I still need help" offering Contact support at once        | A comment box first, then Contact support                           | Asking only the readers an article failed is where the useful sentence comes from.                                                 |
| Six subject cards in one grid                                   | A card per folder, under a heading per audience                     | Production's subjects are its folders, and "FAQs" is a different list for merchants and for recipients.                            |
| Tertiary meta text on the pale band                             | Secondary                                                           | Contrast on the tint.                                                                                                              |
| Contact support → the front page's list of channels             | Opens the chat (`AskSupport`), with `/forms` as the link underneath | Production has no ticket form, so `/forms` redirects to a sign-in most readers cannot pass; the chat needs no account.             |
| The title's last word in blue, in Arabic too                    | The head of the phrase in Arabic (`lib/kb/accent.ts`)               | Arabic puts the topic word first: the last word of «شركاء شيب بلو» is half the brand name.                                         |

## 5. Left open

- **The tracking result screen.** The design's tracking result is a separate
  screen with a gate on the recipient's phone digits and actions that change a
  delivery. The earlier plan explains why neither is built. The tracking page
  keeps its current layout under the new chrome.
- ~~**`updated_at` itself still moves on every view.**~~ **Done, in its own
  PR.** The help centre no longer reads it (§3), and the console's article list,
  which shows it and sorts by it, would have followed readers once the help
  centre was live. #466 made `touch_updated_at()` in `db/sql/001` keep the date
  on `kb_articles` when an UPDATE changed only `view_count`, `helpful_count` or
  `unhelpful_count`. `plans/kb-article-stats.md` then moved the counters to
  `kb_article_stats` and dropped them, and put the trigger back to its plain
  stamp, so a reader no longer writes the article at all (PROJECT-STATE §6.51).
- **An audience on the article**, if the design's chips are wanted beyond what
  the two categories already give.
- **The addresses** of the merchant dashboard, the status page and the terms and
  privacy pages, which would let the header and footer carry the design's
  remaining links.

## 6. The second pass: the landing page as drawn

The first pass drew production's two audiences as the front page's two topic
cards, so "Browse by topic" was two wide cards where the design has six subject
cards. Compared side by side on 2026-11-05, the owner read it as a different
page. The second pass closed the gap:

- **A card per folder.** Production's subjects are its folders: Partners has six
  (FAQs, Financials, Integrations, Policies and Regulations, ShipBlu Unique
  Products, Shipping Services), which fill the design's three-by-two grid, and
  Customers has two. The audiences head their groups, each linking to its own
  page. The grid is three across in both groups, so a card is one size
  wherever it sits.
- **A description on every card.** The folders came from Freshdesk without one
  and the console has no folder editor, so
  `db/sql/010_kb_folder_descriptions.sql` writes one per folder in both
  languages, matched by audience and slug. It fills only a blank description,
  so a replay writes nothing and a line written later wins. It reaches
  production on the first deploy after `dev` is merged into `main`.
- **The design's typeface.** Geist for Latin, from `next/font`, and Rubik for
  Arabic, from the self-hosted 'Rubik Arabic' faces the message text already
  used, with the 600 weight added from the same Fontsource build (5.3.0) so the
  design's semibold headings are drawn at 600 rather than 700. The owner chose
  this over keeping the live Freshdesk portal's Lato and Tajawal. Every
  `font-bold` under `app/help/` became `font-semibold`, since the design uses
  400, 500 and 600 and never 700. The stack's order matters for the reason
  PROJECT-STATE §6.25 gives: `Geist, 'Rubik Arabic'` lead, ahead of
  `var(--font-geist)` and its Arial fallback.
- **Two drawings.** The design's question-and-search parcel, re-exported at
  280px from its 474px original, for the FAQs folders, and the account-settings
  drawing, renamed from `pickups` to `account` for what it shows.
- **The header's bare mark**, as the design draws it on white, at the size of
  the design's bird, and the design's own lede.
- **The design's sizes and weights where they differ from Tailwind's.** Inside
  `.kb-shell` only, `text-xs` is 13px, `text-2xs` 12px, `text-lg` 17px and
  `tracking-tight` -0.011em, as the design's tokens have them; `text-base`
  stays 16px, because a form field below 640px must, or iOS zooms into it.
  Article rows, the next-article cards, the language switch and the footer's
  name are at the design's 500, and Arabic titles at its 1.25 leading.
- **The general words read last in the drawing matcher.** "Policy", "product"
  and "app" match only when a name says nothing more particular, so "Return
  policy" is a return and "Apps & Integrations" an integration.
- **A Freshdesk re-import keeps a folder's description** when Freshdesk has
  none, which is every one of production's, so it cannot undo the descriptions
  above.

## 7. Verified

Verified against a local Postgres seeded in production's shape: two audiences
with their folders, in both locales, with excerpts, headings and tags. The
checks:

- Every page type in English and Arabic, at 1280, 1024, 390 and 360: no
  horizontal overflow, no console errors and no failed requests.
- The article page in print: the rail, feedback, pager, band and search stay out
  of the printout.
- `tsc`, `eslint`, `lint:strict`, `prettier`, `vitest`, `knip`, the repo rules
  and `next build` are clean.
