import { clientPlane } from '@/lib/api/auth';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead } from '@/lib/api/limits';
import { answerRead, markBody, ticketNotFound } from '@/lib/api/requests';
import { newRequestId } from '@/lib/api/respond';
import { markTicketRead } from '@/lib/api/tickets';
import { canonicalUuid } from '@/lib/http/uuid';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');
const ROUTE = 'POST /tickets/{id}/read';

/**
 * Marks the team's replies on one of the user's tickets read, up to `upTo`,
 * the newest message on screen, and answers the ticket and the new badge
 * (`markTicketRead`); the agent sees Read on them in the console.
 *
 * Spends the read bucket, not the send bucket: it writes no message, the SDK
 * retries it as a read, and spent from the twenty sends a minute, reading
 * threads would refuse the user's next message. No `Idempotency-Key`, since
 * marking twice or backwards changes nothing.
 *
 * In the order the sends answer: a path id that is not a UUID is the `404`
 * every ticket route gives, before any query; a body that is not `{ upTo }` is
 * `400` before any query; and a ticket that is not the caller's is that `404`
 * whatever `upTo` names, so the `400` for an `upTo` not on the ticket says
 * nothing about another user's.
 *
 * The log line names the route, the identity, the outcome and how many replies
 * were marked: never the ticket, `upTo` or the body.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route: ROUTE, now: new Date() });
    if ('refusal' in gate) return gate.refusal;
    const { caller } = gate;

    const reads = admitRead(caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const id = canonicalUuid((await context.params).id);
    if (!id) return ticketNotFound(requestId);

    const read = await markBody(request, requestId);
    if ('refusal' in read) return read.refusal;

    const outcome = await markTicketRead(caller, id, read.upTo);
    log.info('read marked', {
      route: ROUTE,
      identity: caller.identityId,
      outcome: outcome.kind,
      marked: outcome.kind === 'read' ? outcome.marked : 0,
      requestId,
    });
    return answerRead(outcome, requestId);
  });
}
