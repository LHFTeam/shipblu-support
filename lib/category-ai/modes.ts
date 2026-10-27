/**
 * The category classifier's settings as values, with nothing that touches the
 * database — so the admin page's client control can import them without
 * shipping the schema to the browser (the `client-db` repo rule, §6.57).
 */

/**
 * `off` asks nothing. `shadow` asks and records what it would have done, and
 * changes nothing. `apply` records and writes the category.
 *
 * Three states, priority's reason: the step between inert and routing work
 * between teams is the one that produces evidence, and Stage 4.2 reads that
 * evidence before anybody turns `apply` on.
 */
export const CATEGORY_AI_MODES = ['off', 'shadow', 'apply'] as const;
export type CategoryAiMode = (typeof CATEGORY_AI_MODES)[number];

export function isCategoryAiMode(value: unknown): value is CategoryAiMode {
  return CATEGORY_AI_MODES.some((mode) => mode === value);
}

/**
 * The winner's share below which nothing settles. A guess, priority's: there
 * are no labelled tickets to calibrate it against yet, and the shadow period is
 * what does.
 */
export const DEFAULT_MIN_PROBABILITY = 0.6;

/**
 * How long Stage 5 holds a fresh ticket for its category before routing it
 * without one. Stored from 4.1 so one page sets everything the classifier and
 * the router read; nothing reads it before Stage 5.
 */
export const DEFAULT_ROUTING_WINDOW_MINUTES = 5;
export const ROUTING_WINDOW_MINUTES = { min: 1, max: 30 } as const;
