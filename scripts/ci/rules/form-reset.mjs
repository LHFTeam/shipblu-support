import ts from 'typescript';
import { fail, read, requireAtLeast, scannable } from '../lib.mjs';

/**
 * A form with a field a reset would move submits through `useActionForm`
 * (§6.80) — in the console, the help centre and the sign-in pages alike.
 *
 * `<form action={fn}>` makes React 19 reset the form after every action, a
 * refusal included. On a refusal that wiped the reply an agent was about to
 * correct, and put a controlled `<select>` back on an option its state no
 * longer held — so the next send went where the screen did not say. In the help
 * centre it emptied a customer's reply when the ticket closed while they typed.
 * The hook submits from `onSubmit` instead, and its `form` is spread onto the
 * element: `<form {...form}>`. So a `<form>` whose `action` is a function, with
 * neither a spread nor an `onSubmit`, is React's own path, and this refuses it
 * when anything inside it is a field the reset moves.
 *
 * What a reset moves, and so what counts: an uncontrolled `input` or
 * `textarea`, which goes back to its default; and any `select`, checkbox,
 * radio or file input, controlled or not, because React never marks a
 * controlled one's default for the browser to return to. What it leaves alone,
 * and so what passes: hidden inputs and buttons, whose value is their
 * attribute, and a controlled text box, whose default React keeps in step with
 * its value. That is why the purge panel's typed confirmation needs no
 * exemption — nothing here is a list of files.
 *
 * Read from the syntax tree, for the reasons `dom-title.mjs` gives. What it
 * cannot see is a field rendered by a component it is not looking at: a
 * `Toggle`, a `TicketFieldInput`, or the children a wrapper is handed. The
 * fields components/ui.tsx wraps one to one — `Input`, `Textarea`, `Select` —
 * are read as the elements they render.
 */
export function checkFormsDoNotReset() {
  const rule = 'form-reset';

  let forms = 0;
  for (const file of scannable.filter((f) => f.startsWith('app/') && f.endsWith('.tsx'))) {
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const visit = (node) => {
      if (ts.isJsxElement(node) && nameOf(node.openingElement.tagName) === 'form') {
        forms++;
        const field = submitsThroughReact(node.openingElement) ? firstMovedField(node) : null;
        if (field) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          fail(
            rule,
            `${file}:${line + 1}`,
            `<form action={…}> holds a <${field}> that React's reset after a refused action would move — submit it through useActionForm, as <form {...form}> (AGENTS.md, §6.80)`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // A rule that passes by finding nothing needs to know it looked. Today's
  // app has about fifty forms, nearly forty of them in the console.
  requireAtLeast(rule, 'app/', forms, 15, '<form> elements');
}

/** The element's name as written: `form`, `Input`, `motion.div`. */
function nameOf(tagName) {
  return tagName.getText();
}

function attribute(opening, name) {
  return opening.attributes.properties.find(
    (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name,
  );
}

/**
 * React runs the action itself, reset and all: `action` is a function, and
 * nothing took the submission over. A spread is the hook's props object, and an
 * `onSubmit` is a form handling its own submission. A string `action` is a
 * plain HTML form React does not touch, written either way — the help centre's
 * search and tracking boxes build theirs as a template, `{`/${locale}/search`}`.
 */
function submitsThroughReact(opening) {
  if (opening.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a))) return false;
  if (attribute(opening, 'onSubmit')) return false;
  const value = attribute(opening, 'action')?.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) return false;
  return !ts.isStringLiteralLike(value.expression) && !ts.isTemplateExpression(value.expression);
}

/** A string an attribute is set to, written either way, or null. */
function staticValue(opening, name) {
  const value = attribute(opening, name)?.initializer;
  if (!value) return null;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) {
    return value.expression.text;
  }
  return null;
}

/** The first field inside the form that a native reset would move, by name. */
function firstMovedField(form) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening && movedByReset(opening)) {
      found = nameOf(opening.tagName);
      return;
    }
    ts.forEachChild(node, visit);
  };
  form.children.forEach(visit);
  return found;
}

function movedByReset(opening) {
  const name = nameOf(opening.tagName);
  const controlled = Boolean(attribute(opening, 'value'));
  if (name === 'select' || name === 'Select') return true;
  if (name === 'textarea' || name === 'Textarea') return !controlled;
  if (name !== 'input' && name !== 'Input') return false;

  const type = (staticValue(opening, 'type') ?? 'text').toLowerCase();
  if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
  if (['checkbox', 'radio', 'file'].includes(type)) return true;
  return !controlled;
}
