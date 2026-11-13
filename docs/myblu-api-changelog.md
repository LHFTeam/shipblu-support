# The myBlu ticket API: changelog

One dated line per change to the contract — `lib/api/schemas.ts`, published as
`docs/myblu-api.openapi.json` and explained in `docs/myblu-api.md` — newest
first. The newest date is the document's `info.version`, and
`lib/api/openapi.test.ts` holds the two together. The API changes by addition,
so a line here says what was added and from which stage it is served; a line
that takes something away is a line about `/api/v2`.

A contract is published when it merges into `dev`. A change made before that,
on the branch that publishes it, amends the line it will merge under rather
than adding one, and the branch's commits to the document are squashed into one
before the merge: a date names one document, and no commit on `dev` carries
another under it.

- 2026-11-13 — Two of stage 3's operations, corrected before the release that serves them, so no app build depends on what they replace: `POST /sessions` refuses a `name` or a `client.appVersion` holding U+0000 as `400 invalid_request` naming the field, and both publish the `pattern` that says so, since the database cannot store that character and the mint answered `500`. `DELETE /session` no longer lists `403 blocked`: a blocked user's session is ended and answered `204`, as any other, rather than left live for the rest of its day.
- 2026-11-12 — First publication, stage 0b of `plans/myblu-ticket-api.md`: every operation's shapes, the error body and its nineteen codes, the webhook's `message.created` and `survey.created`, and the push payload. Every wait and lifetime is a whole number of seconds, at least 1. Every limit on text is counted in UTF-16 code units: the two on what the app's user writes are published where a client reads them (`limits.messageMaxChars`, and the survey's own `commentMaxChars`), and the session's `name`, which only the backend sends, says so in its description. On the server plane each refusal says what the backend does with it rather than what an SDK does: `POST /sessions` names the three it relays to its app as they came, and the rest it answers with a `502` of its own. Served now: `GET /openapi.json` alone; each other operation names the stage that serves it (`x-shipblu-stage`).
