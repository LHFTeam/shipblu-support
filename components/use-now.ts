'use client';

import { useMemo, useSyncExternalStore } from 'react';

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

type Clock = { listeners: Set<() => void>; stop: (() => void) | null };

/**
 * One timer per interval, shared by every caller asking for it.
 *
 * A timer per component would start each one from the moment it mounted, so
 * two badges crossing the same boundary could disagree for most of a tick —
 * one row reading "window closed" beside another still counting down — and a
 * list of a few hundred rows would run a few hundred intervals. The first tick
 * waits for the next bucket boundary, so every subscriber reads the new bucket
 * at the moment it begins.
 */
const clocks = new Map<number, Clock>();

export function subscribeClock(tickMs: number, onChange: () => void): () => void {
  let clock = clocks.get(tickMs);
  if (!clock) {
    clock = { listeners: new Set(), stop: null };
    clocks.set(tickMs, clock);
  }
  const shared = clock;
  shared.listeners.add(onChange);

  if (!shared.stop) {
    const fire = () => {
      for (const listener of shared.listeners) listener();
    };
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(
      () => {
        fire();
        interval = setInterval(fire, tickMs);
      },
      tickMs - (Date.now() % tickMs),
    );
    shared.stop = () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }

  return () => {
    shared.listeners.delete(onChange);
    if (shared.listeners.size === 0) {
      shared.stop?.();
      clocks.delete(tickMs);
    }
  };
}

function getServerSnapshot(): number | null {
  return null;
}

/**
 * Null until mounted, then the current time rounded down to the last tick.
 *
 * The interval is the resolution the caller needs, not a refresh rate to be
 * generous with: every tick re-renders whatever reads it. Half a minute suits a
 * ticket timeline; a "seconds ago" readout is the case for anything shorter.
 */
export function useNow(tickMs: number = TICK_MS): Date | null {
  const store = useMemo(
    () => ({
      subscribe(onChange: () => void): () => void {
        return subscribeClock(tickMs, onChange);
      },
      getSnapshot(): number {
        return Math.floor(Date.now() / tickMs) * tickMs;
      },
    }),
    [tickMs],
  );

  const bucket = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
  return bucket === null ? null : new Date(bucket);
}
