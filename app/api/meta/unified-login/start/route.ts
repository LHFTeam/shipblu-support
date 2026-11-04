import { can } from '@/lib/auth/permissions';
import { getSessionAgent } from '@/lib/auth/session';
import { logger } from '@/lib/log';
import {
  loginDialogUrl,
  newState,
  stateCookie,
  stateCookieSecure,
  unifiedLoginReadiness,
} from '@/lib/meta/unified-login';

const log = logger('meta:unified_login');

export const dynamic = 'force-dynamic';

/**
 * "Connect Instagram" on the Channels page: opens Meta's login for the Unified
 * Login configuration, with a fresh `state` set as a cookie on the way out so
 * the callback can tell this browser's return from anybody else's.
 *
 * A route handler and not a server action, because the whole answer is a
 * redirect to facebook.com: a top-level navigation is what a login dialog
 * needs, and what lets the callback arrive as one, with the session cookie
 * (SameSite=Lax) and the state cookie both on it.
 *
 * The same gate as the callback and as every connect control on the page:
 * `admin.channels.connect`, which is a different thing to hand out from
 * renaming a channel. A request with no cookie never arrives — `proxy.ts`
 * answers it with a redirect to /login — so the 401 is for a session that is
 * gone.
 */
export async function GET() {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });
  if (!can(agent, 'admin.channels.connect')) return new Response('forbidden', { status: 403 });

  const readiness = unifiedLoginReadiness();
  if (!readiness.ready) {
    // Plain text: whoever reaches this has the Channels page, which lists the
    // same variables with the reason each is needed.
    return new Response(
      `This environment cannot open Meta's login yet. Set ${readiness.missing
        .map((setting) => setting.variable)
        .join(', ')} on Render and deploy.`,
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const state = newState();
  const dialog = loginDialogUrl({
    appId: readiness.appId,
    configId: readiness.configId,
    redirectUri: readiness.redirectUri,
    state,
  });

  // The state is deliberately not in this line: it is the one value that binds
  // the callback to this browser, and a log is read by more people than that.
  log.info("opened Meta's login", { agent_id: agent.id });

  return new Response(null, {
    status: 302,
    headers: {
      location: dialog.toString(),
      'set-cookie': stateCookie(state, stateCookieSecure()),
      'cache-control': 'no-store',
    },
  });
}
