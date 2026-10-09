import ts from 'typescript';
import { fail, read, requireAtLeast, scannable } from '../lib.mjs';

/**
 * A button keeps the `type` it was rendered with, outside `ConfirmSubmit`.
 *
 * React commits a click's state update before the browser runs that click's
 * default action. So a button that becomes `type="submit"` in its own click
 * handler is a submit button by the time that same click activates it, and the
 * click that was meant to arm a confirmation submits the form instead.
 * `MergeCandidateRow` merged a contact on one click that way, with its confirm
 * step on screen the whole time (§6.90). Two shapes produce it, and both are
 * refused here:
 *
 * - a `type` that is an expression rather than a string, on `<button>` or
 *   `<Button>`;
 * - a conditional whose two branches are the same button element with
 *   different types, which was the merge row's shape. React keeps the node
 *   and changes the attribute, so it is the expression written out longhand.
 *
 * `components/confirm-submit.tsx` is the one place a button's type changes, and
 * it cancels the arming click so the change cannot act on it. A two-click
 * control is that component, or `useConfirmClick` for one that is not a submit.
 *
 * What this cannot see is the other half of §6.90: a confirm rendered as a
 * different component in place of the arming button. That one is not submitted
 * by the arming click, but the second click of a double-click lands on it. A
 * wrapper's name says nothing about whether it submits, so no syntax check can
 * tell that branch from a harmless one.
 *
 * Read from the syntax tree, for the reasons `dom-title.mjs` gives.
 */
export function checkButtonTypeIsFixed() {
  const rule = 'button-type';
  const exempt = 'components/confirm-submit.tsx';

  let buttons = 0;
  for (const file of scannable.filter((f) => f.endsWith('.tsx') && f !== exempt)) {
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const at = (node) =>
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

    const visit = (node) => {
      const opening = openingOf(node);
      if (opening && isButton(opening)) {
        buttons++;
        const type = attribute(opening, 'type');
        if (type && literalValue(type) === null) {
          fail(
            rule,
            at(type),
            'a button whose type is decided at render can be submitted by the click that changed it — a two-click confirm is ConfirmSubmit from components/confirm-submit.tsx (§6.90)',
          );
        }
      }

      if (ts.isConditionalExpression(node)) {
        const yes = buttonBranch(node.whenTrue);
        const no = buttonBranch(node.whenFalse);
        if (yes && no && yes.tag === no.tag && yes.type !== no.type) {
          fail(
            rule,
            at(node),
            `<${yes.tag} type="${yes.type}"> and <${no.tag} type="${no.type}"> in one position are one node whose type changes, so the click that switches them can submit — a two-click confirm is ConfirmSubmit from components/confirm-submit.tsx (§6.90)`,
          );
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A rule that passes by finding nothing needs to know it looked. Today's
  // tree has about 110 buttons.
  requireAtLeast(rule, '*.tsx', buttons, 60, '<button> and <Button> elements');
}

function openingOf(node) {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return null;
}

/** `<button>`, or `<Button>` from components/ui.tsx, which passes `type` through. */
function isButton(opening) {
  const name = opening.tagName.getText();
  return name === 'button' || name === 'Button';
}

function attribute(opening, name) {
  return opening.attributes.properties.find(
    (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name,
  );
}

/** The string an attribute is set to, written either way, or null for an expression. */
function literalValue(attr) {
  const value = attr.initializer;
  if (!value) return null;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) {
    return value.expression.text;
  }
  return null;
}

/**
 * A conditional's branch, when it is a button: its tag and the type it renders
 * with. A missing `type` is HTML's `submit` on `<button>`, and `button` on
 * `<Button>`, whose default says why.
 */
function buttonBranch(expression) {
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  const opening = openingOf(node);
  if (!opening || !isButton(opening)) return null;

  const tag = opening.tagName.getText();
  const type = attribute(opening, 'type');
  if (!type) return { tag, type: tag === 'button' ? 'submit' : 'button' };
  const value = literalValue(type);
  // An expression is already refused above; one report per mistake is enough.
  return value === null ? null : { tag, type: value };
}
