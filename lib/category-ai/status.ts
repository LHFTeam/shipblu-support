import type { CategoryAiMode } from './modes';

/**
 * What `/reports/category-ai` says Jev is doing, as its bold half and the rest
 * of the sentence after it.
 *
 * With no key the switch is a setting, not what Jev does: said as "is filing
 * tickets" over "it is asked nothing", the bold half was the false one. So the
 * three modes and the key are read in one place, where a test holds each of
 * the six answers.
 */
export function jevStatus(
  mode: CategoryAiMode,
  keyConfigured: boolean,
  minProbability: number,
): { bold: string; tail: string } {
  if (mode === 'off') return { bold: 'switched off', tail: '.' };
  const threshold = `, at a threshold of ${minProbability}`;
  if (!keyConfigured) {
    return {
      bold: mode === 'shadow' ? 'set to shadow' : 'set to file tickets',
      tail: `${threshold}, but this environment has no TYPESAFE_API_KEY, so it is asked nothing and ${mode === 'shadow' ? 'records' : 'files'} nothing.`,
    };
  }
  return {
    bold:
      mode === 'shadow'
        ? 'in shadow: asked, and its answers recorded, with no ticket changed'
        : 'filing tickets',
    tail: `${threshold}.`,
  };
}
