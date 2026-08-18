import { NextResponse } from 'next/server';
import { allow, clientIp } from '@/lib/kb/rate-limit';
import { attachVisitorEmail } from '@/lib/widget/conversation';
import { findLiveConversation, resolveVisitor } from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

/** Deliberately loose: rejecting valid-but-unusual addresses loses a customer. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Captures the email a visitor leaves when nobody is available to chat.
 *
 * This is what turns an out-of-hours chat into something the team can actually
 * reply to, so it is the difference between the widget being useful at 2am and
 * being a dead end.
 */
export async function POST(request: Request) {
  if (!allow(`widget-email:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  let body: { token?: unknown; email?: unknown; name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const contactId = await resolveVisitor(token);
  if (!contactId) return NextResponse.json({ error: 'unknown session' }, { status: 401 });

  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';
  if (!EMAIL.test(email)) return NextResponse.json({ error: 'invalid email' }, { status: 400 });

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) || null : null;

  const conversationId = await findLiveConversation(contactId);
  if (!conversationId) {
    return NextResponse.json({ error: 'no conversation' }, { status: 400 });
  }

  await attachVisitorEmail(contactId, conversationId, email, name);

  return NextResponse.json({ ok: true });
}
