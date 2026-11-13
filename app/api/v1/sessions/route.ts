import type { z } from 'zod';
import { serverPlane } from '@/lib/api/auth';
import { answering, invalidBody, jsonBody, rateLimited } from '@/lib/api/errors';
import { admitMint } from '@/lib/api/limits';
import { apiError, apiJson, newRequestId } from '@/lib/api/respond';
import { CreateSessionRequest, type Session } from '@/lib/api/schemas';
import { mintSession, SESSION_TTL_SECONDS } from '@/lib/api/sessions';
import { forwardedChain } from '@/lib/http/rate-limit';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');
const ROUTE = 'POST /sessions';

/**
 * Mint a session for one myBlu user: the server plane, called by myBlu's
 * backend when its app asks for support, never by the app.
 *
 * The body is a claim about who the user is and which phone they hold, made by
 * the one caller entitled to make it — `MYBLU_API_TOKEN` is what entitles it —
 * and from here on only the session says who is asking. The phone decides which
 * contact a new account joins (`pendingApiContact`), and is kept on the row as
 * the one the backend vouched for at this mint.
 *
 * A new token on every call, twenty-four hours from minting, with no refresh.
 * The log line names the identity and nothing the body carried.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const refused = serverPlane(request, requestId);
    if (refused) return refused;

    const parsed = CreateSessionRequest.safeParse(await jsonBody(request));
    if (!parsed.success) return invalidBody(requestId, parsed.error);
    const { externalUserId, phone, name, client } = parsed.data;

    const minting = admitMint(externalUserId);
    if (!minting.allowed) return rateLimited(requestId, minting, 'Too many sessions for this user');

    const now = new Date();
    const outcome = await mintSession({
      externalUserId,
      // `Phone` is strict E.164 with its plus; stored as the digits after it.
      phone: phone.slice(1),
      name: name ?? null,
      platform: client.platform,
      appVersion: client.appVersion,
      forwardedFor: forwardedChain(request.headers),
      now,
    });

    if (outcome.kind === 'blocked') {
      log.info('mint refused: blocked', { route: ROUTE, identity: outcome.identityId, requestId });
      return apiError('blocked', 'This user may not use support; nothing was minted.', {
        requestId,
      });
    }

    log.info('session minted', { route: ROUTE, identity: outcome.identityId, requestId });
    const minted: z.input<typeof Session> = {
      token: outcome.token,
      expiresAt: outcome.expiresAt.toISOString(),
      expiresInSeconds: SESSION_TTL_SECONDS,
    };
    return apiJson(minted, { requestId, status: 201 });
  });
}
