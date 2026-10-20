# ShipBlu Support for WhatsApp Web

A Chrome extension for company laptops. Beside a WhatsApp Web chat on one of
our coexistence numbers it shows that chat's ticket: its **shipments** and its
**side conversations**, with the console's composer. `plans/whatsapp-web-extension.md`
has the design and the decisions behind it.

## Build

```bash
npm run extension:build                                        # for production
SUPPORT_ORIGIN=http://localhost:3000 npm run extension:build   # for a local console
```

The package lands in `extension/dist/` (not committed). `SUPPORT_ORIGIN` is
baked in — it is the only host the extension may call and where the agent's
password is sent — so it is chosen by whoever builds the package, not typed
into the panel. CI builds it on every pull request (`extension` in `ci.yml`).

## Try it

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
   choose `extension/dist`.
2. Open `https://web.whatsapp.com`, signed in as a coexistence number. If it was
   already open, reload it: Chrome injects the content script only into pages
   loaded after the extension.
3. Click the ShipBlu icon in the toolbar. The side panel opens on WhatsApp Web
   tabs only. Sign in with ShipBlu Support credentials (agents only; a session
   lasts a week).

To debug the panel in a tab of its own, open
`chrome-extension://<id>/panel.html?tab=<WhatsApp tab id>`; without `?tab=`
the panel reads the active tab, which would be itself.

## How it fits together

| File                   | Runs in          | Does                                                             |
| ---------------------- | ---------------- | ---------------------------------------------------------------- |
| `src/background.ts`    | service worker   | enables the side panel on WhatsApp Web tabs only                 |
| `src/content.ts`       | web.whatsapp.com | reads the open chat's message keys and announces them; read-only |
| `src/whatsapp/page.ts` | web.whatsapp.com | everything that depends on WhatsApp Web's markup, in one file    |
| `src/panel/`           | the side panel   | signs in, finds the ticket, draws the two tabs                   |

- **The content script never holds the token.** It runs inside WhatsApp's page
  and only says what is on screen. The panel holds the token in the extension's
  own `localStorage`, which a content script cannot read, and is the only part
  that calls the console.
- **The panel is drawn with the console's own components** (`components/ui.tsx`,
  `shipment-status.tsx`, `icons.tsx`) and its stylesheet is compiled from
  `app/globals.css`, so it follows the design system rather than a copy of it.
  What a parcel's card says comes from the server (`shipmentCard`,
  `trackingView`); the panel decides only how it looks.
- **A chat is matched to its ticket by its messages, not its phone number** —
  WhatsApp has moved many chats to `@lid` ids that carry no number. Each row's
  `true_<chat>_<id>` key becomes `out:<id>`, the shape `wamidKey` gives our
  stored wamids.

## Not done yet

- **Matching a chat to its ticket** (`POST /api/extension/resolve`) is stage 2
  of the plan, waiting on a measurement against a real coexistence chat. Until
  it ships the panel says matching is not live yet.
- **Reading the open chat** (`src/whatsapp/page.ts`) is provisional for the same
  reason.
- **Installing on the laptops** (stage 6): a signing key so the extension id is
  stable, a packed `.crx` with an update manifest, and the Ubuntu policy file
  (`/etc/opt/chrome/policies/managed/`, `ExtensionInstallForcelist`). Until then,
  load it unpacked.
