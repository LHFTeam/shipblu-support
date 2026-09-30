import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hasConsoleSession } from '@/lib/auth/cookie';
import { readJsonBody } from '@/lib/http/json-body';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { recordArticleView } from '@/lib/kb/queries';

export const dynamic = 'force-dynamic';

/** 60 views a minute per address is far beyond a reader and far below a script. */
const LIMIT = 60;
const WINDOW_MS = 60_000;

/** Any object; the id is checked below. */
const viewBody = z.object({ articleId: z.unknown().optional() });

export async function POST(request: Request) {
  if (!allow(`kb-view:${clientIp(request)}`, LIMIT, WINDOW_MS)) {
    return new NextResponse(null, { status: 429 });
  }

  // A reader signed in to the console is one of us, and the count orders the
  // help centre's "most read" list. `hasConsoleSession` says why presence of the
  // cookie is enough.
  if (hasConsoleSession(request.headers)) return new NextResponse(null, { status: 204 });

  const body = await readJsonBody(request, viewBody);
  if (!body) return new NextResponse(null, { status: 400 });

  const { articleId } = body;

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
