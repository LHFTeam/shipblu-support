import { admitAddress } from '@/lib/api/limits';
import { openApiDocument } from '@/lib/api/openapi';
import { apiError, apiJson, newRequestId } from '@/lib/api/respond';
import { logger } from '@/lib/log';

// The limiter has to run on every request, so nothing here may be prerendered
// at build, where the document would also be built for nobody.
export const dynamic = 'force-dynamic';

const log = logger('api');

/**
 * The myBlu API's contract, as the server answering builds it.
 *
 * The one route stage 0b ships, and the first under `/api/v1`: the app's
 * developers fetch the contract of the server they are talking to, which on a
 * deploy part-way through the plan is not the committed file's future. No
 * credential, so it sits behind the address bucket every client-plane request
 * passes before its bearer is read, and answers as every route of this API
 * does — `ShipBlu-Request-Id` and `Cache-Control: no-store` on success and on
 * refusal, and a refusal in the one error shape.
 */
export function GET(request: Request): Response {
  const requestId = newRequestId();

  const admission = admitAddress(request);
  if (!admission.allowed) {
    return apiError('rate_limited', 'Too many requests from this address; wait for Retry-After.', {
      requestId,
      retryAfterSeconds: admission.resetInSeconds,
    });
  }

  try {
    return apiJson(openApiDocument(), { requestId });
  } catch (error) {
    log.error(`openapi document failed requestId=${requestId}`, error);
    return apiError('internal', 'The contract could not be built.', { requestId });
  }
}
