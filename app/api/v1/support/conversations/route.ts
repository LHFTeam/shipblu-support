import { NextResponse } from 'next/server';
import { allow } from '@/lib/kb/rate-limit';
import { apiError } from '@/lib/myblu/errors';
import { listConversations, openConversation } from '@/lib/myblu/conversation';
import { authorise, bearerFrom } from '../_shared';
import { hashToken } from '@/lib/auth/tokens';

export const dynamic = 'force-dynamic';

const MAX_BODY = 5_000;

/**
 * Rate limited on the session rather than on the IP.
 *
 * Egyptian mobile carriers NAT hard enough that a per-IP bucket is a bucket
 * shared by a whole network — one busy customer would lock out everybody else
 * on the same carrier. The session token is the right unit for an authenticated
 * endpoint anyway: it is the thing being spent.
 */
function limit(token: string, name: string, max: number): boolean {
  return allow(`myblu-${name}:${hashToken(token)}`, max, 60_000);
}

export async function GET(request: Request) {
  const auth = await authorise(request);
  if ('error' in auth) return auth.error;

  if (!limit(bearerFrom(request), 'list', 60)) return apiError(request, 'rate_limited');

  return NextResponse.json({ conversations: await listConversations(auth.session.contactId) });
}

export async function POST(request: Request) {
  const auth = await authorise(request);
  if ('error' in auth) return auth.error;

  if (!limit(bearerFrom(request), 'open', 10)) return apiError(request, 'rate_limited');

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
    // The parcel the customer was looking at when they tapped Support. The app
    // already passes this to Freshchat as a user property; here it becomes a
    // link on the ticket, so the agent opens it with the parcel in front of
    // them rather than having to ask which one.
    trackingNumber: typeof body.trackingNumber === 'string' ? body.trackingNumber : null,
  });

  return NextResponse.json({ number: opened.number }, { status: 201 });
}
