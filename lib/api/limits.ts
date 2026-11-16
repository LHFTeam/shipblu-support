import { admit, admitVouched, clientIp, peekVouched, type Admission } from '@/lib/http/rate-limit';

/**
 * The myBlu API's limits, in memory and per instance (`lib/http/rate-limit.ts`):
 * abuse control, not a quota, and forgotten on a deploy. A refusal is
 * `429 rate_limited` with `Retry-After`, and a refused request is still spent.
 *
 * Keyed on the identity wherever a request has one, and on the address only
 * where it has none: carrier-grade NAT puts a great many unrelated phones
 * behind one address (`lib/auth/throttle.ts`), so an address bucket is a
 * ceiling on a script, not a measure of a person. And the address is the first
 * `X-Forwarded-For` value, which a caller writes, so no address bucket stands
 * in front of a client-plane bearer: a forged flood under one carrier's egress
 * would refuse every app behind it, sign-outs included. The session is read
 * first; only a request that presents none, or one refused, spends an address
 * bucket (`spendBadBearer`).
 *
 * The buckets here are `plans/myblu-ticket-api.md`'s eight: the last, uploaded
 * megabytes, arrived with the sends that spend it (stage 7).
 *
 * Two stores. The address and bad-bearer buckets are keyed on a header the
 * caller writes, and live in the shared one every public endpoint uses, which
 * a spray of forged addresses can fill and make evict. The plane, mint and
 * identity buckets — the uploaded megabytes among them — are keyed on nothing
 * an unauthenticated caller can choose, and live in the vouched store
 * (`admitVouched`), which that spray cannot reach: in the shared one, it reset
 * the mint cap.
 */

const MINUTE_MS = 60_000;

/**
 * `GET /openapi.json`, which takes no credential and so has nothing but the
 * address to be counted on. Not the client plane: asked before the bearer, a
 * stranger spending it under a carrier's egress address refused every app
 * behind it for the rest of the minute.
 */
const ADDRESS_LIMIT = 1_200;

export function admitAddress(request: Request): Admission {
  return admit(`api-v1:address:${clientIp(request)}`, ADDRESS_LIMIT, MINUTE_MS);
}

/**
 * Bearers this server refused — none, a malformed one, an unknown, revoked or
 * expired session, a server-plane value that is not `MYBLU_API_TOKEN` — on the
 * address, on both planes, spent only by a refusal and only ever turning that
 * refusal's `401` into a `429` (`refusedBearer` in `lib/api/auth.ts`).
 *
 * Never asked before a bearer is read, on either plane. The address is
 * `clientIp`'s, the first `X-Forwarded-For` value, which a caller can write,
 * so asked first it would refuse a good bearer from an address a stranger had
 * spent: every app behind one carrier's egress, for a hundred and twenty
 * forged requests a minute, and the SDK's one `Retry-After` gate then holds
 * every call. Like every address bucket here, it bounds a careless script and
 * not a determined one, and it sheds no load: a refused bearer has been looked
 * up by the time it is counted. A 256-bit token needs no gate in front of its
 * index, and the owner accepted that cost (on #525 and #531) rather than let a
 * forged address refuse a real user.
 */
const BAD_BEARER_LIMIT = 120;

/** A refused bearer, spent: not allowed means answer `429` rather than `401`. */
export function spendBadBearer(request: Request): Admission {
  return admit(`api-v1:bad-bearer:${clientIp(request)}`, BAD_BEARER_LIMIT, MINUTE_MS);
}

/**
 * The server plane's calls, on the plane itself and apart by what they do:
 * myBlu's backend is one caller however many users it mints for, so the mint
 * budget is what caps minting. Revokes have one of their own, so a cleanup job
 * revoking a batch of deleted accounts cannot spend the minute's mints and
 * leave every app without a session until the window turns. Spent only once
 * the bearer is `MYBLU_API_TOKEN`, or anybody on the internet could spend them
 * for the backend.
 */
const SERVER_PLANE_LIMIT = 600;

export type ServerPlaneBudget = 'mint' | 'revoke';

export function admitServerPlane(budget: ServerPlaneBudget): Admission {
  return admitVouched(`api-v1:server-plane:${budget}`, SERVER_PLANE_LIMIT, MINUTE_MS);
}

/**
 * Mints for one `externalUserId`. It bounds an honest app's loop — a token
 * refused, a new one asked for, refused again — and nothing more, since the
 * caller chooses its key; the plane's own bucket is what caps minting.
 */
const MINT_LIMIT = 10;
const MINT_WINDOW_MS = 10 * MINUTE_MS;

export function admitMint(externalUserId: string): Admission {
  return admitVouched(`api-v1:mint:${externalUserId}`, MINT_LIMIT, MINT_WINDOW_MS);
}

/**
 * Reads, on the session's identity: what a polling app spends — every `GET`,
 * and the read marker (`POST /tickets/{id}/read`). The marker writes no
 * message, and the SDK retries it as it retries a read; spent from the send
 * bucket, twenty a minute, a user scrolling through threads would have their
 * next message refused.
 */
const READ_LIMIT = 240;

export function admitRead(identityId: string): Admission {
  return admitVouched(`api-v1:read:${identityId}`, READ_LIMIT, MINUTE_MS);
}

/**
 * Messages written, on the session's identity: both requests that write one,
 * `POST /tickets` and `POST /tickets/{id}/messages`, spend it. A retry under
 * the same `Idempotency-Key` spends it too, as every refused request does: it
 * is a request, and a client retrying in a loop is what the bucket is for.
 */
const SEND_LIMIT = 20;

export function admitSend(identityId: string): Admission {
  return admitVouched(`api-v1:send:${identityId}`, SEND_LIMIT, MINUTE_MS);
}

/**
 * Tickets opened, on the session's identity: ten an hour, beside the ten open
 * at once below. Charged only for a ticket opened. `createApiTicket` asks
 * before its transaction (`newTicketFits`, which spends nothing) and spends
 * (`admitNewTicket`) inside it, under the account lock, once the transaction
 * has decided to insert. Never by a replay: a retry of a ticket that exists
 * opens nothing, and spending on it let one ticket's retries refuse it `429`,
 * and the user's next ticket with it, for the rest of the hour. Nor by a
 * refusal: spent up front, an outbox resending a create on every foreground
 * while the app's row was off, or past the open cap, ran the hour out on
 * `503`s and `409`s, and the first create that could open was refused `429`.
 */
const NEW_TICKET_LIMIT = 10;
const HOUR_MS = 60 * MINUTE_MS;

function newTicketKey(identityId: string): string {
  return `api-v1:new-ticket:${identityId}`;
}

export function newTicketFits(identityId: string): Admission {
  return peekVouched(newTicketKey(identityId), NEW_TICKET_LIMIT, HOUR_MS);
}

export function admitNewTicket(identityId: string): Admission {
  return admitVouched(newTicketKey(identityId), NEW_TICKET_LIMIT, HOUR_MS);
}

/**
 * Open or pending tickets one user may have when opening another. Published on
 * `GET /config` as `tickets.maxOpen` from stage 3, and enforced by
 * `POST /tickets` from stage 4, which answers `409 too_many_open` past it. A
 * cap on opening, not on what is open: a reply reopening a resolved ticket is
 * that ticket going on, and refusing it would cut a customer off in the middle
 * of a conversation they already have, so a user can hold more than this once
 * replies reopen what they had resolved.
 */
export const MAX_OPEN_TICKETS = 10;

/**
 * Files uploaded, on the session's identity: a hundred megabytes an hour, the
 * widget's figure per visitor (`/api/widget/message`), so four full messages
 * and change. One message carries at most 25 MB (`GET /config`).
 *
 * Counted to the byte, not in whole megabytes a send. Rounded up per send, as
 * the widget counts, a 30 KB voice note cost a megabyte, so the hour's budget
 * was a hundred file messages, not a hundred megabytes: a user in a long
 * back-and-forth with support was refused for an hour after uploading three.
 *
 * Asked before a send's files are stored (`uploadFits`, `peekVouched`, which spends nothing)
 * and spent only once they are (`spendUpload`), the widget's lesson: spent up
 * front, a send that failed on Storage — `502 upload_failed`, which the SDK
 * retries under the same key — cost its megabytes again on every retry, and
 * four retries of one video ran the hour out with nothing stored. Nor is a
 * replay spent: a key already spent stores nothing, so it is answered before
 * this is asked. Two sends can both fit and then both spend, the price of not
 * holding a lock across a multi-second upload, as the widget pays it.
 */
export const UPLOAD_BYTES_LIMIT = 100 * 1024 * 1024;

function uploadKey(identityId: string): string {
  return `api-v1:upload-bytes:${identityId}`;
}

export function uploadFits(identityId: string, bytes: number): Admission {
  return peekVouched(uploadKey(identityId), UPLOAD_BYTES_LIMIT, HOUR_MS, bytes);
}

export function spendUpload(identityId: string, bytes: number): void {
  admitVouched(uploadKey(identityId), UPLOAD_BYTES_LIMIT, HOUR_MS, bytes);
}
