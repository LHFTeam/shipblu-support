import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extensionAgentFor } from '@/lib/auth/extension-session';
import { ticketSideConversations } from '@/lib/extension/tickets';
import { readJsonBody } from '@/lib/http/json-body';
import { startSideConversation } from '@/lib/side-conversations/write';

export const dynamic = 'force-dynamic';

/** The ticket's side conversations, for the extension's Side conversations tab. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });

  const { id } = await context.params;
  const found = await ticketSideConversations(agent, id);
  if (!found) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json(found);
}

/**
 * Strict, because the extension is the only writer and a key it misspells
 * should fail loudly here rather than drop a cc or a "set pending" silently.
 * No anchor: the panel has no thread to quote a message from.
 */
const startBody = z.strictObject({
  body: z.string(),
  recipientId: z.string(),
  toAddress: z.string().default(''),
  ccAddresses: z.string().default(''),
  subject: z.string().default(''),
  setPending: z.boolean().default(false),
});

/**
 * Starts one, through the same function as the console's composer — the
 * permission, the visibility rule and the refusal of the customer's own address
 * are `lib/side-conversations/write.ts`'s, not this route's.
 *
 * A refusal is a 422 carrying the sentence the console would have shown.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });

  const body = await readJsonBody(request, startBody);
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const { id } = await context.params;
  const result = await startSideConversation(agent, {
    ...body,
    conversationId: id,
    anchorMessageId: null,
    includeAnchor: false,
  });
  if (result.error !== null) return NextResponse.json({ error: result.error }, { status: 422 });

  return NextResponse.json({ ok: true });
}
