import { getSessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { readProgressVersion } from '@/lib/whatsapp/onboarding-reads';

export const dynamic = 'force-dynamic';

/**
 * Whether anything the Channels page shows of a WhatsApp onboarding has moved:
 * one short string, which the page compares with the one it was rendered with.
 *
 * Polled while an attempt is connecting or a copy is arriving, in place of
 * re-rendering the whole page on a timer. A render of that page is about a
 * dozen queries, and each progress card used to run one every three seconds
 * while its job was stepping (minutes) and every fifteen while a history or
 * contacts copy arrived (hours, for six months of history). This is the session
 * lookup and four reads — the page's own readers of the onboardings, the
 * channels, the business accounts and their stored credentials, each a table
 * of a few rows, two at a time (`readProgressVersion`) — and the page renders
 * only when the answer changes. While history chunks are still arriving that
 * is still most polls; the saving is in the stretches where nothing moves, a
 * pending retry's countdown among them (§6.91).
 *
 * A route handler, so those reads queue for the route handlers' places beside
 * the webhooks rather than the pages'. Each poller on a page has at most one
 * question in flight.
 *
 * The same permission as the page. The answer is a hash, so it says nothing
 * about the rows it was made from — but whether somebody is connecting a number
 * is still the admins' business. The 401 here is for a cookie whose session is
 * gone; a request with no cookie at all never arrives, because `proxy.ts`
 * answers it with a redirect to /login, which the poller reads the same way.
 */
export async function GET() {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });
  if (!can(agent, 'admin.channels')) return new Response('forbidden', { status: 403 });

  const version = await readProgressVersion(new Date());
  return Response.json({ version }, { headers: { 'cache-control': 'no-store' } });
}
