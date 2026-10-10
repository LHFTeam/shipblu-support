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
 * step on screen the whole time (§6.90). Refused here, on `<button>` and
 * `<Button>`:
 *
 * - a `type` that is an expression rather than a string;
 * - a conditional whose branches render the same button element with
 *   different types, which was the merge row's shape. Branches are read
 *   through nested conditionals and single-child fragments, which keep the
 *   node just the same;
 * - a function that returns the same button element with one type from one
 *   `return` and another type from another, which is the same conditional
 *   spelled as an early return or a `switch`.
 *
 * In every one React keeps the DOM node and changes its attribute.
 *
 * `components/confirm-submit.tsx` is the one place a button's type changes, and
 * it cancels the arming click so the change cannot act on it. A two-click
 * control is that component, or `useConfirmClick` for one that is not a submit.
 *
 * A function is read as one position, so a render helper called from two
 * fixed places with two types is reported too. That is the conservative
 * answer; write the two buttons out where they are used.
 *
 * What this cannot see:
 * - an element chosen through a variable assigned in branches;
 * - the button inside a wrapper element that two `return`s both render, as
 *   in `return <form><button type="submit" /></form>` and the same with
 *   `type="button"`: only the element each `return` names is compared;
 * - the other half of §6.90, a confirm rendered as a different component in
 *   place of the arming button. That one is not submitted by the arming click,
 *   but the second click of a double-click lands on it. A wrapper's name says
 *   nothing about whether it submits, so no syntax check can tell that branch
 *   from a harmless one.
 *
 * Read from the syntax tree, for the reasons `dom-title.mjs` gives.
 */
export function checkButtonTypeIsFixed() {
  const rule = 'button-type';
  const exempt = 'components/confirm-submit.tsx';
  const advice =
    'one node whose type changes, so the click that switches it can submit — a two-click confirm is ConfirmSubmit from components/confirm-submit.tsx (§6.90)';

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
        const pair = clash(buttonsIn(node.whenTrue), buttonsIn(node.whenFalse));
        if (pair) fail(rule, at(node), `${describe(pair)} in one position are ${advice}`);
      }

      if (isFunction(node)) {
        const returns = returnsOf(node).map((r) => ({ node: r, found: buttonsIn(r.expression) }));
        for (let i = 1; i < returns.length; i++) {
          const pair = returns
            .slice(0, i)
            .map((earlier) => clash(earlier.found, returns[i].found))
            .find(Boolean);
          if (pair) {
            fail(
              rule,
              at(returns[i].node),
              `${describe(pair)} returned by one function are ${advice}`,
            );
            break;
          }
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
 * The buttons an expression can render in the position it occupies, with the
 * type each renders with. A missing `type` is HTML's `submit` on `<button>`,
 * and `button` on `<Button>`, whose default says why. Read through parentheses,
 * nested conditionals and a fragment around a single element, none of which
 * gives React a reason to replace the node.
 */
function buttonsIn(expression) {
  let node = expression;
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  if (!node) return [];
  if (ts.isConditionalExpression(node)) {
    return [...buttonsIn(node.whenTrue), ...buttonsIn(node.whenFalse)];
  }
  if (ts.isJsxFragment(node)) {
    const children = node.children.filter(
      (c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces),
    );
    return children.length === 1 ? buttonsIn(children[0]) : [];
  }

  const opening = openingOf(node);
  if (!opening || !isButton(opening)) return [];
  const tag = opening.tagName.getText();
  const type = attribute(opening, 'type');
  if (!type) return [{ tag, type: tag === 'button' ? 'submit' : 'button' }];
  const value = literalValue(type);
  // An expression is already refused where it is written; one report per mistake.
  return value === null ? [] : [{ tag, type: value }];
}

/** The first pair, one from each side, that is one element with two types. */
function clash(left, right) {
  for (const a of left) {
    const b = right.find((r) => r.tag === a.tag && r.type !== a.type);
    if (b) return [a, b];
  }
  return null;
}

function describe([a, b]) {
  return `<${a.tag} type="${a.type}"> and <${b.tag} type="${b.type}">`;
}

function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** A function's own `return` statements with a value, not those of functions inside it. */
function returnsOf(fn) {
  const found = [];
  const walk = (node) => {
    if (node !== fn && isFunction(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(fn);
  return found;
}
