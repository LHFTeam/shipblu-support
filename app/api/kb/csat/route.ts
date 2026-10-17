import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recordAnswer, surveyByToken } from '@/lib/csat';
import { readJsonBody } from '@/lib/http/json-body';
import { allow, clientIp } from '@/lib/http/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Records a satisfaction rating.
 *
 * Public and unauthenticated — the token in the body is the credential. The
 * rate limit is per IP rather than per token because the thing worth stopping
 * is someone working through guessed tokens, and a genuine respondent posts
 * twice: the score, then the comment.
 */
const LIMIT = 20;
const WINDOW_MS = 60 * 60_000;

/** Any object; each field is checked below, where each refusal is decided. */
const csatBody = z.object({
  token: z.unknown().optional(),
  rating: z.unknown().optional(),
  comment: z.unknown().optional(),
});

export async function POST(request: Request) {
  if (!allow(`csat:${clientIp(request)}`, LIMIT, WINDOW_MS)) {
    return new NextResponse(null, { status: 429 });
  }

  const body = await readJsonBody(request, csatBody);
  if (!body) return new NextResponse(null, { status: 400 });

  if (typeof body.token !== 'string' || !body.token) {
    return new NextResponse(null, { status: 400 });
  }
  if (typeof body.rating !== 'number') {
    return new NextResponse(null, { status: 400 });
  }

  // As sent: `recordAnswer` trims it and cuts it to length, once, for every door.
  const comment = typeof body.comment === 'string' ? body.comment : null;

  // The outcome is deliberately not reflected in the status code. A response
  // that distinguishes "unknown token" from "already answered" is an oracle for
  // whoever is trying tokens, and the customer has nothing to do differently
  // either way.
  const survey = await surveyByToken(body.token);
  if (survey) await recordAnswer(survey.id, body.rating, comment, 'page');

  return new NextResponse(null, { status: 204 });
}
