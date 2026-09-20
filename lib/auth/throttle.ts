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

/**
 * Drops every expired bucket, amortised over the calls that create them.
 *
 * `hit` only ever resets a key it sees *again*, and `clearLoginAttempts` only
 * deletes on a successful sign-in — so a key that is never hit twice is never
 * removed by either. That makes the map grow one entry per distinct address and
 * per distinct source, forever, on endpoints an unauthenticated caller reaches:
 * `/login` and the two that send mail to a typed address. An attacker spraying
 * distinct addresses is then filling a Map rather than being throttled by it.
 *
 * Swept here rather than on a timer or in the `cleanup` job, because neither can
 * reach this: the map is per-process heap, there is nothing to hang an interval
 * on in a request-scoped web process, and a job runs in the worker. One pass
 * every `SWEEP_EVERY` new keys is O(size) on a map that is small precisely
 * because of the sweep.
 */
function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** New keys between sweeps. Nothing depends on the exact number. */
const SWEEP_EVERY = 256;
let sinceSweep = 0;

function hit(key: string, max: number = MAX_ATTEMPTS): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    // Counted on the branch that adds a key rather than on every call, so the
    // sweep is paid for by the growth it exists to bound.
    sinceSweep += 1;
    if (sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      sweepExpired(now);
    }
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= max;
}

/** Exported for the test that proves the map does not grow without bound. */
export function throttleBucketCount(): number {
  return buckets.size;
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
