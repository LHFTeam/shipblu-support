import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJsonBody } from '@/lib/http/json-body';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { appendVisitorMessage, listMessages } from '@/lib/widget/conversation';
import { resolveVisitor } from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

const MAX_LENGTH = 5000;

/** Any object; each field is read below, where what a bad one means is decided. */
const messageBody = z.object({
  token: z.unknown().optional(),
  body: z.unknown().optional(),
  pageUrl: z.unknown().optional(),
});

export async function POST(request: Request) {
  if (!allow(`widget-message:${clientIp(request)}`, 30, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  const body = await readJsonBody(request, messageBody);
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const token = typeof body.token === 'string' ? body.token : '';
  const contactId = await resolveVisitor(token);

  // 401 rather than issuing a new token: silently starting a fresh
  // conversation would drop the message the visitor thought they had sent.
  if (!contactId) return NextResponse.json({ error: 'unknown session' }, { status: 401 });

  const text = typeof body.body === 'string' ? body.body.trim().slice(0, MAX_LENGTH) : '';
  if (!text) return NextResponse.json({ error: 'empty message' }, { status: 400 });

  const result = await appendVisitorMessage(contactId, text, {
    // Which page they were on is the single most useful piece of context an
    // agent can have when a chat opens with "this isn't working".
    pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl.slice(0, 500) : null,
    userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
  });

  return NextResponse.json({
    conversationId: result.conversationId,
    messages: await listMessages(result.conversationId),
  });
}
