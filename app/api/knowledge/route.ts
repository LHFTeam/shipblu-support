import { can } from '@/lib/auth/permissions';
import { getSessionAgent } from '@/lib/auth/session';
import { searchForAgent } from '@/lib/kb/agent-search';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { requestBaseUrl } from '@/lib/kb/site';

export const dynamic = 'force-dynamic';

/**
 * Article search for the composer's knowledge panel.
 *
 * Deliberately not under `/api/kb`, which `proxy.ts` lists in
 * `PUBLIC_PREFIXES` so the widget and the help centre can reach it without a
 * session. Anything added there is unauthenticated by default, and this returns
 * the internal folders — so it lives on its own prefix and checks for itself.
 *
 * `kb.view` is on the agent role baseline, so every agent who can open a ticket
 * can search from it. That is a slightly new meaning for the key, which until
 * now only decided whether the `/kb` section appeared in the nav.
 *
 * Not rate limited, unlike its siblings under `/api/kb`. Those are open to the
 * internet and count requests per IP; this one is already behind a session, and
 * a bucket here would throttle a fast typist rather than an abuser.
 */
export async function GET(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });
  if (!can(agent, 'kb.view')) return new Response('forbidden', { status: 403 });

  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').trim();

  const requested = params.get('locale') ?? DEFAULT_LOCALE;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  // The origin the agent is on, not the one we publish: an article they cannot
  // open is no use to them, and `KB_PUBLIC_HOST` may name a domain that does
  // not serve this app yet.
  const origin = requestBaseUrl(request.headers);

  return Response.json({ articles: await searchForAgent(origin, agent.role, locale, query) });
}
