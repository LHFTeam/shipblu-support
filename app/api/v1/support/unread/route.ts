import { NextResponse } from 'next/server';
import { hashToken } from '@/lib/auth/tokens';
import { allow } from '@/lib/kb/rate-limit';
import { unreadCount } from '@/lib/myblu/conversation';
import { apiError } from '@/lib/myblu/errors';
import { authorise, bearerFrom } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * The badge on the app's Support row.
 *
 * Its own endpoint rather than a field on the conversation list, because the
 * Account tab wants the number without the list — and the list is the more
 * expensive of the two by an order of magnitude.
 */
export async function GET(request: Request) {
  const auth = await authorise(request);
  if ('error' in auth) return auth.error;

  if (!allow(`myblu-unread:${hashToken(bearerFrom(request))}`, 60, 60_000)) {
    return apiError(request, 'rate_limited');
  }

  return NextResponse.json({ unread: await unreadCount(auth.session.contactId) });
}
