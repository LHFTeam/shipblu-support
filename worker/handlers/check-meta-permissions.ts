import { env, metaAppSecret } from '@/lib/env';
import { diagnoseCapabilities, requiredScopes } from '@/lib/meta/capabilities';
import { instagramLoginConfigured } from '@/lib/meta/connection';

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
 *
 * **It reports on both connections, and it can say much less about the second
 * one.** `debug_token` is a graph.facebook.com endpoint and an Instagram Login
 * token is issued by the Instagram side of the app, which publishes no scope
 * list of its own — so for the direct connection this asks the only question
 * that host will answer, `GET /me`, and reports what that settles: whether the
 * token works at all, and which account it belongs to. That is not nothing. Both
 * Instagram outages this system has had were a credential in the wrong place,
 * and both would have been answered by it in one line.
 */

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const INSTAGRAM_GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;

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

  const reports = diagnoseCapabilities(scopes, [], 'facebook_page');

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
    console.log('\n[meta:permissions] every Facebook Page capability is granted.');
    await checkInstagramLogin();
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

  await checkInstagramLogin();
}

/**
 * The direct Instagram connection, as far as its own host will describe it.
 *
 * Three things are checked and each has already been the whole cause of an
 * outage here: that the token is *there*, that it is *valid*, and that it names
 * the account the rest of the configuration points at. A token for the wrong
 * account resolves perfectly and then refuses every send with a sentence about
 * the object not existing.
 *
 * The scope list is printed rather than verified, and said to be so. Pretending
 * to have checked it would be worse than saying it cannot be — the thing that
 * cost §6.28 a day was a scope list everybody trusted because it looked right.
 */
type InstagramMe = { user_id?: string; id?: string; username?: string; error?: unknown };

async function checkInstagramLogin(): Promise<void> {
  console.log('');

  if (!instagramLoginConfigured()) {
    console.log(
      '[meta:permissions] no direct Instagram connection — INSTAGRAM_ACCESS_TOKEN is unset, ' +
        'so every Instagram call goes out over the Facebook Page above',
    );
    return;
  }

  const token = env().INSTAGRAM_ACCESS_TOKEN!;
  const expected = env().INSTAGRAM_ACCOUNT_ID;

  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/me`);
  url.searchParams.set('fields', 'user_id,username');

  let body: InstagramMe | null = null;
  let status = 0;

  try {
    // Header rather than query string: a URL is the part of a request that ends
    // up in logs, and this one is a live credential.
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    status = response.status;
    body = (await response.json().catch(() => null)) as InstagramMe | null;
  } catch (error) {
    console.error(
      `[meta:permissions] graph.instagram.com unreachable: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (status !== 200 || !body || body.error) {
    console.error(
      `[meta:permissions] INSTAGRAM_ACCESS_TOKEN is set but graph.instagram.com refused it ` +
        `(HTTP ${status}): ${JSON.stringify(body?.error ?? body)}`,
    );
    console.error(
      '[meta:permissions] every Instagram send, reply and moderation is routed to this ' +
        'credential while it is set — see metaConnection() in lib/meta/connection.ts — so ' +
        'this refusal is the whole Instagram channel, not one call.',
    );
    return;
  }

  // Meta calls it `user_id` on this host and `id` on the other. Both are the
  // Instagram professional account id, and it is the same value the webhook's
  // `entry.id` carries on either connection.
  const accountId = body.user_id ?? body.id ?? null;

  console.log(
    `[meta:permissions] direct Instagram connection OK — @${body.username ?? 'unknown'} ` +
      `(${accountId ?? 'no id returned'})`,
  );

  if (expected && accountId && accountId !== expected) {
    console.warn(
      `[meta:permissions] but INSTAGRAM_ACCOUNT_ID is ${expected}, and this token belongs to ` +
        `${accountId}. Every reply is addressed to the configured id with this token, which ` +
        `Graph refuses with a message about the object not existing.`,
    );
  }

  console.warn(
    `[meta:permissions] this host publishes no scope list, so the grant cannot be checked ` +
      `from here — confirm in the App Dashboard under Instagram → API setup with Instagram ` +
      `login: ${requiredScopes('instagram_login').join(', ')}`,
  );
}
