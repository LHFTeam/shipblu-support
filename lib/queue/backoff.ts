/**
 * Backoff for the worker's main loop.
 *
 * The loop previously retried every 5 seconds regardless of why it failed. That
 * is fine for a dropped connection, but actively harmful for a bad credential:
 * a wrong password will never fix itself, and hammering the pooler with failing
 * auth attempts trips Supavisor's shared circuit breaker — which then blocks
 * *other* services from connecting at all. One misconfigured service should not
 * be able to take the rest of the project down with it.
 *
 * So the delay is chosen from the kind of failure, not just the attempt count.
 */

export type FailureKind =
  /** Connection refused, DNS, timeouts — usually self-resolving. */
  | 'transient'
  /** Wrong password or role. Will not fix itself without human action. */
  | 'auth'
  /** The pooler is refusing new connections until things go quiet. */
  | 'circuit_breaker';

type Profile = { baseMs: number; maxMs: number };

const PROFILES: Record<FailureKind, Profile> = {
  // 5s → 10 → 20 → 40 → 60 (capped). Recovers quickly from a blip.
  transient: { baseMs: 5_000, maxMs: 60_000 },
  // 30s → 60 → 120 → 240 → 300 (capped). Nothing we retry will help; the point
  // is to stay alive and log clearly without generating load.
  auth: { baseMs: 30_000, maxMs: 300_000 },
  // 60s → 120 → 240 → 480 → 600 (capped). The breaker resets only if we stop
  // knocking, so this backs off hardest.
  circuit_breaker: { baseMs: 60_000, maxMs: 600_000 },
};

/** Postgres SQLSTATEs that mean "your credentials are wrong", not "try again". */
const AUTH_SQLSTATES = new Set([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name — wrong database in the URL
]);

export function classifyFailure(error: unknown): FailureKind {
  const text = errorText(error);

  // Supavisor reports this as a message rather than a SQLSTATE.
  if (text.includes('ECIRCUITBREAKER') || text.includes('temporarily blocked')) {
    return 'circuit_breaker';
  }

  const code = (error as { code?: unknown })?.code;
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code;
  for (const candidate of [code, causeCode]) {
    if (typeof candidate === 'string' && AUTH_SQLSTATES.has(candidate)) return 'auth';
  }

  if (/password authentication failed|role .* does not exist/i.test(text)) return 'auth';

  return 'transient';
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return `${error.message} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  }
  return String(error);
}

/**
 * Delay before the next attempt. `attempt` is 1 for the first failure.
 *
 * Jitter (±20%) keeps multiple worker instances from retrying in lockstep and
 * re-tripping the breaker together the moment it resets. `random` is injectable
 * so tests are deterministic.
 */
export function backoffMs(
  kind: FailureKind,
  attempt: number,
  random: () => number = Math.random,
): number {
  const { baseMs, maxMs } = PROFILES[kind];
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = 1 + (random() - 0.5) * 0.4;
  return Math.round(Math.min(exponential * jitter, maxMs));
}
