import { can } from '@/lib/auth/permissions';
import { getSessionAgent } from '@/lib/auth/session';
import { env, metaAppSecret } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';
import { inspectToken, type TokenInspection } from '@/lib/meta/debug-token';
import { redact } from '@/lib/meta/redact';
import {
  callbackPage,
  clearedStateCookie,
  clientBusinessId,
  connectedAccounts,
  exchangeCode,
  accountlessDetails,
  inspectionWarning,
  probeAccount,
  readCallbackParams,
  readStateCookie,
  refuseInspection,
  sameState,
  stateCookieSecure,
  unifiedLoginReadiness,
  type CallbackOutcome,
  type ConnectedAccount,
} from '@/lib/meta/unified-login';

const log = logger('meta:unified_login');

export const dynamic = 'force-dynamic';

/**
 * Where Meta's login sends the admin back, with the code — the redirect URL
 * registered on the Unified Login configuration.
 *
 * Exchanges the code for the system-user token, proves what the token reaches,
 * and shows it once (the module header of `lib/meta/unified-login.ts` says why
 * the browser and not the database). Everything here is one request: the code
 * lives minutes and is spent on its first use, so there is no job to hand it
 * to, and the person who pressed Connect is the one waiting for the answer.
 *
 * Every response — a page or a refusal — is uncached and sends no referrer
 * onward, and clears the state cookie: a second visit to the same URL meets no
 * cookie and is answered "not opened from the console" rather than a second
 * exchange of a spent code.
 */
export async function GET(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });
  if (!can(agent, 'admin.channels.connect')) return new Response('forbidden', { status: 403 });

  const url = new URL(request.url);
  const params = readCallbackParams(url.searchParams);
  const expectedState = readStateCookie(request.headers.get('cookie'));

  if (params.kind === 'cancelled') {
    log.info('Meta’s login was cancelled', { agent_id: agent.id, reason: params.reason });
    return page(200, { kind: 'cancelled', reason: params.reason });
  }

  // The state check comes before anything is sent to Meta: a code arriving
  // without this browser's cookie is somebody else's, or a replay, and is not
  // worth an exchange — which would spend it.
  if (params.kind === 'invalid' || !sameState(expectedState, params.state)) {
    log.warn(
      `callback refused: ${params.kind === 'invalid' ? params.reason : 'state did not match the cookie'} agent_id=${agent.id}`,
    );
    return page(400, {
      kind: 'refused',
      reason:
        'This link was not opened from the console, or it expired. Go back to Channels and press Connect Instagram again.',
    });
  }

  const readiness = unifiedLoginReadiness();
  if (!readiness.ready) {
    return page(503, {
      kind: 'refused',
      reason: `This environment is not set up for Unified Login: ${readiness.missing
        .map((setting) => setting.variable)
        .join(', ')} must be set on Render first.`,
    });
  }

  const appSecret = metaAppSecret()!;
  const exchanged = await exchangeCode({
    appId: readiness.appId,
    appSecret,
    redirectUri: readiness.redirectUri,
    code: params.code,
  }).catch((error: unknown) => ({
    ok: false as const,
    // `exchangeCode` builds its own sentences, with the code and the secret
    // cut out; a throw past it is from URL building, which carries neither,
    // but the sentence is scrubbed below all the same.
    error: `The exchange with graph.facebook.com failed: ${errorMessage(error)}`,
  }));
  if (!exchanged.ok) {
    const reason = redact(exchanged.error, [appSecret, params.code]);
    log.warn(`exchange failed: ${reason} agent_id=${agent.id}`);
    return page(502, { kind: 'refused', reason });
  }

  const token = exchanged.token;
  const warnings: string[] = [];

  // Every sentence below that repeats what Graph or the network layer said
  // passes through this on its way to the page and the log, with all three
  // secrets this request holds. Graph is not known to echo a bearer token or
  // the request it was sent, but nothing promises it never will, and cutting
  // all three everywhere is cheaper than reasoning per call about which of
  // them that call was sent (`beginCoexistenceOnboarding` does the same).
  const scrub = (text: string) => redact(text, [token, params.code, appSecret]);

  // Not the proof — the account list below is — so an inspection that did not
  // answer costs the page its metadata, not the connection.
  let inspection: TokenInspection | null = null;
  try {
    inspection = await inspectToken(token);
  } catch (error) {
    warnings.push(
      `Meta's token inspection did not answer (${scrub(errorMessage(error))}), so the type, ` +
        `expiry and permissions are not shown; npm run job -- check_meta_permissions reads ` +
        `them once the token is set.`,
    );
  }
  if (inspection) {
    const refusal = scrub(refuseInspection(inspection, readiness.appId) ?? '');
    if (refusal) {
      log.warn(`token refused: ${refusal} agent_id=${agent.id}`);
      return page(409, { kind: 'refused', reason: refusal });
    }
    const doubt = inspectionWarning(inspection);
    if (doubt) warnings.push(doubt);
  }

  let accounts: ConnectedAccount[];
  try {
    accounts = await connectedAccounts(token);
  } catch (error) {
    const said = scrub(errorMessage(error));
    log.warn(`accounts unreadable: ${said} agent_id=${agent.id}`);
    return page(502, {
      kind: 'refused',
      reason: `The token Meta issued could not list its Instagram accounts (${said}), so there is nothing to set. Connect again.`,
    });
  }
  // Metadata, never the reason a connection fails — read before the account
  // question is settled, because the refusal page prints it too.
  let business: string | null = null;
  try {
    business = await clientBusinessId(token);
  } catch (error) {
    warnings.push(
      `Meta did not say which business portfolio the token is for (${scrub(errorMessage(error))}).`,
    );
  }

  const configuredAccountId = env().INSTAGRAM_ACCOUNT_ID ?? null;

  /*
    An empty list is not the last word. `/me/assigned_instagram_accounts`
    answered `[]` on 2026-11-05 for a token whose portfolio listed the account
    as shared with this app, so the account every reply is addressed to is
    read directly: a token that reads it can address it, and is accepted with
    the list's silence noted; one that cannot is refused with Graph's own
    sentence and the token's permissions, which is what the admin needs to
    fix the configuration rather than the dialog.
  */
  if (accounts.length === 0 && configuredAccountId) {
    const probe = await probeAccount(token, configuredAccountId);
    if (probe.ok) {
      accounts = [probe.account];
      warnings.push(
        `Meta’s list of the token’s Instagram accounts was empty, but the token reads ` +
          `${configuredAccountId} directly, which is what every reply does. Treat the empty list ` +
          `as a reading to record (plans/instagram-unified-login.md, Not known yet).`,
      );
      log.warn(`assigned_instagram_accounts empty, direct read ok agent_id=${agent.id}`);
    } else {
      const details = accountlessDetails({
        inspection,
        clientBusinessId: business,
        configuredAccountId,
        probeError: scrub(probe.error),
      });
      log.warn(
        `no accounts on the token agent_id=${agent.id} scopes=${inspection?.scopes.join(',') ?? '?'} ` +
          `probe=${scrub(probe.error)}`,
      );
      return page(409, {
        kind: 'refused',
        reason:
          'The token Meta issued reaches no Instagram account, so there is nothing to set: its ' +
          'account list is empty and it cannot read the account this environment replies as.',
        details,
      });
    }
  }
  if (accounts.length === 0) {
    log.warn(
      `no accounts on the token agent_id=${agent.id} scopes=${inspection?.scopes.join(',') ?? '?'}`,
    );
    return page(409, {
      kind: 'refused',
      reason:
        'The token Meta issued reaches no Instagram account, so there is nothing to set, and ' +
        'INSTAGRAM_ACCOUNT_ID is unset, so no account could be read directly.',
      details: accountlessDetails({
        inspection,
        clientBusinessId: business,
        configuredAccountId: null,
        probeError: null,
      }),
    });
  }

  log.info('token issued', {
    agent_id: agent.id,
    account_ids: accounts.map((account) => account.id).join(','),
    usernames: accounts.map((account) => account.username ?? '-').join(','),
    token_type: inspection?.type ?? null,
    expires_at: inspection ? (inspection.expiresAt?.toISOString() ?? 'never') : null,
    expires_in: exchanged.expiresIn,
    client_business_id: business,
  });

  return page(200, {
    kind: 'connected',
    token,
    accounts,
    inspection,
    clientBusinessId: business,
    warnings,
    configuredAccountId,
  });
}

function page(status: number, outcome: CallbackOutcome): Response {
  return new Response(callbackPage(outcome), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'set-cookie': clearedStateCookie(stateCookieSecure()),
    },
  });
}
