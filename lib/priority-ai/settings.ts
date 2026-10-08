import { logger } from '@/lib/log';

const log = logger('classify_priority');

/**
 * The two switches the priority classifier answers to, read straight from
 * `process.env`.
 *
 * Not through `env()`, for the reason `lib/categorise/detect.ts` gives about its
 * thresholds: the enqueue half runs inside `afterMessageStored`, which every
 * ingest path and the console's reply action reach, and `env()` validates the
 * whole schema — so an enum there would let a typo in a switch nobody on that
 * path cares about fail every inbound message. A value that will not parse is
 * logged and read as the safe default instead: `off`, and the constant.
 */

/**
 * `off` asks nothing. `shadow` asks and records what it would have done, and
 * changes nothing. `apply` records and writes.
 *
 * Three states rather than a boolean because the step between "inert" and
 * "moving SLA deadlines" is the one that produces evidence: no ticket in the
 * archive carries a priority anybody chose, so a shadow run is the only way to
 * read the classifier's answers before they become breaches.
 */
export const PRIORITY_AI_MODES = ['off', 'shadow', 'apply'] as const;
export type PriorityAiMode = (typeof PRIORITY_AI_MODES)[number];

/**
 * The winner's own probability below which nothing is applied.
 *
 * A guess, and it says so: there were no labelled tickets to calibrate it
 * against when this shipped (`plans/priority-through-typesafe.md`). It is an env
 * var so the first measured week can move it without a deploy.
 */
export const DEFAULT_MIN_PROBABILITY = 0.6;

export function priorityAiMode(): PriorityAiMode {
  const raw = process.env.PRIORITY_AI?.trim().toLowerCase();
  if (!raw) return 'off';
  const mode = PRIORITY_AI_MODES.find((candidate) => candidate === raw);
  if (!mode) {
    log.warn(
      `PRIORITY_AI=${raw} is not one of ${PRIORITY_AI_MODES.join(' | ')}; reading it as off`,
    );
    return 'off';
  }
  return mode;
}

export function priorityAiMinProbability(): number {
  const raw = process.env.PRIORITY_AI_MIN_PROBABILITY;
  if (!raw) return DEFAULT_MIN_PROBABILITY;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    log.warn(
      `PRIORITY_AI_MIN_PROBABILITY=${raw} is not a number in 0..1; using ${DEFAULT_MIN_PROBABILITY}`,
    );
    return DEFAULT_MIN_PROBABILITY;
  }
  return value;
}
