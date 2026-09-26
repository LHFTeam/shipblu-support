import { NextResponse } from 'next/server';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { recordArticleView } from '@/lib/kb/queries';

export const dynamic = 'force-dynamic';

/** 60 views a minute per address is far beyond a reader and far below a script. */
const LIMIT = 60;
const WINDOW_MS = 60_000;

export async function POST(request: Request) {
  if (!allow(`kb-view:${clientIp(request)}`, LIMIT, WINDOW_MS)) {
    return new NextResponse(null, { status: 429 });
  }

  let articleId: unknown;
  try {
    ({ articleId } = (await request.json()) as { articleId?: unknown });
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (typeof articleId !== 'string' || !UUID.test(articleId)) {
    return new NextResponse(null, { status: 400 });
  }

  // A non-existent id updates zero rows, so an invented one is a no-op rather
  // than an error worth reporting back.
  await recordArticleView(articleId);

  // 204: the beacon ignores the body, and sending one wastes a round trip.
  return new NextResponse(null, { status: 204 });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
