import { NextResponse } from 'next/server';
import { hashToken } from '@/lib/auth/tokens';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { applyVisitorIdentity, recordIdentityOnConversation } from '@/lib/widget/identify';
import { identitySigningEnabled, parseIdentity, verifyIdentity } from '@/lib/widget/identity';
import { findLiveConversation, resolveVisitor } from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

/**
 * Takes the identity the host page holds for its signed-in user.
 *
 * Called by the widget when the page hands it one, so a merchant who is already
 * signed into the dashboard never types their own name into a support chat — and
 * the agent sees who they are before reading the first sentence.
 *
 * The limit is generous because the widget re-sends on every open: this is an
 * idempotent write that usually changes nothing, and rejecting it would cost the
 * agent the customer's name rather than protect anything.
 */
export async function POST(request: Request) {
  if (!allow(`widget-identify:${clientIp(request)}`, 30, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  let body: { token?: unknown; identity?: unknown; signature?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  const contactId = await resolveVisitor(token);
  if (!contactId) return NextResponse.json({ error: 'unknown session' }, { status: 401 });

  const identity = parseIdentity(body.identity);
  // Nothing usable in it — an empty config, or every field dropped by the
  // parser. Not an error: the widget works fine anonymously, and failing here
  // would make a host page's typo look like an outage.
  if (!identity) return NextResponse.json({ ok: true, verified: false });

  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const verified = signature ? verifyIdentity(identity, signature) : false;
  if (signature && !verified && identitySigningEnabled()) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  const outcome = await applyVisitorIdentity({
    contactId,
    webchatIdentifier: hashToken(token),
    identity,
    verified,
  });

  /*
   * A different person on the same browser. The widget answers this by throwing
   * its token away and opening a fresh session, which is the only correct
   * behaviour: a shared dashboard machine would otherwise show the second
   * merchant the first one's conversation.
   */
  if (outcome === 'reset') return NextResponse.json({ ok: false, reset: true });

  if (outcome === 'applied') {
    const conversationId = await findLiveConversation(contactId);
    if (conversationId) await recordIdentityOnConversation(conversationId, contactId);
  }

  return NextResponse.json({ ok: true, verified });
}
