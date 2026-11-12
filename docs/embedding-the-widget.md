# Embedding the chat widget

What another ShipBlu site pastes onto its pages to get live chat, and what it
may tell the widget about the person reading it. Written for whoever maintains
the merchant dashboard; the reasoning behind the design is in
`app/widget/embed.js/route.ts` and `lib/widget/identity.ts`.

## The tag

```html
<script src="https://<helpdesk-host>/widget/embed.js" async></script>
```

That is the whole integration. The snippet draws the launcher and, on first
open, an iframe pointing back at the host it was loaded from — so the chat runs
on **our** origin, where the host page's CSS cannot reach it and where the
visitor's token lives in storage the host page cannot read.

`<helpdesk-host>` is whichever hostname serves this app:
`shipblu-support.onrender.com`, or `support.shipblu.com`, whose DNS has pointed
here since 2026-11-11. Pick one and keep it. The visitor's token lives in the
frame's own storage, which belongs to the host the script was loaded from, so
moving to the other host later starts every visitor afresh: their stored
conversation stays behind on the first. `support.shipblu.com` is the name to
pick, since it is the one meant to last. Load it from the same host in every
environment — the script frames the origin it was served from, so a staging
dashboard pointing at production opens production's chat.

**A third-party origin must be allowlisted before the frame will load.** The
`/widget` route answers with `frame-ancestors 'self' …WIDGET_ALLOWED_ORIGINS`,
so `https://app.shipblu.com` has to be in that variable or the merchant sees a
launcher that opens an empty box. Measured 2026-08-31, production answered
`frame-ancestors 'self';`: the variable was unset. Measured 2026-11-12, on both
hosts, it answers `frame-ancestors 'self' https://app.shipblu.com
https://app.staging.shipblu.com https://merchant.staging.shipblu.com
https://merchant.shipblu.com https://business.shipblu.com`, so those origins can
frame the widget today, and any other has to be added first.

## What it puts on your page

Two elements and one stylesheet, all appended to `document.body` and
`document.head`:

- `#shipblu-chat-launcher`, a 56px button 20px from the bottom corner — the
  right-hand one, or the left-hand one when the locale is `ar`. It is ShipBlu
  blue (`#145bfe`, `#0f4ad6` on hover) and shaped as a speech bubble whose tail
  points inwards, with the mark drawn inline as SVG. An unread count sits on its
  top corner in coral (`#bc5300`) with a white ring.
- `#shipblu-chat-frame`, created on first open: a 380 × 600px card above the
  launcher (12px corners, a soft shadow, shorter on a short window), or the
  whole screen below 640px wide or 480px tall.
- A `<style>` that hides both when printing, and holds the launcher's hover and
  `:focus-visible` rules.

Both elements sit at `z-index: 2147483000`. The launcher is drawn in the
system font stack, so until the panel is first opened nothing at all — no
webfont, no image — is requested from your page beyond `embed.js` itself. Its
styles are inline and its hover and focus rules are `!important`, so do not
target the two ids from your stylesheet: the result is the launcher
half-restyled, not yours.

## Telling the widget who is reading

A signed-in dashboard already knows the merchant's name, address and account.
Handing them over is what stops a support chat opening with three questions the
site could have answered itself.

Set the config object **before** the tag, exactly as Freshchat's
`fcWidgetMessengerConfig` was set:

```js
window.shipbluChatSettings = {
  locale: 'en', // 'en' or 'ar'; drives the widget's language and side
  firstName: 'Nour',
  lastName: 'Adel',
  email: 'nour@merchant.example',
  phone: '+20 100 123 4567',
  accountId: '4471', // the merchant's account number on the platform
  accountName: 'Acme Trading',
  meta: { tier: 'gold' }, // anything else worth showing an agent
};
```

| Field                    | Where it lands                                                             |
| ------------------------ | -------------------------------------------------------------------------- |
| `firstName` + `lastName` | The contact's name. `name` may be sent whole instead.                      |
| `email`                  | The contact's address, and linked so their later email joins this history. |
| `phone`                  | The contact's phone, for display.                                          |
| `accountId`              | Linked to the shipping account on the ticket, when it is an SBID.          |
| `accountName`            | Shown beside it in the ticket's activity trail.                            |
| `meta`                   | Stored on the contact under an `sb_` prefix — `tier` becomes `sb_tier`.    |

Values are trimmed and capped at 200 characters, an address that is not one is
dropped rather than stored, and `meta` keys must look like identifiers. None of
that is negotiable at the call site: the widget parses what it is given and
keeps the parts it can use.

## Calling it after the page has loaded

A dashboard whose user signs in without a page load — every SPA — sets nothing
up front and calls the API instead. It is available as soon as the script has
run:

```js
window.shipbluChat.identify({ name, email, accountId, accountName });
window.shipbluChat.clear(); // on sign-out. See below — this one matters.
window.shipbluChat.setLocale('ar'); // language switch without a reload
window.shipbluChat.open(); // e.g. from a "Contact support" menu item
window.shipbluChat.close();
window.shipbluChat.toggle();
window.shipbluChat.compose('Tracking number: 1755021358719\n\n'); // open with a draft
```

**`compose(text)` opens the panel with `text` already in the composer, and
stops there.** It is for a page that knows what the conversation is about — the
help centre's tracking page uses it so a recipient asking about a parcel does
not have to copy the number across. The widget puts the text in the box,
focuses it and waits: the visitor writes their own question under it and
decides when it goes. Nothing is sent on their behalf, and nothing overwrites a
message they have already started typing — a second call onto a non-empty
composer only moves the caret.

The text is capped at 1,000 characters and is a draft like any other, so keep
it to the facts the agent needs first. Called before the frame exists, it waits
for it; called on a panel that is already open, it lands immediately.

**Call `clear()` when the user signs out.** The visitor's token lives in the
widget's own storage, so it outlives the dashboard's session entirely: on a
shared machine in a merchant's warehouse, the next person to sign in would
otherwise open the chat onto the previous one's conversation. `clear()` throws
that token away and starts a clean session.

The widget does not rely on the host page remembering, or on the clear
arriving: a sign-out that leaves the page at once can lose it. Before the panel
reopens a stored conversation, it checks who your page says is reading: the
account id, the email, and the phone when there is no email. That has to be
the person the conversation was last identified as. If your page names
somebody else, the panel starts clean without fetching anything of the old
conversation, and throws it away. What that means for a host page:

- **Give the identity as early as you have it**, in `shipbluChatSettings` or
  through `identify()`. A conversation identified as somebody is not reopened
  while your page names nobody, or names less than it was identified with
  (the email without the account). It is kept, and reopened as soon as your
  page says the rest.
- **Adding a field is fine; changing one is a different person.** An account
  id handed over after the email keeps the conversation. A changed email or
  account starts clean. So does an email added to an identity that only ever
  had the account, because any of that account's people could be the one
  reading.
- **An anonymous page does not open a merchant's chat.** Other pages on your
  site share the panel's storage, so a conversation identified on the
  dashboard is not reopened on a page that never says who is reading. It is
  still there when the merchant is back on the dashboard.

`clear()` still matters: it removes the token at sign-out, instead of leaving
it to be refused at the next open. The server checks too, afterwards: an
identity naming a different account than the one already on the session is
refused, and the widget answers by opening a fresh session by itself.

## Proving the identity (optional, recommended)

Everything above arrives from a browser, so on its own it is a _claim_: anyone
who opens devtools can call `identify()` with somebody else's address. The
widget treats an unsigned claim accordingly — it fills in the name, address and
phone an agent reads, and it never links the person to a shipping account,
because that link asserts who may speak for an account.

To make it a fact, have the dashboard's **backend** sign it:

```
signature = HMAC-SHA256(WIDGET_IDENTITY_SECRET, "<accountId>|<email>")   # lowercase hex
```

```python
import hmac, hashlib
signature = hmac.new(
    secret.encode(), f"{account_id}|{email}".encode(), hashlib.sha256
).hexdigest()
```

```js
crypto.createHmac('sha256', secret).update(`${accountId}|${email}`).digest('hex');
```

Send it alongside the identity — `{ ...user, signature }` in the config object,
or `identify(user, signature)` — and the widget links the person to their
shipping account, so an agent opens the ticket with the account's shipments
already in front of them.

Both halves are the values _after_ normalisation: the account id as digits and
letters only, the email lower-cased and trimmed. Empty fields are still their
side of the `|`. The signature covers the identifying half only, deliberately:
name, phone and `meta` are decoration, and covering them would mean a merchant
renaming themselves in the dashboard silently stops being identified at all.

**A signature proves only an account id or an email.** An identity with neither
— a phone alone, say — signs the constant `"|"`, and one HMAC of that would be a
valid signature for every phone number there is. So such an identity is always
_unverified_, signed or not: its name and phone still reach the agent, marked as
the dashboard's word, and no signature over it is refused with a 401 either,
right or wrong, so an integration that signs every user keeps working for the
ones without an email. To have a user verified, send their account id or email.
One exception keeps a broken integration visible: an email or account id you
sent that the widget could not read — an address without a domain, an account id
of punctuation alone — is dropped from the identity, but your backend signed it,
so a signature that does not verify is still a 401.
A phone-keyed integration that needs the phone itself vouched for gets a second
accepted claim form, added beside this one; the `<accountId>|<email>` form does
not change.

The secret is `WIDGET_IDENTITY_SECRET`, per environment and never shared with
staging — a signature minted against one deployment would otherwise be
replayable at the other. While it is unset, signatures are ignored and every
identity is unverified; once it is set, a signature that does not verify is a
401 rather than a quiet downgrade — except over an identity naming neither an
account id nor an email, which is unverified whatever its signature (above).

## What the visitor sees before they type

The five most-read help centre articles for the widget's locale, on the opening
screen, replaced by the conversation as soon as there is one. They come from the
same source as the help centre's most-read list, so an article that earns its
place there earns it here; nothing has to be curated per surface, and a locale
with nothing read yet simply shows no list. Set `locale` correctly and the
questions arrive in the visitor's language — that is the only thing the host
page controls here.

## Who the launcher is not drawn for

On the pages this app renders — the help centre, the customer portal, the
tracking page — the launcher is left out entirely for a reader signed in to the
agent console. That is a surface the team reads on too, and a chat an agent
opens against their own queue is a contact and a conversation with nobody
behind either, in the tables the reports are drawn from.
`viewerIsTeamMember()` in `lib/widget/audience.ts` is the decision, taken on the
server, per request.

The launcher also leaves when the reader leaves those pages without a reload.
An agent who signs in on the help centre reaches the console by a client-side
navigation, and the launcher that loaded while they were signed out used to
ride along onto their inbox. `ChatWidget` in `app/help/chat.tsx` takes it down
when the help centre's layout goes, through a `destroy()` on the same
`shipbluChat` object.

**`destroy()` is not part of this contract**, although you will find it on the
object. It does exactly what the help centre needs, and its limits are ones a
host page would trip over:

- It leaves the page's scroll position to a router it assumes is about to set
  one.
- It drops a `clear()` still on its way to the panel, and leaves no object to
  sign a visitor out with afterwards.
- It cannot reach a snippet that has not finished loading.
- A copy loaded after it reads `shipbluChatSettings` again, so it is told
  whatever your page said at load rather than what you told the copy it
  replaced, an identity included.

Do not call it. If you need to take the chat off a page without a reload, ask,
and it will get a version made for a host page.

**A host page of your own gets no such filtering and should not expect any.**
`embed.js` is one publicly cached response shared by every reader of every site
carrying it, so it cannot answer differently for one of them. Nothing about
`/widget` or `/api/widget/*` changes either: an agent who opens the chat from a
dashboard gets a working chat, because a launcher opening an empty box is the
worse of the two.

## What the agent sees

The requester's name, email and phone on the ticket, the shipping account in the
ticket's Shipping accounts panel when the account id is an SBID, and a line in
the activity trail saying who the dashboard said this was — marked _the
dashboard's word, not verified_ when it was not signed, or named neither an
account id nor an email, so nobody reads a claimed name back to a caller as
though we had checked it.

## Moving off Freshchat

The old tag was `fw-cdn.com/11720815/4351362.js` with a
`window.fcWidgetMessengerConfig`. The mapping is one-to-one except:

- `siteId` has no equivalent. Environments are separated by which host serves
  `embed.js`.
- The account name does not need to be crammed into `firstName`, as
  `` `${first} ${last} (${account})` `` was doing. `accountName` is a field of its
  own and is shown as one, so `firstName` can be the person's actual name.
- `meta.cf_sb_account_id` and `meta.cf_sb_account_name` become the top-level
  `accountId` and `accountName`, which is what makes the account a link on the
  ticket rather than a string in a custom field.
- Nothing is loaded from a third-party CDN: the script comes from the helpdesk
  itself, so it is covered by whatever CSP the dashboard already sets for its
  own origin.
