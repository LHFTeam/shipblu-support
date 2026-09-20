import { NextResponse } from 'next/server';
import { getConversation, threadVersion } from '@/lib/myblu/conversation';
import { apiError } from '@/lib/myblu/errors';
import { authorise, handle } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * One thread — the endpoint the app polls while it is open.
 *
 * Two things make that cheap enough to poll every few seconds. An `ETag` from
 * `threadVersion`, so an unchanged thread is a 304 with no body; and `?since=`,
 * so a changed one carries only what is new.
 *
 * `since` is **exclusive**. The app sends the timestamp of the last message it
 * holds, and an inclusive comparison would return that message again on every
 * poll — a client appending what it receives would duplicate the conversation
 * one message at a time. That off-by-one is the bug this endpoint would
 * actually have, which is why it has a test rather than a comment alone.
 */
export async function GET(request: Request, context: { params: Promise<{ number: string }> }) {
  return handle(request, async () => {
    // Higher than the list: this is the one an open thread polls.
    const auth = await authorise(request, 'thread', 240);
    if ('error' in auth) return auth.error;

    const { number: raw } = await context.params;
    const number = Number.parseInt(raw, 10);
    if (!Number.isInteger(number) || number <= 0) return apiError(request, 'not_found');

    const sinceRaw = new URL(request.url).searchParams.get('since');
    const parsed = sinceRaw ? new Date(sinceRaw) : null;
    // An unparseable `since` is dropped rather than refused: the alternative is
    // an error the customer sees because their clock or their client sent
    // something odd, when returning the whole thread is both correct and cheap.
    const since = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

    // Scoped by the contact, so a guessed ticket number resolves to nothing
    // rather than to somebody else's thread.
    const version = await threadVersion(auth.session.contactId, number);
    if (!version) return apiError(request, 'not_found');

    // **Conditional requests are honoured only on the full thread.** The
    // version describes the conversation, not the slice: answering 304 to a
    // request that also carried `?since=` would tell a client holding only a
    // fragment that its fragment is current, and it would render a partial
    // thread that never recovers until the next message bumps the version.
    if (!since && matches(request.headers.get('if-none-match'), version)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: version, 'Cache-Control': 'no-store' },
      });
    }

    const thread = await getConversation(auth.session.contactId, number, since);
    if (!thread) return apiError(request, 'not_found');

    return NextResponse.json(thread, {
      headers: { ETag: version, 'Cache-Control': 'no-store' },
    });
  });
}

/**
 * Whether `If-None-Match` names this version.
 *
 * A list and a weak validator are both ordinary on the wire — RFC 9110 allows
 * `"a", "b"`, and an intermediary may downgrade a strong tag to `W/"a"`. Strict
 * equality against the raw header therefore misses the client's own tag coming
 * back slightly changed, and the endpoint answers a full body on every poll:
 * the 304 is the entire reason the tag exists, so failing open on a formatting
 * difference quietly removes the saving.
 */
function matches(header: string | null, version: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;

  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .includes(version);
}
