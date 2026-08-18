import { NextResponse } from 'next/server';
import { isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { allow, clientIp } from '@/lib/kb/rate-limit';
import { listMessages } from '@/lib/widget/conversation';
import {
  findLiveConversation,
  issueVisitorToken,
  registerVisitor,
  resolveVisitor,
  widgetHours,
} from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

/**
 * Opens or resumes a widget session.
 *
 * Called on every widget load, so it is the one place that decides whether the
 * visitor sees "we're here" or "leave a message" — and it returns the whole
 * transcript, because a returning visitor expects their conversation to still
 * be there.
 */
export async function POST(request: Request) {
  if (!allow(`widget-session:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  let body: { token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const supplied = typeof body.token === 'string' ? body.token : '';
  let token = supplied;
  let contactId = supplied ? await resolveVisitor(supplied) : null;

  // A token we do not recognise gets replaced rather than trusted. It is either
  // stale (the contact was deleted) or invented, and in both cases issuing a
  // fresh one is the behaviour that keeps the widget working.
  if (!contactId) {
    token = issueVisitorToken();
    contactId = (await registerVisitor(token)).contactId;
  }

  const conversationId = await findLiveConversation(contactId);
  const messages = conversationId ? await listMessages(conversationId) : [];

  const hours = await widgetHours();
  const online = hours ? isWithinBusinessHours(hours) : false;
  const opensAt = !online && hours ? nextOpeningAt(hours) : null;

  return NextResponse.json({
    token,
    // Returned so the widget can render its own messages optimistically and
    // still reconcile with the server's ids.
    conversationId,
    messages,
    online,
    opensAt: opensAt?.toISOString() ?? null,
    timezone: hours?.timezone ?? null,
  });
}
