import { fail, lineOf, scannable, scan } from '../lib.mjs';

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
    DOM_OPENING_TAG,
    (file, _line, match, contents) => {
      const at = ownTitleAttribute(contents, match.index + match[0].length);
      if (at === -1) return;
      fail(
        'dom-title',
        `${file}:${lineOf(contents, at)}`,
        'title= on a DOM element never appears on a phone — use Tooltip or InfoTip from components/tooltip.tsx',
      );
    },
  );
}

/**
 * The start of a lowercase JSX element: `<div`, `<input`, but not `<motion.div`
 * (a member expression, so a component) nor the `<string` of `useState<string>`,
 * which follows an identifier where no element can.
 */
const DOM_OPENING_TAG = /(?<![\w$.)\]])<[a-z][a-zA-Z0-9]*(?=[\s/>])/g;

/** An attribute named exactly `title`, from the whitespace in front of it. */
const TITLE_ATTRIBUTE = /\stitle\s*=/y;

/**
 * Where the opening tag that continues at `from` names a `title` attribute of
 * its own, or -1.
 *
 * Walked rather than matched, because the tag's `>` is not the first `>` after
 * its name. This rule was a single pattern that stopped at any `>`, so an arrow
 * function in an earlier attribute — `onChange={(e) => …}` — ended the tag at
 * `=>`, and the inbox search box carried a `title=` past it with the check
 * green. So: a quoted attribute value is skipped whole, a `{…}` expression is
 * skipped by counting braces, and only a `>` outside both closes the tag. A
 * `title` inside an expression belongs to something else — a variable, or an
 * element nested there, which is matched as its own opening tag.
 *
 * What it does not see: inside `{…}` it counts braces and nothing else, so a
 * string holding a lone brace (`{'}'}`) throws the count off and the rest of that
 * one tag goes unread. Knowing the brace is quoted would mean lexing JavaScript,
 * and a check that misses one freak tag is better than one that guesses. A `<`
 * outside an expression ends the walk too — it cannot occur inside an opening
 * tag, so what started the walk was never an element.
 */
function ownTitleAttribute(source, from) {
  let i = from;
  while (i < source.length) {
    const c = source[i];
    if (c === '>' || c === '<') return -1;

    if (c === '"' || c === "'") {
      const close = source.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }

    if (c === '{') {
      let depth = 1;
      i++;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      continue;
    }

    TITLE_ATTRIBUTE.lastIndex = i;
    if (TITLE_ATTRIBUTE.test(source)) return i + 1;
    i++;
  }
  return -1;
}
