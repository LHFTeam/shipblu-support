# The myBlu support API

The endpoints the myBlu app uses to replace its Freshchat SDK with support chat
backed by this system. A myBlu ticket lands in the same inbox as that person's
WhatsApp and email, on a `mobile` channel, and an agent answers it from the
console without knowing or caring which surface it came from.

Everything is under `/api/v1/support/`, matching the `/api/v1/` shape the app
already speaks to `api.shipblu.com`.

## The handshake

myBlu's user holds an opaque bearer from `api.shipblu.com`. This system cannot
read anything out of it, so it asks the platform directly:

```
POST /api/v1/support/session
Authorization: Bearer <the platform access token the app already holds>
Content-Type: application/json
Accept-Language: ar | en

{
  "installId": "3f7a1c84-2b19-4f6e-9a0d-1e2f3a4b5c6d",
  "phone": "+201001234567",
  "email": "nour@example.com",
  "firstName": "Nour",
  "lastName": "Adel"
}
```

```json
{
  "token": "…",
  "expiresAt": "2026-09-27T17:16:00.000Z",
  "identityVerified": true,
  "contact": { "name": "Nour Adel", "email": "nour@example.com", "phone": "201001234567" },
  "online": false,
  "opensAt": "2026-09-21T07:00:00.000Z",
  "timezone": "Africa/Cairo"
}
```

`token` is the bearer for every other endpoint. Keep it in secure storage beside
the platform token; it lasts **seven days** and slides forward on use, so a
daily user never re-handshakes.

### `installId` — generate one, keep it, never regenerate it

A UUID the app creates on first launch and stores in `expo-secure-store`. It is
**not** a credential for the platform and it is not the session token: it is how
a device is recognised across the session token rotating and across
sign-out/sign-in.

Sixteen characters minimum, 128 maximum, `A-Z a-z 0-9 _ . : -` only. Regenerating
it — on reinstall, say — starts the person a fresh support history when the
platform cannot identify them (see below); it costs nothing when it can.

### `identityVerified`, and why the phone the app sends is not enough

The bearer proves _some live myBlu user_ is calling. A phone number in the
request body claims _which one_, and nothing links the two — so if this system
believed it, any myBlu user could read any Egyptian mobile's support history by
typing it.

So the phone is only a fact when `api.shipblu.com` says it:

| `identityVerified` | What happened                                   | What the customer sees                                          |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------- |
| `true`             | The platform named the person for this token    | Their whole support history, across WhatsApp, email and the app |
| `false`            | The token is live but the platform named nobody | Only the tickets opened from **this install**                   |

Both are working states — `false` is not an error and must not be surfaced as
one. The fields the app sends are still used: they fill in the name, email and
phone an agent reads, and the phone makes the person show up as a merge
suggestion so an agent can join the records deliberately.

**If you want `true` for everyone**, the change is on the platform, not in the
app: have `GET /api/v1/myshipblu/customer-accounts/` return the phone. This
system reads it server-side, so nothing in myBlu changes and no release is
needed. (It reads `phone`, `phone_number`, `mobile` or `customer_phone`,
whichever arrives.)

There is a second, optional route if the platform would rather sign at login
than widen that endpoint — see [Signed identities](#signed-identities-optional).

### Ending a session

```
DELETE /api/v1/support/session
Authorization: Bearer <support token>
```

Always `204`. Call it from the app's own `logout()`. Without it the device keeps
a usable support session for up to seven days after the platform token is
dropped.

## Status codes — read this before writing the client

myBlu's HTTP client calls `useAuth.logout()` on **any authenticated 401**. This
API is built around that, and the rule is: **only the handshake ever returns 401.**

| Status | Code                      | What it means                                  | What the app should do                                                 |
| ------ | ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `401`  | `platform_token_invalid`  | `api.shipblu.com` rejected the bearer          | Sign the user out. This is the one case where that is right.           |
| `403`  | `support_session_expired` | The support token is stale, unknown or revoked | Re-handshake with the platform token, retry once. **Do not sign out.** |
| `503`  | `platform_unavailable`    | The platform could not be reached              | Show the message, offer retry. **Nobody is signed out.**               |
| `400`  | `invalid_request`         | Missing `installId`, empty body                | Fix the request                                                        |
| `404`  | `not_found`               | No such conversation _for this customer_       | Show "not found"                                                       |
| `429`  | `rate_limited`            | Too fast                                       | Back off                                                               |

Every body is `{ code, message, detail }`. `message` and `detail` carry the same
sentence, localised by `Accept-Language` — Arabic unless the header leads with
`en` — so `extractErrorMessage` shows a real sentence rather than
`Error code: NNN`.

The suggested client shape:

```ts
async function support<T>(path: string, init?: RequestInit): Promise<T> {
  const run = () => request<T>({ ...init, path, logoutOn401: false });
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.responseCode === 403) {
      await handshake(); // the platform bearer is still in the store
      return run();
    }
    throw error;
  }
}
```

`logoutOn401: false` on every support call. A 401 here means the _platform_
token is dead, and the handshake surfaces that explicitly.

## Conversations

All of these take `Authorization: Bearer <support token>`.

### List

```
GET /api/v1/support/conversations
```

```json
{
  "conversations": [
    {
      "number": 1,
      "subject": "الشحنة متأخرة ومحدش اتصل بيا",
      "status": "قيد المراجعة",
      "statusCategory": "open",
      "lastMessageAt": "2026-09-20T17:16:00.301Z",
      "createdAt": "2026-09-20T17:15:00.000Z"
    }
  ]
}
```

`number` is the ticket number and the id for every other call. `status` is a
customer-facing label and **can be null** — the team's own status names are not
shown to customers — so fall back to a word for `statusCategory` (`open`,
`pending`, `resolved`, `closed`) in the reader's language.

### Open one

```
POST /api/v1/support/conversations

{
  "body": "الشحنة متأخرة ومحدش اتصل بيا",
  "trackingNumber": "3218841",
  "subject": "optional"
}
```

→ `201 { "number": 1 }`

`trackingNumber` is the parcel the customer was looking at — pass it whenever
you have it. It attaches the parcel to the ticket, so the agent opens it with
the shipment in front of them instead of asking which one. This is what
`openSupport({ trackingNumber })` already collects for Freshchat today.

### Read a thread

```
GET /api/v1/support/conversations/{number}
GET /api/v1/support/conversations/{number}?since=2026-09-20T17:16:00.301Z
```

```json
{
  "number": 1,
  "subject": "…",
  "status": "…",
  "statusCategory": "open",
  "canReply": true,
  "lastMessageAt": "2026-09-20T17:16:00.301Z",
  "createdAt": "2026-09-20T17:15:00.000Z",
  "messages": [
    {
      "id": "…",
      "from": "customer",
      "authorName": null,
      "body": "…",
      "createdAt": "2026-09-20T17:15:00.000Z"
    },
    { "id": "…", "from": "agent", "authorName": "Ahmed", "body": "…", "createdAt": "…" }
  ]
}
```

`canReply` is false once a ticket is closed — a closed ticket needs a new one,
not a reply.

**Polling.** This is the endpoint to poll while a thread is open, and two things
make that cheap:

- **`ETag`.** Send it back as `If-None-Match` and an unchanged thread is a `304`
  with no body.
- **`?since=`.** Pass the `createdAt` of the last message you hold. It is
  **exclusive**, so you get only what is new and can append the result directly.

```ts
useQuery({
  queryKey: ['support', number],
  queryFn: () => support(`/api/v1/support/conversations/${number}`),
  refetchInterval: 5_000, // while the screen is focused
});
```

### Reply

```
POST /api/v1/support/conversations/{number}/messages

{ "body": "لسه محدش رد عليا" }
```

→ `201`, with the full thread back so an optimistic row can be reconciled in one
round trip. A reply reopens a resolved ticket, exactly as an emailed reply
would.

### Unread badge

```
GET /api/v1/support/unread     →  { "unread": 2 }
```

Counts tickets whose last message is ours. Cheap enough for the Account tab to
call on focus.

## Help articles

```
GET /api/v1/support/articles                 the most-read articles for the locale
GET /api/v1/support/articles?q=تتبع الشحنة   search (3 characters minimum)
GET /api/v1/support/articles?locale=en       override the session's locale
```

```json
{
  "locale": "ar",
  "articles": [{ "title": "…", "slug": "…", "url": "https://…/ar/a/…" }]
}
```

Worth putting above the composer: answering before a ticket is opened is the
cheapest support there is, and myBlu has no help centre of its own today. Slugs
can be Arabic, so the `url` is already encoded — open it as given.

## Localisation

Send `Accept-Language: ar` or `en` on every call, as the app already does. It
decides the language of error messages, the article list, and the locale
recorded on the session. Arabic is the default when the header is missing.

## Backend asks

Things the myBlu side needs that are not in this system:

1. **`HELPDESK_API_URL`** in `app.config.ts`, `src/lib/env.ts`, and both
   `.env.staging/` and `.env.production/`.
2. **An install UUID**, generated once and kept in `expo-secure-store`.
3. **`logoutOn401: false`** on every support call, with a 403 retry (above).
4. **A deep link for a reply.** `parseRedirection` understands `/redirect/order/{id}`
   and the payment shapes today; a `/redirect/support/{number}` shape is what a
   push notification about an agent reply would carry. Push itself is not built
   yet — see below.
5. **Optionally, on `api.shipblu.com`:** return the phone from
   `/api/v1/myshipblu/customer-accounts/`. That is the whole of what turns
   `identityVerified` true for every user, and it needs no app release.

## Not built yet

**Push notifications.** The plan is an FCM data message when an agent replies,
carrying `link` for the existing deep-link router. It needs a device-token
endpoint here and the myBlu Firebase service account, which this system does not
hold. Until it exists, an agent's reply is discovered by polling an open thread
or by the unread badge on next launch.

**Attachments.** The message shape has no `attachments` array yet. It will be
added as an optional field rather than a breaking change. On the myBlu side this
needs `expo-image-picker` and a decision about `READ_MEDIA_IMAGES`, which
`app.config.ts` currently blocks deliberately to satisfy Play policy.

## Signed identities (optional)

Only relevant if the platform would rather sign at login than return the phone
from its profile endpoint. It needs an app release, because myBlu's zod DTOs
strip fields they do not name — which is why returning the phone is the
recommended route instead.

```
signature = HMAC-SHA256(MOBILE_IDENTITY_SECRET, "<phone>|<email>")   # lowercase hex
```

Both halves are the values _after_ normalisation: the phone as digits only, the
email lower-cased and trimmed. An empty field is still its side of the `|`. Send
it as `signature` in the handshake body.

The signature covers the identifying half only. Name is decoration, and covering
it would mean a customer editing their profile silently stops being identified.

The secret is `MOBILE_IDENTITY_SECRET`, per environment and never shared with
staging — a signature minted against one deployment would otherwise be replayable
at the other. While it is unset, signatures are ignored and identity rests on
what the platform returned.

## What an agent sees

A ticket on the **myBlu app** channel, with the parcel attached if one was
passed, the customer's name and number, and — where the platform confirmed who
they are — their WhatsApp and email history on the same contact. A reply typed
in the console is delivered by writing it: there is no provider in between, so
it is on the customer's screen at their next poll.
