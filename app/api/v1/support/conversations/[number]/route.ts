import { NextResponse } from 'next/server';
import { hashToken } from '@/lib/auth/tokens';
import { allow } from '@/lib/kb/rate-limit';
import { getConversation, threadVersion } from '@/lib/myblu/conversation';
import { apiError } from '@/lib/myblu/errors';
import { authorise, bearerFrom } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * One thread — the endpoint the app polls while it is open.
 *
 * Two things make that cheap enough to poll every few seconds. An `ETag` from
 * `threadVersion`, so an unchanged thread is a 304 with no body and no message
 * read at all; and `?since=`, so a changed one carries only what is new.
 *
 * `since` is **exclusive**. The app sends the timestamp of the last message it
 * holds, and an inclusive comparison would return that message again on every
 * poll — a client appending what it receives would duplicate the conversation
 * one message at a time. That off-by-one is the bug this endpoint would
 * actually have, which is why it has a test rather than a comment alone.
 */
export async function GET(request: Request, context: { params: Promise<{ number: string }> }) {
  const auth = await authorise(request);
  if ('error' in auth) return auth.error;

  const token = bearerFrom(request);
  // Higher than the list: this is the one an open thread polls.
  if (!allow(`myblu-thread:${hashToken(token)}`, 240, 60_000)) {
    return apiError(request, 'rate_limited');
  }

  const { number: raw } = await context.params;
  const number = Number.parseInt(raw, 10);
  if (!Number.isInteger(number) || number <= 0) return apiError(request, 'not_found');

  // Scoped by the contact, so a guessed ticket number resolves to nothing
  // rather than to somebody else's thread.
  const version = await threadVersion(auth.session.contactId, number);
  if (!version) return apiError(request, 'not_found');

  if (request.headers.get('if-none-match') === version) {
    return new Response(null, { status: 304, headers: { ETag: version } });
  }

  const sinceRaw = new URL(request.url).searchParams.get('since');
  const since = sinceRaw ? new Date(sinceRaw) : null;
  // An unparseable `since` is dropped rather than refused: the alternative is
  // an error the customer sees because their clock or their client sent
  // something odd, when returning the whole thread is both correct and cheap.
  const cursor = since && !Number.isNaN(since.getTime()) ? since : null;

  const thread = await getConversation(auth.session.contactId, number, cursor);
  if (!thread) return apiError(request, 'not_found');

  return NextResponse.json(thread, {
    headers: { ETag: version, 'Cache-Control': 'no-store' },
  });
}
