import { serverPlane } from '@/lib/api/auth';
import { answering, invalidBody, jsonBody } from '@/lib/api/errors';
import { apiNoContent, newRequestId } from '@/lib/api/respond';
import { RevokeSessionsRequest } from '@/lib/api/schemas';
import { revokeSessions } from '@/lib/api/sessions';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');
const ROUTE = 'POST /sessions/revoke';

/**
 * End every session of one myBlu user, on every device: the server plane, for
 * an account deleted, a number changed or released, or a "sign out
 * everywhere". One device's sign-out is the app's own `DELETE /session`.
 *
 * `204` whether or not the user is known, so the call cannot be used to ask
 * who is. The reason is recorded on every live row; the rows are kept, as the
 * record of who was vouched for, until the nightly sweep.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const refused = serverPlane(request, requestId);
    if (refused) return refused;

    const parsed = RevokeSessionsRequest.safeParse(await jsonBody(request));
    if (!parsed.success) return invalidBody(requestId, parsed.error);

    const { identityId, revoked } = await revokeSessions(
      parsed.data.externalUserId,
      parsed.data.reason,
      new Date(),
    );
    log.info('sessions revoked', {
      route: ROUTE,
      identity: identityId ?? 'none',
      reason: parsed.data.reason,
      revoked,
      requestId,
    });
    return apiNoContent({ requestId });
  });
}
