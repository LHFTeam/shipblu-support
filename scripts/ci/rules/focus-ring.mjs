import ts from 'typescript';
import { fail, lineOf, lineOfNode, parseSource, read, requireAtLeast, scannable } from '../lib.mjs';

/**
 * The keyboard focus ring is one rule in `app/globals.css`, in `@layer base`,
 * and a focusable element keeps it unless a utility deliberately changes it
 * (docs/PROJECT-STATE.md §6.109). Three things hold that.
 *
 * A focus style in a stylesheet sits in `@layer base` or `@layer components`,
 * the two layers Tailwind orders below its utilities, and nothing outside a
 * layer declares an outline. An unlayered rule beats every layered one whatever
 * its specificity. The ring was unlayered, so nothing written against it took
 * effect: a field's outline suppression, the rail's white ring, a pill's own
 * radius. The call sites that noticed reached for the important suffix, and
 * the ones that did not shipped classes that did nothing. The other way round,
 * an unlayered `outline: none` would now beat the ring wherever it matched, and
 * a focus style in `@layer utilities`, or a layer declared after it, would
 * compete with the utilities again.
 *
 * A class string that suppresses the outline does not lean on a translucent
 * focus ring instead. Every shared field drew a 2px ring at 20% alpha beside an
 * outline suppression that never applied. That ring is 1.35:1 against the white
 * surface, under the 3:1 a focus indicator needs, and it is a box-shadow, which
 * forced-colours mode removes. Once the global rule was layered the
 * suppression would have applied, leaving each field a one-pixel border
 * change. So a field keeps the outline. Where a wrapper draws the ring for
 * what is inside it (the widget's composer), the wrapper draws an outline too,
 * not only a box-shadow. Every way a utility removes the outline counts:
 * `outline-none`, `outline-hidden` (which still draws in forced colours, and
 * nowhere else), `outline-0` and `outline-transparent`. This judges one class
 * string at a time, so a primitive that builds its classes from two constants
 * — `FIELD_BASE` and `FIELD_SURFACE` in components/ui.tsx — is held by the
 * comment beside them, not by this check.
 *
 * No outline utility carries the important modifier, in either spelling:
 * Tailwind v4 reads a leading `!` as it reads a trailing one. Nothing needs it
 * against a layered rule, and a leftover one tells the next reader the
 * unlayered rule is still there to beat. Two outline utilities fighting on one
 * element (§6.93) are answered by a prop on the primitive.
 */
export function checkFocusRing() {
  const rule = 'focus-ring';

  // CSS comments blanked, newlines kept, as `light-only` does.
  const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  // The layers Tailwind orders below `@layer utilities`, where a focus style
  // loses to any utility that names the same property.
  const BELOW_UTILITIES = new Set(['base', 'components']);
  const layerOf = (prelude) => /^@layer\s+([\w-]+)/.exec(prelude)?.[1] ?? null;
  const OUTLINE_DECLARATION = /(?:^|[;{\s])outline(?:-(?:style|width|color|offset))?\s*:/;
  const FOCUS_SELECTOR = /:focus(?:-visible|-within)?\b/;

  let globalRing = false;
  for (const file of scannable.filter((f) => f.endsWith('.css'))) {
    const css = stripCss(read(file));
    // Each open block: the at-rule or selector it belongs to, where its body
    // starts, and the line its prelude is on, outermost first.
    const stack = [];
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
      if (ch === '{') {
        const raw = css.slice(start, i);
        const prelude = raw.trim();
        const line = lineOf(css, start + raw.length - raw.trimStart().length);
        const layers = stack.map((b) => layerOf(b.prelude)).filter(Boolean);
        if (!prelude.startsWith('@') && FOCUS_SELECTOR.test(prelude)) {
          if (
            file === 'app/globals.css' &&
            /:focus-visible/.test(prelude) &&
            prelude.includes('[tabindex]')
          ) {
            globalRing = true;
          }
          if (!layers.some((name) => BELOW_UTILITIES.has(name))) {
            fail(
              rule,
              `${file}:${line}`,
              layers.length
                ? `a focus style in @layer ${layers.join(' / ')} competes with the utilities — put it in @layer base`
                : 'a focus style outside a cascade layer outranks every Tailwind utility, so no class can adjust it without ! — put it in @layer base',
            );
          }
        }
        stack.push({ prelude, bodyStart: i + 1, line, layers, nested: false });
        if (stack.length > 1) stack[stack.length - 2].nested = true;
        start = i + 1;
      } else if (ch === '}') {
        const block = stack.pop();
        // A rule's own declarations, read once its block closes. A focus
        // selector was judged above, and an at-rule holds no declarations.
        if (
          block &&
          !block.nested &&
          !block.prelude.startsWith('@') &&
          !FOCUS_SELECTOR.test(block.prelude) &&
          block.layers.length === 0 &&
          OUTLINE_DECLARATION.test(css.slice(block.bodyStart, i))
        ) {
          fail(
            rule,
            `${file}:${block.line}`,
            'an outline declared outside a cascade layer outranks the base-layer focus ring on everything it selects — put it in a layer',
          );
        }
        start = i + 1;
      } else if (ch === ';') {
        start = i + 1;
      }
    }
  }
  if (!globalRing) {
    fail(
      rule,
      'app/globals.css',
      'the shared :focus-visible ring is gone — every focusable element relies on it for a ring',
    );
  }

  // Either spelling of the important modifier: after the utility, or before
  // it and after any variants (`focus-visible:!outline-none`).
  const IMPORTANT_OUTLINE = /^(?:[^\s:]+:)*(?:!-?outline(?:-\S*)?|-?outline(?:-\S*)?!)$/;
  const SUPPRESSES =
    /^(?:(?:focus|focus-visible|focus-within):)?outline-(?:none|hidden|0|transparent)$/;
  const TRANSLUCENT_RING = /^(?:focus|focus-visible):ring-\S*\/\d+$/;

  let classStrings = 0;
  for (const file of scannable.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) {
    const source = parseSource(file);
    const visit = (node) => {
      let text = null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateExpression(node)) {
        text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
      }
      if (text !== null) {
        const tokens = text.split(/\s+/).filter(Boolean);
        if (tokens.some((t) => /(?:^|:)-?outline\b/.test(t))) classStrings++;
        for (const token of tokens.filter((t) => IMPORTANT_OUTLINE.test(t))) {
          fail(
            rule,
            `${file}:${lineOfNode(source, node)}`,
            `${token} — the focus ring is in @layer base, so the plain utility already wins; drop the !`,
          );
        }
        const suppression = tokens.find((t) => SUPPRESSES.test(t));
        if (suppression && tokens.some((t) => TRANSLUCENT_RING.test(t))) {
          fail(
            rule,
            `${file}:${lineOfNode(source, node)}`,
            `${suppression} beside a translucent focus ring: that ring is about 1.35:1 and forced colours removes it — leave the outline to the global ring, or have the wrapper that draws the ring draw an outline`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A rule that passes by finding nothing needs to know it looked. Today's tree
  // has fifteen class strings naming an outline: few, because a field takes
  // its ring from the global rule rather than spelling one.
  requireAtLeast(rule, '*.ts, *.tsx', classStrings, 8, 'class strings that name an outline');
}
