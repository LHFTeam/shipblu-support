import ts from 'typescript';
import {
  fail,
  lineOf,
  lineOfNode,
  parseSource,
  read,
  requireAtLeast,
  scannable,
  stripCssComments,
} from '../lib.mjs';

/**
 * The keyboard focus ring is one rule in `app/globals.css`, in `@layer base`,
 * and a focusable element keeps it unless a utility deliberately changes it
 * (docs/PROJECT-STATE.md §6.109). Three things hold that.
 *
 * A stylesheet declares a focus outline in `@layer base` or `@layer
 * components`, the two layers Tailwind orders below its utilities, declares
 * any other outline in one of Tailwind's layers, and never removes the outline
 * from a focused element. An unlayered rule beats every layered one whatever
 * its specificity. The ring was unlayered, so nothing written against it took
 * effect: a field's outline suppression, the rail's white ring, a pill's own
 * radius. The call sites that noticed reached for the important suffix, and
 * the ones that did not shipped classes that did nothing. The other way round,
 * an unlayered `outline: none`, or one in a layer declared after the
 * utilities, would beat the ring and every utility wherever it matched.
 *
 * - A layer is placed by the first name of its path. `@layer overrides {
 *   @layer base { … } }` is `overrides.base`, which sits wherever `overrides`
 *   does, not inside `base`.
 * - An `@utility` is emitted into `@layer utilities` and applied by class, so
 *   a focus outline in one is a utility's to set. A `@variant` or a media
 *   query nested in a rule declares for that rule.
 * - Removing the outline under a focus selector (`none`, a zero width,
 *   `transparent`) is refused in every layer, an `@utility` included. A
 *   stylesheet rule reaches every element its selector matches. An element
 *   that needs no ring says so with a utility, where the class-string check
 *   below can see it.
 * - The shared rule still declares an outline. A selector left behind with
 *   its declaration edited away is not a ring.
 * - Only outline declarations are judged. A focus rule that changes a border
 *   is not the ring, and moving one into `@layer base` would make it lose to
 *   the unlayered rule it was written against.
 * - Keyframe steps are left alone: they animate an outline rather than
 *   setting one.
 *
 * A module that removes the outline in a class string draws no focus ring in
 * another. Every shared field drew a 2px ring at 20% alpha beside an outline
 * suppression that never applied. That ring is 1.35:1 against the white
 * surface, under the 3:1 a focus indicator needs. It is also a box-shadow,
 * which forced-colours mode removes whatever its colour. Once the global rule
 * was layered the suppression would have applied, leaving each field a
 * one-pixel border change. So a field keeps the outline. Where a wrapper draws
 * the ring for what is inside it (the widget's composer), the wrapper draws an
 * outline, not a box-shadow.
 *
 * Every way a utility removes the outline counts: `outline-none`,
 * `outline-hidden` (which draws in forced colours and nowhere else),
 * `outline-0` and `outline-transparent`. So does every focus ring, opaque or
 * not, behind any variant that names focus. An opaque ring beside
 * `outline-hidden` could pass the contrast bar, but a class string does not say
 * which ring is opaque (a token's alpha is in globals.css), and the global ring
 * already is one.
 *
 * The two are judged across the module, not one string at a time, because a
 * primitive builds its classes from pieces: `FIELD_BASE` and `FIELD_SURFACE` in
 * components/ui.tsx, a `cn()` call's arguments, a conditional in a template.
 * A suppression where focus is only parked for a screen reader (a skip link's
 * target, a thanks line) sits in a module that draws no ring. A ring imported
 * from another module is not seen.
 *
 * No outline utility carries the important modifier, in either spelling:
 * Tailwind v4 reads a leading `!` as it reads a trailing one. Nothing needs it
 * against a layered rule, and a leftover one tells the next reader the
 * unlayered rule is still there to beat. Two outline utilities fighting on one
 * element (§6.93) are answered by a prop on the primitive.
 */
export function checkFocusRing() {
  const rule = 'focus-ring';

  // The layers Tailwind orders below `@layer utilities`, where a focus outline
  // loses to any utility that names the same property; and Tailwind's own
  // layers, any of which a utility can still override an outline in.
  const BELOW_UTILITIES = new Set(['base', 'components']);
  const TAILWIND_LAYERS = new Set(['base', 'components', 'utilities']);
  // The names a block adds to the layer path: a dotted `@layer a.b` both, an
  // `@utility` the layer Tailwind emits it into.
  const layersOf = (prelude) => {
    const layer = /^@layer\s+([\w.-]+)$/.exec(prelude);
    if (layer) return layer[1].split('.');
    return /^@utility\b/.test(prelude) ? ['utilities'] : [];
  };
  const FOCUS_SELECTOR = /:focus(?:-visible|-within)?\b/;
  const FOCUS_VARIANT = /^@variant\b[^{]*focus/;

  // A block's own declarations: its body with every nested block taken out, so
  // a rule holding a nested rule is still read, and a child is not read twice.
  const ownDeclarations = (body) => {
    let text = body;
    for (let previous = ''; previous !== text;) {
      previous = text;
      text = text.replace(/[^{};]*\{[^{}]*\}/g, '');
    }
    return text;
  };
  const OUTLINE_PROPERTY = /^outline(?:-(?:style|width|color|offset))?$/;
  const outlineDeclarations = (body) =>
    ownDeclarations(body)
      .split(';')
      .map((text) => {
        const colon = text.indexOf(':');
        if (colon < 0) return null;
        const property = text.slice(0, colon).trim().toLowerCase();
        const value = text
          .slice(colon + 1)
          .replace(/!\s*important/i, '')
          .trim()
          .toLowerCase();
        return { property, value };
      })
      .filter((d) => d && OUTLINE_PROPERTY.test(d.property));
  // Function calls folded away first, so the zeros in `rgb(0 0 0)` are not
  // read as a width.
  const valueTokens = (value) => {
    let text = value;
    for (let previous = ''; previous !== text;) {
      previous = text;
      text = text.replace(/[\w-]+\([^()]*\)/g, 'fn');
    }
    return text.split(/\s+/);
  };
  const isZero = (token) => /^0+(?:\.0+)?(?:[a-z]+)?$/.test(token);
  const removesOutline = ({ property, value }) => {
    if (property === 'outline') {
      return valueTokens(value).some((t) => t === 'none' || t === 'transparent' || isZero(t));
    }
    if (property === 'outline-style') return value === 'none';
    if (property === 'outline-width') return isZero(value);
    if (property === 'outline-color') return value === 'transparent';
    return false;
  };

  let globalRing = false;
  const judge = (file, block, body) => {
    const outlines = outlineDeclarations(body);
    if (!outlines.length) return;
    const where = `${file}:${block.line}`;
    const [top] = block.layers;
    const path = block.layers.join('.');
    const removed = outlines.find(removesOutline);
    if (
      file === 'app/globals.css' &&
      /:focus-visible/.test(block.prelude) &&
      block.prelude.includes('[tabindex]') &&
      outlines.some((d) => d.property === 'outline') &&
      !removed
    ) {
      globalRing = true;
    }
    if (block.focus) {
      if (removed) {
        fail(
          rule,
          where,
          `${removed.property}: ${removed.value} under a focus selector takes the keyboard ring off everything it matches — recolour or move the ring instead, or suppress it with a utility on the one element that takes no input`,
        );
      } else if (!block.inUtility && !BELOW_UTILITIES.has(top)) {
        fail(
          rule,
          where,
          top
            ? `a focus outline in @layer ${path} competes with the utilities — put it in @layer base`
            : 'a focus outline outside a cascade layer outranks every Tailwind utility, so no class can adjust it without ! — put it in @layer base',
        );
      }
    } else if (!TAILWIND_LAYERS.has(top)) {
      fail(
        rule,
        where,
        top
          ? `an outline declared in @layer ${path} outranks the focus ring and every utility on everything it selects — declare it in @layer components, where a utility can still override it`
          : 'an outline declared outside a cascade layer outranks the focus ring and every utility on everything it selects — declare it in @layer components, where a utility can still override it',
      );
    }
  };

  for (const file of scannable.filter((f) => f.endsWith('.css'))) {
    // Strings and url() bodies blanked as well as comments, newlines kept, so a
    // brace or a semicolon inside `content: '{'` cannot move the walker.
    const css = stripCssComments(read(file)).replace(
      /(["'])(?:\\[\s\S]|(?!\1)[^\\\n])*\1|url\([^)]*\)/g,
      (m) => m.replace(/[^\n]/g, ' '),
    );
    // Each open block: its prelude, where its body starts, the line the
    // prelude is on, and what it inherits from the blocks around it.
    const stack = [];
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
      if (ch === '{') {
        const raw = css.slice(start, i);
        const prelude = raw.trim();
        const parent = stack.at(-1);
        const atRule = prelude.startsWith('@');
        stack.push({
          prelude,
          bodyStart: i + 1,
          line: lineOf(css, start + raw.length - raw.trimStart().length),
          layers: [...(parent?.layers ?? []), ...layersOf(prelude)],
          inKeyframes: Boolean(parent?.inKeyframes) || /^@(?:-\w+-)?keyframes\b/.test(prelude),
          inUtility: Boolean(parent?.inUtility) || /^@utility\b/.test(prelude),
          focus:
            Boolean(parent?.focus) ||
            (atRule ? FOCUS_VARIANT.test(prelude) : FOCUS_SELECTOR.test(prelude)),
        });
        start = i + 1;
      } else if (ch === '}') {
        // A block's own declarations, read once it closes: a style rule's, and
        // an at-rule's nested in one, which declares for that rule.
        const block = stack.pop();
        if (block && !block.inKeyframes) judge(file, block, css.slice(block.bodyStart, i));
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
      'the shared :focus-visible ring is gone, or no longer declares an outline — every focusable element relies on it for a ring',
    );
  }

  // Either spelling of the important modifier: after the utility, or before
  // it and after any variants (`focus-visible:!outline-none`).
  const IMPORTANT_OUTLINE = /^(?:[^\s:]+:)*(?:!-?outline(?:-\S*)?|-?outline(?:-\S*)?!)$/;
  // Behind any variants, responsive and stacked ones included
  // (`md:focus:outline-none`), since each still removes the ring where it
  // applies.
  const SUPPRESSES = /^(?:[^\s:]+:)*outline-(?:none|hidden|0|transparent)$/;
  // A ring behind any variant naming focus (`focus:`, `focus-within:`,
  // `group-focus:`, `has-[input:focus-visible]:`), of any colour or opacity.
  // Not `ring-offset-*` or `ring-inset`, which draw nothing on their own.
  const FOCUS_RING = /^(?:[^\s:]+:)*[^\s:]*focus[^\s:]*:ring(?:-(?!offset-|inset$)\S*)?$/;

  let classStrings = 0;
  for (const file of scannable.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) {
    const source = parseSource(file);
    const suppressions = [];
    let ring = null;
    const visit = (node) => {
      let text = null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateExpression(node)) {
        text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
      }
      if (text !== null) {
        const tokens = text.split(/\s+/).filter(Boolean);
        const line = lineOfNode(source, node);
        if (tokens.some((t) => /(?:^|:)-?outline\b/.test(t))) classStrings++;
        for (const token of tokens.filter((t) => IMPORTANT_OUTLINE.test(t))) {
          fail(
            rule,
            `${file}:${line}`,
            `${token} — the focus ring is in @layer base, so no ! is needed against it; where two outline utilities fight on one element (§6.93), give the primitive a prop instead`,
          );
        }
        const suppression = tokens.find((t) => SUPPRESSES.test(t));
        if (suppression) suppressions.push({ token: suppression, line });
        const drawn = tokens.find((t) => FOCUS_RING.test(t));
        if (drawn && !ring) ring = { token: drawn, line };
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!ring) continue;
    for (const { token, line } of suppressions) {
      fail(
        rule,
        `${file}:${line}`,
        `${token} in a module that draws a focus ring (${ring.token}, line ${ring.line}) — that ring is a box-shadow, which forced colours removes, and a field's 20% one is 1.35:1: leave the outline to the global ring, have the wrapper that draws the ring draw an outline, or move a suppression that only parks focus into a component of its own`,
      );
    }
  }

  // A rule that passes by finding nothing needs to know it looked. Today's tree
  // has fifteen class strings naming an outline: few, because a field takes
  // its ring from the global rule rather than spelling one.
  requireAtLeast(rule, '*.ts, *.tsx', classStrings, 8, 'class strings that name an outline');
}
