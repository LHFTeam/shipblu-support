# Design system brief for Claude Design

This is a prompt for Claude Design. Paste everything below the line. If Claude Design can link a
GitHub repository, connect `LHFTeam/shipblu-support` first so it can read the files §2 names;
otherwise upload `app/globals.css`, `components/` and `app/help/[locale]/chrome.tsx` alongside it.

The facts in it (token values, file paths, what collides with what) were read from `main` on
2026-10-07. If the styling changes before you use it, re-check §2.

---

Build a design system for **ShipBlu Support**, the in-house helpdesk of ShipBlu, an Egyptian
last-mile delivery company that ships for e-commerce merchants. It replaces Freshdesk and
Freshchat. The product is already built, and parts of it are live. This is not a blank-page brand
exercise. I want a system that **unifies what has drifted, keeps what was decided for good
reasons, and can be adopted in two steps: first a token swap that changes no markup, then a
component restyle.**

## 1. The product, and who reads each surface

One Next.js app renders three surfaces for three very different readers. It uses React 19 server
components and Tailwind CSS v4.

| Surface                                                                                                  | Who reads it                                                                                 | How they read it                                                                                                                                                                                                           | Density                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Agent console**: inbox, ticket view, contacts, knowledge-base editor, reports, admin settings          | ShipBlu support agents and supervisors                                                       | All day on a laptop, and often on a phone. The UI is in English, but most customer content inside it is Arabic, often mixed with English and digits.                                                                       | High. Agents scan the inbox list a hundred times a day, so each ticket is three tight lines, not a card. |
| **Help centre, customer portal and parcel tracking** (public, on their own hostname)                     | Merchants asking how settlement or pickups work, and recipients asking where their parcel is | Once, with a question, mostly on a phone, often on a weak connection. **Arabic is the default locale and the front door (RTL)**, and English is second. Pages must work before JavaScript loads. Customers print articles. | Low. It should read like a page, not an app.                                                             |
| **Chat widget**: a ~380px iframe panel plus a 56px launcher button injected into merchants' own websites | A visitor on someone else's site                                                             | At a glance. It goes full-screen on a phone.                                                                                                                                                                               | Medium, with text at interface size.                                                                     |

## 2. Start from what exists

Read these before proposing anything:

- `app/globals.css` holds every token in use today: the console's `@theme` and `:root`, the help
  centre's `.kb-shell` scope, `.kb-article` and `.widget-article` typography, and the print
  styles. The comments give the reason for each decision.
- `components/ui.tsx` holds the dozen shared primitives: Button, Input, Textarea, Select, Label,
  Field, Badge, ErrorText, SuccessText, EmptyState, Card, PageHeader, Table/Row/Cell and Toggle.
- `components/tooltip.tsx`, `search-input.tsx`, `icons.tsx`, `brand.tsx` (the logo, as inline
  SVG), `channel.tsx`, `avatar.tsx` and `charts.tsx`, plus `lib/auth/agent-colors.ts`.
- `app/(console)/layout.tsx`, `nav.tsx`, and `app/(console)/inbox/`: `list.tsx`, `shell.tsx`,
  and in `[number]/` the files `timeline.tsx`, `composer.tsx`, `header.tsx` and
  `window-indicator.tsx`.
- `app/help/[locale]/chrome.tsx`, `home.tsx`, `notice.tsx`, `track/result.tsx` and `fonts.ts`,
  plus `lib/shipments/status.ts`, which holds the logistics status taxonomy.
- `app/widget/`, and `app/widget/embed.js/route.ts`, where the launcher is styled inline on the
  host page.
- `plans/help-centre-landing-and-tracking.md` records what was taken from an earlier, _proposed_
  ShipBlu design system: its palette and logistics status taxonomy, now in `.kb-shell`. It also
  records what was deliberately left out: Geist and Rubik, radii, spacing, the dark theme and the
  component bundle.

### What is there today

**Console** (`:root`, written in oklch):

- **Brand ramp** at hue ~255. `brand-600` ≈ `#1558ad` is the primary button. `brand-500` ≈
  `#2d74ca` is the focus ring and chart series 1. The navy rail is ≈ `#071e40`.
- **Coral accent**: `accent-600` ≈ `#e35413`. It is meant to be scarce, and today it appears in
  the nav count badges, the active-nav marker, the "Create ticket" button and chart series 2.
- **States**: `critical` ≈ `#d73337`, `positive` ≈ `#2e9e52`, `caution` ≈ `#d9a514`.
- **Neutrals**, cool and near-white: background `#f9fafc`, surface `#fff`, border `#dee2e5`, text
  `#15191d`, muted text `#636a71`.
- **Type**: the system UI font stack, with tabular figures everywhere. Almost all text is 12px or
  14px.
- **Shape**: radius 4px on badges, 6px on controls and 12px on cards. There is almost no shadow.

**Help centre** (`.kb-shell`, written in hex, taken from the proposed design system):

- **The `blu` ramp**, where `blu-500 #1c5bfe` is the only action colour.
- **Cool charcoal neutrals**: text is `neutral-900 #1e1e1e` and the page canvas is
  `neutral-50 #f6f8fa`.
- **Feedback roles**: success, warning, danger, info and neutral, each with a background, a
  border and a text colour.
- **A logistics status taxonomy** in which out-for-delivery has its own violet, so it never shares
  blue with in-transit.
- **Fonts**: Lato for Latin and Tajawal for Arabic, the same pairing as the live Freshdesk portal
  that customers already know.
- **Cards**: white, with a hairline border, a 12px radius and a soft two-layer shadow.

Inside `.kb-shell` the console's token names point at help-centre values. That is how the shared
primitives take help-centre colours without a second set of components.

**Logo**: a bird mark made of five flat polygons, in blue `#145BFE` and navy `#022D65`. It always
sits on a white rounded square with a 28% radius, which is what lets it read on the navy rail.

**Widget**: the panel uses the console's tokens and the system font. The launcher is styled
inline with its own hard-coded colours.

### What has drifted

These problems are the reason for this brief.

1. **Four brand blues are live**: the logo's `#145BFE`, the help centre's `#1c5bfe`, the
   console's `#1558ad`, and the widget launcher's hard-coded `#0b6bcb`. There are also two navies:
   the logo's `#022D65` and the rail's `#071e40`.
2. **The two surfaces use different token names.** The console uses `--background`,
   `--surface`, `--muted`, `--border`, `--foreground` and so on. The help centre uses the proposed
   system's `--color-text-primary` and `--color-feedback-*-bg` names, with a `--kb-*` layer on top.
3. **The console's state colours are not tokens.** Badges, errors, notes and channel chips use
   raw Tailwind hues at 15% tint: `emerald`, `amber`, `red`, `blue`, `violet`, `pink` and `slate`.
   `text-red-600` alone appears 25 times. One component uses `--danger`, which nothing defines.
4. **Some colours mean two things.**
   - The "resolved" ticket status is blue, the same family as the brand, info, web chat, Facebook
     and in-transit.
   - A **private note** and a reply **posted publicly** on Facebook or Instagram both use the same
     amber "warning" tone, though their meanings are opposite.
   - Coral (hue ~40) and the critical red (hue ~25) are close enough to confuse at badge size.
5. **The coral breaks the help centre's own rule.** The proposed system makes blue the only
   action colour, but the help centre's ticket-form submit button is coral, because nobody set a
   help-centre value for `accent`.
6. **Every help-centre page after the front page, except tracking, still has a solid blue title
   band.** The proposed system says blue is never a page background except in sign-in and
   marketing panels. A pale `subtle` band already exists, but only the tracking page uses it.
7. **Some sizes are one-offs.** Nav count badges and chips use 9px, 10px and 11px text, and there
   is no defined type scale.

## 3. Constraints that are not negotiable

Each of these was decided for a recorded reason, and CI enforces several of them. Design within
them.

- **Light only.** One palette everywhere, whatever the operating system asks for. No dark theme,
  no `prefers-color-scheme: dark`, no `dark:` variants, and `color-scheme: light` stays on `:root`.
  CI rejects all three. A dark theme would be a separate project.
- **No component library, icon package or charting library.** Every primitive is a styled native
  element. Specify components as Tailwind v4 classes and CSS custom properties on native HTML.
  Tokens live in CSS (`@theme` and `:root`), not in a JS config. Charts are server-rendered SVG.
- **Icons** are hand-drawn on a 24×24 grid with a 1.75 stroke, round caps and joins, and
  `currentColor`, and are 20px by default. Add to this set rather than replacing it. Never use an
  emoji as an icon: the launcher once used 💬, which looked like a different product on each of
  three operating systems.
- **RTL comes from logical properties only**: `ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`,
  `text-start` and `border-inline-start`. Icons that point a direction, such as back chevrons, flip
  in RTL. Brand marks and charts do not. Never assume Arabic text is LTR. Mixed-direction text
  (`dir="auto"`) is normal in the console.
- **No modals.** Things open in place: editors, pickers, and the knowledge panel under the
  composer. The one overlay is the idle sign-out warning. Do not add dialogs, drawers or sheets
  that cover content.
- **No `title=` tooltips**, because they never appear on a phone. An explanation is either a
  **hint** that is always on screen under the field, or an **InfoTip** (ⓘ). An InfoTip opens on
  hover, focus _and_ tap and closes on Escape or a tap outside it. It is rendered into
  `document.body` so a table's overflow cannot clip it.
- **Inputs are 16px on phones** and 14px from `sm` up. iOS zooms into any smaller field and does
  not zoom back out.
- **Tap targets on phones** are never smaller than the inputs beside them. Selects are already
  taller on phones for this reason.
- **One focus style**: a 2px `:focus-visible` outline in the ring colour, offset by 2px, on every
  interactive element.
- **The console uses tabular figures.** Prose in the help centre uses proportional figures.
- **Colour is never the only signal.**
  - Status badges always include words.
  - Every chart has a table of its values beside it.
  - Each chart series keeps one colour (series 1 brand blue, series 2 the accent), so changing a
    filter never recolours a series.
- **Agent colours are stored in the database**, one key per agent. The nine keys are `blue`,
  `emerald`, `violet`, `amber`, `pink`, `cyan`, `lime`, `fuchsia` and `slate`.
  - You may change what each one looks like.
  - You may not rename, remove or reorder the keys.
  - Each must be a solid fill with white initials at a contrast of at least 5:1.
  - Each must be a distinct hue at 20px, and must not look like one of the pale badge tints next
    to it.
- **In-transit and out-for-delivery stay distinct**: blue and violet. A shipment status the
  system does not recognise is shown as its label alone, with no stepper and no colour.
- **A private note must look unmistakably different from a reply**, without anyone having to
  read it. A note is never sent to the customer. The same goes for a _public_ reply to a Facebook
  or Instagram comment versus a private message.
- **Article bodies are plain semantic HTML** from an editor and an importer. They have no classes,
  no inline styles, no `div` or `span`, and **no `h1`**, because the page owns the `h1`. Style
  articles by element name: `h2` to `h6`, `p`, lists, `blockquote`, `table`, `pre`, `img` and
  `figure`. Keep a line length of about 62 characters, 17px text on a phone and 18px from tablet
  up, a line-height of about 1.75, and the print stylesheet.
- **The widget launcher is styled inline on someone else's page.** It cannot read our CSS
  variables or load our fonts, and it must work in old browsers. Give it literal hex values and a
  system font.
- **The help centre keeps Lato and Tajawal**, served from our own domain. List Lato, then
  Tajawal, then any metric-matched fallback font. In any other order, every Arabic letter renders
  in Arial, which has already shipped once.
- **WCAG AA contrast** for every text and background pair you specify, including text on tinted
  badges. Check each pair against the surface it actually sits on.

## 4. Decisions to make, with reasons

For each of these, recommend one option, say what it costs, and show it in the UI kit. Do not
choose silently.

1. **One brand blue.** Merge the four blues into one ramp. I would anchor it on the logo's
   `#145BFE`, since the help centre's `#1c5bfe` is almost the same colour. Use the logo's
   `#022D65` as the navy. Take the console's darker action shade from the same ramp instead of
   keeping a separate one, and check that white 14px text on it passes AA.
2. **What coral is for.** Coral is ShipBlu's warm accent, and the console uses it as its one
   "look here" colour. Decide its job on all three surfaces. One option is attention only: unread
   or assigned counts, an SLA about to be missed, a messaging window about to close, and never a
   second button colour. Either way, move it far enough from the critical red that the two cannot
   be confused at badge size.
3. **One set of state colours with no accidental overlaps.** It has to cover all of these:
   - **Feedback**: success, warning, danger, info and neutral.
   - **Ticket status groups**: `open`, `pending`, `resolved` and `closed`.
   - **Priority**: `low`, `medium`, `high` and `urgent`.
   - **Messaging window**: open, closing within 2 hours, and closed (templates only).
   - **Channels**: email, WhatsApp, customer bot, web chat, Facebook, Instagram, portal and API.
     Each should be recognisable as the platform's own colour but quiet enough that a list of them
     still looks like one interface.
   - **Logistics statuses**: draft, scheduled, picked-up, in-transit, out-for-delivery, delivered,
     attempted, on-hold, returned, exception, lost and cancelled.
   - **The nine agent colours.**

   Show them all side by side in one grid so any overlap is visible. In particular, fix "resolved
   = blue" and the amber shared by private notes and public posts.

4. **The console's typeface.** It uses the system font stack today. Either keep that, or move the
   console to Lato and Tajawal so the console and help centre share one brand. Either way, Arabic
   customer text in the console must render in a real Arabic font, and tabular figures must still
   be available.
5. **One set of token names.** Use three layers (primitive, then semantic, then component) that
   both surfaces share. The help centre and the console should differ in **density and type
   scale**, not have separate colour systems. Keep the existing names working through the mapping
   in §5.
6. **The help centre's page header.** Design what replaces the solid blue band on the article,
   category, folder, search, forms and portal pages.

## 5. What to produce

**A. Foundations**

- **Colour**: the base colour ramps (in oklch, with the hex beside every value), the semantic
  roles, the state colour grid from §4.3, and a contrast table for every text and background pair.
- **Type**: two scales. The _console_ scale is dense, based on 12px and 14px, and needs a defined
  size for counts and chips in place of the 9–11px one-offs. The _reading_ scale is for the help
  centre and article text. Cover Latin and Arabic, with line heights, and show Arabic and English
  set together at each size. Arabic needs more line height than Latin at the same size.
- **Spacing, radius, elevation and borders**: a small named scale for each. The console is flat
  with hairline borders. Use shadows only for things that really float: the InfoTip bubble, the
  idle warning, the widget panel and the launcher.
- **Focus, motion, icons and RTL**: keep motion minimal and respect `prefers-reduced-motion`.
  Write rules for icons, and rules for RTL with mirrored examples.
- **Breakpoints** in use:
  - `sm` 640px.
  - `md` 768px. Below it the console is one pane with a bottom nav bar; from it up, a side rail,
    the ticket list and the ticket.
  - `lg` 1024px.
  - `xl` 1280px, where the ticket sidebar appears.
  - The help centre's content is at most 72rem wide.

**B. Tokens as code**

- One CSS file in Tailwind v4 form: `@theme { … }` for anything that should generate utility
  classes, and `:root { … }` for semantic roles. Add whatever help-centre scope is needed, for
  density and type only.
- A **mapping table** from every name in use today to its new token:
  - `--background`, `--surface`, `--surface-2`, `--foreground`, `--muted`,
    `--muted-foreground`, `--border`, `--border-strong`, `--ring`, `--rail`, `--rail-foreground`,
    `--series-1`, `--series-2`, `--chart-grid`, `--button-primary` and `--button-primary-hover`.
  - The `brand-*` and `accent-*` ramps, and `--color-positive`, `--color-caution` and
    `--color-critical`.
  - Every `--kb-*` name, and the `--color-*` names inside `.kb-shell`.
  - Each raw Tailwind hue in use (`emerald`, `amber`, `red`, `blue`, `violet`, `pink` and
    `slate`, at 500, 600 and 700) and the semantic token that replaces it.

  The goal is that adopting the system starts with a token swap that changes no markup.

- The launcher's literal values (see §3), taken from the same tokens.

**C. Components.** For each one, give its structure and every state: default, hover,
focus-visible, active, disabled, read-only, invalid, and loading or pending. Show each on a phone
and a desktop, in LTR and in RTL:

- **Actions**: Button (primary, secondary, ghost, danger, and whatever coral becomes, in sizes sm
  and md).
- **Form controls**: Input, Textarea, Select, SearchInput, Label, Field (with a hint and with an
  ⓘ explanation) and Toggle.
- **Status and feedback**: Badge (every tone), ErrorText, SuccessText, EmptyState and the count
  badge.
- **Layout**: Card, the console's PageHeader, and Table/Row/Cell with horizontal scrolling.
- **Help text**: InfoTip and Tooltip.
- **Identity**: the agent avatar tile, and ChannelBadge with and without its label.
- **Navigation**: the nav rail and the phone bottom bar, each with a live count.
- **Availability**: the availability switch (accepting tickets on or off). Show all three ways an
  agent ends up away: they chose it, a supervisor set it, or the idle timer did.
- **The idle sign-out countdown.**

**D. Domain patterns.** These are most of what the screens actually contain.

- **Inbox row.** It shows:
  - who the requester is and how long ago they wrote;
  - the subject and a preview;
  - the channel mark, the status and the ticket number;
  - the messaging window countdown and the priority;
  - the state of any side conversation with a hub ("awaiting hub" or "hub replied");
  - a marker when the last message was ours;
  - the assignee's tile, or "unassigned".

  Show the unread, active and hover states.

- **Conversation timeline.** The message types are:
  - an inbound reply, and an outbound reply aligned to the end;
  - a private note;
  - a public comment, a reply "sent privately", and a direct message;
  - an echo of the customer bot's message, and an automated or system message;
  - attachments: an image grid, a file, and a shared-location card;
  - delivery receipts: sent, delivered, read and failed;
  - a side-conversation card: a thread with a hub, placed in time order.
- **Composer.**
  - Reply mode and note mode, unmistakably different.
  - The canned-response picker, and the knowledge panel opening in place under the composer.
  - The WhatsApp template form for after the 24-hour window has closed.
  - The read-only notice that replaces the composer on channels we only observe.
- **Ticket sidebar.**
  - The requester's profile and the ticket's custom fields.
  - Detected categories with their evidence grade. It is a grade, not a probability, so do not
    draw it as a percentage bar.
  - Linked shipments with their status, and the root cause recorded when a ticket is resolved.
- **Reports**: a stat tile, grouped columns, a line chart and a legend. Also the note explaining
  where the data in the selected date range starts and why, and metric headers with InfoTips.
- **Admin**: a settings form, a rule or condition builder, and a table of rules with toggles.
- **Help centre.**
  - The hero, with _search articles_ and _track a parcel_ side by side, not stacked.
  - Common-search chips, and topic cards that each show three article titles.
  - The most-read and recently-updated lists.
  - The "still need help" panel, with a live line such as "we're answering now" or "back at
    10:00".
  - The service notice banner, in info, warning and danger. A notice may exist in only one
    language, so it sets its own `lang` and `dir`.
  - The breadcrumb trail, the article page with yes/no feedback, and search results.
  - The customer ticket form, with questions that appear on condition and file upload.
  - The portal's sign-in, registration and password reset, and "my tickets" with a ticket's
    thread.
  - The satisfaction survey.
  - The tracking result: status badge, four-step stepper, return-journey stepper, estimated date
    and last update.
- **Widget**: the closed launcher with an unread dot, the home view (search, articles and "start
  a chat"), the chat thread, an article, the out-of-hours form, and the full-screen phone layout.

**E. A UI kit of full screens**, each at 390px wide and at desktop width:

- The console inbox. At 1440px, the list, an open ticket and the sidebar together. At 390px, the
  list on one screen and the ticket on the next.
- A reports dashboard, an admin settings page, and the console sign-in.
- The help-centre home page in Arabic (RTL) and in English, and an article in Arabic.
- A tracking result for a parcel out for delivery, and one for a return.
- The widget open on an ordinary merchant's online shop.

**F. Written guidance.** For every decision that is not obvious, write one or two sentences on
_why_, and what would break with the obvious alternative. The codebase documents itself this way,
and the system's reasoning will be copied straight into code comments.

## 6. Don't

- Don't design a dark theme, a theme switcher, modals, drawers, or `title=` tooltips.
- Don't add a font, icon set or component kit that needs a new runtime dependency.
- Don't use blue as a page background in the help centre, except in sign-in and marketing
  panels, and don't use blue for body text there. Charcoal is for text; blue is for actions and
  links.
- Don't make the console spacious. It is a tool for people who triage tickets all day, so keep it
  dense, and spend the whitespace on the help centre.
- Don't put invented operational claims in mockups. Show no WhatsApp phone number on the help
  centre (there is no public one), no "updated weekly", and no promised response times. A block
  with no content hides itself, so show that state rather than placeholder content.
- Don't make RTL versions by flipping screenshots. Build them from logical properties, so the spec
  matches how the code works.

## 7. Content for the mockups

Use realistic ShipBlu content, not lorem ipsum. Arabic is the customers' language. In Arabic
copy, address the customer as «حضرتك» and use no imperatives, because we don't know the
customer's gender.

- **Customer messages (Egyptian Arabic)**: «الأوردر بتاعي متأخر بقاله ٣ أيام، ممكن أعرف هو فين؟» ·
  «المندوب اتصل وأنا مكنتش موجود، ينفع يجي بكرة؟» · «عايز ألغي الشحنة دي». Add one that mixes in a
  tracking number: «رقم الشحنة 1762044817395 ولسه مجاش».
- **Merchant questions (English)**: "When does COD settlement land in my account?" · "How do I
  schedule a pickup from our warehouse?"
- **Tracking numbers** are 13 digits, such as `1762044817395`. Example statuses: "Out for
  delivery", "In transit to Cairo hub", "Delivery attempted: customer unreachable", "Returned to
  merchant".
- **Help-centre topics**: الشحن والتوصيل · الدفع عند الاستلام والتسويات · المرتجعات · حساب التاجر.
- **The inbox** should hold:
  - a WhatsApp ticket with 1h 40m left in its window;
  - a public Instagram comment;
  - an email from a merchant;
  - a web chat;
  - a transcript from the customer bot.
- **Agent names**: Egyptian names written in Latin script, such as Mariam Adel, Omar Hassan and
  Nour Ibrahim.
