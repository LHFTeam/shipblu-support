import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MAX_COMMENT } from '@/lib/csat/limits';
import { readJsonBody } from '@/lib/http/json-body';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { isUuid } from '@/lib/http/uuid';
import { answerSurvey } from '@/lib/widget/conversation';
import { resolveVisitor } from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

/** Any object; each field is read below, where what a bad one means is decided. */
const csatBody = z.object({
  token: z.unknown().optional(),
  surveyId: z.unknown().optional(),
  rating: z.unknown().optional(),
  comment: z.unknown().optional(),
});

/**
 * An answer from the survey card in the chat.
 *
 * The visitor's token is the credential, as it is for reading the chat — no
 * link, and so none of the link's token: the card is drawn from the visitor's
 * own transcript, and `answerSurvey` records nothing for a survey that is not
 * on one of their web chat conversations. A genuine visitor posts twice per
 * survey, the score and then the comment, so the limit is the message route's.
 *
 * The answer is the rating the survey holds afterwards, so a card whose first
 * post lost its reply shows the rating that was kept rather than a second tap
 * that was not. That says nothing a visitor did not know: it is their own
 * survey. One that is not theirs, one that does not exist and one a newer
 * survey closed all answer `{"rating":null}` alike, for the reason
 * `app/api/kb/csat/route.ts` gives — an answer telling them apart would say
 * which survey ids exist.
 */
export async function POST(request: Request) {
  if (!allow(`widget-csat:${clientIp(request)}`, 30, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  const body = await readJsonBody(request, csatBody);
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const token = typeof body.token === 'string' ? body.token : '';
  const contactId = await resolveVisitor(token);
  if (!contactId) return NextResponse.json({ error: 'unknown session' }, { status: 401 });

  // Checked before it reaches a query: Postgres answers a malformed uuid with
  // an error, not with no rows.
  if (!isUuid(body.surveyId)) return NextResponse.json({ error: 'no survey' }, { status: 400 });
  if (typeof body.rating !== 'number') {
    return NextResponse.json({ error: 'no rating' }, { status: 400 });
  }

  const comment =
    typeof body.comment === 'string' && body.comment.trim()
      ? body.comment.slice(0, MAX_COMMENT)
      : null;

  const stored = await answerSurvey(contactId, body.surveyId, body.rating, comment);

  return NextResponse.json({ rating: stored });
}
