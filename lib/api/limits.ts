import { admit, clientIp, type Admission } from '@/lib/http/rate-limit';

/**
 * The myBlu API's limits, in memory and per instance (`lib/http/rate-limit.ts`):
 * abuse control, not a quota, and forgotten on a deploy.
 *
 * Only the first bucket of `plans/myblu-ticket-api.md`'s table is here, because
 * only the contract's own route exists yet. The rest arrive with the routes they
 * guard, each on its own key: the bad-bearer bucket on the address, the server
 * plane's on the plane and minting on `externalUserId`, with the session routes
 * (stage 3); and reads, sends, new tickets and uploaded megabytes on the
 * session's identity, with the routes that spend them (stages 3 to 7).
 *
 * This one is keyed on the address, the only thing known about a request
 * before its bearer is read, and it is generous for that reason: carrier-grade
 * NAT puts a great many unrelated phones behind one address
 * (`lib/auth/throttle.ts`), so it is a ceiling on a script, not a measure of a
 * person.
 */

/** Every client-plane request, and the contract's, before anything is read. */
const ADDRESS_LIMIT = 1_200;
const ADDRESS_WINDOW_MS = 60_000;

export function admitAddress(request: Request): Admission {
  return admit(`api-v1:address:${clientIp(request)}`, ADDRESS_LIMIT, ADDRESS_WINDOW_MS);
}
