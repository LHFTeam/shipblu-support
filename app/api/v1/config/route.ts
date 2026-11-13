import { clientPlane } from '@/lib/api/auth';
import { apiChannel } from '@/lib/api/channel';
import { configFor, supportHoursAt } from '@/lib/api/config';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead } from '@/lib/api/limits';
import { apiJson, newRequestId } from '@/lib/api/respond';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { groupHours } from '@/lib/hours/resolve';

export const dynamic = 'force-dynamic';

const ROUTE = 'GET /config';

/**
 * Who is signed in, and what the server allows: read by the SDK on start and
 * after every new token, where `user.externalId` must be the user it asked a
 * token for or the token is thrown away.
 *
 * A read on the session's identity, so it spends that identity's read bucket.
 * No write: the session with its identity and contact, the `api` channel row
 * that says whether a ticket can be opened, and the hours catalog
 * (`loadHoursCatalog`, memoised for thirty seconds) for `support`, the hours of
 * that row's group. The catalog is read after the row and never beside it: a
 * cold catalog is three concurrent queries of its own, and the pool's admission
 * gate holds eight places (§6.91). One `now` for the gate and the hours.
 *
 * So `support` follows a schedule edit within the catalog's thirty seconds, and
 * not at once: the admin's save clears the console's copy of the memo, and this
 * handler reads a copy of its own (`lib/hours/catalog.ts` says why). Accepted,
 * as every other reader outside the console accepts it: the TTL bounds it.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const now = new Date();
    const gate = await clientPlane(request, { requestId, route: ROUTE, now });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const channel = await apiChannel();
    const hours = groupHours(await loadHoursCatalog(), channel?.defaultGroupId ?? null);
    return apiJson(configFor(gate.caller, channel !== null, supportHoursAt(hours, now)), {
      requestId,
    });
  });
}
