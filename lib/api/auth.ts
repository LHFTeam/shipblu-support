import { safeEqual } from '@/lib/auth/tokens';
import { env } from '@/lib/env';
import { logger } from '@/lib/log';
import { invalidRequest, notConfigured, rateLimited } from './errors';
import { admitAddress, admitServerPlane, spendBadBearer } from './limits';
import { apiError } from './respond';
import { ShipBluClientHeader } from './schemas';
import { lookupSession, type Caller, type SessionLookup } from './sessions';

/**
 * Who may call `/api/v1`, on each of its two planes (`plans/myblu-ticket-api.md`,
 * _Two planes, and a webhook back_).
 *
 * - **The server plane** is myBlu's backend, holding `MYBLU_API_TOKEN`. It mints
 *   and ends sessions and does nothing else: a user named in a request body is
 *   a claim, and only the server plane says who a session is.
 * - **The client plane** is the app, holding a session token for one user.
 *   Only the session says who is asking; nothing a request carries — a body
 *   field, a header, a cookie — names the user.
 *
 * Neither reads a cookie. `/api/v1` is public in `proxy.ts` so the app reaches
 * it signed in to nothing, and a console or portal cookie arriving with a
 * request is ignored rather than taken for a credential: a browser that holds
 * one and has no bearer is `401` like anybody else.
 */

const log = logger('api');

/**
 * Below this, a value counts as unset. A minting token is what a leak turns
 * into every user, so one short enough to have been typed by hand, or cut off
 * when pasted, is treated as no token at all rather than as a weak one.
 * Checked here, at first use, and never in `lib/env.ts`, where a format rule
 * turns one mistyped value into a console that does not load.
 */
const MIN_TOKEN_CHARS = 32;

const warned = new Set<string>();

function usable(name: string, value: string | undefined): string | null {
  if (!value) return null;
  if (value.length < MIN_TOKEN_CHARS) {
    if (!warned.has(name)) {
      warned.add(name);
      // The name and the rule, never the value or its length.
      log.warn(`${name} is shorter than ${MIN_TOKEN_CHARS} characters and counts as unset`);
    }
    return null;
  }
  return value;
}

/**
 * The bearers the server plane accepts now: `MYBLU_API_TOKEN` and, while a
 * rotation is under way, `MYBLU_API_TOKEN_PREVIOUS`. Empty while the current
 * value is unusable, whatever the previous one holds — the current value is
 * the switch, and the previous one only ever rides beside it.
 */
export function serverPlaneTokens(): string[] {
  const e = env();
  const current = usable('MYBLU_API_TOKEN', e.MYBLU_API_TOKEN);
  if (!current) return [];
  const previous = usable('MYBLU_API_TOKEN_PREVIOUS', e.MYBLU_API_TOKEN_PREVIOUS);
  return previous ? [current, previous] : [current];
}

/**
 * Whether the API is switched on: a usable `MYBLU_API_TOKEN`. While it is not,
 * both planes answer `503 not_configured` — the client plane before it reads a
 * session — so every stage deploys before anybody at myBlu holds a value, and
 * unsetting it stops the whole API at the next restart rather than a day later.
 */
function apiSwitchedOn(): boolean {
  return serverPlaneTokens().length > 0;
}

/**
 * `Authorization: Bearer <value>`: the value, or why there is none, in words
 * for the refusal. Never a query parameter: no credential rides in a URL.
 *
 * The two reasons are told apart because they send a developer to different
 * places: no header is a client that never attached one, and a header that
 * does not parse — `Basic …`, a bare value, a value with a space in it — is
 * one that attached the wrong thing. Neither repeats what the header held.
 */
type Bearer = { bearer: string } | { bearer: null; missing: string };

const NO_BEARER = 'An Authorization bearer is required.';
const NOT_A_BEARER = 'Authorization must be `Bearer <token>`.';

function bearerOf(request: Request): Bearer {
  const header = request.headers.get('authorization');
  if (header === null || header.trim() === '') return { bearer: null, missing: NO_BEARER };
  const bearer = /^Bearer +(\S+) *$/i.exec(header)?.[1];
  return bearer ? { bearer } : { bearer: null, missing: NOT_A_BEARER };
}

/**
 * A bearer this server refused, answered: `401` with the code the refusal
 * deserves, or `429` once the address has spent its budget of them.
 *
 * The budget is spent only here, by a refusal, and only ever changes a
 * refusal's status: no bearer is refused for it, on either plane. The address
 * is `clientIp`'s, the first `X-Forwarded-For` value, which a caller writes,
 * so a budget asked before the bearer is read would let anybody refuse a live
 * session — or myBlu's backend its minting token — for the rest of a minute by
 * spending it under that address: every app behind one carrier's egress, for
 * a hundred and twenty requests a minute. What it would have stopped is
 * nothing a bearer of 256 bits needs stopping from; a script that writes a
 * fresh address each time is never refused by it anyway.
 */
function refusedBearer(
  request: Request,
  requestId: string,
  code: 'unauthenticated' | 'session_expired',
  message: string,
): Response {
  const spent = spendBadBearer(request);
  if (!spent.allowed) {
    return rateLimited(requestId, spent, 'Too many refused bearers from this address');
  }
  return apiError(code, message, { requestId });
}

/**
 * The server plane's gate: the API switched on, the bearer one of its values,
 * and the plane under its limit. Null when the request may go on, the refusal
 * otherwise.
 *
 * Every accepted value is compared, matched or not, with `safeEqual`, so the
 * time an answer takes says nothing about which value came close.
 *
 * A wrong bearer spends the address's bad-bearer budget, and past it is
 * answered `429` rather than `401`; the right one is never refused for it
 * (`refusedBearer` says why).
 */
export function serverPlane(request: Request, requestId: string): Response | null {
  const accepted = serverPlaneTokens();
  if (accepted.length === 0) return notConfigured(requestId);

  const presented = bearerOf(request);
  const { bearer } = presented;
  const matched =
    bearer !== null && accepted.map((value) => safeEqual(bearer, value)).some(Boolean);
  if (!matched) {
    return refusedBearer(
      request,
      requestId,
      'unauthenticated',
      presented.bearer === null
        ? presented.missing
        : 'The bearer is not MYBLU_API_TOKEN as this server holds it.',
    );
  }

  const plane = admitServerPlane();
  if (!plane.allowed) return rateLimited(requestId, plane, 'The server plane is over its limit');
  return null;
}

export type ClientGate = { caller: Caller } | { refusal: Response };

/** The session a request presents, read but not yet judged for its contact's block. */
type Presented =
  { session: Extract<SessionLookup, { kind: 'live' | 'blocked' }> } | { refusal: Response };

type GateInput = { requestId: string; route: string; now: Date };

/**
 * The client plane's gate, in the order each refusal is cheapest to give:
 *
 * 1. The address bucket, before anything is read.
 * 2. The switch: `503` before a session is read, so an API switched off reads
 *    nothing for anybody.
 * 3. `ShipBlu-Client`, required, and the `426` decided on it — before the
 *    session, because a request the `426` rule cannot judge would let a build
 *    old enough to have lost the header past the one gate that can stop it.
 * 4. The session, its identity and the identity's contact, read now and never
 *    cached: `unauthenticated` for none of ours, `session_expired` for a row
 *    past its day, `blocked` for a contact that may not use support. The first
 *    two spend the address's bad-bearer budget, and past it are answered `429`
 *    (`refusedBearer`); a live session is never refused for it.
 */
export async function clientPlane(request: Request, input: GateInput): Promise<ClientGate> {
  const gate = await presentedSession(request, input);
  if ('refusal' in gate) return gate;
  if (gate.session.kind === 'live') return { caller: gate.session.caller };

  log.info('refused: blocked', {
    route: input.route,
    identity: gate.session.identityId,
    requestId: input.requestId,
  });
  return {
    refusal: apiError('blocked', 'This user may not use support.', {
      requestId: input.requestId,
    }),
  };
}

/** The session `DELETE /session` ends: its hash, and whose it is for the log line. */
export type Ending = { tokenHash: string; identityId: string };

/**
 * `DELETE /session`'s gate: the client plane's, steps 1 to 4, except that a
 * blocked or deleted contact's session is handed back to be ended rather than
 * refused. Ending a session takes nothing from anybody, and the SDK's
 * `reset()` wipes the device whatever this answers, so a `403` here would
 * leave alive a token its app has already let go of — for the rest of its
 * day, and usable again the moment the block is lifted.
 *
 * A gate of its own, rather than an option on `clientPlane`, so no other
 * route can be handed a blocked contact's session by passing a flag: every
 * other route refuses one, and only this one is written to end it.
 */
export async function endingPlane(
  request: Request,
  input: GateInput,
): Promise<{ ending: Ending } | { refusal: Response }> {
  const gate = await presentedSession(request, input);
  if ('refusal' in gate) return gate;
  const { session } = gate;
  return session.kind === 'live'
    ? { ending: { tokenHash: session.caller.tokenHash, identityId: session.caller.identityId } }
    : { ending: { tokenHash: session.tokenHash, identityId: session.identityId } };
}

/** Steps 1 to 4 of `clientPlane`, up to the session read, its block not yet judged. */
async function presentedSession(
  request: Request,
  { requestId, now }: GateInput,
): Promise<Presented> {
  const address = admitAddress(request);
  if (!address.allowed) {
    return { refusal: rateLimited(requestId, address, 'Too many requests from this address') };
  }

  if (!apiSwitchedOn()) return { refusal: notConfigured(requestId) };

  const header = request.headers.get('shipblu-client');
  const client = header === null ? null : ShipBluClientHeader.safeParse(header);
  if (!client?.success) {
    return {
      refusal: invalidRequest(
        requestId,
        header === null
          ? 'ShipBlu-Client is required on every client-plane request.'
          : 'ShipBlu-Client must be name/version tokens separated by spaces, the SDK first.',
        'ShipBlu-Client',
      ),
    };
  }
  const stale = belowMinimum(client.data);
  if (stale) {
    return {
      refusal: apiError('client_upgrade_required', `${stale} is no longer served; update it.`, {
        requestId,
      }),
    };
  }

  const presented = bearerOf(request);
  if (presented.bearer === null) {
    return { refusal: refusedBearer(request, requestId, 'unauthenticated', presented.missing) };
  }
  const session = await lookupSession(presented.bearer, now);
  if (session.kind === 'live' || session.kind === 'blocked') return { session };
  if (session.kind === 'expired') {
    return {
      refusal: refusedBearer(
        request,
        requestId,
        'session_expired',
        'This session is past its twenty-four hours; ask for a new one.',
      ),
    };
  }
  return {
    refusal: refusedBearer(
      request,
      requestId,
      'unauthenticated',
      'No live session for this bearer.',
    ),
  };
}

/**
 * The first version of each `ShipBlu-Client` token this server still serves,
 * by the token's name: an SDK (`sdk-ts`), the app (`app`) or a platform
 * (`ios`, `android`). A request whose token is older answers
 * `426 client_upgrade_required`, and the SDK stops every call and tells the app
 * once.
 *
 * Empty: no build is refused yet, and none should be before one exists that
 * this server cannot serve. To stop serving one, add its name and the first
 * version still served — `['sdk-ts', '0.2.0']` — in the change that needs it,
 * with a dated line in `docs/myblu-api-changelog.md`; it takes effect when that
 * change deploys. A code constant rather than a variable, because which builds
 * a server can answer is a fact about its code, and a value set in the
 * dashboard could refuse every installed app on one typo.
 */
const MINIMUM_VERSIONS: ReadonlyMap<string, string> = new Map();

/**
 * The first token in a `ShipBlu-Client` header older than its minimum, as the
 * header spelled it, or null. A version is compared by its leading dotted
 * numbers, so `0.3.0-beta.1` reads as `0.3.0`; one with no numbers to read is
 * older than any minimum, since nothing can say it is not. A token whose name
 * has no minimum is not judged.
 */
export function belowMinimum(
  header: string,
  minimums: ReadonlyMap<string, string> = MINIMUM_VERSIONS,
): string | null {
  for (const token of header.split(' ')) {
    const slash = token.indexOf('/');
    const minimum = minimums.get(token.slice(0, slash));
    if (minimum !== undefined && olderThan(token.slice(slash + 1), minimum)) return token;
  }
  return null;
}

function olderThan(version: string, minimum: string): boolean {
  const have = dotted(version);
  const need = dotted(minimum) ?? [];
  if (!have) return true;
  for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

function dotted(version: string): number[] | null {
  const core = /^\d+(?:\.\d+)*/.exec(version)?.[0];
  return core ? core.split('.').map(Number) : null;
}
