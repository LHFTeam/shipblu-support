import { fail, scannable, scan } from '../lib.mjs';

/**
 * `title=` on a DOM element never appears on a phone, which is where the console
 * is read. components/tooltip.tsx answers hover, focus and tap alike.
 *
 * Only lowercase JSX elements are DOM elements — `<Section title="...">` is a
 * component prop and perfectly fine.
 */
export function checkNoDomTitleAttribute() {
  /**
   * Three uses that predate this check and are not mechanical swaps.
   *
   * `Tooltip` renders its trigger as a real button, which is what makes it
   * answer a tap. That is the right shape for a span of text and the wrong shape
   * for these: `availability.tsx` would nest a button inside the submit button
   * it describes, and the other two would turn a layout element — an avatar
   * circle, a channel badge — into a control. Each needs a design decision about
   * what the trigger should be, not a find and replace, so they are named here
   * rather than silently rewritten or the rule dropped.
   *
   * Anything not on this list fails. Do not extend it — fix the call site.
   */
  const predating = new Set([
    'app/(console)/availability.tsx',
    'app/(console)/layout.tsx',
    'components/channel.tsx',
  ]);

  scan(
    scannable.filter((f) => f.endsWith('.tsx') && !predating.has(f)),
    /<[a-z][a-zA-Z0-9]*(?:\s+[^<>]*?)?\stitle=/g,
    (file, line) => {
      fail(
        'dom-title',
        `${file}:${line}`,
        'title= on a DOM element never appears on a phone — use Tooltip or InfoTip from components/tooltip.tsx',
      );
    },
  );
}
