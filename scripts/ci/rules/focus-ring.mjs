import ts from 'typescript';
import { fail, lineOf, lineOfNode, parseSource, read, requireAtLeast, scannable } from '../lib.mjs';

/**
 * The keyboard focus ring is one rule in `app/globals.css`, in `@layer base`,
 * and a focusable element keeps it unless a utility deliberately changes it
 * (docs/PROJECT-STATE.md §6.109). Three things hold that.
 *
 * A focus style in a stylesheet sits inside a cascade layer. Tailwind's
 * utilities are `@layer utilities`, and an unlayered rule beats every layered
 * one whatever its specificity. The ring was unlayered, so nothing written
 * against it took effect: a field's outline suppression, the rail's white
 * ring, a pill's own radius. The call sites that noticed reached for the
 * important suffix, and the ones that did not shipped classes that did nothing.
 *
 * A class string that suppresses the outline does not lean on a translucent
 * focus ring instead. Every shared field drew a 2px ring at 20% alpha beside an
 * outline suppression that never applied. That ring is 1.35:1 against the white
 * surface, under the 3:1 a focus indicator needs, and it is a box-shadow, which
 * forced-colours mode removes. Once the global rule was layered the
 * suppression would have applied, leaving each field a one-pixel border
 * change. So a field keeps the outline. Where a wrapper draws the ring for
 * what is inside it (the widget's composer), the wrapper draws an outline too,
 * not only a box-shadow. This judges one class
 * string at a time, so a primitive that builds its classes from two constants
 * — `FIELD_BASE` and `FIELD_SURFACE` in components/ui.tsx — is held by the
 * comment beside them, not by this check.
 *
 * No outline utility carries the important suffix. Nothing needs it against a
 * layered rule, and a leftover one tells the next reader the unlayered rule is
 * still there to beat. Two outline utilities fighting on one element (§6.93)
 * are answered by a prop on the primitive.
 */
export function checkFocusRing() {
  const rule = 'focus-ring';

  // CSS comments blanked, newlines kept, as `light-only` does.
  const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  let globalRing = false;
  for (const file of scannable.filter((f) => f.endsWith('.css'))) {
    const css = stripCss(read(file));
    // The at-rule or selector each open block belongs to, outermost first.
    const stack = [];
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
      if (ch === '{') {
        const raw = css.slice(start, i);
        const prelude = raw.trim();
        if (!prelude.startsWith('@') && /:focus(?:-visible|-within)?\b/.test(prelude)) {
          if (
            file === 'app/globals.css' &&
            /:focus-visible/.test(prelude) &&
            prelude.includes('[tabindex]')
          ) {
            globalRing = true;
          }
          if (!stack.some((p) => p.startsWith('@layer'))) {
            fail(
              rule,
              `${file}:${lineOf(css, start + raw.length - raw.trimStart().length)}`,
              'a focus style outside a cascade layer outranks every Tailwind utility, so no class can adjust it without ! — put it in @layer base',
            );
          }
        }
        stack.push(prelude);
        start = i + 1;
      } else if (ch === '}') {
        stack.pop();
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

  const IMPORTANT_OUTLINE = /^(?:[^\s:]+:)*-?outline(?:-\S*)?!$/;
  const SUPPRESSES = /^(?:(?:focus|focus-visible|focus-within):)?outline-none$/;
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
        if (
          tokens.some((t) => SUPPRESSES.test(t)) &&
          tokens.some((t) => TRANSLUCENT_RING.test(t))
        ) {
          fail(
            rule,
            `${file}:${lineOfNode(source, node)}`,
            'outline-none beside a translucent focus ring: that ring is about 1.35:1 and forced colours removes it — leave the outline to the global ring, or have the wrapper that draws the ring draw an outline',
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A rule that passes by finding nothing needs to know it looked. Today's tree
  // has about forty class strings naming an outline.
  requireAtLeast(rule, '*.ts, *.tsx', classStrings, 10, 'class strings that name an outline');
}
