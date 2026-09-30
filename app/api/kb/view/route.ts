import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SESSION_COOKIE } from '@/lib/auth/cookie';
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

  // A reader signed in to the console is one of us. The count orders the help
  // centre's "most read" list and is the views figure editors judge an article
  // by, and the inbox links straight here, so a team re-reading the same few
  // procedures all day would otherwise rank them for customers. The cookie's
  // presence rather than a live session: looking the session up would put a
  // query on a public endpoint to answer a question whose worst wrong answer —
  // a forged cookie — only stops the forger's own view being counted. On the
  // help-centre hostname the console's cookie is never sent, so this knows only
  // about readers who came from the console on its own host, which is where the
  // inbox link sends them.
  if (signedInToConsole(request)) return new NextResponse(null, { status: 204 });

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

/**
 * Read off the header rather than `NextRequest.cookies`, so the handler keeps
 * taking a plain `Request` like every other public endpoint here and their tests.
 */
function signedInToConsole(request: Request): boolean {
  const header = request.headers.get('cookie');
  if (!header) return false;
  return header.split(';').some((pair) => pair.trim().startsWith(`${SESSION_COOKIE}=`));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
