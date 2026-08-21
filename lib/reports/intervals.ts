/**
 * Turning recorded intervals into measured time.
 *
 * Presence and focus are both written by hot paths that are deliberately
 * approximate — `lib/assignment/presence.ts` explains why — so the rows they
 * leave behind can overlap, can be duplicated by two instances racing, and can
 * arrive shredded into fragments by a tab closing and reopening. All three are
 * corrected here, once, by treating the rows as a *set of spans* and taking
 * their union rather than summing them.
 *
 * That distinction is the whole file. Summing durations is the obvious
 * implementation and it is wrong in the one direction that matters: it makes an
 * agent look like they were at their desk for longer than the day contained,
 * and it makes occupancy — focused time over online time — exceed 100% and stop
 * meaning anything. A union can only ever measure time that actually elapsed.
 *
 * Pure and dateless in the arithmetic, so the awkward cases can be tested
 * without a database or a clock.
 */

/** Half-open, in epoch milliseconds: `[start, end)`. */
export type Span = { start: number; end: number };

/**
 * A recorded interval as the tables store it.
 *
 * `endedAt` is null for a stream still open — and also for one that died without
 * running its abort handler, which is why the end falls back to the last beat
 * rather than to "now". A dead stream's last beat is the last moment we have
 * evidence the agent was there; treating it as still open would credit them for
 * every hour since.
 */
export type Recorded = { startedAt: Date; lastBeatAt: Date; endedAt: Date | null };

export function toSpan({ startedAt, lastBeatAt, endedAt }: Recorded): Span {
  const start = startedAt.getTime();
  const end = (endedAt ?? lastBeatAt).getTime();

  // A row whose end precedes its start is not a negative duration, it is a
  // corrupt row; clamping to zero keeps one bad write from subtracting real
  // time from an agent's day.
  return { start, end: Math.max(start, end) };
}

/**
 * The union of a set of spans, with gaps up to `stitchMs` treated as continuous.
 *
 * The stitch is what stops presence from being reported as noise. Closing one of
 * two console tabs marks an agent offline and the survivor's next keepalive puts
 * them back, so a single uninterrupted shift legitimately arrives as a string of
 * fragments separated by seconds. Without a stitch the online total is still
 * roughly right, but "sessions" reads as forty and the longest one as three
 * minutes, which describes the reconnect logic rather than the person.
 *
 * Callers pass the window that matches their signal: the heartbeat TTL for
 * presence, something tighter for focus, whose beat is more frequent.
 */
export function mergeSpans(spans: Span[], stitchMs = 0): Span[] {
  const sorted = [...spans]
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];

    if (last && span.start - last.end <= stitchMs) {
      // Overlapping or close enough to stitch. `Math.max` matters: a short span
      // wholly inside a long one must not shorten it.
      last.end = Math.max(last.end, span.end);
      continue;
    }

    merged.push({ ...span });
  }

  return merged;
}

/**
 * Spans clipped to a window, dropping anything outside it.
 *
 * A night shift spans midnight, so an interval routinely belongs to two days.
 * Clipping rather than assigning the whole interval to whichever day it started
 * in is what makes the days add up to the range.
 */
export function clampSpans(spans: Span[], from: number, to: number): Span[] {
  const clipped: Span[] = [];

  for (const span of spans) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end, to);
    if (end > start) clipped.push({ start, end });
  }

  return clipped;
}

export function totalSeconds(spans: Span[]): number {
  return Math.round(spans.reduce((running, span) => running + (span.end - span.start), 0) / 1000);
}

export function longestSeconds(spans: Span[]): number {
  return Math.round(
    spans.reduce((longest, span) => Math.max(longest, span.end - span.start), 0) / 1000,
  );
}

/** The first instant covered, or null for a day with nothing in it. */
export function firstStart(spans: Span[]): Date | null {
  return spans.length ? new Date(Math.min(...spans.map((span) => span.start))) : null;
}

export function lastEnd(spans: Span[]): Date | null {
  return spans.length ? new Date(Math.max(...spans.map((span) => span.end))) : null;
}
