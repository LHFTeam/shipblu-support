import { NextResponse } from 'next/server';
import { getConversation, reply } from '@/lib/myblu/conversation';
import { apiError } from '@/lib/myblu/errors';
import { authorise, handle, MAX_BODY } from '../../../_shared';

export const dynamic = 'force-dynamic';

/**
 * A customer's reply.
 *
 * Recorded as **inbound** whatever channel the ticket arrived on, which is
 * `appendReply`'s rule and worth restating here: the customer said it, so it
 * reopens a resolved ticket and moves the SLA clock exactly as an emailed reply
 * would. An agent still answers over the ticket's own channel.
 *
 * A closed ticket answers `not_found` rather than a distinct refusal. The app
 * would do the same thing with either — tell the customer to open a new one —
 * and a separate code is a branch on both sides that nothing reads differently.
 */
export async function POST(request: Request, context: { params: Promise<{ number: string }> }) {
  return handle(request, async () => {
    const auth = await authorise(request, 'reply', 30);
    if ('error' in auth) return auth.error;

    const { number: raw } = await context.params;
    const number = Number.parseInt(raw, 10);
    if (!Number.isInteger(number) || number <= 0) return apiError(request, 'not_found');

    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return apiError(request, 'invalid_request');
    }

    const text = typeof body.body === 'string' ? body.body.trim().slice(0, MAX_BODY) : '';
    if (!text) return apiError(request, 'invalid_request');

    const result = await reply(auth.session.contactId, number, text);
    if (!result.ok) return apiError(request, 'not_found');

    // The thread back, so the app can reconcile its optimistic row against the
    // server's id in one round trip rather than sending and then polling.
    const thread = await getConversation(auth.session.contactId, number);
    if (!thread) return apiError(request, 'not_found');

    return NextResponse.json(thread, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  });
}
