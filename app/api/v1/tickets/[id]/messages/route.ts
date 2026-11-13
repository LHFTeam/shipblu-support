import type { z } from 'zod';
import { clientPlane } from '@/lib/api/auth';
import { POLL_THREAD_SECONDS } from '@/lib/api/config';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead, admitSend } from '@/lib/api/limits';
import {
  answerSend,
  idempotencyKey,
  pageAsked,
  refuseMultipart,
  sendBody,
  ticketNotFound,
} from '@/lib/api/requests';
import { apiJson, newRequestId } from '@/lib/api/respond';
import { SendMessageRequest, type MessagesPage } from '@/lib/api/schemas';
import { readMessages, sendApiMessage } from '@/lib/api/tickets';
import { canonicalUuid } from '@/lib/http/uuid';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');

type Context = { params: Promise<{ id: string }> };

/**
 * A page of one ticket's messages: with no cursor the newest page, `before`
 * to page back, `after` to poll, never both (`readMessages`). Ascending by
 * `(createdAt, id)` either way, with the ticket, the user's unread badge, and
 * `pollAfterSeconds`, which is how load is shed by a change here rather than
 * by a release of the app. A read: no write, no session connection.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = newRequestId();
  const route = 'GET /tickets/{id}/messages';
  return answering(route, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route, now: new Date() });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const id = canonicalUuid((await context.params).id);
    if (!id) return ticketNotFound(requestId);

    const asked = pageAsked(new URL(request.url), requestId);
    if ('refusal' in asked) return asked.refusal;

    const page = await readMessages(gate.caller, id, asked);
    if (!page) return ticketNotFound(requestId);
    const body: z.input<typeof MessagesPage> = { ...page, pollAfterSeconds: POLL_THREAD_SECONDS };
    return apiJson(body, { requestId });
  });
}

/**
 * The user's message on one of their tickets. A reply to a `resolved` ticket
 * reopens it; one to a `closed` ticket is `409 ticket_closed`, and the app
 * offers a new ticket. `Idempotency-Key` is required, as on `POST /tickets`:
 * `201` the first time, `200` with `Idempotent-Replayed: true` for a retry,
 * and `409 key_reused` for a key spent on another ticket or on a create.
 *
 * The path id is lower-cased before anything reads it (`canonicalUuid`): the
 * contract's `format: uuid` takes either case and so does Postgres, but which
 * ticket a key was spent on is compared in code, against the row's lower-case
 * id, and a client holding ids as a native UUID type (Swift's `uuidString` is
 * upper-case) had its retry of a stored message refused as `key_reused`.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = newRequestId();
  const route = 'POST /tickets/{id}/messages';
  return answering(route, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route, now: new Date() });
    if ('refusal' in gate) return gate.refusal;
    const { caller } = gate;

    const sends = admitSend(caller.identityId);
    if (!sends.allowed) return rateLimited(requestId, sends, 'Too many messages from this user');

    const id = canonicalUuid((await context.params).id);
    if (!id) return ticketNotFound(requestId);

    const keyed = idempotencyKey(request, requestId);
    if ('refusal' in keyed) return keyed.refusal;
    const multipart = refuseMultipart(request, requestId);
    if (multipart) return multipart;
    const read = await sendBody(request, requestId, SendMessageRequest);
    if ('refusal' in read) return read.refusal;

    const outcome = await sendApiMessage(caller, id, {
      text: read.body.text,
      locale: read.body.locale,
      key: keyed.key,
      // Present and parsed: the gate refuses a request without it.
      client: request.headers.get('shipblu-client') ?? '',
    });
    log.info('message send answered', {
      route,
      identity: caller.identityId,
      outcome: outcome.kind === 'sent' && outcome.replayed ? 'replayed' : outcome.kind,
      requestId,
    });
    return answerSend(outcome, requestId);
  });
}
