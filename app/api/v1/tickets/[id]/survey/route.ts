import type { z } from 'zod';
import { clientPlane } from '@/lib/api/auth';
import { answering, rateLimited } from '@/lib/api/errors';
import { admitRead } from '@/lib/api/limits';
import { surveyAnswerBody, surveyNotFound } from '@/lib/api/requests';
import { apiJson, newRequestId } from '@/lib/api/respond';
import type { SurveyEnvelope } from '@/lib/api/schemas';
import { answerSurvey, readSurvey } from '@/lib/api/survey';
import { canonicalUuid } from '@/lib/http/uuid';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('api');

type Context = { params: Promise<{ id: string }> };

/**
 * The satisfaction survey on one of the user's tickets, worded on the server
 * in the survey's own locale (`readSurvey`), or `404 not_found` while the
 * ticket has none — and for one the team decided not to send, and for a ticket
 * that is not the user's, alike. A read: it spends the reads bucket, writes
 * nothing and logs no success line.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const requestId = newRequestId();
  const route = 'GET /tickets/{id}/survey';
  return answering(route, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route, now: new Date() });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const id = canonicalUuid((await context.params).id);
    if (!id) return surveyNotFound(requestId);

    const survey = await readSurvey(gate.caller, id);
    if (!survey) return surveyNotFound(requestId);
    const body: z.input<typeof SurveyEnvelope> = { survey };
    return apiJson(body, { requestId });
  });
}

/**
 * An answer: the rating, posted when it is tapped, and a comment, posted
 * second with the same rating (`answerSurvey`, through `recordAnswer`). `200`
 * with the survey as it stands afterwards, never `204`: the first rating wins
 * whichever door it came through, so the app draws what this answers. Spends
 * the reads bucket, as the read marker does: it writes no message, the SDK
 * retries it as a read, and a tap and its comment spent from the sends bucket
 * would leave the user's next message refused.
 *
 * The log line names the route, the identity and whether a survey was there,
 * never the rating or the comment.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = newRequestId();
  const route = 'POST /tickets/{id}/survey';
  return answering(route, requestId, async () => {
    const gate = await clientPlane(request, { requestId, route, now: new Date() });
    if ('refusal' in gate) return gate.refusal;

    const reads = admitRead(gate.caller.identityId);
    if (!reads.allowed) return rateLimited(requestId, reads, 'Too many reads for this user');

    const id = canonicalUuid((await context.params).id);
    if (!id) return surveyNotFound(requestId);

    const answer = await surveyAnswerBody(request, requestId);
    if ('refusal' in answer) return answer.refusal;

    const survey = await answerSurvey(gate.caller, id, answer.rating, answer.comment);
    log.info('survey answer answered', {
      route,
      identity: gate.caller.identityId,
      outcome: survey ? survey.status : 'not_found',
      requestId,
    });
    if (!survey) return surveyNotFound(requestId);
    const body: z.input<typeof SurveyEnvelope> = { survey };
    return apiJson(body, { requestId });
  });
}
