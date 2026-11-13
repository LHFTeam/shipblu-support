import { admit, clientIp, type Admission } from '@/lib/http/rate-limit';

/**
 * The myBlu API's limits, in memory and per instance (`lib/http/rate-limit.ts`):
 * abuse control, not a quota, and forgotten on a deploy. A refusal is
 * `429 rate_limited` with `Retry-After`, and a refused request is still spent.
 *
 * Keyed on the identity wherever a request has one, and on the address only
 * before it does: carrier-grade NAT puts a great many unrelated phones behind
 * one address (`lib/auth/throttle.ts`), so an address bucket is a ceiling on a
 * script, not a measure of a person, and it is generous for that reason.
 *
 * The buckets here are `plans/myblu-ticket-api.md`'s first seven. Uploaded
 * megabytes arrive with the route that spends them (stage 7), on the session's
 * identity.
 */

const MINUTE_MS = 60_000;

/** Every client-plane request, and the contract's, before anything is read. */
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
 * not a determined one; the address bucket above is the ceiling before auth.
 */
const BAD_BEARER_LIMIT = 120;

/** A refused bearer, spent: not allowed means answer `429` rather than `401`. */
export function spendBadBearer(request: Request): Admission {
  return admit(`api-v1:bad-bearer:${clientIp(request)}`, BAD_BEARER_LIMIT, MINUTE_MS);
}

/**
 * Every server-plane call, on the plane itself: myBlu's backend is one caller
 * however many users it mints for, so this is what caps minting. Spent only
 * once the bearer is `MYBLU_API_TOKEN`, or anybody on the internet could spend
 * it for the backend and stop every app from getting a session.
 */
const SERVER_PLANE_LIMIT = 600;

export function admitServerPlane(): Admission {
  return admit('api-v1:server-plane', SERVER_PLANE_LIMIT, MINUTE_MS);
}

/**
 * Mints for one `externalUserId`. It bounds an honest app's loop — a token
 * refused, a new one asked for, refused again — and nothing more, since the
 * caller chooses its key; the plane's own bucket is what caps minting.
 */
const MINT_LIMIT = 10;
const MINT_WINDOW_MS = 10 * MINUTE_MS;

export function admitMint(externalUserId: string): Admission {
  return admit(`api-v1:mint:${externalUserId}`, MINT_LIMIT, MINT_WINDOW_MS);
}

/** Reads, on the session's identity: what a polling app spends. */
const READ_LIMIT = 240;

export function admitRead(identityId: string): Admission {
  return admit(`api-v1:read:${identityId}`, READ_LIMIT, MINUTE_MS);
}

/**
 * Messages written, on the session's identity: both requests that write one,
 * `POST /tickets` and `POST /tickets/{id}/messages`, spend it. A retry under
 * the same `Idempotency-Key` spends it too, as every refused request does: it
 * is a request, and a client retrying in a loop is what the bucket is for.
 */
const SEND_LIMIT = 20;

export function admitSend(identityId: string): Admission {
  return admit(`api-v1:send:${identityId}`, SEND_LIMIT, MINUTE_MS);
}

/**
 * Tickets opened, on the session's identity: ten an hour, beside the ten open
 * at once below. Spent by `createApiTicket` once the pool has found its
 * `Idempotency-Key` unspent, and never by a replay: a retry of a ticket that
 * exists opens nothing, and spending on it let one ticket's retries refuse it
 * `429`, and the user's next ticket with it, for the rest of the hour.
 */
const NEW_TICKET_LIMIT = 10;
const HOUR_MS = 60 * MINUTE_MS;

export function admitNewTicket(identityId: string): Admission {
  return admit(`api-v1:new-ticket:${identityId}`, NEW_TICKET_LIMIT, HOUR_MS);
}

/**
 * Open or pending tickets one user may have at once. Published on
 * `GET /config` as `tickets.maxOpen` from stage 3, and enforced by
 * `POST /tickets` from stage 4, which answers `409 too_many_open` past it.
 */
export const MAX_OPEN_TICKETS = 10;
