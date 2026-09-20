import { NextResponse } from 'next/server';
import { unreadCount } from '@/lib/myblu/conversation';
import { authorise, handle } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * The badge on the app's Support row.
 *
 * Its own endpoint rather than a field on the conversation list, because the
 * Account tab wants the number without the list — and the list is the more
 * expensive of the two by an order of magnitude.
 */
export async function GET(request: Request) {
  return handle(request, async () => {
    const auth = await authorise(request, 'unread', 60);
    if ('error' in auth) return auth.error;

    return NextResponse.json({ unread: await unreadCount(auth.session.contactId) });
  });
}
