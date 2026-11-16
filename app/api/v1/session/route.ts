import { endingPlane } from '@/lib/api/auth';
import { answering } from '@/lib/api/errors';
import { apiNoContent, newRequestId } from '@/lib/api/respond';
import { endSession } from '@/lib/api/sessions';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');
const ROUTE = 'DELETE /session';

/**
 * End the presented session and nothing else: the client plane, called by the
 * SDK's `reset()` on sign-out, with a five-second deadline after which the app
 * wipes the device whether or not this landed. The user's other devices keep
 * theirs; ending all of them is the backend's `POST /sessions/revoke`.
 *
 * The one client-plane request a blocked or deleted contact is not refused:
 * `endingPlane` hands its session back, and it is ended and answered `204`
 * like any other. Refused, it would stay live for the rest of its day, and a
 * block lifted within it would bring back a token the app had already let go
 * of.
 *
 * Spent from the address bucket alone, not the identity's reads, for the same
 * reason: a refusal here would leave a session alive that its app has already
 * let go of.
 */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const now = new Date();
    const gate = await endingPlane(request, { requestId, route: ROUTE, now });
    if ('refusal' in gate) return gate.refusal;

    await endSession(gate.ending.tokenHash, now);
    log.info('session ended', { route: ROUTE, identity: gate.ending.identityId, requestId });
    return apiNoContent({ requestId });
  });
}
