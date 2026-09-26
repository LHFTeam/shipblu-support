import { NextResponse } from 'next/server';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { parseVisitorDetails } from '@/lib/widget/contact';
import { attachVisitorDetails } from '@/lib/widget/conversation';
import { findLiveConversation, resolveVisitor } from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

/**
 * Captures how to reach a visitor who wrote in with nobody available.
 *
 * This is what turns an out-of-hours chat into something the team can actually
 * reply to, so it is the difference between the widget being useful at 2am and
 * being a dead end. It takes a phone number as well as an address because in
 * Egypt the way back is more often WhatsApp than email, and either one on its
 * own is enough — `parseVisitorDetails` holds that rule.
 *
 * A live conversation is required, which is why the widget sends the message
 * first and these details second. The endpoint writes a `contact_updated`
 * timeline event, and an event needs a conversation to hang on; relaxing that so
 * the form could be submitted first would file the details somewhere no agent
 * looks.
 */
export async function POST(request: Request) {
  if (!allow(`widget-contact:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  let body: { token?: unknown; name?: unknown; email?: unknown; phone?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const contactId = await resolveVisitor(token);
  if (!contactId) return NextResponse.json({ error: 'unknown session' }, { status: 401 });

  const details = parseVisitorDetails(body);
  if (!details) return NextResponse.json({ error: 'no way to reply' }, { status: 400 });

  const conversationId = await findLiveConversation(contactId);
  if (!conversationId) {
    return NextResponse.json({ error: 'no conversation' }, { status: 400 });
  }

  await attachVisitorDetails(contactId, conversationId, details);

  return NextResponse.json({ ok: true });
}
