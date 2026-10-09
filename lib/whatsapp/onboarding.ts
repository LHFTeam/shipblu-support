import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { groups, jobs, whatsappOnboardings } from '@/db/schema';
import { env, metaAppSecret } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { isTimeout } from '@/lib/http/deadline';
import { logger } from '@/lib/log';
import { inspectToken, type TokenInspection } from '@/lib/meta/debug-token';
import { GRAPH_BASE, graphTimeout } from '@/lib/meta/graph';
import { enqueue } from '@/lib/queue';
import { ensureAccountForWaba } from './accounts';
import { callGraph, WhatsAppApiError } from './client';
import {
  credentialKeyProblem,
  REQUIRED_BUSINESS_TOKEN_SCOPES,
  storeBusinessToken,
} from './credentials';
import {
  clientBusinessRequest,
  isMetaId,
  phoneNumbersRequest,
  readWabaRequest,
  tokenExchangeUrl,
} from './onboarding-requests';
import { LIVE_ATTEMPT_MS } from './onboarding-view';

const log = logger('coexistence');

/**
 * Connecting a WhatsApp Business-app number through Meta's Embedded Signup —
 * the half that cannot wait.
 *
 * Meta's window hands the browser a code that lives thirty seconds and can be
 * used once. So everything the code forces happens here, inside the server
 * action that receives it: exchange it for the business's token, prove the
 * token reaches the WABA the browser named, seal and store the token, and
 * record the attempt. Everything after that — subscribing, creating the
 * channel, asking the phone for its contacts and history — is the
 * `complete_coexistence_onboarding` job (`./onboarding-complete`), which runs
 * with the stored credential. A closed tab therefore abandons nothing, and the
 * first run, a retry and a later "copy the history" cannot differ.
 *
 * This is the second exception to "anything slow or external is a job", and the
 * reason is the same kind as `refreshRequesterProfile`'s: the code dies before
 * a queued job could be sure of running. The job half takes the stored
 * credential and must stay out of the web service, which is why it is a
 * separate module only the worker may import (`credential-confinement`).
 *
 * The plaintext token exists here as one local, from the exchange to the seal.
 * It is never logged, never returned, never put in a job payload, and every
 * sentence this module builds about a request names its host and path, never
 * its URL — the exchange's URL carries the app secret and the code.
 *
 * A fetch tracing span is the place a sentence rule cannot reach: Next's
 * patched `fetch` (and `@vercel/otel`'s, and OpenTelemetry's undici
 * instrumentation) names the span after the whole URL and records it as
 * `http.url` / `url.full`. Nothing registers a tracer today, so nothing leaves
 * the process; the day an `instrumentation.ts` does, the exchange's URL and
 * `debug_token`'s `input_token` go to the tracing vendor with every Connect
 * unless the Graph hosts' query strings are kept out of spans
 * (`docs/PROJECT-STATE.md` §6.88). The exchange stays a GET regardless:
 * it is the only shape Meta documents (`./onboarding-requests`), and trying
 * another spends a code that works once.
 */

/** A variable the button cannot work without, and what it is for. */
export type MissingSetting = { variable: string; why: string };

export type Readiness =
  { ready: true; appId: string; configId: string } | { ready: false; missing: MissingSetting[] };

/**
 * Whether "Connect a WhatsApp number" can work in this environment, and if not,
 * which variables are missing — all of them, so whoever opens Render fixes the
 * lot in one visit.
 *
 * Asked before the button opens Meta's window and again before the code is
 * spent: a code exchanged into a token that cannot then be stored is a business
 * that has to go through Meta's flow a second time.
 */
export function coexistenceReadiness(): Readiness {
  const e = env();
  const missing: MissingSetting[] = [];

  if (!e.META_APP_ID) {
    missing.push({
      variable: 'META_APP_ID',
      why: "Meta's window is opened for this app, and the code it returns is exchanged as it.",
    });
  }
  if (!metaAppSecret()) {
    missing.push({
      variable: 'META_APP_SECRET',
      why: 'The code Meta returns is exchanged for the business token with the app secret.',
    });
  }
  if (!e.META_EMBEDDED_SIGNUP_CONFIG_ID) {
    missing.push({
      variable: 'META_EMBEDDED_SIGNUP_CONFIG_ID',
      why:
        'The Facebook Login for Business configuration that opens Embedded Signup for a ' +
        'number on the WhatsApp Business app.',
    });
  }
  const keyProblem = credentialKeyProblem();
  if (keyProblem) missing.push({ variable: 'WHATSAPP_CREDENTIAL_KEY', why: keyProblem });
  if (!e.APP_URL?.startsWith('https://')) {
    missing.push({
      variable: 'APP_URL',
      why: "Meta's sign-in only opens from an https page on an address its configuration allows.",
    });
  }

  if (missing.length > 0) return { ready: false, missing };
  return { ready: true, appId: e.META_APP_ID!, configId: e.META_EMBEDDED_SIGNUP_CONFIG_ID! };
}

/**
 * What the browser says Meta's window returned. Every field is a claim: the
 * code is proven by Meta accepting it, the WABA by the token reading it, the
 * number by the WABA listing it.
 *
 * The number may be missing. Meta's implementation and v4 pages put
 * `phone_number_id` in the finish event of this flow, but the coexistence
 * guide's own sample carries only `waba_id` — so it is taken when given and
 * read from the WABA when not, where a number converted from the Business app
 * is the account's only one.
 */
export type SignupClaim = {
  code: string;
  wabaId: string;
  phoneNumberId: string | null;
  defaultGroupId: string | null;
};

/**
 * `wait` marks a refusal that running Meta's window again cannot fix — an
 * attempt on this number is still live — so the card stops offering one: each
 * run of the window unlinks the phone's linked devices again.
 */
export type BeginOutcome =
  | { ok: true; onboardingId: string; accountId: string; notice: string }
  | { ok: false; error: string; wait?: true };

/** The `error` on an attempt a newer one retired. */
const SUPERSEDED = 'superseded';

const ALREADY_CONNECTING =
  'This number is already being connected — watch the progress below. If it stops ' +
  'moving, it can be started again in fifteen minutes.';

/**
 * The refusal for an attempt live only because its job is still in the queue.
 *
 * Its own sentence, because past `LIVE_ATTEMPT_MS` that is the one way an
 * attempt stays live, and `ALREADY_CONNECTING`'s "in fifteen minutes" is then
 * false for ever: nothing changes until a worker takes the job. A running
 * worker hands back a job whose holder died within minutes (`STALLED_AFTER_MS`
 * in `lib/queue`), so a job still outstanding this long after the attempt
 * started is one no worker is getting through.
 */
const JOB_WAITING =
  'A job to connect this number is still waiting in the queue, and no worker has finished it in ' +
  'fifteen minutes — the worker service is what to check. Nothing is lost: the sign-in and ' +
  'its credential are saved, and the job carries on as soon as a worker picks it up.';

/**
 * The first phase. Never throws for anything a person could cause: every
 * refusal is a sentence, because the action that calls this answers a form.
 */
export async function beginCoexistenceOnboarding(
  claim: SignupClaim,
  actor: { id: string; name: string },
): Promise<BeginOutcome> {
  const readiness = coexistenceReadiness();
  if (!readiness.ready) {
    return {
      ok: false,
      error: `This environment is not set up to connect numbers yet: ${readiness.missing
        .map((setting) => setting.variable)
        .join(', ')}.`,
    };
  }

  const code = claim.code.trim();
  if (!code || code.length > 2048) {
    return { ok: false, error: "Meta's window did not return a usable sign-in code. Try again." };
  }
  if (!isMetaId(claim.wabaId) || (claim.phoneNumberId !== null && !isMetaId(claim.phoneNumberId))) {
    return {
      ok: false,
      error: "Meta's window did not say which business account was chosen. Try again.",
    };
  }

  if (claim.defaultGroupId) {
    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, claim.defaultGroupId))
      .limit(1);
    if (!group)
      return { ok: false, error: 'That default group no longer exists — reload the page.' };
  }

  // Checked before the code is spent, so a second click while the first
  // connection is still running costs nothing. The partial unique index below
  // is what makes it atomic; this only makes it cheap — and can only be asked
  // when the window named the number.
  const live = claim.phoneNumberId ? await liveAttemptOn(claim.phoneNumberId) : null;
  if (live) return { ok: false, error: liveRefusal(live), wait: true };

  const appSecret = metaAppSecret()!;
  const exchanged = await exchangeCode(code, readiness.appId, appSecret);
  if (!exchanged.ok) return { ok: false, error: exchanged.error };

  // The one plaintext. A local, from here to the seal below.
  const token = exchanged.token;
  const warnings: string[] = [];

  let inspection: TokenInspection | null = null;
  try {
    inspection = await inspectToken(token);
  } catch (error) {
    // Not the proof — reading the WABA below is — so a debug_token that did
    // not answer costs the metadata, not the connection.
    warnings.push(`Meta's token inspection did not answer (${errorMessage(error)}).`);
  }

  if (inspection) {
    const refusal = refuseInspection(inspection, readiness.appId, claim.wabaId);
    if (refusal) return { ok: false, error: refusal };
  }

  let wabaName: string | null;
  try {
    const waba = await callGraph<{ id?: string; name?: string }>(
      readWabaRequest(claim.wabaId),
      token,
    );
    if (waba?.id !== claim.wabaId) {
      return {
        ok: false,
        error: `Meta did not return business account ${claim.wabaId} to the new token. Try again.`,
      };
    }
    wabaName = typeof waba.name === 'string' ? waba.name : null;
  } catch (error) {
    return {
      ok: false,
      error:
        `The token Meta issued cannot read business account ${claim.wabaId}, so nothing was ` +
        `stored: ${error instanceof WhatsAppApiError ? error.message : errorMessage(error)}. ` +
        `Sign in to Meta's window as an admin of the business portfolio that owns the number.`,
    };
  }

  const phoneNumberId = claim.phoneNumberId ?? (await onlyNumberOn(claim.wabaId, token));
  if (typeof phoneNumberId !== 'string') return { ok: false, error: phoneNumberId.error };

  // Metadata, so never the reason a connection fails.
  let businessId: string | null = null;
  try {
    const me = await callGraph<{ client_business_id?: string }>(clientBusinessRequest(), token);
    businessId = typeof me?.client_business_id === 'string' ? me.client_business_id : null;
  } catch (error) {
    warnings.push(
      `Meta did not say which business portfolio the token is for (${errorMessage(error)}).`,
    );
  }

  const committed = await db
    .transaction(async (tx) => {
      // A stale attempt — its job dead, or never picked up — is retired here,
      // in the same transaction as the insert that replaces it, so a worker
      // that never ran cannot lock a number out short of SQL.
      await tx
        .update(whatsappOnboardings)
        .set({
          status: 'failed',
          error: SUPERSEDED,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(whatsappOnboardings.phoneNumberId, phoneNumberId),
            eq(whatsappOnboardings.status, 'exchanged'),
            sql`not (${liveAttempt()})`,
          ),
        );

      const account = await ensureAccountForWaba(tx, claim.wabaId, wabaName);
      const stored = await storeBusinessToken(tx, {
        accountId: account.id,
        wabaId: claim.wabaId,
        token,
        inspection,
        businessId,
        actor: { id: actor.id, label: actor.name },
      });

      const [row] = await tx
        .insert(whatsappOnboardings)
        .values({
          whatsappAccountId: account.id,
          wabaId: claim.wabaId,
          phoneNumberId,
          defaultGroupId: claim.defaultGroupId,
          status: 'exchanged',
          startedByAgentId: actor.id,
          startedByLabel: actor.name,
        })
        // The partial unique index: a live attempt that appeared since the
        // check above. Nothing in this transaction survives the refusal, the
        // credential included.
        .onConflictDoNothing()
        .returning({ id: whatsappOnboardings.id });

      if (!row) throw new AlreadyConnecting();
      return { onboardingId: row.id, account, stored };
    })
    .catch((error: unknown) => {
      if (error instanceof AlreadyConnecting) return null;
      throw error;
    });

  // Refused at the insert. The number may be known only now — read off the
  // WABA after the code was spent, because the window did not name it — so
  // why the attempt in the way is live is asked here too: one kept live only
  // by its queued job is `JOB_WAITING`, where "in fifteen minutes" would stay
  // false for as long as no worker runs.
  if (!committed) {
    return { ok: false, error: liveRefusal(await liveAttemptOn(phoneNumberId)), wait: true };
  }

  // After the commit: a job is enqueued only once the row it names exists.
  await enqueue(
    'complete_coexistence_onboarding',
    { onboardingId: committed.onboardingId },
    { priority: 10 },
  );

  log.info('exchanged', {
    onboardingId: committed.onboardingId,
    accountId: committed.account.id,
    wabaId: claim.wabaId,
    agentId: actor.id,
    tokenType: inspection?.type ?? 'uninspected',
    expiresAt: inspection ? (inspection.expiresAt?.toISOString() ?? 'never') : 'unknown',
  });

  const notes = [
    `Signed in to Meta and stored the business token${
      inspection
        ? inspection.expiresAt
          ? ` (expires ${inspection.expiresAt.toISOString().slice(0, 10)})`
          : ' (never expires)'
        : ''
    }. Connecting the number now.`,
    committed.account.created ? `Business account "${wabaName ?? claim.wabaId}" was added.` : null,
    committed.account.reactivated
      ? 'The business account had been switched off; it is on again.'
      : null,
    committed.stored.replacedVariable
      ? `It now sends with the stored credential instead of ${committed.stored.replacedVariable}; forgetting the credential falls back to META_PAGE_ACCESS_TOKEN, not to that variable.`
      : null,
    ...warnings,
  ];

  return {
    ok: true,
    onboardingId: committed.onboardingId,
    accountId: committed.account.id,
    notice: notes.filter(Boolean).join(' '),
  };
}

class AlreadyConnecting extends Error {}

/**
 * The number on a WABA that has exactly one, or why it cannot be chosen.
 *
 * For a finish event that did not name the number. A Business-app number
 * converted into a messaging account is that account's only number; a WABA
 * with several is one where guessing would connect the wrong phone.
 */
async function onlyNumberOn(wabaId: string, token: string): Promise<string | { error: string }> {
  try {
    const listed = await callGraph<{ data?: { id?: string }[] }>(
      phoneNumbersRequest(wabaId),
      token,
    );
    const ids = (listed?.data ?? []).map((number) => number.id).filter((id): id is string => !!id);
    if (ids.length === 1) return ids[0]!;
    return {
      error:
        ids.length === 0
          ? `Business account ${wabaId} has no phone number yet. Finish the number step in Meta's window and connect again.`
          : `Meta's window did not say which number was connected, and business account ${wabaId} has ${ids.length}. Connect again and finish the number step.`,
    };
  } catch (error) {
    return {
      error: `Meta would not list the numbers on business account ${wabaId}: ${
        error instanceof WhatsAppApiError ? error.message : errorMessage(error)
      }. Connect again.`,
    };
  }
}

/**
 * Whether an `exchanged` attempt still counts: younger than fifteen minutes, or
 * its job still queued or running. Correlated on the outer row; both sides
 * qualified by hand (`${table}.column`), for the reason `storedCredentialExists`
 * in `./credentials` gives.
 */
function liveAttempt() {
  return sql`(${startedRecently()} or ${jobOutstanding()})`;
}

function startedRecently() {
  return sql<boolean>`${whatsappOnboardings}.started_at > now() - ${`${LIVE_ATTEMPT_MS} milliseconds`}::interval`;
}

function jobOutstanding() {
  return sql`exists (
    select 1 from ${jobs}
    where ${jobs}.type = 'complete_coexistence_onboarding'
      and ${jobs}.status in ('pending', 'processing')
      and ${jobs}.payload ->> 'onboardingId' = ${whatsappOnboardings}.id::text
  )`;
}

type LiveAttempt = 'recent' | 'queued' | null;

/**
 * Why the number has a live attempt, for the sentence that refuses another
 * beside it: `recent` while it is inside `LIVE_ATTEMPT_MS`, `queued` once that
 * has passed and only its job keeps it — the case `JOB_WAITING` exists for.
 */
async function liveAttemptOn(phoneNumberId: string): Promise<LiveAttempt> {
  const [row] = await db
    .select({ recent: startedRecently() })
    .from(whatsappOnboardings)
    .where(
      and(
        eq(whatsappOnboardings.phoneNumberId, phoneNumberId),
        eq(whatsappOnboardings.status, 'exchanged'),
        liveAttempt(),
      ),
    )
    .limit(1);
  if (!row) return null;
  return row.recent ? 'recent' : 'queued';
}

/**
 * The sentence refusing an attempt beside a live one. `ALREADY_CONNECTING` as
 * well when the live one has finished since it was in the way: the refusal
 * happened, and the progress card says what came of it.
 */
function liveRefusal(live: LiveAttempt): string {
  return live === 'queued' ? JOB_WAITING : ALREADY_CONNECTING;
}

/**
 * Why a token Meta just issued must not be stored, or null.
 *
 * Only what Meta actually said is held against it. `granular_scopes` may list no
 * targets for a business token, and absent targets mean "not narrowed", so a
 * WABA missing from targets refuses only when targets were given.
 */
export function refuseInspection(
  inspection: TokenInspection,
  appId: string,
  wabaId: string,
): string | null {
  if (!inspection.isValid) {
    return `Meta says the token it just issued is not valid${
      inspection.error ? `: ${inspection.error}` : ''
    }. Try again.`;
  }
  if (inspection.appId && inspection.appId !== appId) {
    return (
      `Meta issued the token for app ${inspection.appId}, not this one (${appId}). Check that ` +
      `META_EMBEDDED_SIGNUP_CONFIG_ID belongs to the app META_APP_ID names.`
    );
  }
  for (const scope of REQUIRED_BUSINESS_TOKEN_SCOPES) {
    if (!inspection.scopes.includes(scope)) {
      return (
        `The token Meta issued does not carry ${scope}, which sending from the number needs. ` +
        `Add it to the Facebook Login for Business configuration and connect again.`
      );
    }
    const granted = inspection.granularScopes.find((entry) => entry.scope === scope);
    if (granted?.targetIds && !granted.targetIds.includes(wabaId)) {
      return (
        `The token carries ${scope} for business account(s) ${granted.targetIds.join(', ')}, ` +
        `not for ${wabaId}. Connect again and choose the account that owns the number.`
      );
    }
  }
  return null;
}

/**
 * `GET /oauth/access_token`, sent with a `fetch` of its own.
 *
 * Outside every Graph client because the URL carries the app secret and the
 * code (`tokenExchangeUrl` says why that is the shape), and those clients put
 * the request into their error messages. Every sentence here names host and
 * path, and anything Meta or the network layer says back has both secrets cut
 * out before it is repeated.
 */
async function exchangeCode(
  code: string,
  appId: string,
  appSecret: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const url = tokenExchangeUrl(GRAPH_BASE, { appId, appSecret, code });
  const where = `${url.host}${url.pathname}`;
  const scrub = (text: string) =>
    [appSecret, code].reduce(
      (out, secret) => (secret ? out.split(secret).join('[redacted]') : out),
      text,
    );
  const timeoutMs = graphTimeout('GET');

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      error: isTimeout(error)
        ? `${where} did not answer in ${timeoutMs / 1000}s, so nothing was stored. Press Connect again.`
        : `${where} could not be reached (${scrub(errorMessage(error))}), so nothing was stored. Press Connect again.`,
    };
  }

  type ExchangeBody = { access_token?: unknown; error?: { message?: unknown } };
  let body: ExchangeBody | null = null;
  try {
    body = JSON.parse(text) as ExchangeBody;
  } catch {
    // Not JSON: refused below with the status.
  }

  if (response.ok && typeof body?.access_token === 'string' && body.access_token) {
    return { ok: true, token: body.access_token };
  }

  const meta =
    typeof body?.error?.message === 'string'
      ? scrub(body.error.message)
      : `HTTP ${response.status}`;
  return {
    ok: false,
    error:
      `Meta refused the sign-in code (${meta}), so nothing was stored. The code lives thirty ` +
      `seconds and can be used once — press Connect and finish Meta's window a little faster.`,
  };
}

/**
 * Starts an attempt's job again — the "Retry connection" button — for an
 * attempt that failed, or one still `exchanged` whose job died without saying
 * so (no longer live: older than fifteen minutes and nothing queued for it).
 * One older than that whose job is still queued is refused with `JOB_WAITING`
 * rather than `ALREADY_CONNECTING`: a retry would only queue a second job
 * behind the first for the same missing worker.
 *
 * Refused for an attempt something newer has replaced — retired as superseded,
 * or simply older than another attempt on the same number — because reopening
 * it would connect the number with the older sign-in's account and group, over
 * whatever the newer one decided. The row is locked before it is judged, and
 * the newer-attempt check is a second statement after the lock, so its
 * snapshot is taken once a concurrent retry of the same row has committed
 * (the reason `storedCredentialEditRefusal` in `./credentials` gives). A
 * newer attempt inserted concurrently is the partial unique index's to refuse,
 * and the refusal picks between the same two sentences for whichever attempt
 * on the number is live.
 */
export async function retryOnboarding(
  onboardingId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Kept outside the transaction for its refusal: the unique violation rolls
  // the transaction back, and the catch below still has to name the number.
  let phoneNumberId: string | null = null;
  const outcome = await db
    .transaction(async (tx): Promise<{ ok: true } | { ok: false; error: string }> => {
      const [row] = await tx
        .select({
          id: whatsappOnboardings.id,
          status: whatsappOnboardings.status,
          error: whatsappOnboardings.error,
          phoneNumberId: whatsappOnboardings.phoneNumberId,
          createdAt: whatsappOnboardings.createdAt,
        })
        .from(whatsappOnboardings)
        .where(eq(whatsappOnboardings.id, onboardingId))
        .for('update')
        .limit(1);

      if (!row) return { ok: false, error: 'That connection no longer exists — reload the page.' };
      phoneNumberId = row.phoneNumberId;
      if (row.status === 'connected') {
        return { ok: false, error: 'That number is already connected — reload the page.' };
      }

      const [newer] = await tx
        .select({ id: whatsappOnboardings.id })
        .from(whatsappOnboardings)
        .where(
          and(
            eq(whatsappOnboardings.phoneNumberId, row.phoneNumberId),
            ne(whatsappOnboardings.id, row.id),
            gt(whatsappOnboardings.createdAt, row.createdAt),
          ),
        )
        .limit(1);
      if (row.error === SUPERSEDED || newer) {
        return {
          ok: false,
          error:
            'A newer connection of this number has replaced this one, so it cannot be ' +
            'started again — retry the newer one, or connect the number again.',
        };
      }

      if (row.status === 'exchanged') {
        const [live] = await tx
          .select({ recent: startedRecently() })
          .from(whatsappOnboardings)
          .where(and(eq(whatsappOnboardings.id, row.id), liveAttempt()))
          .limit(1);
        if (live) return { ok: false, error: live.recent ? ALREADY_CONNECTING : JOB_WAITING };
      }

      await tx
        .update(whatsappOnboardings)
        .set({
          status: 'exchanged',
          error: null,
          lastTransientError: null,
          nextAttemptAt: null,
          finishedAt: null,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(whatsappOnboardings.id, row.id));
      return { ok: true };
    })
    .catch(async (error: unknown) => {
      // The partial unique index: another attempt on this number is live —
      // and, as at the first phase's insert, asked why, so one kept live only
      // by its queued job names the worker rather than "fifteen minutes".
      if (isUniqueViolation(error)) {
        const live = phoneNumberId ? await liveAttemptOn(phoneNumberId) : null;
        return { ok: false as const, error: liveRefusal(live) };
      }
      throw error;
    });

  if (!outcome.ok) return outcome;

  // After the commit, as in the first phase. A job of the attempt's that is
  // still dead or failed in the table stays there as its record.
  await enqueue('complete_coexistence_onboarding', { onboardingId }, { priority: 10 });
  return { ok: true };
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return (
    (error as { code?: unknown } | null)?.code === '23505' ||
    (typeof cause === 'object' && cause !== null && cause.code === '23505')
  );
}
