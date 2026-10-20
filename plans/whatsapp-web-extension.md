# A Chrome extension beside WhatsApp Web

## Context

Agents answering a coexistence number from WhatsApp Web on a company laptop
have to keep the console open in another tab to see the parcel a customer is
asking about, or to ask a hub about it. The ticket already exists — every
message on a coexistence number reaches us through Cloud API, and its tracking
numbers are already detected and synced — so what is missing is a view of it
_next to the chat_, and the one write an agent makes from there: a side
conversation.

Outcome: an agent signs in to the extension with their ShipBlu Support
credentials, opens WhatsApp Web on a number we hold, opens a chat, and a Chrome
side panel shows two tabs for that customer's ticket — **Shipments** and **Side
conversations** — with the side-conversation composer the ticket page has.

Constraints given by the user: company-owned devices only (no privacy
expectation on the device), Chrome on Ubuntu first and Windows possibly.

## What is true today (checked, 2026-10-20)

- **Only a coexistence number can be open in WhatsApp Web.** A Cloud-API-only
  number has no phone app and cannot link a WhatsApp Web session. Production
  has two coexistence channels, `Nayera Mohamed` and `ShipBlu Admin`; `WhatsApp
Support` is Cloud-API-only and `WhatsApp Customer Bot` is a read-only bot
  copy. So the extension serves exactly the numbers whose
  `channels.config.coexistence` is set, and their `displayPhoneNumber` is
  already stored there (`lib/whatsapp/coexistence.ts`).
- **Agent auth is a cookie session** (`lib/auth/session.ts`), `httpOnly`,
  `SameSite=Lax`, subject to the inactivity sign-out in `getSessionAgent()`.
- **Side conversations** are written only by `startSideConversation` and its
  siblings in `app/(console)/side-conversation-actions.ts`, with the recipient
  rules in `lib/side-conversations/guard.ts` and visibility inherited from the
  ticket through `loadConversation`.
- **Shipments on a ticket** are read by `shipmentsForConversation`
  (`lib/shipments/queries.ts`), which already avoids `shipments.data`.
- **A wamid decodes to WhatsApp's own message key** (`wamidKey`,
  `lib/whatsapp/wamid.ts`): `fromMe` plus the message id, with the chat part
  dropped because it varies between copies of the same message (§6.94).

## Design

### 1. Which chat is open: by message id, not by phone number

The obvious design reads the customer's phone number off the open chat. It
fails in two ways: WhatsApp Web's DOM is obfuscated and changes without
notice, and WhatsApp has been moving chats to `@lid` identifiers that carry no
phone number at all — a growing share of chats would match nothing.

Instead the content script reads the **message keys** of the rows on screen.
WhatsApp Web renders each message with a `data-id` of the form
`<fromMe>_<chat jid>_<message id>` — the same `fromMe` + id pair `wamidKey`
extracts from the wamid we stored for that message. The extension sends the
last few keys (`out:3EB0…`, `in:A5F2…`), the server finds the messages they
name on a channel the agent may see, and the ticket they belong to is the
answer. That is LID-proof for the reason §6.94 is: the chat half is exactly the
part dropped.

Two things this needs on the server:

- **A stored, indexed key.** Matching by key today decodes in memory. A
  `messages.wa_key` text column, written at ingest by `wamidKey`, with a partial
  index, and a `backfill_wa_keys` job for the coexistence channels' existing
  rows (idempotent, no dedupe key — §Background work).
- **Verification first.** That WhatsApp Web's `data-id` message id equals the
  id inside our wamid for a coexistence number is inferred from §6.94, not
  measured. Stage 0 measures it on one real chat before anything is built on
  it. If it does not hold, fall back to the phone number from the chat's
  `@c.us` jid, and say plainly that `@lid` chats will not resolve.

Which _number_ WhatsApp Web is signed in as is read the same defensive way
(WhatsApp Web keeps its own jid in `localStorage`), compared to the
coexistence channels' `displayPhoneNumber`, and on any doubt the panel asks the
agent to pick the number once per profile. A wrong guess here only changes
which tickets are searched, never what is written.

### 2. Sign-in: a session of its own, by bearer token

The extension does not ride the console cookie. It would work only while a
console tab keeps the session alive, the inactivity sign-out would end it under
an agent who is busy in WhatsApp, and the user asked for an explicit sign-in.

- `POST /api/extension/session` takes email and password and runs the same
  throttle and `authenticate` as the console form (`lib/auth/sign-in.ts`);
  **agents only**, since `authenticate` also answers customers. It answers a
  256-bit token, stored hashed like every other (`lib/auth/tokens.ts`).
- A new `extension_sessions` table rather than a `kind` on `sessions`: the
  inactivity policy, the presence stream and the "who is online" reads all
  assume a `sessions` row is a console tab, and an extension token living there
  would be signed out by a timer it cannot feed, or keep an agent "online"
  while they are not. Its own lifetime (a shift, 12 hours, not sliding past
  it), revoked by `destroyAllSessionsForAgent` too, so a password change or
  deactivation ends it, and checked against `agents.is_active` on every call
  for the reason `getSessionAgent` gives.
- The token lives in `chrome.storage.session` (cleared when the browser
  closes) and is sent only by the extension's service worker as
  `Authorization: Bearer`. **The content script never holds it and never calls
  the API** — it runs inside web.whatsapp.com's page, and talks only to the
  service worker by `chrome.runtime` messaging.
- Every `/api/extension/*` route resolves the agent through one
  `requireExtensionAgent(request)` and then applies exactly the permission and
  ticket-visibility checks the console does (`can()`, `loadConversation`).
  CORS: none needed for service-worker fetches with `host_permissions`; the
  routes answer no `Access-Control-Allow-Origin` at all, so a page script on
  any site cannot read them.

### 3. The API

All under `app/api/extension/`, JSON, logic in `lib/extension/` per the layer
rule:

| Route                                  | Does                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `POST/DELETE session`                  | sign in / sign out                                                     |
| `GET numbers`                          | the coexistence numbers this agent may see, with `displayPhoneNumber`  |
| `POST resolve`                         | message keys + number → ticket (number, subject, status, requester)    |
| `GET tickets/[id]/shipments`           | `shipmentsForConversation`, plus `agentTracking()` for the detail view |
| `GET tickets/[id]/side-conversations`  | `sideConversationsForConversation`                                     |
| `GET side-conversation-recipients`     | `listSideConversationRecipients`                                       |
| `POST tickets/[id]/side-conversations` | start one; `POST …/[sideId]/reply`, `…/done` for the follow-ups        |

The side-conversation writes must not be a second copy of the action.
`startSideConversation`'s body — recipient resolution from the directory, the
three refusals, the anchor quote, the insert and the enqueue — moves into
`lib/side-conversations/start.ts`, and both the server action and the route
call it. Two copies of "who may receive this" is the failure
`lib/side-conversations/guard.ts` exists to prevent.

The shipment detail goes through `agentTracking()` and nothing else, so the
extension adds no new reader of `shipments.data` (§6.38).

### 4. The extension

- **Manifest V3, Chrome's native side panel** (`chrome.sidePanel`, Chrome 114+,
  same on Ubuntu and Windows) rather than a sidebar injected into WhatsApp's
  DOM. WhatsApp Web re-renders its layout freely; an injected panel fights it
  and breaks with each release, and a side panel is outside the page entirely.
  Enabled only on `https://web.whatsapp.com/*`.
- Content script: read-only. It watches the open chat (a `MutationObserver` on
  the conversation pane), collects message `data-id`s, and posts the keys to
  the service worker. It writes nothing into the page.
- Side panel: signed-out → sign-in form; signed-in, no recognised number →
  number picker; chat with no ticket found → says so and links to the console
  search; otherwise the two tabs, and a link to open the ticket in the console.
  Polls while visible (30 s) — SSE through a service worker that MV3 may stop
  at any moment is not worth it for this.
- Permissions: `sidePanel`, `storage`, host permissions for
  `https://web.whatsapp.com/*` and the support host. Nothing else.
- Arabic and English, RTL by `direction()`, matching the console's palette
  (the design-system tokens copied as CSS variables — the extension cannot
  import `app/globals.css`).

### 5. Where the code lives and how it ships

**Recommended: an `extension/` directory in this repo**, with its own
`package.json` and a small esbuild build, excluded from the app's `tsc`,
`knip` and `repo-rules` scope and given its own lint/typecheck step in CI. The
API it calls and the extension change together, so one PR should be able to
carry both.

**Distribution by Chrome enterprise policy**, `ExtensionInstallForcelist`:

- Ubuntu: a JSON file in `/etc/opt/chrome/policies/managed/` (or
  `/etc/chromium/policies/managed/`), installable by whatever provisions the
  laptops. Self-hosted `.crx` plus an `update.xml` is allowed here.
- Windows: Chrome refuses force-installed extensions from outside the Chrome
  Web Store unless the machine is domain-joined or enrolled in Chrome Browser
  Cloud Management. If the Windows devices are neither, the extension has to be
  published to the Web Store (unlisted, or private to the Google Workspace
  domain) — which then works for Ubuntu too and gives auto-update for free.

## Stages

0. **Measure** — on a real coexistence chat, compare WhatsApp Web `data-id`s
   with the `channel_message_id`s and `wamidKey` of the same messages. Decides
   section 1's approach. No code merged.
1. **Server: auth** — `extension_sessions`, `requireExtensionAgent`, the session
   route, revocation in `destroyAllSessionsForAgent`, tests for agent-only
   sign-in and revocation.
2. **Server: resolve** — `messages.wa_key`, ingest writes it, backfill job,
   `resolve` + `numbers` routes, `*.db.test.ts` for the lookup and its
   visibility rule.
3. **Server: read + write** — shipments and side-conversation routes;
   `lib/side-conversations/start.ts` extracted and the action moved onto it.
4. **Extension** — skeleton, sign-in, number detection, chat resolution,
   Shipments tab.
5. **Extension** — Side conversations tab and composer.
6. **Ship** — CI step for `extension/`, packaging, the policy files for Ubuntu
   (and Windows per the answer above), a page in the console handbook.

## Open questions for the user

1. Are the Windows devices domain-joined or managed by Chrome Browser Cloud
   Management? Decides self-hosted vs Chrome Web Store.
2. Is there a Google Workspace domain to publish privately under, if it is the
   Web Store?
3. The extension session's lifetime — 12 hours non-sliding is proposed.
4. If a customer has no open ticket on that number (all resolved), show the
   most recent resolved one read-only, or nothing?
