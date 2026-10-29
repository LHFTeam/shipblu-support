import { describe, expect, it } from 'vitest';
import { describeEvent } from '@/lib/tickets/event-labels';
import { ROUTING_OUTCOMES } from './decide';
import { ROUTING_OUTCOME_LABELS } from './mode-copy';

/**
 * The outcome labels the routing report heads its columns with. The `Record`
 * type makes a missing outcome a compile error; these hold what it cannot —
 * that nothing else is in it, and that no two columns read alike.
 */

describe('ROUTING_OUTCOME_LABELS', () => {
  it('names exactly the outcomes the enum holds, in their order', () => {
    // The report pivots over `ROUTING_OUTCOMES`, so a label for anything else
    // would be a column no row can fill.
    expect(Object.keys(ROUTING_OUTCOME_LABELS)).toEqual([...ROUTING_OUTCOMES]);
  });

  it('gives every outcome a label of its own', () => {
    const labels = Object.values(ROUTING_OUTCOME_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim()).not.toBe('');
  });

  it('labels only outcomes the timeline has a sentence for', () => {
    // `describeRouted` answers "routed the ticket" for an outcome it does not
    // know, so a label here with no sentence there would head a column whose
    // tickets the timeline cannot explain.
    for (const outcome of ROUTING_OUTCOMES) {
      expect(describeEvent('routed', { outcome })).not.toBe('routed the ticket');
    }
  });
});
