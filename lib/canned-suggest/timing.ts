/**
 * The clocks the suggestion route and the composer have to agree on.
 *
 * Imports nothing, so the composer — a client component — can take values from
 * it without the `client-bundle` rule following them into `db/client`, which
 * `suggest.ts` reaches. Both sides read these numbers rather than keeping their
 * own copies, because the one bug this split has had was the two disagreeing: a
 * composer that lost the race to another tab gave up asking after three seconds
 * while the server could still be waiting five on Jev, and so never showed an
 * answer that arrived in between.
 */

/**
 * How long a suggestion may take. Measured calls answer in a quarter of a
 * second (the shadow run's p90 is 274 ms); five seconds is room for a slow day
 * and still short of the point where the agent has given up and started
 * typing, after which the answer is held rather than drawn.
 */
export const SUGGEST_TIMEOUT_MS = 5_000;

/** How soon a composer that lost the race should ask again. */
export const RETRY_AFTER_MS = 1_000;

/**
 * How many times a composer that lost the race asks again before it stops:
 * enough waits to outlast the winner's call however slow it is, plus one for
 * the round trips either side of it.
 */
export const MAX_PENDING_RETRIES = Math.ceil(SUGGEST_TIMEOUT_MS / RETRY_AFTER_MS) + 1;
