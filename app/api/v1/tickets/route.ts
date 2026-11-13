import type { z } from 'zod';
import { clientPlane } from '@/lib/api/auth';
import { POLL_LIST_SECONDS } from '@/lib/api/config';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead, admitSend } from '@/lib/api/limits';
import {
  answerSend,
  idempotencyKey,
  listAsked,
  refuseMultipart,
  sendBody,
} from '@/lib/api/requests';
import { apiJson, newRequestId } from '@/lib/api/respond';
import { CreateTicketRequest, type TicketsPage } from '@/lib/api/schemas';
import { createApiTicket, listTickets } from '@/lib/api/tickets';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');
const ROUTE = 'POST /tickets';
const LIST_ROUTE = 'GET /tickets';

/**
 * The user's tickets, newest first by `(lastMessageAt, id)`, paged back with
 * `before`, every status, and only those opened with one tracking number when
 * `trackingNumber` asks (`listTickets`). Polled by re-reading the first page
 * at `pollAfterSeconds`. A read: one statement after the session — two on a
 * page with no ticket on it — and no write and no session connection. It never
 * reads the `api` channel row, so the list goes on while new tickets are
 * switched off, and it is never `404`: a user with no tickets has an empty one.
 *
 * No success line, as the other reads write none: a thirty-second poll per
 * user would be the log. Nothing here reads the query string into a line, so a
 * cursor or a tracking number never reaches one.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return answering(LIST_ROUTE, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route: LIST_ROUTE, now: new Date() });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const asked = listAsked(new URL(request.url), requestId);
    if ('refusal' in asked) return asked.refusal;

    const page = await listTickets(gate.caller, asked);
    const body: z.input<typeof TicketsPage> = { ...page, pollAfterSeconds: POLL_LIST_SECONDS };
    return apiJson(body, { requestId });
  });
}

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
