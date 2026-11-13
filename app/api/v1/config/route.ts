import { clientPlane } from '@/lib/api/auth';
import { apiChannel } from '@/lib/api/channel';
import { configFor } from '@/lib/api/config';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead } from '@/lib/api/limits';
import { apiJson, newRequestId } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

const ROUTE = 'GET /config';

/**
 * Who is signed in, and what the server allows: read by the SDK on start and
 * after every new token, where `user.externalId` must be the user it asked a
 * token for or the token is thrown away.
 *
 * A read on the session's identity, so it spends that identity's read bucket.
 * Two statements and no write: the session with its identity and contact, then
 * the `api` channel row that says whether a ticket can be opened.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route: ROUTE, now: new Date() });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const channel = await apiChannel();
    return apiJson(configFor(gate.caller, channel !== null), { requestId });
  });
}
