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
 * dozen queries on a pool of eight places, and the polling ran a render every
 * three seconds per card for as long as a copy took — hours, for six months of
 * history. This is two queries, and the page renders only when the answer
 * changes (§6.91).
 *
 * The same permission as the page. The answer is a hash, so it says nothing
 * about the rows it was made from — but whether somebody is connecting a number
 * is still the admins' business.
 */
export async function GET() {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });
  if (!can(agent, 'admin.channels')) return new Response('forbidden', { status: 403 });

  const version = await readProgressVersion(new Date());
  return Response.json({ version }, { headers: { 'cache-control': 'no-store' } });
}
