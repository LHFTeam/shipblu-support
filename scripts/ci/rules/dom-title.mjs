import ts from 'typescript';
import { fail, lineOfNode, parseSource, requireAtLeast, scannable } from '../lib.mjs';

/**
 * `title=` on a DOM element never appears on a phone, which is where the console
 * is read. components/tooltip.tsx answers hover, focus and tap alike.
 *
 * Only lowercase JSX elements are DOM elements — `<Section title="...">` is a
 * component prop and perfectly fine. A component that forwards its props to a
 * DOM element is the one case this cannot see, so those refuse `title` in their
 * types instead: `NativeProps` in components/ui.tsx, which `tsc` enforces at
 * the call site.
 *
 * Read from the syntax tree the TypeScript compiler builds, not from the text.
 * This rule was a pattern that stopped at the first `>`, so an arrow function in
 * an earlier attribute — `onChange={(e) => …}` — ended the tag at `=>`, and the
 * inbox search box carried a `title=` past it with the check green. Letting
 * `=>` through, as one fix did, still stopped at a comparison
 * (`disabled={count > 0}`) or a type argument (`ChangeEvent<HTMLInputElement>`).
 * The hand-written walker that replaced the pattern closed that and opened three
 * more in review: an element straight after JSX text (`Hours<abbr title>`), a
 * brace inside a quoted string inside an expression, and `stripComments`
 * blanking a `//` or `/*` inside an attribute value (`href="//cdn…"`,
 * `accept="image/*"`). Each was one more approximation of a lexer the repo
 * already has, exactly, in the compiler `tsc` runs: comments are trivia in the
 * tree rather than text to blank, and an attribute is a node rather than a
 * guess about where a tag ends.
 */
export function checkNoDomTitleAttribute() {
  const rule = 'dom-title';

  let elements = 0;
  for (const file of scannable.filter((f) => f.endsWith('.tsx'))) {
    const source = parseSource(file);

    const visit = (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        isDomElement(node.tagName)
      ) {
        elements++;
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) continue;
          if (attribute.name.text !== 'title') continue;
          fail(
            rule,
            `${file}:${lineOfNode(source, attribute)}`,
            'title= on a DOM element never appears on a phone — use Tooltip or InfoTip from components/tooltip.tsx',
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A rule that passes by finding nothing needs to know it looked. Today's
  // tree has about 2,000 DOM elements.
  requireAtLeast(rule, '*.tsx', elements, 500, 'DOM elements in JSX');
}

/**
 * What React renders as a DOM element rather than calling as a component: a
 * lowercase name, a hyphenated custom element (`<relative-time>`), or a
 * namespaced one (`<svg:rect>`). The compiler's own test, `isIntrinsicJsxName`,
 * is not in its public API, so it is spelled out here. `<motion.div>` is a
 * property access and so a component, whatever its case.
 */
function isDomElement(tagName) {
  if (ts.isJsxNamespacedName(tagName)) return true;
  if (!ts.isIdentifier(tagName)) return false;
  return /^[a-z]/.test(tagName.text) || tagName.text.includes('-');
}
