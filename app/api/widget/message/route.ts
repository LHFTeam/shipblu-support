import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJsonBody } from '@/lib/http/json-body';
import { allow, clientIp } from '@/lib/http/rate-limit';
import {
  appendVisitorMessage,
  listMessages,
  VisitorUploadFailed,
  type VisitorUpload,
} from '@/lib/widget/conversation';
import { MAX_WIDGET_REQUEST_BYTES } from '@/lib/widget/files';
import { resolveVisitor } from '@/lib/widget/session';
import { megabytesOf, readVisitorUploads } from '@/lib/widget/uploads';

export const dynamic = 'force-dynamic';

const MAX_LENGTH = 5000;

const HOUR = 60 * 60 * 1000;

/**
 * How many megabytes of files an hour, for one visitor and for one address.
 *
 * Per visitor, so one person sending photos one by one never meets the
 * address's budget on their own; per address as well, because a token costs
 * nothing to mint (`/api/widget/session`), and a script minting a new one per
 * upload would otherwise have no ceiling but the session route's. Generous on
 * the address, because Egypt's mobile carriers put whole neighbourhoods behind
 * one, and a budget a crowd shares is one an honest customer can run out of.
 */
const UPLOAD_MB_PER_VISITOR = 100;
const UPLOAD_MB_PER_ADDRESS = 400;

/** Any object; each field is read below, where what a bad one means is decided. */
const messageBody = z.object({
  token: z.unknown().optional(),
  body: z.unknown().optional(),
  pageUrl: z.unknown().optional(),
});

type Fields = { token: unknown; body: unknown; pageUrl: unknown; files: File[] };

/**
 * A text message as the JSON it has always been sent as, or a message with
 * files as the multipart body the widget sends them in.
 *
 * The files ride in the message's own request, as a ticket form's ride in its
 * submission (`lib/forms/files.ts`), and there is no upload endpoint beside it:
 * an endpoint taking bytes before a message exists would be storage with
 * nothing to explain it and a sweep owed for every object whose message never
 * came. Here a file cannot exist without the message it was sent with.
 *
 * The length is checked before the body is read, because `proxy.ts` has already
 * cloned it under `proxyClientMaxBodySize`, and a clone past that cap arrives
 * truncated rather than refused — a corrupt body whose only answer would be
 * "invalid". Checked against the header, so a body with none is read and
 * judged by its files.
 */
async function readFields(request: Request): Promise<Fields | 'too_large' | 'invalid'> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    const body = await readJsonBody(request, messageBody);
    return body
      ? { token: body.token, body: body.body, pageUrl: body.pageUrl, files: [] }
      : 'invalid';
  }

  if (Number(request.headers.get('content-length')) > MAX_WIDGET_REQUEST_BYTES) return 'too_large';

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return 'invalid';
  }
  return {
    token: form.get('token'),
    body: form.get('body'),
    pageUrl: form.get('pageUrl'),
    // Every part, an empty one included: the composer's own rules refuse that
    // one with a reason (`checkWidgetFiles`), where dropping it here stored the
    // words without the file the visitor saw going.
    files: form.getAll('files').filter((entry): entry is File => entry instanceof File),
  };
}

export async function POST(request: Request) {
  const address = clientIp(request);
  if (!allow(`widget-message:${address}`, 30, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  const fields = await readFields(request);
  if (fields === 'too_large') {
    return NextResponse.json({ error: 'too_large_total' }, { status: 413 });
  }
  if (fields === 'invalid') return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const token = typeof fields.token === 'string' ? fields.token : '';
  const contactId = await resolveVisitor(token);

  // 401 rather than issuing a new token: silently starting a fresh
  // conversation would drop the message the visitor thought they had sent.
  if (!contactId) return NextResponse.json({ error: 'unknown session' }, { status: 401 });

  const text = typeof fields.body === 'string' ? fields.body.trim().slice(0, MAX_LENGTH) : '';
  if (!text && fields.files.length === 0) {
    return NextResponse.json({ error: 'empty message' }, { status: 400 });
  }

  let uploads: VisitorUpload[] = [];
  if (fields.files.length > 0) {
    const read = await readVisitorUploads(fields.files);
    // The reason is the composer's own, so the panel can say it in the
    // visitor's language; the name is theirs, handed back.
    if (!read.ok) {
      const { refusal } = read;
      return NextResponse.json(
        { error: refusal.reason, filename: 'filename' in refusal ? refusal.filename : null },
        { status: 400 },
      );
    }
    uploads = read.uploads;

    // Spent only on files that would be stored, so a refused one costs nothing.
    const megabytes = megabytesOf(uploads);
    if (
      !allow(`widget-upload:${contactId}`, UPLOAD_MB_PER_VISITOR, HOUR, megabytes) ||
      !allow(`widget-upload:${address}`, UPLOAD_MB_PER_ADDRESS, HOUR, megabytes)
    ) {
      return NextResponse.json({ error: 'slow_down' }, { status: 429 });
    }
  }

  let result: Awaited<ReturnType<typeof appendVisitorMessage>>;
  try {
    result = await appendVisitorMessage(
      contactId,
      text,
      {
        // Which page they were on is the single most useful piece of context an
        // agent can have when a chat opens with "this isn't working".
        pageUrl: typeof fields.pageUrl === 'string' ? fields.pageUrl.slice(0, 500) : null,
        userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
      },
      uploads,
    );
  } catch (error) {
    // Nothing was stored, the message included, so the widget puts the words
    // and the files back to send again.
    if (error instanceof VisitorUploadFailed) {
      return NextResponse.json({ error: 'upload_failed' }, { status: 502 });
    }
    throw error;
  }

  return NextResponse.json({
    conversationId: result.conversationId,
    messages: await listMessages(result.conversationId),
  });
}
