import { NextResponse } from 'next/server';
import { apiError } from '@/lib/myblu/errors';
import { listConversations, openConversation } from '@/lib/myblu/conversation';
import { authorise, handle, MAX_BODY } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handle(request, async () => {
    const auth = await authorise(request, 'list', 60);
    if ('error' in auth) return auth.error;

    return NextResponse.json({ conversations: await listConversations(auth.session.contactId) });
  });
}

export async function POST(request: Request) {
  return handle(request, async () => {
    const auth = await authorise(request, 'open', 10);
    if ('error' in auth) return auth.error;

    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return apiError(request, 'invalid_request');
    }

    const text = typeof body.body === 'string' ? body.body.trim().slice(0, MAX_BODY) : '';
    if (!text) return apiError(request, 'invalid_request');

    const opened = await openConversation(auth.session.contactId, {
      body: text,
      subject: typeof body.subject === 'string' ? body.subject : null,
      // The parcel the customer was looking at when they tapped Support. The
      // app already passes this to Freshchat as a user property; here it
      // becomes a link on the ticket, so the agent opens it with the parcel in
      // front of them rather than having to ask which one.
      trackingNumber: typeof body.trackingNumber === 'string' ? body.trackingNumber : null,
    });

    return NextResponse.json({ number: opened.number }, { status: 201 });
  });
}
