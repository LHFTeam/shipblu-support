'use client';

import { useSyncExternalStore } from 'react';

/**
 * A clock that ticks, without a hydration mismatch.
 *
 * Server and client render at different instants, so any time-derived output
 * has to start as null and fill in after mount. `useSyncExternalStore` is the
 * mechanism React provides for exactly that — `getServerSnapshot` is used for
 * the server render and the hydration pass, `getSnapshot` afterwards — which
 * avoids the setState-in-effect the naive version needs.
 *
 * Snapshots are bucketed to the tick interval so repeated calls return the same
 * value; returning `Date.now()` directly would differ on every render and send
 * React into a loop.
 */

const TICK_MS = 30_000;

function subscribe(onChange: () => void): () => void {
  const timer = setInterval(onChange, TICK_MS);
  return () => clearInterval(timer);
}

function getSnapshot(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

function getServerSnapshot(): number | null {
  return null;
}

/** Null until mounted, then the current time rounded down to the last tick. */
export function useNow(): Date | null {
  const bucket = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return bucket === null ? null : new Date(bucket);
}
