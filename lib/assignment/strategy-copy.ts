import type { AssignmentStrategy } from '@/lib/assignment';

/**
 * What the console calls each assignment strategy wherever a group's is shown
 * as one word: the groups list, the category editor's route-group picker and
 * summary, the readiness panel on `/admin/channels` and the routing report's
 * still-unassigned table. Four copies of it had come to exist, so a strategy
 * added or renamed had four places to change; keyed on the enum's own type, a
 * value added there is a compile error here rather than a blank cell.
 *
 * Its own module and pure, for `lib/routing/mode-copy.ts`'s reason: two of
 * those screens are `'use client'` forms, and `lib/assignment/index.ts` holds
 * the pool, so the map there would put the schema in their bundles
 * (`client-bundle`). The import above is a type, and is erased. The groups
 * editor's options say more and the rule builder's are fragments of a
 * sentence; they answer other questions and keep their own words.
 */
export const STRATEGY_LABELS: Record<AssignmentStrategy, string> = {
  manual: 'Manual',
  round_robin: 'Round robin',
  load_balanced: 'Load balanced',
};
