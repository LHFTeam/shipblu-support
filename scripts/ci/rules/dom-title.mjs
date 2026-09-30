import ts from 'typescript';
import { fail, read, scannable } from '../lib.mjs';

/**
 * `title=` on a DOM element never appears on a phone, which is where the console
 * is read. components/tooltip.tsx answers hover, focus and tap alike.
 *
 * Only lowercase JSX elements are DOM elements — `<Section title="...">` is a
 * component prop and perfectly fine.
 *
 * Read off the syntax tree rather than matched as text. A pattern has to guess
 * where a tag ends, and every guess was wrong somewhere: the first took the `=>`
 * of `onChange={(e) => …}` for the end of the tag, so the inbox search box
 * carried a phone-invisible tooltip through every run of this check, and
 * letting `=>` through still stopped at `count > 0` or `ChangeEvent<Input>`.
 * The parser knows where the attributes are, so there is nothing left to guess.
 * TypeScript is already how the repository is type-checked, so this adds no
 * dependency.
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

  for (const file of scannable.filter((f) => f.endsWith('.tsx') && !predating.has(f))) {
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const visit = (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        /^[a-z]/.test(node.tagName.text)
      ) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'title') {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            fail(
              'dom-title',
              `${file}:${line + 1}`,
              'title= on a DOM element never appears on a phone — use Tooltip or InfoTip from components/tooltip.tsx',
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
