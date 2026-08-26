import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema';
import { can } from '@/lib/auth/permissions';
import { getSessionAgent } from '@/lib/auth/session';
import { signedUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Redirects to a short-lived signed URL for a contact's profile picture.
 *
 * The same shape as `/api/attachments/[id]` and for the same reason: the bucket
 * is private, so every read goes through the session check and the URL that
 * reaches the browser expires. A profile picture is less sensitive than an
 * invoice, but "which customers does this company support" is still not
 * something to publish, and a public bucket would make the object key the only
 * thing standing between a stranger and every avatar we hold.
 *
 * Authorised on `contact.view` — the same permission as the contact page, which
 * is where the picture is otherwise seen. An agent who may not open contacts
 * gets a 404 and the console falls back to initials, rather than a broken image.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await getSessionAgent();
  if (!agent) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  if (!can(agent, 'contact.view'))
    return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { id } = await context.params;

  // Postgres raises 22P02 on a malformed uuid rather than returning no rows, so
  // without this an `<img>` pointed at a mistyped id is a 500 and a stack trace
  // instead of the quiet 404 the console is built to fall back from — and this
  // route is requested on every ticket render.
  if (!UUID.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const rows = await db
    .select({ avatarPath: contacts.avatarPath })
    .from(contacts)
    .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)))
    .limit(1);

  const avatarPath = rows[0]?.avatarPath;
  if (!avatarPath) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const url = await signedUrl(avatarPath, 300);
  const response = NextResponse.redirect(url, { status: 307 });

  // Shorter than the signature's own life, so a cached redirect can never
  // outlive the URL it points at. `private` because the response is one agent's
  // to hold — a shared cache must not serve it to the next session.
  response.headers.set('Cache-Control', 'private, max-age=240');
  return response;
}
