import { clientPlane } from '@/lib/api/auth';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitSend } from '@/lib/api/limits';
import { answerSend, idempotencyKey, refuseMultipart, sendBody } from '@/lib/api/requests';
import { newRequestId } from '@/lib/api/respond';
import { CreateTicketRequest } from '@/lib/api/schemas';
import { createApiTicket } from '@/lib/api/tickets';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');
const ROUTE = 'POST /tickets';

/**
 * Open a ticket from the myBlu app, with its first message: the client plane,
 * as the session's user and nobody named in the body.
 *
 * `Idempotency-Key` is required: the first request is `201`, and a retry under
 * the same key `200` with `Idempotent-Replayed: true` and what the first
 * stored, creating nothing (`createApiTicket`). Spends the identity's send
 * bucket, as both message-writing routes do; its new-ticket bucket is spent by
 * `createApiTicket` once the key is known to be unspent, so a retry is never
 * refused it. Files are stage 7's: until then a multipart body is
 * `400 invalid_request`.
 *
 * The log line names the route, the identity and the outcome, never the body.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route: ROUTE, now: new Date() });
    if ('refusal' in gate) return gate.refusal;
    const { caller } = gate;

    const sends = admitSend(caller.identityId);
    if (!sends.allowed) return rateLimited(requestId, sends, 'Too many messages from this user');

    const keyed = idempotencyKey(request, requestId);
    if ('refusal' in keyed) return keyed.refusal;
    const multipart = refuseMultipart(request, requestId);
    if (multipart) return multipart;
    const read = await sendBody(request, requestId, CreateTicketRequest);
    if ('refusal' in read) return read.refusal;

    const outcome = await createApiTicket(caller, {
      text: read.body.text,
      locale: read.body.locale,
      trackingNumber: read.body.trackingNumber ?? null,
      key: keyed.key,
      // Present and parsed: the gate refuses a request without it.
      client: request.headers.get('shipblu-client') ?? '',
    });
    log.info('ticket create answered', {
      route: ROUTE,
      identity: caller.identityId,
      outcome: outcome.kind === 'sent' && outcome.replayed ? 'replayed' : outcome.kind,
      requestId,
    });
    return answerSend(outcome, requestId);
  });
}

/**
 * The list is stage 5's (`plans/myblu-ticket-api.md`, stage 4). Until then this
 * path answers `GET` with a `404` and no body, as every operation not served
 * yet answers: Next would answer a method this file did not export with `405`,
 * which an SDK classifies by its status as `invalid_request`, its own bug,
 * rather than as a route not served yet — and the app's list would fail as a
 * broken request instead of waiting for its stage. Stage 5 replaces this.
 */
export function GET(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
