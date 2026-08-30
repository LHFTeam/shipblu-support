import { env, metaAppSecret } from '@/lib/env';
import { diagnoseCapabilities, requiredScopes } from '@/lib/meta/capabilities';

/**
 * What the live Meta token actually carries, and which capability each gap stops.
 *
 *   npm run job -- check_meta_permissions
 *
 * Read-only. It writes nothing, subscribes to nothing and can be run against
 * production whenever a channel goes quiet in one direction.
 *
 * It exists because the question it answers had no cheap answer, and the
 * expensive ones were wrong twice. "Which permissions does this token hold?"
 * was settled by reading the scope list somebody remembered configuring
 * (§6.28 — the list was innocent and the token was the wrong *type*), and then
 * by inferring the answer from which half of Instagram had gone silent (§6.34 —
 * correct, but it took an afternoon and a dead end through App Review). Graph
 * will simply say.
 *
 * `debug_token` rather than `/me/permissions`: the latter needs a *user* token
 * and this deployment sends with a Page one, where `/me` is the Page and the
 * edge does not exist. `debug_token` takes any token, is authorised with the app
 * token we already build for subscriptions, and returns three things that have
 * each been the answer to an outage here — `type`, `scopes`, and
 * `granular_scopes`, which says *per asset* who a permission was granted for.
 * That last one matters when an app administers more than one Page: a scope
 * granted for the wrong account reads as granted in every other view.
 */

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type DebugToken = {
  type?: string;
  application?: string;
  app_id?: string;
  is_valid?: boolean;
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  granular_scopes?: { scope: string; target_ids?: string[] }[];
  profile_id?: string;
  user_id?: string;
};

export async function checkMetaPermissions(): Promise<void> {
  const appId = env().META_APP_ID;
  const appSecret = metaAppSecret();
  const token = env().META_PAGE_ACCESS_TOKEN;

  // Loud rather than skipped: this job only ever runs because somebody typed it,
  // and a silent success would leave them believing the token is fine.
  const missing = [
    !appId && 'META_APP_ID',
    !appSecret && 'META_APP_SECRET',
    !token && 'META_PAGE_ACCESS_TOKEN',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} must be set before the token can be inspected`);
  }

  const url = new URL(`${GRAPH_BASE}/debug_token`);
  url.searchParams.set('input_token', token!);

  // The app token goes in the header, not the query string: it contains the app
  // secret verbatim and a URL is the part of a request that reaches logs.
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${appId}|${appSecret}` },
  });

  const body = (await response.json().catch(() => null)) as { data?: DebugToken; error?: unknown };

  if (!response.ok || !body?.data) {
    throw new Error(
      `debug_token failed (HTTP ${response.status}): ${JSON.stringify(body?.error ?? body)}`,
    );
  }

  const data = body.data;
  const scopes = data.scopes ?? [];

  console.log(`\n[meta:permissions] token type ${data.type ?? 'unknown'}, valid=${data.is_valid}`);

  // §6.28 in one line: a token can carry every scope needed and still be the
  // wrong kind, and Graph's refusal for that names a capability rather than a
  // token — which reads as an App Review problem and is not one.
  if (data.type && data.type.toUpperCase() !== 'PAGE') {
    console.warn(
      `[meta:permissions] this is a ${data.type} token, not a Page token. A page-scoped id ` +
        `can only be resolved by that Page's own token — see docs/PROJECT-STATE.md §6.28.`,
    );
  }

  console.log(`[meta:permissions] ${scopes.length} scope(s): ${scopes.join(', ') || '(none)'}`);

  for (const entry of data.granular_scopes ?? []) {
    const targets = entry.target_ids?.length ? entry.target_ids.join(', ') : 'all assets';
    console.log(`[meta:permissions]   ${entry.scope} → ${targets}`);
  }

  console.log('');

  const reports = diagnoseCapabilities(scopes);

  for (const report of reports) {
    const gaps = report.permissions.filter((entry) => entry.status !== 'granted');

    if (gaps.length === 0) {
      console.log(`[meta:permissions] OK      ${report.capability.name}`);

      // A granted permission is not the same as a delivered webhook, and for
      // exactly one row here it is not even close. Saying so on the *passing*
      // line is the point: the failure mode this prevents is reading a clean
      // grant list as "so the problem must be our parser".
      if (report.capability.advancedAccess) {
        console.warn(`[meta:permissions]         but: ${report.capability.advancedAccess}`);
      }
      continue;
    }

    console.warn(
      `[meta:permissions] BLOCKED ${report.capability.name} — ` +
        `${gaps.map((entry) => `${entry.permission} (${entry.status})`).join(', ')}`,
    );
    console.warn(`[meta:permissions]         symptom: ${report.capability.symptom}`);
  }

  const blocked = reports.filter((report) => report.blocked);

  if (blocked.length === 0) {
    console.log('\n[meta:permissions] every capability this system uses is granted.');
    return;
  }

  /*
    The sentence that closes the loop, because the wrong next step here is the
    intuitive one. A missing permission is not fixed by adding it to an App
    Review submission — that asks for Advanced Access and does nothing until it
    is approved. Standard Access already covers a role holder testing on their
    own assets, and it needs the permission to have been *requested* in the
    authorisation that minted this token.
  */
  console.warn(
    `\n[meta:permissions] ${blocked.length} capability(s) blocked. These are grants, not ` +
      `approvals: re-run the authorisation with the permission in its scope list. Standard ` +
      `Access already covers an app admin, developer or tester on assets they administer, so ` +
      `App Review is only needed to reach the general public.`,
  );
  console.warn(`[meta:permissions] full scope list to request: ${requiredScopes().join(',')}`);
}
