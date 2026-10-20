import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extensionAgentFor } from '@/lib/auth/extension-session';
import { readJsonBody } from '@/lib/http/json-body';
import { replyToSideConversation } from '@/lib/side-conversations/write';

export const dynamic = 'force-dynamic';

const replyBody = z.strictObject({ body: z.string() });

/** A follow-up on a side conversation, through the console's own write. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });

  const body = await readJsonBody(request, replyBody);
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const { id } = await context.params;
  const result = await replyToSideConversation(agent, { sideConversationId: id, body: body.body });
  if (result.error !== null) return NextResponse.json({ error: result.error }, { status: 422 });

  return NextResponse.json({ ok: true });
}
