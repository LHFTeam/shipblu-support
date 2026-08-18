import { NextResponse } from 'next/server';
import { MAX_COMMENT, recordResponse } from '@/lib/csat';
import { allow, clientIp } from '@/lib/kb/rate-limit';

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

export async function POST(request: Request) {
  if (!allow(`csat:${clientIp(request)}`, LIMIT, WINDOW_MS)) {
    return new NextResponse(null, { status: 429 });
  }

  let body: { token?: unknown; rating?: unknown; comment?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (typeof body.token !== 'string' || !body.token) {
    return new NextResponse(null, { status: 400 });
  }
  if (typeof body.rating !== 'number') {
    return new NextResponse(null, { status: 400 });
  }

  const comment =
    typeof body.comment === 'string' && body.comment.trim()
      ? body.comment.slice(0, MAX_COMMENT)
      : null;

  // The outcome is deliberately not reflected in the status code. A response
  // that distinguishes "unknown token" from "already answered" is an oracle for
  // whoever is trying tokens, and the customer has nothing to do differently
  // either way.
  await recordResponse(body.token, body.rating, comment);

  return new NextResponse(null, { status: 204 });
}
