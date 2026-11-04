import { NextResponse } from 'next/server';
import { ATTACHMENT_URL_TTL_SECONDS } from '@/lib/attachments/signed-url';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { isUuid } from '@/lib/http/uuid';
import { signedUrl } from '@/lib/storage';
import { widgetAttachmentPath } from '@/lib/widget/conversation';
import { fileLinkValid } from '@/lib/widget/file-links';

export const dynamic = 'force-dynamic';

/**
 * Redirects a widget's link to a short-lived signed URL for that one file.
 *
 * The widget's twin of `app/api/attachments/[id]/route.ts`: the bucket stays
 * private, and the URL that reaches the browser expires in minutes. What
 * authorises the request is the link itself, signed by the visitor's transcript
 * for this file and for some hours (`lib/widget/file-links.ts`) — never the
 * visitor's token, because a picture's, a player's and a link's address can be
 * copied and shared, and the token is the whole chat. `widgetAttachmentPath`
 * then asks what can have changed since the link was signed.
 *
 * Every refusal answers as a file that does not exist, so a link reveals
 * nothing about why it stopped working.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const query = new URL(request.url).searchParams;
  // A malformed id is a link to nothing; Postgres would raise 22P02 on it. And
  // the signature first: it costs an HMAC and no query, so a script walking
  // ids is refused here without spending the honest visitors' budget below.
  if (!isUuid(id) || !fileLinkValid(id, query.get('expires'), query.get('signature'), new Date())) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  /*
    What is left to limit is links we signed: each is a query and a Storage
    signature. Per address, since a link carries no visitor, and generous for
    the reason the upload budget gives — Egypt's carriers put whole
    neighbourhoods behind one address, and a picture asks once and a player
    once per range it fetches, so a dozen visitors there opening chats of ten
    photos each used to meet a ceiling of 120 and see the rest as links.
  */
  if (!allow(`widget-attachment:${clientIp(request)}`, 600, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  const path = await widgetAttachmentPath(id);
  if (!path) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const url = await signedUrl(path, ATTACHMENT_URL_TTL_SECONDS);
  const response = NextResponse.redirect(url, { status: 307 });
  // For the console route's reason: the URL stops working within minutes, and
  // a player asks again on purpose to get a new one.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
