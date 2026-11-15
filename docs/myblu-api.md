# The myBlu ticket API

How the myBlu app reaches ShipBlu's support team, and what each side has to
do for it to work. Written for two teams at once: **myBlu's backend**, which
mints a session for each user who asks for support and receives a webhook
when the team answers, and **myBlu's app**, which talks to this API through
the SDK. Whoever writes or reviews that SDK reads all of it, since the rules
and the conformance scenarios at the end are what an SDK is checked against.

Three files, and which one wins:

| File                          | What it is                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `docs/myblu-api.openapi.json` | **The contract**: every request, answer, header, error and the webhook, as OpenAPI 3.1.           |
| this guide                    | What the contract means, what the backend and an SDK must do, and the scenarios an SDK is run on. |
| `docs/myblu-api-changelog.md` | One dated line for every change to the contract.                                                  |

The document is built from `lib/api/schemas.ts`, the shapes the server's routes
parse with, and a test fails when the two disagree. Where this guide and the
document disagree, the document is right and this guide is the bug. The
reasoning behind the design is `plans/myblu-ticket-api.md`.

## Where it is

| Environment  | Base URL                                              | Notes                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production   | `https://support.shipblu.com/api/v1`                  | The name to build into the app.                                                                                                                                                            |
| Production   | `https://shipblu-support.onrender.com/api/v1`         | The same server on its service host, for a check when DNS is in doubt. Not for the app.                                                                                                    |
| Staging      | `https://shipblu-support-staging.onrender.com/api/v1` | Suspended. Resumed for named test windows, with its own secrets and its own minting token. A staging app never points at production, and a staging backend never holds production's token. |
| A local mock | `http://127.0.0.1:4010`                               | Served from the committed document; below.                                                                                                                                                 |

myBlu has no remote configuration: its own backend's base URL is set per build
(`extra.apiBaseUrl` in the app's `app.config.ts`), so this one goes beside it
and reaches users only with a release. Settle it before the first build that
carries the SDK.

**Paths have no trailing slash**, unlike ShipBlu's backend, which serves the app
Django-style URLs that end in one. `/api/v1/config/` is answered with a redirect
to `/api/v1/config`, and a client should never rely on following it.

**The shapes are published before the routes exist.** The contract went out in
stage 0b of the plan so the app and the SDK could be written against it; the
routes land stage by stage after it. Until an operation's stage ships, it
answers `404` without this API's error body, and an SDK changes nothing on one
(_Errors_). That is the framework's own page, but for `GET /tickets` from
stage 4 until stage 5: the route serving `POST /tickets` answers its `GET`
with an empty `404` of its own, never a `405`, so an SDK reads it as it reads
every operation not served yet. The document marks each operation with the
stage that serves it (`x-shipblu-stage`):

| Stage | Serves                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------- |
| 0b    | `GET /openapi.json`, the contract of the server answering, with no credential                            |
| 3     | `POST /sessions`, `POST /sessions/revoke`, `DELETE /session`, `GET /config`                              |
| 4     | `POST /tickets`, `GET /tickets/{id}`, `GET` and `POST /tickets/{id}/messages`. The SDK's 0.1 is cut here |
| 5     | `GET /tickets`, `POST /tickets/{id}/read`, and `support` on `GET /config`. A pilot can run from here     |
| 6     | The webhook's `message.created`. The launch waits for this                                               |
| 7     | Files: multipart on the two sends, and `GET /attachments/{id}`                                           |
| 8     | `GET` and `POST /tickets/{id}/survey`, and the webhook's `survey.created`                                |

### Running a mock

Any OpenAPI 3.1 mock server can serve the committed document. Stoplight's Prism
is the one this guide was checked with:

```bash
npx @stoplight/prism-cli@5.16.0 mock docs/myblu-api.openapi.json
```

It listens on `http://127.0.0.1:4010` and serves the paths **without** the
`/api/v1` prefix, so point the SDK's base URL at `http://127.0.0.1:4010`, with
`allowInsecureBaseUrl` set (rule 8 below). Every answer is a worked example from
the document. Ask for another with Prism's `Prefer` header, naming the status and
the example, which for a refusal is its error code:

```bash
H='ShipBlu-Client: sdk-ts/0.1.0 app/5.4.1 ios/18.1'

curl -s http://127.0.0.1:4010/config -H 'Authorization: Bearer sbu_test' -H "$H"

curl -s -X POST http://127.0.0.1:4010/tickets \
  -H 'Authorization: Bearer sbu_test' -H "$H" -H 'Prefer: code=201' \
  -H 'Idempotency-Key: 0b7e9c2a-3d4f-4a1b-8c5d-6e7f8a9b0c1d' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Where is my parcel?","locale":"en","trackingNumber":"1755021358719"}'

curl -s -i -X POST http://127.0.0.1:4010/tickets/8a1f4c2e-6b3d-4f9a-a7e5-1c2d3e4f5a6b/messages \
  -H 'Authorization: Bearer sbu_test' -H "$H" -H 'Prefer: code=409, example=ticket_closed' \
  -H 'Idempotency-Key: 4e3d2c1b-0a9f-4e8d-a7c6-b5a4f3e2d1c0' \
  -H 'Content-Type: application/json' -d '{"text":"Hello?","locale":"en"}'

curl -s -i http://127.0.0.1:4010/config -H 'Authorization: Bearer sbu_test' -H "$H" -H 'Prefer: code=429'
```

What the mock does that the server does not, so a test against it is read
correctly:

- **It answers the lowest success status an operation has.** On the two sends
  that is the replay's `200` with `Idempotent-Replayed: true`, so ask for
  `Prefer: code=201` to see a first send.
- **It checks each request against the document** and answers a refusal the
  document declares — a `400` with its first example, a `401` for a missing
  bearer — and says what it found in an `sl-violations` header. The example's
  `field` is the example's, not the request's.
- **It reads repeated multipart parts as one value**, so it refuses every
  multipart send with files. Drive files against staging once stage 7 ships.
- **It accepts any bearer** and keeps no state: a ticket created is not there
  to read, and a key sent twice is not remembered. The conformance scenarios
  below that turn on state are run against a stub of the SDK's own, which this
  mock's examples are the fixtures for.
- **It sends CORS headers.** The server sends none and answers no `OPTIONS`.

## Two planes, and a webhook back

|              | Who calls                | Credential                                    | May do                                  |
| ------------ | ------------------------ | --------------------------------------------- | --------------------------------------- |
| Server plane | myBlu's backend          | `Authorization: Bearer <MYBLU_API_TOKEN>`     | mint a session for a user; end sessions |
| Client plane | the app, through the SDK | `Authorization: Bearer <session token>`       | everything else, as that one user       |
| Webhook      | this system, to myBlu    | an HMAC over the body, `MYBLU_WEBHOOK_SECRET` | tell the backend something happened     |

The server plane's token never ships in the app: a value compiled into a binary
is extractable, and whoever extracts it can mint any user. So the app asks its
own backend for a session, the backend asks this API, and the app holds a token
that is good for one user for twenty-four hours. The backend never creates a
ticket or reads a message: a user named in a request body is a claim, and only
the session says who is asking.

## For myBlu's backend

The backend team has not said which languages it writes. The snippets below are
in Python and Node, as defaults: ShipBlu's backend serves the app Django-style
URLs, so Python is the likely one. They are written to be read, not pasted —
error handling and configuration are the backend's own.

### Minting a session

The app asks the backend for a support session whenever the SDK needs a token:
when it has none, when one is refused, and shortly before one runs out. The
backend's route for that is its own to name — something like
`POST /api/v1/myshipblu/support-session/` — authenticated by the app's own
access token like every other route it serves. The app's request carries
`{ platform, appVersion }`, taken from the `client` the SDK is configured
with, because `POST /sessions` asks for both and only the app knows them; they
are labels for the support team to read, never a credential. The backend reads
the signed-in user, calls `POST /sessions` here, and hands back two fields.

When `POST /sessions` refuses, the backend answers the app with the refusal as
it came — its status, this API's error body, and `Retry-After` on a `429` — for
the three codes the app's SDK acts on: `403 blocked`, `429 rate_limited` and
`503 not_configured`. Anything else, a `400` or a `401` (the backend's own bug),
a `5xx` or no answer at all, is a `502` of the backend's own, which the SDK
reads as "not signed in" (rule 2).

```python
import os
import requests

SUPPORT_API = "https://support.shipblu.com/api/v1"


class SupportRefusal(Exception):
    """403 blocked, 429 rate_limited or 503 not_configured: answer the app with
    this status, this body and this Retry-After, as they came."""

    def __init__(self, status: int, body: dict, retry_after):
        super().__init__(f"support API refused: {status}")
        self.status, self.body, self.retry_after = status, body, retry_after


def refusal_to_relay(response):
    if response.status_code not in (403, 429, 503):
        return None
    try:
        body = response.json()
    except ValueError:
        return None  # not this API's answer: a proxy's page, say
    if not isinstance(body, dict) or "error" not in body:
        return None
    return SupportRefusal(response.status_code, body, response.headers.get("Retry-After"))


def to_e164(phone: str) -> str:
    """The app signs in with 01XXXXXXXXX; this API takes +20 and the last ten digits."""
    digits = "".join(ch for ch in phone if ch.isdigit())
    if len(digits) == 11 and digits.startswith("01"):
        return "+20" + digits[1:]
    if len(digits) == 12 and digits.startswith("201"):
        return "+" + digits
    raise ValueError("not an Egyptian mobile number")


def mint_support_session(user, platform: str, app_version: str) -> dict:
    """platform and app_version are the app's request's: "ios" or "android", and "5.4.1"."""
    body = {
        "externalUserId": user.support_id,  # stable, never reused, never the phone
        "phone": to_e164(user.phone),
        "client": {"platform": platform, "appVersion": app_version},  # "ios" or "android"
    }
    name = user.get_full_name()
    # At most 200 UTF-16 code units, which len() does not count; a longer one is refused.
    if name and len(name.encode("utf-16-le")) // 2 <= 200:
        body["name"] = name
    response = requests.post(
        f"{SUPPORT_API}/sessions",
        json=body,
        headers={"Authorization": f"Bearer {os.environ['MYBLU_API_TOKEN']}"},
        timeout=10,
    )
    refusal = refusal_to_relay(response)
    if refusal:
        raise refusal
    response.raise_for_status()  # anything else: a 502 of the backend's own
    session = response.json()
    # Hand these to the app and keep nothing: never log, cache or store the token.
    return {"token": session["token"], "expiresInSeconds": session["expiresInSeconds"]}


def revoke_support_sessions(user, reason: str) -> None:
    """reason: signed_out, phone_changed, account_deleted, number_released or other."""
    requests.post(
        f"{SUPPORT_API}/sessions/revoke",
        json={"externalUserId": user.support_id, "reason": reason},
        headers={"Authorization": f"Bearer {os.environ['MYBLU_API_TOKEN']}"},
        timeout=10,
    ).raise_for_status()
```

```js
const SUPPORT_API = 'https://support.shipblu.com/api/v1';

/** 403 blocked, 429 rate_limited or 503 not_configured: answer the app with these, as they came. */
export class SupportRefusal extends Error {
  constructor(status, body, retryAfter) {
    super(`support API refused: ${status}`);
    Object.assign(this, { status, body, retryAfter });
  }
}

/** The app signs in with 01XXXXXXXXX; this API takes +20 and the last ten digits. */
export function toE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('01')) return `+20${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('201')) return `+${digits}`;
  throw new Error('not an Egyptian mobile number');
}

async function serverPlane(path, body) {
  const response = await fetch(`${SUPPORT_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MYBLU_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return response.status === 204 ? null : response.json();
  if ([403, 429, 503].includes(response.status)) {
    const refusal = await response.json().catch(() => null); // a proxy's page is not one
    if (refusal?.error) {
      throw new SupportRefusal(response.status, refusal, response.headers.get('Retry-After'));
    }
  }
  throw new Error(`support API answered ${response.status}`); // a 502 of the backend's own
}

/** platform and appVersion are the app's request's: 'ios' or 'android', and '5.4.1'. */
export async function mintSupportSession(user, { platform, appVersion }) {
  const session = await serverPlane('/sessions', {
    externalUserId: user.supportId, // stable, never reused, never the phone
    phone: toE164(user.phone),
    // At most 200 UTF-16 code units, which `length` counts; a longer one is refused.
    ...(user.name && user.name.length <= 200 && { name: user.name }),
    client: { platform, appVersion },
  });
  // Hand these to the app and keep nothing: never log, cache or store the token.
  return { token: session.token, expiresInSeconds: session.expiresInSeconds };
}

/** reason: signed_out, phone_changed, account_deleted, number_released or other. */
export function revokeSupportSessions(user, reason) {
  return serverPlane('/sessions/revoke', { externalUserId: user.supportId, reason });
}
```

`POST /sessions` answers `201 { token, expiresAt, expiresInSeconds }`: a new
token on every call, twenty-four hours from minting, with no refresh token.
`expiresInSeconds` is a whole number, at least 1, which the SDK measures on its
own clock from the moment its provider answered (rule 2), so hand it to the app
as it came. `name` is at most 200 UTF-16 code units, which JavaScript's
`length` counts and Python's `len` does not: a longer one is
`400 invalid_request`, so a `502` to the app, which reads it as not signed in.
Leave such a name out.

`POST /sessions/revoke` answers `204` whether or not the user is known. Its
refusals are the backend's to act on, and none is relayed: there is no app
waiting. A revoke refused `503 not_configured` is sent again later, since a
session minted before the API was switched off works again if it is switched
back on within that session's day.

### Receiving the webhook

One URL, registered with ShipBlu (`MYBLU_WEBHOOK_URL` on this side), receives
every event. It is `https`, with no query string and no userinfo
(`user:password@`): a URL that is not is refused when ShipBlu first uses it, and
nothing is sent, so a delivery is authenticated by its signature and never by a
token in the URL. It is posted to exactly as registered, and a redirect is not
followed, so a `3xx` is a failed delivery: register the URL as the receiver
serves it. On Django that means with its trailing slash, or `APPEND_SLASH`
redirects every delivery and every one fails.

The receiver verifies the signature over the **raw** body before it parses
anything: parsing and re-serialising changes the bytes, and the signature no
longer matches.

```python
import hashlib
import hmac
import re
import time


def verify(raw_body: bytes, timestamp, signature, secret: str, now=None) -> bool:
    """X-ShipBlu-Timestamp and X-ShipBlu-Signature, over request.body in Django.

    Either header may be missing (None): the answer is then False, never an exception.
    """
    now = time.time() if now is None else now
    if timestamp is None or signature is None:
        return False
    # ASCII digits only: str.isdigit() also passes "²", which int() then refuses.
    if not re.fullmatch(r"[0-9]{1,12}", timestamp) or abs(now - int(timestamp)) > 300:
        return False
    expected = hmac.new(
        secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256
    ).hexdigest().encode()
    # Two signatures, comma-separated, while ShipBlu rotates its secret: accept either.
    # Bytes, because compare_digest raises on a str with a non-ASCII character in it.
    return any(
        part.startswith("v1=") and hmac.compare_digest(part[3:].encode(), expected)
        for part in signature.split(",")
    )
```

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

/** rawBody is the request's bytes, e.g. from express.raw({ type: 'application/json' }). */
export function verify(rawBody, timestamp, signature, secret, now = Date.now() / 1000) {
  if (!/^\d{1,12}$/.test(timestamp ?? '') || Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex'),
  );
  // Two signatures, comma-separated, while ShipBlu rotates its secret: accept either.
  return (signature ?? '').split(',').some((part) => {
    const given = Buffer.from(part.startsWith('v1=') ? part.slice(3) : '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Then, in order: refuse with `401` if it does not verify; parse the body; if its
`id` was seen in the last day, answer `2xx` and stop; record the `id`, answer
`2xx`, and only then push. Anything but a `2xx` is retried, and the same event
arrives again.

Answer within ten seconds: ShipBlu waits that long for each attempt, and one
not answered by then is retried as a refusal is. Retries back off and stop
within a day of the event, which is why a day of dedupe covers them. A receiver
down for longer loses those pushes, never the messages: the app's next poll
still reads them.

### The backend's rules

- **Never log or store a session token.** It is the user's support history,
  read and written, for a day. Pass it to the app and keep nothing; the backend
  needs none of its own, since it never calls the client plane.
- **Mint a new one on every call.** A backend that caches a token hands back the
  token that was just refused, and the app loops between the two.
- **`MYBLU_API_TOKEN` stays on the backend.** It mints any user. On a suspected
  leak, ShipBlu replaces the value (the leaked one never becomes the previous
  one), revokes every live session, and reads what was minted in the window.
- **`externalUserId` is stable for a person, never reused, and not the phone.**
  The app does not see one today: verifying the code answers
  `{ access_token, is_new }` and the profile answers an email and a name. So the
  backend exposes the id it holds, or mints one when an account is created, and
  sends it to the app as well — on the profile or beside the token at sign-in —
  because the SDK's `user()` is the app saying who is signed in, and the app has
  nothing else to say it with.
- **Phones are strict E.164 with the plus.** The app holds and sends the national
  form, `01` and nine digits, the only one its sign-in accepts; convert it to
  `+20` and the last ten digits before minting. A national number is refused
  `400 invalid_request` rather than guessed, because a wrong guess is a
  different person, silently.
- **Revoke when the person behind an account changes.** `account_deleted` behind
  the app's `DELETE /api/v1/myshipblu/customer-accounts/`; `phone_changed` when
  the number on an account changes; `number_released` when a number is given to
  somebody new and keeps the old account; `signed_out` for a "sign out
  everywhere". `account_deleted` and `number_released` also take the user's
  tickets out of the app for good; they stay with the support team. A sign-out
  on one device is the SDK's `reset()`, which ends that device's session only.
- **Push only to devices signed in as that user.** The webhook names
  `user.externalId`. Today the app registers its FCM token at
  `POST /api/v1/users/device-tokens/` without its bearer, keyed by the profile's
  email, and registers nothing for a profile with no email; a sign-out withdraws
  nothing. That cannot meet this rule: register device tokens with the app's
  bearer, keyed by the backend's own user id, and drop them on sign-out.
- **Write the push's title and body yourself, in the user's language**, beside
  the data keys below. The app shows a push only with the title and body it
  carries, and has no wording of its own to fall back on. The webhook carries no
  message text, on purpose: a customer's words would pass through a third system
  and onto a lock screen.

## Headers

| Header                | Direction | When                                  | What                                                                                                                                                            |
| --------------------- | --------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`       | request   | every request but `GET /openapi.json` | `Bearer <MYBLU_API_TOKEN>` on the server plane, `Bearer <session token>` on the client plane. No credential is ever accepted in a URL.                          |
| `ShipBlu-Client`      | request   | every client-plane request            | `sdk-ts/0.3.0 app/5.4.1 ios/18.1`: `name/version` tokens, the SDK first, then the app, then the platform. Missing is `400 invalid_request`; it decides a `426`. |
| `Idempotency-Key`     | request   | `POST /tickets`, `POST …/messages`    | A UUID made before a send's first attempt and reused on every retry of it. Missing or not a UUID is `400 idempotency_key_required`.                             |
| `Content-Type`        | request   | a request with a body                 | `application/json`, or `multipart/form-data` on the two sends from stage 7.                                                                                     |
| `Content-Length`      | request   | a multipart body                      | Required: `411 length_required` without it.                                                                                                                     |
| `ShipBlu-Request-Id`  | answer    | every answer                          | An opaque id for the request, repeated in an error's body. Quote it in a bug report.                                                                            |
| `Cache-Control`       | answer    | every answer                          | `no-store`. Nothing between the server and the app may cache an answer.                                                                                         |
| `Idempotent-Replayed` | answer    | a `200` to a send                     | `true`: an earlier attempt under the same key stored the message, and this is what it stored.                                                                   |
| `Retry-After`         | answer    | a `429`                               | Whole seconds to wait.                                                                                                                                          |
| `X-ShipBlu-Event`     | webhook   | every delivery                        | The body's `type`.                                                                                                                                              |
| `X-ShipBlu-Event-Id`  | webhook   | every delivery                        | The body's `id`, the same on every attempt.                                                                                                                     |
| `X-ShipBlu-Timestamp` | webhook   | every delivery                        | Unix seconds when this attempt was signed.                                                                                                                      |
| `X-ShipBlu-Signature` | webhook   | every delivery                        | `v1=<hex>`, or `v1=<hex>,v1=<hex>` while a secret is rotated.                                                                                                   |

The API reads no `Accept-Language`. `locale` on a write, exactly `ar` or `en`, is
the only language it is told, and the only translated text it returns is a
survey's.

## Operations

| Plane  | Operation                          | Body                                                                 | Answers                                                                             |
| ------ | ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| none   | `GET /openapi.json`                |                                                                      | `200`, the contract                                                                 |
| Server | `POST /sessions`                   | `{ externalUserId, phone, name?, client: { platform, appVersion } }` | `201 { token, expiresAt, expiresInSeconds }`                                        |
| Server | `POST /sessions/revoke`            | `{ externalUserId, reason }`                                         | `204`, whether or not the user is known                                             |
| Client | `DELETE /session`                  |                                                                      | `204`                                                                               |
| Client | `GET /config`                      |                                                                      | `200`, below                                                                        |
| Client | `POST /tickets`                    | `{ text, locale, trackingNumber? }`; multipart from stage 7          | `201 { ticket, message }`; `200` to a replay                                        |
| Client | `GET /tickets/{id}`                |                                                                      | `200 { ticket }`                                                                    |
| Client | `GET /tickets/{id}/messages`       | `?after=` or `?before=`, `?limit=`                                   | `200 { messages, olderCursor, newerCursor, ticket, unreadTotal, pollAfterSeconds }` |
| Client | `POST /tickets/{id}/messages`      | `{ text, locale }`; multipart from stage 7                           | `201 { message, ticket }`; `200` to a replay                                        |
| Client | `GET /tickets`                     | `?before=`, `?limit=`, `?trackingNumber=`                            | `200 { tickets, olderCursor, unreadTotal, pollAfterSeconds }`                       |
| Client | `POST /tickets/{id}/read`          | `{ upTo }`                                                           | `200 { ticket, unreadTotal }`                                                       |
| Client | `GET /attachments/{id}`            |                                                                      | `200 { url, expiresInSeconds }`                                                     |
| Client | `GET`, `POST /tickets/{id}/survey` | `POST`: `{ rating, comment? }`                                       | `200 { survey }`; `GET` is `404` while there is none                                |

A request field the server does not know is ignored rather than refused, so an
SDK newer than the server it meets still works. A field it knows and finds wrong
is `400 invalid_request`, with `field` naming it.

## What it answers

JSON in UTF-8. Instants are ISO-8601 in UTC with their `Z`. Ids are UUIDs.

### A ticket

One per problem, many per user, opened from the app and never from anywhere
else: the app sees only the tickets its own user opened through it.

| Field            | Type                                 | Meaning                                                                                                                                             |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | uuid                                 | The ticket.                                                                                                                                         |
| `number`         | integer                              | The number the user and an agent can both quote.                                                                                                    |
| `subject`        | string or null                       | The opening message's first words; null when it had none, such as a ticket opened with a photo, and the app draws its own title.                    |
| `trackingNumber` | string or null                       | The number the ticket was opened with, as sent. Never one an agent added.                                                                           |
| `status`         | `open` `pending` `resolved` `closed` | The status's category. More may be added; draw an unknown one as `open`. A reply to `resolved` reopens the ticket; a reply to `closed` is refused.  |
| `statusLabel`    | string or null                       | A label the team typed for this status, one language, shown as written. When null, the SDK's word for `status`.                                     |
| `canReply`       | boolean                              | Whether a message may be sent now.                                                                                                                  |
| `createdAt`      | instant                              | When it was opened.                                                                                                                                 |
| `lastMessageAt`  | instant                              | When its newest message was stored; the list is ordered by it.                                                                                      |
| `unreadCount`    | integer                              | The team's messages on it not yet marked read.                                                                                                      |
| `preview`        | object or null                       | `{ from, text, hasAttachments }`: the newest message, for a list row; `text` is its first 140 UTF-16 code units, never cut inside a surrogate pair. |
| `survey`         | object or null                       | `{ status }` when the ticket has a survey, so a list can prompt without a call per ticket. Null until stage 8.                                      |

The SDK ships the help centre's words for the four statuses: Open / مفتوحة,
In progress / قيد المعالجة, Resolved / تم الحل, Closed / مغلقة.

A ticket here has no assignee, group, priority, category, tag, custom field,
SLA date or event in it. That is the read model, not an omission.

### A message

| Field         | Type                        | Meaning                                                                                                                                     |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | uuid                        | The message. Merge by it.                                                                                                                   |
| `from`        | `customer` `agent` `system` | The user; a person on the team; nobody, as an automated reply. More may be added; draw an unknown one as `system`. No agent's name is sent. |
| `text`        | string                      | Words somebody wrote, never a label of ours: `""` for a message sent as files alone.                                                        |
| `createdAt`   | instant                     | When the server stored it.                                                                                                                  |
| `clientId`    | uuid or null                | The `Idempotency-Key` the user's own message was sent under, on every read: how an outbox recognises a message whose answer it never got.   |
| `attachments` | array                       | `{ id, filename, contentType, sizeBytes }` per file, in order. `contentType` is what the server read from the bytes.                        |

Only replies are returned: never an agent's note, an event or a forward.

### `GET /config`

| Field               | Meaning                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.id`           | The user's id here, which a contact merge does not change. Kept in the store, which is namespaced by `externalUserId` (rule 1); when it changes, the cached tickets and messages are wiped.         |
| `user.externalId`   | The id the session was minted for. A client that asked for another user discards the token.                                                                                                         |
| `tickets.canCreate` | Whether `POST /tickets` is open now. When false, hide the new-ticket button rather than fail a send.                                                                                                |
| `tickets.maxOpen`   | Open or pending tickets one user may have at once.                                                                                                                                                  |
| `limits.*`          | `messageMaxChars`, `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `contentTypes`, `extensions`. They move with the server; check against these. `messageMaxChars` counts UTF-16 code units (_Files_). |
| `support`           | `{ online, opensAt, timezone }`, the team's hours. Absent until stage 5; `opensAt` and `timezone` are null when no hours are set.                                                                   |
| `polling`           | `{ threadSeconds, listSeconds }`: what a screen polls at before its first `pollAfterSeconds`. Whole seconds, each at least 1.                                                                       |

### The survey

`GET /tickets/{id}/survey` answers `{ survey }`, where `survey` is
`{ id, status, rating, comment, locale, intro, question, labels, commentPrompt,
commentMaxChars, button, thanks, expiresAt }`, worded on the server in the
survey's own locale, which can differ from the app's. `status` is `sent`
(waiting), `answered` or `expired`, and a status the SDK does not know is drawn
as `expired`, which offers nothing to tap. A ticket with no survey answers
`404`, and so does one whose survey the team decided not to send. `labels` is
five words for the ratings 1 to 5. The rating is posted the moment it is
tapped; a comment is a second `POST` carrying the same rating. The first rating
wins whichever way it came — the app, or a link — so draw the survey `POST`
answers, not the rating tapped.

`commentMaxChars` is the longest comment kept, in UTF-16 code units as
`limits.messageMaxChars` is: stop the comment box there. A longer comment is
`400 invalid_request` and is never cut short, since the user's last sentence
would go without a word. It is on the survey rather than in `GET /config`
because the survey carries the rest of the box's words.

## Errors

One shape for every refusal:

```json
{
  "error": {
    "code": "ticket_closed",
    "message": "The ticket is closed; open a new one.",
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

`message` is English for a developer's log: never shown to the user, never
parsed. `requestId` is the answer's `ShipBlu-Request-Id`. A client branches on
`code`, and classifies a code it does not know by the HTTP status it came with:
codes are added.

An answer without this API's error body — a proxy's page, or the framework's
`404` for a route this server does not serve — is classified by its status as
well, with one exception. Such a `404` says nothing about the ticket: an
operation answers it before its stage ships — `GET /tickets` included, while
`POST /tickets` on the same path is already served — and again if that stage
is reverted. So the SDK fails the call and changes nothing in its store or its
outbox; only `not_found` in the body drops a ticket.

| HTTP | `code`                               | Also in `error`                                                                           | What the SDK does                                                                                               |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid_request`                    | `field`                                                                                   | fails the call. A text over the limit is this; never truncated                                                  |
| 400  | `invalid_cursor`                     |                                                                                           | drops the cursor and loads the newest page                                                                      |
| 400  | `idempotency_key_required`           |                                                                                           | an SDK bug; never retried                                                                                       |
| 400  | `empty_message`                      |                                                                                           | fails the send. Neither words nor files                                                                         |
| 400  | `file_refused`                       | `reason`: `too_many`, `too_large`, `too_large_total`, `type`, `empty`; `filename` or null | fails the send and names the file                                                                               |
| 401  | `unauthenticated`, `session_expired` |                                                                                           | one refresh, one replay                                                                                         |
| 403  | `blocked`                            |                                                                                           | stops; no refresh, no retry                                                                                     |
| 404  | `not_found`                          |                                                                                           | drops the ticket from its store and fails its outbox entries. A `404` without this body changes nothing (above) |
| 409  | `ticket_closed`                      |                                                                                           | fails the send; the app offers a new ticket                                                                     |
| 409  | `too_many_open`                      |                                                                                           | fails the create; never retried                                                                                 |
| 409  | `key_reused`                         |                                                                                           | an SDK bug                                                                                                      |
| 411  | `length_required`                    |                                                                                           | an SDK bug                                                                                                      |
| 413  | `too_large`                          |                                                                                           | fails the send                                                                                                  |
| 426  | `client_upgrade_required`            |                                                                                           | stops every call; tells the app once                                                                            |
| 429  | `rate_limited`                       | `Retry-After` header                                                                      | waits that long, then retries                                                                                   |
| 500  | `internal`                           |                                                                                           | backs off: five attempts for a read; a send until its entry ages                                                |
| 502  | `upload_failed`                      |                                                                                           | nothing was stored; retries the whole send under the same key                                                   |
| 503  | `not_configured`                     |                                                                                           | on `POST /tickets`: fails the create, not retried. Elsewhere: holds everything until the next foreground        |

`unauthenticated` is no bearer, a malformed one, or a token with no live session
behind it: unknown, swept or revoked. `session_expired` is a session past its
twenty-four hours. A client treats the two alike, because the server often
cannot tell them apart.

`not_found` is one answer for a ticket that is not the user's, not there,
deleted, or merged into another, and for an id that is not a UUID: nothing
tells those apart, so nothing can be learned by asking. `not_configured` on any
operation means the API is switched off on that server; on `POST /tickets`
alone, that opening tickets is (`GET /config` says so beforehand, as
`tickets.canCreate`). So a create it refuses is failed, and on any other call
the SDK stops polling and holds the outbox, sending nothing, until the next
foreground asks again; an entry still fails once it is a day old (rule 4).

## Idempotency

The two requests that write a message carry `Idempotency-Key`, a UUID the SDK
makes before the first attempt and sends again, unchanged, on every retry.

- The first time, the answer is `201`. A retry of a send the server already
  stored is `200` with `Idempotent-Replayed: true`, and answers what the first
  attempt stored: no second message, and on `POST /tickets` no second ticket.
- A retry of a create whose ticket the user can no longer read — deleted,
  marked spam or merged away since the first attempt — is `404 not_found`, and
  nothing is created. The SDK fails the entry.
- A key sent with another ticket or another operation is `409 key_reused`.
- Keys are the user's own: one user can neither collide with another's nor learn
  whether another's exists.
- Every message the user wrote carries its key back as `clientId`, on every read
  and not only in the send's answer. When the answer to a send is lost and the
  next poll returns the message, the outbox still holding it matches it by
  `clientId` and draws one bubble.

## Reading without a stream

There is no stream, ever: no SSE and no WebSocket. The app polls a cursor while
a screen is open and is woken by a push while it is not.

- `GET /tickets/{id}/messages` with no cursor returns the **newest** page.
  `?before=<olderCursor>` returns the page before it; `olderCursor` is null at the
  start of the thread. `?after=<newerCursor>` returns what is newer; `newerCursor`
  is never null and comes back unchanged when nothing is new, so a poll always has
  a cursor to send. Both together is `400 invalid_request`.
- `messages` is ascending by `(createdAt, id)` whichever way was asked. `limit`
  is 30 by default and 100 at most. A full page means ask again at once.
- `after` re-reads a few seconds before its cursor, because a row stamped
  earlier can be committed later. **A page may repeat rows the client holds:
  merge by `id`.**
- `GET /tickets` is newest first by `(lastMessageAt, id)` and pages back with
  `before`. It has no `after`: a ticket that gets a message moves to the top, so
  the list is polled by re-reading its first page and merging by `id`.
  `?trackingNumber=` finds the tickets opened with a parcel's number, so a
  shipment screen finds its ticket after a reinstall.
- A cursor is opaque. Send it back as it came; one this server did not mint is
  `400 invalid_cursor`, never a first page.
- **Every poll's answer carries `pollAfterSeconds`, and the SDK obeys it.** A
  whole number of seconds, never less than 1. Five seconds on an open thread to
  start, thirty on the list, nothing in the background. It is how load is shed
  by a change here rather than a release of the app, which takes days to reach
  users and leaves old builds for months.

## Read receipts and unread

`POST /tickets/{id}/read` with `{ upTo }`, the newest message on screen, marks the
team's messages read up to it. The agent sees "Read" on them. `upTo` is any
message this API returned on this ticket, the user's own included; one that is
not a reply on the ticket is `400 invalid_request` and marks nothing. Marking
twice, or backwards, changes nothing.

`unreadCount` on a ticket and `unreadTotal` across them are the team's messages
not yet marked read. They are kept on the server, so two devices and a reinstall
show the same badge. `unreadTotal` also rides on every `GET …/messages`, so a
badge is right while a thread is open.

## Files

From stage 7. Before it, a multipart body is `400 invalid_request`.

- **Sending.** `multipart/form-data` on the two sends: parts `text`, `locale`
  and, on `POST /tickets`, `trackingNumber`, named as the JSON fields are; and
  `files`, repeated, one part per file in the order to show them. `text` may be
  empty when there is a file.
- **Limits** come from `GET /config`: five files, 25 MB each and 25 MB in all,
  and 5,000 UTF-16 code units of text, today. A file or a text over a limit is
  refused by the SDK before anything is sent.
- **Text is counted in UTF-16 code units**, as JavaScript's `length` counts it,
  so an emoji is two. The document's `maxLength` on `text` counts characters,
  so a text with emoji in it can pass that bound and still be refused: check
  against `limits.messageMaxChars`.
- **A file is admitted on its label and stored by its bytes.** A part's
  `Content-Type` must be one of `limits.contentTypes`; a part with none, or with
  `application/octet-stream`, is admitted only by an extension in
  `limits.extensions`. So take the type from the platform's own reading, and give
  a nameless file a name with an extension. A voice recording must be labelled as
  audio, or its MP4 container is stored as a video.
- **`Content-Length` is required** on a multipart body, `411` without it, so the
  SDK builds the body in a file first. The proxy in front of the server cuts an
  oversized body short rather than refusing it, and the header is the only guard.
- **Downloading.** `GET /attachments/{id}` answers `{ url, expiresInSeconds }`,
  a five-minute link on another host. Use it at once; never log it, store it, or
  send the session's bearer to it. Expiry is not revocation; a `403` from the
  link means ask again. JSON rather than a redirect, so no HTTP library has to
  decide whether to forward `Authorization` to another host.
- Files from the team: not yet. The read model already carries `attachments` on
  every message, so the day an agent can send one, no app changes.

## Limits

In memory on each server instance: abuse control, not a quota, forgotten on a
deploy. A refusal is `429 rate_limited` with `Retry-After`, and a refused request
still counts, so a client that polls through a refusal stays refused until the
window turns.

| Bucket                    | Key              | Limit                                      |
| ------------------------- | ---------------- | ------------------------------------------ |
| Client plane, before auth | address          | 1,200 a minute                             |
| Bad bearer                | address          | 120 a minute                               |
| Server plane, all calls   | the plane        | 600 a minute                               |
| Minting                   | `externalUserId` | 10 in ten minutes                          |
| Reads                     | identity         | 240 a minute                               |
| Sends                     | identity         | 20 a minute                                |
| New tickets               | identity         | 10 an hour, and 10 open or pending at once |
| Uploaded megabytes        | identity         | 100 an hour                                |

The first bucket is live with `GET /openapi.json`; the rest arrive with the
routes they guard. The minting bucket bounds an honest app's loop and nothing
more, since the caller chooses its key; the server plane's own bucket is what
caps minting.

## The webhook

From stage 6, one `POST` to `MYBLU_WEBHOOK_URL` per event, while the URL is set:

```text
POST <MYBLU_WEBHOOK_URL>
Content-Type: application/json; charset=utf-8
X-ShipBlu-Event: message.created
X-ShipBlu-Event-Id: message.created:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f
X-ShipBlu-Timestamp: 1794476469
X-ShipBlu-Signature: v1=3124322b87a59bb4b8b2677d6ff364ea2b77f48be9d0933de71ff3be1433f03d
```

```json
{
  "version": 1,
  "id": "message.created:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  "type": "message.created",
  "occurredAt": "2026-11-12T09:41:07.004Z",
  "user": { "externalId": "u_83412" },
  "ticket": { "id": "8a1f4c2e-6b3d-4f9a-a7e5-1c2d3e4f5a6b", "number": 4812, "status": "open" },
  "message": { "id": "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f", "from": "agent" }
}
```

| Event             | From    | Sent when                                                                        | Carries                     |
| ----------------- | ------- | -------------------------------------------------------------------------------- | --------------------------- |
| `message.created` | stage 6 | a person on the team, or an automated reply, writes on one of the user's tickets | `message: { id, from }`     |
| `survey.created`  | stage 8 | a resolved ticket's survey is ready to answer in the app                         | `survey: { id, expiresAt }` |

Ids only, never text: the body is rebuilt from the database when it is sent, so
a message purged before a retry lands is never sent late. `user.externalId` is
read off the ticket's own record of who opened it, never off the contact, and
the phone is never sent. More event types will be added; a receiver answers
`2xx` to one it does not know and does nothing with it.

**The signature** is `v1=` and the lowercase hex HMAC-SHA256, under
`MYBLU_WEBHOOK_SECRET`, of the `X-ShipBlu-Timestamp` value, a `.`, and the raw
body. The timestamp is the attempt's, so a retry is not refused by the clock
rule. While ShipBlu rotates the secret, the header carries two signatures,
`v1=<hex>,v1=<hex>`, one under each, and the receiver accepts either: it holds
one secret and moves to the new one when told.

### The test vector

A receiver's verification, run over these four lines with the clock rule off
(they are signed in the past), accepts them. The secret is a throwaway that no
server holds. A test in this repository recomputes the signature from these
lines, so they cannot drift from the scheme.

```text
secret: throwaway-test-secret-not-for-any-server
timestamp: 1794476469
body: {"version":1,"id":"message.created:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f","type":"message.created","occurredAt":"2026-11-12T09:41:07.004Z","user":{"externalId":"u_83412"},"ticket":{"id":"8a1f4c2e-6b3d-4f9a-a7e5-1c2d3e4f5a6b","number":4812,"status":"open"},"message":{"id":"6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f","from":"agent"}}
signature: v1=3124322b87a59bb4b8b2677d6ff364ea2b77f48be9d0933de71ff3be1433f03d
```

The body is exactly the bytes after `body: ` to the end of the line, with no
trailing newline.

### The receiver's rules

- Verify over the raw body, before parsing.
- Refuse a timestamp more than five minutes from the receiver's clock.
- Dedupe on the event's `id` for a day: the sender runs each event at least
  once, not exactly once, and a retry carries the same `id`.
- Answer `2xx` as soon as the event is verified and recorded, within ten
  seconds, and do the work after. Anything else is retried, a redirect
  included.
- Push only to devices signed in as that user.
- Treat the webhook as a hint and `GET …/messages` as the truth. A webhook can
  be late, or lost after its retries; the app's next poll is not.

## The push

The backend forwards each event to the user's devices as an FCM data payload
with exactly these keys, every value a string, beside the title and body it
writes itself:

| Key                | Value                                          |
| ------------------ | ---------------------------------------------- |
| `sb_v`             | `"1"`. A payload without it is not this API's. |
| `sb_type`          | the event's `type`, e.g. `"message.created"`   |
| `sb_event_id`      | the event's `id`                               |
| `sb_user`          | `user.externalId`                              |
| `sb_ticket_id`     | `ticket.id`                                    |
| `sb_ticket_number` | `ticket.number`, as a string                   |
| `sb_message_id`    | `message.id`, on `message.created`             |
| `sb_survey_id`     | `survey.id`, on `survey.created`               |

The document publishes this as the `PushData` schema. No key carries a
message's text.

One push reaches the app twice: **when it arrives**, and again **when it is
tapped**. The app hands it to `support.push.handle(message.data)` both times,
ahead of its own routing on `data.link`. The SDK answers null for a push that is
not this API's or is for another user, and the app goes on as it does today.
Otherwise it answers `{ type, ticketId, ticketNumber, messageId }` every time it
is handed that push, and fetches the ticket's new messages only the first time
(rule 10). On arrival the app shows the notification as it shows any other and
opens nothing; on a tap it opens that ticket.

A notification the app draws itself, as myBlu does for a push that arrives in
the foreground on Android, carries these keys beside the app's own, or its tap
has nothing to route on. `push.handle` ignores any key it does not know.

## What is not in the contract

- **A stream.** No SSE and no WebSocket, on any version. Poll a cursor.
- **A ticket API for the backend.** The server plane mints and ends sessions,
  and nothing else; the backend never creates a ticket or reads a message.
- **Shipment data.** No answer carries anything about a parcel but the tracking
  number the same user opened the ticket with. The app has its own source.
- **A category, a form or a priority chosen by the app.** The support side files
  each ticket, and a person corrects it.
- **The agent's name.** Messages say `from: agent`.
- **A browser client.** No CORS header, no `OPTIONS`.
- **Files from the team**, until the console can send one.
- **A status-change event.** Status rides on every poll and on the next
  `message.created`.
- **A device-registration endpoint.** The backend holds the push credentials and
  the device tokens; this side holds neither.
- **A survey by email** for a myBlu ticket.
- **Retirement headers, yet.** When an operation is retired, `Deprecation` and
  `Sunset` arrive six months ahead, and `/api/v1` lives twelve months after
  `/api/v2` exists.

## What every SDK does

The behaviours a generated client does not give, as rules. Every SDK follows
them, and the scenarios below check them.

1. **Who is reading is the app's statement, never the stored token's.** The SDK
   stores each token beside the `externalUserId` it asked the provider for. On
   start, on every foreground and before every send from the outbox it compares
   that with `user()`: a stored token for another user, or any stored token while
   `user()` is null, is thrown away without being sent anywhere, and the store
   and outbox, namespaced by that id, are wiped before anything is drawn. After a
   refresh it reads `GET /config`, whose `user.externalId` must be the user it
   asked for, or the token is discarded. It keeps `GET /config`'s `user.id` in
   that namespace, and when it changes wipes the cached tickets and messages:
   the user's identity here was removed and made again. A Keychain item outlives
   a sign-out that never arrived, and on iOS a reinstall.
2. **The token provider.** `tokenProvider(userId)` resolves a token minted by that
   call. The SDK calls it when it holds no token, on a `401`, and when under five
   minutes remain — measured on a monotonic clock from the moment the provider
   answered, never against `expiresAt` and the device's date. It always checks
   before a multipart send. One call in flight at a time. A rejection carrying
   one of this API's refusals, which the backend relays as it came (each SDK
   names how its provider rejects with one), is that refusal: `blocked` stops
   the SDK as a `403` does, `rate_limited` waits its `Retry-After`, and
   `not_configured` holds the outbox as the error table says. Any other
   rejection means the user is not signed in: sends stay in the outbox and reads
   fail until the next foreground.
3. **One refresh, one replay.** On any `401`, of either code, discard the token,
   ask the provider once and replay the request once. A second `401` surfaces; it
   never loops. `403 blocked` is never refreshed.
4. **A key per send, made before the first attempt**, and kept in a persisted
   outbox with the text and the files' local paths, first in, first out per
   ticket; a send on a ticket whose create has not come back waits for it. A send
   whose answer was lost is retried with the same key. A permanent refusal is
   failed and shown, with `retry` and `discard`. An entry a day old is failed,
   not sent.
5. **Merge by `id`, and match the user's own messages on `clientId`.** A page may
   repeat rows.
6. **Poll only in the foreground, at the server's `pollAfterSeconds`.** Back off
   with jitter on `429` and `5xx`, honouring `Retry-After`; `503 not_configured`
   is not backed off but waits for the next foreground (the error table). On
   `426` stop, and tell the app once.
7. **`reset()`** calls `DELETE /session` with a five-second deadline, then wipes
   the token, the store and the outbox whether or not it landed.
8. **The token lives in the Keychain or a Keystore-backed store**, excluded from
   backups, and never in a log, a crash report or analytics. The SDK refuses a
   base URL that is not `https` unless configured with `allowInsecureBaseUrl`,
   which exists for a local mock and which a release build never sets.
9. **Always send `Content-Length`** on a multipart body, which means building it
   in a file first; images are scaled to 2,048 pixels on the long edge before
   upload, and a file over a limit from `GET /config` is refused locally.
10. **`push.handle(payload)`** resolves null, making no request, for a payload
    without `sb_v` and for an `sb_user` that is not the user it holds a session
    for. Otherwise it resolves `{ type, ticketId, ticketNumber, messageId }` for
    the app to route to, every time it is handed that payload, because the app
    hands it the same push when it arrives and again when it is tapped. The
    first time it meets an `sb_event_id` it also fetches that ticket's new
    messages and updates the unread total; after that it makes no request. It
    ignores any key it does not know.
11. **Ignore unknown fields and unknown enum values.**

## Conformance scenarios

Every SDK runs these, numbered as here, against a stub server whose answers are
the document's examples:

1. A send whose answer is dropped, retried: one message,
   `Idempotent-Replayed: true`.
2. The answer dropped and a poll returns the message before the retry: one
   bubble.
3. `after` returns a row already held: no duplicate.
4. A `401` of either code mid-send: one refresh, one replay, one message.
5. Two concurrent `401`s: one call to the provider.
6. `429` with `Retry-After: 7`: no request for seven seconds.
7. `pollAfterSeconds` moves from 5 to 60: the next poll is 60 seconds later.
8. `409 ticket_closed` on a queued send: failed, not retried.
9. `503 not_configured` on a create: failed, not retried.
10. An unknown field and an unknown `status`: decoded.
11. `user()` names another user at start: the stored token is never sent, and
    the store and outbox are empty before any callback.
12. A push without `sb_v`, or for another `sb_user`: null and no request.
13. A 30 MB file: refused locally.
14. `426`: polling stops, the app is told once.
15. An outbox entry 25 hours old: failed, never sent.
16. A send queued behind an unsent create goes out after it, on its ticket.
17. The same push handed over when it arrives and again when it is tapped: the
    ticket both times, and one fetch.
18. A `404` with no error body of this API's, on `POST /tickets/{id}/read`: the
    call fails, and the ticket and its outbox entries stay.

## Moving off Freshchat

The app embeds Freshchat today (`react-native-freshchat-sdk` 7.6, read from
myBlu's `main` at `e005f11` on 2026-11-12), and keeps it until a pilot on this
API has proved the path. What each piece becomes:

| Today, with Freshchat                                                                                                                                                                                                            | With this API                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openSupport({ trackingNumber })` from the order screen's late-delivery card (`src/app/order/[orderId]/index.tsx`): sets the user property `tracking_number`, which the next parcel's overwrites, and opens the one conversation | `support.tickets.list({ trackingNumber })`; open the ticket it finds, or a composer that calls `support.tickets.create({ text, trackingNumber })`. One ticket per problem, and the number belongs to the ticket rather than to the user. |
| `openSupport()` from the account tab's Support row (`src/app/(tabs)/account.tsx`)                                                                                                                                                | The ticket list, `support.tickets.list()`, with a new-ticket button that `GET /config`'s `tickets.canCreate` shows or hides.                                                                                                             |
| `showConversationWithReferenceID('myBlu', 'myBlu')`: one endless conversation per installation                                                                                                                                   | Many tickets per user, each with its own status, and history that survives a reinstall because it is kept on the server under the user, not the installation.                                                                            |
| `setUser` with phone, email and name, and no external id or restore id (`syncFreshchatUser` in `src/services/freshchat.ts`)                                                                                                      | The app tells the SDK nothing about the person but `user()`, the `externalUserId` signed in now. The backend vouches for the phone when it mints; the name goes with the mint, used only for a new contact. No email is sent.            |
| A sign-out resets nothing: the next account on the device is the same Freshchat user                                                                                                                                             | `support.reset()` in `logout()`; and the SDK wipes a stored token for any other user on its own (rule 1).                                                                                                                                |
| `setPushRegistrationToken(fcmToken)`                                                                                                                                                                                             | Nothing. This side holds no device token. The backend's device tokens are registered with the app's bearer, keyed by the user's id, and dropped on sign-out (the backend's rules).                                                       |
| `isFreshchatNotification` / `handlePushNotification`, ahead of the app's routing on `data.link` (`src/services/push.ts`)                                                                                                         | `support.push.handle(message.data)` wherever a push reaches the app, on arrival and on a tap (below): null for a push that is not this API's, otherwise the ticket. The title and body are the backend's.                                |
| Started at the entry point and the root layout (`index.js`, `src/app/_layout.tsx`); camera and photo-library usage strings and an R8 keep rule (`app.config.ts`); `plugins/withFreshchatAndroidFix.js`                           | `ShipBluSupport.configure(…)` once at start. The usage strings stay if the composer attaches photos (stage 7); the keep rule and the build fix leave with Freshchat.                                                                     |
| The conversation's history, in Freshchat                                                                                                                                                                                         | Not carried over: this API shows only tickets opened through it.                                                                                                                                                                         |

The push goes to `push.handle` in five places in `src/services/push.ts`, where
Freshchat's handler is in three. On arrival, in `setBackgroundMessageHandler`
and `onMessage`, the answer only says the push is this API's: it is still shown
as any other push is, and nothing is opened. On a tap, in
`onNotificationOpenedApp`, in `getInitialNotification` (a tap that starts the
app, which hands Freshchat nothing today) and in expo-notifications' response
listener (a notification the app drew itself), the app opens the ticket
answered. `presentForegroundNotification` keeps only `link` and its own marker
on the local copy it draws on Android, so for a support push it carries the
`sb_*` keys too, or that tap has nothing to route on.

## How the contract changes

By addition. New fields and new enum values appear without notice; a client
ignores a field it does not know and keeps an enum value it does not know. What
an operation sends and answers is fixed from the release that ships it, and what
this guide says a field means is fixed once an app build depends on it. A change
that cannot be made by addition is `/api/v2`, beside `/api/v1`.

Every change is a dated line in `docs/myblu-api-changelog.md`, whose newest date
is the document's `info.version`. A shape that has to change before its route
ships changes in `lib/api/schemas.ts` first, and the document, this guide and
the changelog in the same pull request.
