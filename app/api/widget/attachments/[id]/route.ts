import { NextResponse } from 'next/server';
import { ATTACHMENT_URL_TTL_SECONDS } from '@/lib/attachments/signed-url';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { isUuid } from '@/lib/http/uuid';
import { signedUrl } from '@/lib/storage';
import { visitorAttachmentPath } from '@/lib/widget/conversation';
import { resolveVisitor } from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

/**
 * Redirects a visitor to a short-lived signed URL for a file in their own chat.
 *
 * The widget's twin of `app/api/attachments/[id]/route.ts`, with the visitor's
 * token where the console has the agent's session: the bucket stays private,
 * the URL that reaches the browser expires in minutes, and which files the
 * token reaches is `visitorAttachmentPath`'s question — one on a web chat
 * conversation of theirs, off a message they can read.
 *
 * The token rides in the query string because this is an `<img>`, a `<video>`
 * and a link, none of which can carry a header, as the stream's `EventSource`
 * cannot (`/api/widget/stream`). A file the token does not reach answers exactly
 * as one that does not exist.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  // A picture asks once, a player once per range it fetches; generous enough for
  // a thread of them, and a ceiling on a script walking ids.
  if (!allow(`widget-attachment:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  const { id } = await context.params;
  // A malformed id is a link to nothing; Postgres would raise 22P02 on it.
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const token = new URL(request.url).searchParams.get('token') ?? '';
  const contactId = await resolveVisitor(token);
  if (!contactId) return NextResponse.json({ error: 'unknown session' }, { status: 401 });

  const path = await visitorAttachmentPath(contactId, id);
  if (!path) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const url = await signedUrl(path, ATTACHMENT_URL_TTL_SECONDS);
  const response = NextResponse.redirect(url, { status: 307 });
  // For the console route's reason: the URL stops working within minutes, and
  // a player asks again on purpose to get a new one.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
