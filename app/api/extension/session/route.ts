import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  destroyExtensionSession,
  extensionAgentFor,
  signInExtension,
} from '@/lib/auth/extension-session';
import { readJsonBody } from '@/lib/http/json-body';
import { requestMeta } from '@/lib/http/request-meta';

export const dynamic = 'force-dynamic';

const signInBody = z.object({ email: z.string(), password: z.string() });

/**
 * The WhatsApp Web extension's sign-in. Answers a bearer token the extension's
 * service worker keeps and sends on every other `/api/extension/*` call.
 *
 * No `Access-Control-Allow-Origin` on any answer here, deliberately: the
 * extension's service worker is exempt from CORS through its host permission,
 * and a script on any web page is then unable to read these routes at all.
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request, signInBody);
  if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

  const outcome = await signInExtension(body.email, body.password, await requestMeta());

  if (outcome.kind === 'throttled') {
    return NextResponse.json(
      { error: 'Too many attempts. Wait a few minutes and try again.' },
      { status: 429 },
    );
  }
  if (outcome.kind === 'invalid') {
    return NextResponse.json({ error: 'Incorrect email or password' }, { status: 401 });
  }

  return NextResponse.json({ token: outcome.token, expiresAt: outcome.expiresAt.toISOString() });
}

/** Who the token belongs to — what the panel asks when it opens. */
export async function GET(request: Request) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });
  return NextResponse.json({ agent: { id: agent.id, name: agent.name, email: agent.email } });
}

export async function DELETE(request: Request) {
  await destroyExtensionSession(request);
  // 204 whether or not there was a session: signing out of one that already
  // ended is the outcome the extension asked for.
  return new NextResponse(null, { status: 204 });
}
