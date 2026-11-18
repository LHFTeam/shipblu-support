import { clientPlane } from '@/lib/api/auth';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead } from '@/lib/api/limits';
import { attachmentNotFound } from '@/lib/api/requests';
import { apiJson, newRequestId } from '@/lib/api/respond';
import { attachmentLink } from '@/lib/api/tickets';
import { canonicalUuid } from '@/lib/http/uuid';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Where to fetch one file on one of the user's tickets: `{ url,
 * expiresInSeconds }`, a five-minute Storage link (`attachmentLink`), and
 * `404 not_found` for a file that is not the user's for any reason. A read: it
 * spends the reads bucket, writes nothing and logs no success line, and the
 * link is never written into a line, since it is the file for five minutes.
 *
 * The path id is lower-cased first, as a ticket's is (`canonicalUuid`), and one
 * that is not a UUID is that `404` before any query, where Postgres would
 * answer it 22P02.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = newRequestId();
  const route = 'GET /attachments/{id}';
  return answering(route, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route, now: new Date() });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const id = canonicalUuid((await context.params).id);
    if (!id) return attachmentNotFound(requestId);

    const link = await attachmentLink(gate.caller, id);
    if (!link) return attachmentNotFound(requestId);
    return apiJson(link, { requestId });
  });
}
