/**
 * Per-instance sign-in throttle.
 *
 * In-memory on purpose: the alternative is a write to Postgres on every failed
 * password attempt, which is a denial-of-service amplifier of its own. With one
 * to three web instances an attacker gains at most a few times the allowance,
 * which still leaves online guessing hopeless against a 12-character minimum.
 *
 * Keyed on email *and* IP so one attacker cannot lock a real agent out by
 * spamming their address — the agent's own IP stays under its own budget.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function hit(key: string, max: number = MAX_ATTEMPTS): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= max;
}

export function allowLoginAttempt(email: string, ip: string | null): boolean {
  // Both must pass, and both are incremented, so neither key can be starved by
  // traffic against the other.
  const byEmail = hit(`email:${email}`);
  const byIp = ip ? hit(`ip:${ip}`) : true;
  return byEmail && byIp;
}

/**
 * Budget for anything that makes us send an email to an address somebody typed
 * into a form — portal registration and password-reset requests.
 *
 * A different concern from sign-in: a failed sign-in costs an attacker a guess,
 * while these cost a *third party* an unwanted email. So the per-address budget
 * is the tight one — five links to the same inbox in a quarter of an hour is
 * already generous for a person who mistyped their password.
 *
 * The per-source budget is deliberately much looser. Most ShipBlu customers
 * reach us over Egyptian mobile networks, where carrier-grade NAT puts a large
 * number of unrelated people behind one address; a tight IP cap there does not
 * stop an attacker (who has more than one address) and does stop a genuine
 * customer whose neighbour signed up first. It exists to blunt a single host
 * spraying thousands of addresses, and that is all it is sized for.
 */
const EMAIL_MAX_PER_ADDRESS = 5;
const EMAIL_MAX_PER_SOURCE = 60;

export function allowEmailDispatch(email: string, ip: string | null): boolean {
  const byEmail = hit(`mail:${email}`, EMAIL_MAX_PER_ADDRESS);
  const byIp = ip ? hit(`mailip:${ip}`, EMAIL_MAX_PER_SOURCE) : true;
  return byEmail && byIp;
}

/** Called on success so a legitimate agent is not held back by earlier typos. */
export function clearLoginAttempts(email: string, ip: string | null): void {
  buckets.delete(`email:${email}`);
  if (ip) buckets.delete(`ip:${ip}`);
}

/** Keeps the map from growing without bound on a long-lived instance. */
export function pruneThrottleBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
