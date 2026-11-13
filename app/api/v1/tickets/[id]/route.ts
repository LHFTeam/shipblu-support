import { clientPlane } from '@/lib/api/auth';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead } from '@/lib/api/limits';
import { ticketNotFound } from '@/lib/api/requests';
import { apiJson, newRequestId } from '@/lib/api/respond';
import type { TicketEnvelope } from '@/lib/api/schemas';
import { readTicket } from '@/lib/api/tickets';
import { canonicalUuid } from '@/lib/http/uuid';
import type { z } from 'zod';

export const dynamic = 'force-dynamic';

const ROUTE = 'GET /tickets/{id}';

/**
 * One ticket the user opened from the app. Anything else — another user's, a
 * ticket on another channel, a deleted, spam or merged one, an id that is not a
 * UUID — is the same `404`, from one query or, for the last, before any:
 * Postgres refuses a malformed uuid with 22P02, which would be a `500`. The id
 * is lower-cased on the way in (`canonicalUuid`), as every ticket route reads
 * it, so the one spelling reaches every comparison made in code.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = newRequestId();
  return answering(ROUTE, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route: ROUTE, now: new Date() });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const id = canonicalUuid((await context.params).id);
    if (!id) return ticketNotFound(requestId);

    const ticket = await readTicket(gate.caller, id);
    if (!ticket) return ticketNotFound(requestId);
    const body: z.input<typeof TicketEnvelope> = { ticket };
    return apiJson(body, { requestId });
  });
}
